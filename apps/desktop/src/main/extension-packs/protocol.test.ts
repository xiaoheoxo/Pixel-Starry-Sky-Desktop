import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codedError } from '@pixelsky/protocol'

vi.mock('electron', () => ({
  protocol: { handle: vi.fn() },
  app: { getPath: () => tmpdir() },
  net: { fetch: vi.fn() },
}))
vi.mock('../account/account', () => ({ baseUrl: () => 'http://127.0.0.1:9' }))

const { createIconStore, ICON_MAX_BYTES } = await import('./market/icons')
const { storeIconResponse } = await import('./protocol')

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'icons-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>')
const reply = (bytes: Buffer, type: string) => ({ bytes, headers: new Headers({ 'content-type': type }) })
const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])

function store(download: (p: string) => Promise<ReturnType<typeof reply>>, extra: object = {}) {
  const dir = tmp()
  const fn = vi.fn(download)
  let t = 1_000_000
  const s = createIconStore({ dir, download: fn, now: () => t, ...extra })
  return { s, dir, fn, tick: (ms: number) => (t += ms) }
}

describe('icon store', () => {
  it('下载 png，写进缓存，第二次不再请求', async () => {
    const { s, dir, fn } = store(async () => reply(PNG, 'image/png'))
    const r = await s.get('acme.one', '1.0.0')
    expect(r).toMatchObject({ kind: 'ok', icon: { mime: 'image/png' } })
    expect(fn).toHaveBeenCalledWith('/cloud/extensions/acme.one/1.0.0/icon')
    expect(list(dir)).toEqual(['acme.one@1.0.0.png'])
    await s.get('acme.one', '1.0.0')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('只收 png / svg：别的类型、png 文件头不对都拒绝，不缓存', async () => {
    for (const [bytes, type] of [
      [PNG, 'image/jpeg'],
      [PNG, 'text/html'],
      [SVG, 'application/octet-stream'],
      [Buffer.from('not a png'), 'image/png'],
    ] as const) {
      const { s, dir } = store(async () => reply(bytes, type))
      expect((await s.get('acme.one', '1.0.0')).kind).toBe('bad')
      expect(list(dir)).toEqual([])
    }
  })

  it('超过 256 KB 拒绝（内容超限和下载层 tooLarge 两种）', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES)])
    expect((await store(async () => reply(big, 'image/png')).s.get('acme.one', '1.0.0')).kind).toBe('bad')
    const r = await store(async () => {
      throw codedError('extstore.tooLarge')
    }).s.get('acme.one', '1.0.0')
    expect(r.kind).toBe('bad')
  })

  it('SVG 要过 checkSvg', async () => {
    const ok = store(async () => reply(SVG, 'image/svg+xml; charset=utf-8'))
    expect((await ok.s.get('acme.one', '1.0.0')).kind).toBe('ok')
    expect(list(ok.dir)).toEqual(['acme.one@1.0.0.svg'])
    for (const evil of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="x()"/>',
      '<svg><image href="http://x/a.png"/></svg>',
    ]) {
      const { s, dir } = store(async () => reply(Buffer.from(evil), 'image/svg+xml'))
      expect((await s.get('acme.one', '1.0.0')).kind).toBe('bad')
      expect(list(dir)).toEqual([])
    }
  })

  it('缓存里被改坏的 SVG 不再送出，重新下载', async () => {
    const { s, dir, fn } = store(async () => reply(SVG, 'image/svg+xml'))
    await s.get('acme.one', '1.0.0')
    writeFileSync(join(dir, 'acme.one@1.0.0.svg'), '<svg><script/></svg>')
    expect((await s.get('acme.one', '1.0.0')).kind).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('404 在内存里记 10 分钟，之后再请求；不写磁盘', async () => {
    const { s, dir, fn, tick } = store(async () => {
      throw codedError('extstore.notFound')
    })
    expect((await s.get('acme.one', '1.0.0')).kind).toBe('missing')
    tick(9 * 60_000)
    expect((await s.get('acme.one', '1.0.0')).kind).toBe('missing')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(list(dir)).toEqual([])
    tick(2 * 60_000)
    await s.get('acme.one', '1.0.0')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('网络失败不记 404，下次还会请求', async () => {
    const { s, fn } = store(async () => {
      throw codedError('extstore.offline')
    })
    expect((await s.get('acme.one', '1.0.0')).kind).toBe('failed')
    await s.get('acme.one', '1.0.0')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('同一个图标同时请求只下载一次', async () => {
    const { s, fn } = store(async () => reply(PNG, 'image/png'))
    await Promise.all([s.get('acme.one', '1.0.0'), s.get('acme.one', '1.0.0')])
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('id / version 不合法直接拒绝，不请求', async () => {
    const { s, fn } = store(async () => reply(PNG, 'image/png'))
    for (const [id, v] of [
      ['../x', '1.0.0'],
      ['acme.one', '../1'],
      ['ACME', '1.0.0'],
      ['acme.one', '1.0'],
    ]) {
      expect((await s.get(id, v)).kind).toBe('bad')
    }
    expect(fn).not.toHaveBeenCalled()
  })

  it('缓存最多 maxEntries 个，最久没用的先删', async () => {
    const { s, dir } = store(async () => reply(PNG, 'image/png'), { maxEntries: 3 })
    const touch = (v: string, sec: number): void => {
      const t = new Date(1_000_000 + sec * 1000)
      utimesSync(join(dir, `acme.one@${v}.png`), t, t)
    }
    for (let i = 1; i <= 3; i++) {
      await s.get('acme.one', `1.0.${i}`)
      touch(`1.0.${i}`, i)
    }
    // 读一次 1.0.1 会刷新它的使用时间，1.0.2 成了最久没用的
    await s.get('acme.one', '1.0.1')
    touch('1.0.1', 1000)
    await s.get('acme.one', '1.0.4')
    expect(list(dir)).toEqual(['acme.one@1.0.1.png', 'acme.one@1.0.3.png', 'acme.one@1.0.4.png'])
  })

  it('remove 删掉 <id>@* 并清掉 404 记录', async () => {
    const { s, dir } = store(async () => reply(PNG, 'image/png'))
    await s.get('acme.one', '1.0.0')
    await s.get('acme.one', '2.0.0')
    await s.get('acme.two', '1.0.0')
    await s.remove('acme.one')
    expect(list(dir)).toEqual(['acme.two@1.0.0.png'])
  })
})

describe('store-icon 协议响应', () => {
  const icons = (kind: 'ok' | 'missing' | 'bad' | 'failed') =>
    ({
      get: vi.fn(async () => (kind === 'ok' ? { kind, icon: { mime: 'image/png', bytes: PNG } } : { kind })),
      remove: vi.fn(),
    }) as never

  it('成功：content-type、nosniff、CSP', async () => {
    const res = await storeIconResponse(new URL('pixelsky-ext://store-icon/acme.one/1.0.0'), icons('ok'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('路径必须正好是 <id>/<version>', async () => {
    for (const u of [
      'pixelsky-ext://store-icon/acme.one',
      'pixelsky-ext://store-icon/a/b/c',
      'pixelsky-ext://store-icon/',
    ]) {
      expect((await storeIconResponse(new URL(u), icons('ok'))).status, u).toBe(400)
    }
  })

  it('状态码：missing 404、bad 400、failed 502', async () => {
    const u = new URL('pixelsky-ext://store-icon/acme.one/1.0.0')
    expect((await storeIconResponse(u, icons('missing'))).status).toBe(404)
    expect((await storeIconResponse(u, icons('bad'))).status).toBe(400)
    expect((await storeIconResponse(u, icons('failed'))).status).toBe(502)
  })
})

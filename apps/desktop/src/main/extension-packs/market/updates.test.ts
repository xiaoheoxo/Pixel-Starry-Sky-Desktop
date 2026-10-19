import { describe, expect, it, vi } from 'vitest'
import type { ExtPackInfo } from '@pixelsky/protocol'
import { StoreError } from './api'
import type { StoreKey } from './keys'
import { AUTO_CHECK_INTERVAL_MS, createUpdates, type UpdatesDeps } from './updates'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('../../account/account', () => ({ baseUrl: () => 'http://127.0.0.1:9', extensionsFetch: vi.fn() }))

const SITE = 'https://cloud.test'

function pack(id: string, version: string, over: Partial<ExtPackInfo> = {}): ExtPackInfo {
  return {
    key: `s-${id}`,
    id,
    source: 'store',
    enabled: true,
    live: true,
    store: { version, installedAt: 1, sha256: 'a'.repeat(64), keyId: 'k', site: SITE },
    ...over,
  } as ExtPackInfo
}

interface DetailSpec {
  version?: string
  engines?: string
  status?: number
  /** 这个版本的签名钥匙 id（详情的 latest / versions 里） */
  keyId?: string
}
function setup(packs: ExtPackInfo[], specs: Record<string, DetailSpec>, over: Partial<UpdatesDeps> = {}) {
  const calls: Array<{ id: string; opts: unknown }> = []
  let inflight = 0
  let peak = 0
  const gate: { wait: Promise<void> | null } = { wait: null }
  const detail = vi.fn(async (id: string, opts?: unknown) => {
    calls.push({ id, opts })
    inflight++
    peak = Math.max(peak, inflight)
    try {
      if (gate.wait) await gate.wait
      else await new Promise(resolve => setTimeout(resolve, 1))
      const spec = specs[id]
      if (!spec) throw new StoreError('x', 'not_found', 404, 'extstore.notFound')
      if (spec.status) throw new StoreError('x', 'internal', spec.status, 'extstore.api.status')
      return {
        extension: { id, version: spec.version },
        ...(spec.keyId && {
          latest: { version: spec.version, keyId: spec.keyId },
          versions: [{ version: spec.version, keyId: spec.keyId }],
        }),
        manifest: spec.engines ? { engines: { pixelsky: spec.engines } } : null,
      } as never
    } finally {
      inflight--
    }
  })
  let clock = 1_000_000
  const changes = vi.fn()
  const updates = createUpdates({
    api: { detail },
    site: () => SITE,
    packs: () => packs,
    appVersion: '0.4.1-beta',
    blocked: () => null,
    now: () => clock,
    onChange: changes,
    log: () => undefined,
    ...over,
  })
  return { updates, detail, calls, changes, gate, peak: () => peak, advance: (ms: number) => (clock += ms) }
}

describe('checkUpdates', () => {
  it('有新版本：给 latest；没有更新、比本机低（没被停用）、404、详情出错都不算', async () => {
    const s = setup(
      [
        pack('acme.up', '1.0.0'),
        pack('acme.same', '1.0.0'),
        pack('acme.old', '2.0.0'),
        pack('acme.gone', '1.0.0'),
        pack('acme.err', '1.0.0'),
      ],
      {
        'acme.up': { version: '1.2.0' },
        'acme.same': { version: '1.0.0' },
        'acme.old': { version: '1.0.0' },
        'acme.err': { status: 500, version: '9.0.0' },
      },
    )
    expect(await s.updates.check()).toEqual({ 'acme.up': { latest: '1.2.0', engineOk: true } })
    expect(s.updates.last()).toEqual({ 'acme.up': { latest: '1.2.0', engineOk: true } })
  })

  it('每次取详情都是 { fresh: true }', async () => {
    const s = setup([pack('acme.a', '1.0.0'), pack('acme.b', '1.0.0')], {
      'acme.a': { version: '1.1.0' },
      'acme.b': { version: '1.1.0' },
    })
    await s.updates.check()
    expect(s.calls).toHaveLength(2)
    for (const c of s.calls) expect(c.opts).toEqual({ fresh: true })
  })

  it('新版本要求更高的像素星空：engineOk:false，带 engineNeed', async () => {
    const s = setup([pack('acme.a', '1.0.0')], { 'acme.a': { version: '1.1.0', engines: '>=9.0.0' } })
    expect(await s.updates.check()).toEqual({ 'acme.a': { latest: '1.1.0', engineOk: false, engineNeed: '9.0.0' } })
  })

  it('满足版本要求时 engineOk:true，没有 engineNeed', async () => {
    const s = setup([pack('acme.a', '1.0.0')], { 'acme.a': { version: '1.1.0', engines: '>=0.4.0' } })
    expect(await s.updates.check()).toEqual({ 'acme.a': { latest: '1.1.0', engineOk: true } })
  })

  it('只查当前站点装的商店扩展：别的站点、内置、文件夹都不查', async () => {
    const other = pack('acme.other', '1.0.0')
    other.store!.site = 'https://another.test'
    const s = setup(
      [
        other,
        pack('acme.mine', '1.0.0'),
        pack('acme.builtin', '1.0.0', { source: 'builtin', store: undefined }),
        pack('acme.folder', '1.0.0', { source: 'folder', store: undefined }),
      ],
      { 'acme.mine': { version: '1.1.0' } },
    )
    expect(Object.keys(await s.updates.check())).toEqual(['acme.mine'])
    expect(s.calls.map(c => c.id)).toEqual(['acme.mine'])
  })

  it('本机这版被停用、商店里最新退回到更早的可用版本：给 rollbackTo；那个版本也在名单里就不给', async () => {
    const blocked = pack('acme.bad', '1.1.0', { blocked: { reason: '含恶意代码', at: 'now' }, live: false })
    const s = setup([blocked], { 'acme.bad': { version: '1.0.0' } })
    expect(await s.updates.check()).toEqual({ 'acme.bad': { latest: '1.0.0', engineOk: true, rollbackTo: '1.0.0' } })
    const s2 = setup([blocked], { 'acme.bad': { version: '1.0.0' } }, { blocked: () => ({ reason: 'x' }) })
    expect(await s2.updates.check()).toEqual({})
    // 没被停用、商店版本比本机低：不换回
    const s3 = setup([pack('acme.bad', '1.1.0')], { 'acme.bad': { version: '1.0.0' } })
    expect(await s3.updates.check()).toEqual({})
  })

  it('换回的那个版本是用已作废的钥匙签的：不给 rollbackTo；钥匙还能用就照给', async () => {
    const blocked = pack('acme.bad', '1.1.0', { blocked: { reason: '含恶意代码', at: 'now' }, live: false })
    const key = (keyId: string, status: StoreKey['status']): StoreKey => ({
      keyId,
      publicKey: 'x',
      sites: [SITE],
      status,
    })
    const keys = {
      table: [key('dead0001', 'revoked'), key('old00001', 'verifyOnly')],
      dev: { packaged: true, value: undefined },
    }
    const s = setup([blocked], { 'acme.bad': { version: '1.0.0', keyId: 'dead0001' } }, { keys })
    expect(await s.updates.check()).toEqual({})
    const s2 = setup([blocked], { 'acme.bad': { version: '1.0.0', keyId: 'old00001' } }, { keys })
    expect(await s2.updates.check()).toEqual({ 'acme.bad': { latest: '1.0.0', engineOk: true, rollbackTo: '1.0.0' } })
  })

  it('同时在飞的请求不超过 4 个', async () => {
    const ids = Array.from({ length: 10 }, (_, n) => `acme.p${n}`)
    const s = setup(
      ids.map(id => pack(id, '1.0.0')),
      Object.fromEntries(ids.map(id => [id, { version: '1.1.0' }])),
    )
    const out = await s.updates.check()
    expect(Object.keys(out)).toHaveLength(10)
    expect(s.peak()).toBe(4)
  })

  it('同时多次调用只发一轮', async () => {
    const s = setup([pack('acme.a', '1.0.0')], { 'acme.a': { version: '1.1.0' } })
    const [a, b] = [s.updates.check(), s.updates.check()]
    expect(b).toBe(a)
    await a
    expect(s.detail).toHaveBeenCalledTimes(1)
  })

  it('10 分钟节流：打开页面的自动检查（maxAgeMs）在 10 分钟内直接回上次结果，点「检查更新」立刻查', async () => {
    const s = setup([pack('acme.a', '1.0.0')], { 'acme.a': { version: '1.1.0' } })
    await s.updates.check({ maxAgeMs: AUTO_CHECK_INTERVAL_MS })
    expect(s.detail).toHaveBeenCalledTimes(1)
    s.advance(9 * 60_000)
    await s.updates.check({ maxAgeMs: AUTO_CHECK_INTERVAL_MS })
    expect(s.detail).toHaveBeenCalledTimes(1)
    await s.updates.check() // 手动：不看间隔
    expect(s.detail).toHaveBeenCalledTimes(2)
    s.advance(AUTO_CHECK_INTERVAL_MS + 1)
    await s.updates.check({ maxAgeMs: AUTO_CHECK_INTERVAL_MS })
    expect(s.detail).toHaveBeenCalledTimes(3)
  })

  it('结果有变化才通知', async () => {
    const s = setup([pack('acme.a', '1.0.0')], { 'acme.a': { version: '1.1.0' } })
    await s.updates.check()
    expect(s.changes).toHaveBeenCalledTimes(1)
    await s.updates.check()
    expect(s.changes).toHaveBeenCalledTimes(1)
  })
})

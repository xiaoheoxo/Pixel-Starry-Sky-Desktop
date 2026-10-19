import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCodedError } from '@pixelsky/protocol'
import type { ExtPackFiles } from '@pixelsky/protocol'
import { readPackZip } from '@pixelsky/extension-cli/zip'
import { cleanTemp, tempDir } from '../testing'
import { badPathReason, unpackPack } from './unpack'

afterEach(cleanTemp)

const enc = new TextEncoder()

interface Item {
  path: string
  text?: string
  kind?: 'file' | 'symlink'
}
function fake(items: Item[]): { src: ExtPackFiles; read: ReturnType<typeof vi.fn> } {
  const map = new Map(items.map(i => [i.path, i]))
  const read = vi.fn((path: string) => {
    const i = map.get(path)
    return i && i.kind !== 'symlink' ? enc.encode(i.text ?? 'x') : null
  })
  return {
    read,
    src: {
      entries: items.map(i => ({ path: i.path, size: (i.text ?? 'x').length, kind: i.kind ?? 'file' })),
      truncated: false,
      stat: () => 1,
      read,
    },
  }
}

const files = (dir: string, base = dir): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory()
      ? files(join(dir, d.name), base)
      : [
          join(dir, d.name)
            .slice(base.length + 1)
            .replace(/\\/g, '/'),
        ],
  )

async function codeOf(p: Promise<unknown>): Promise<{ code?: string; params?: unknown }> {
  try {
    await p
  } catch (e) {
    return parseCodedError((e as Error).message) ?? {}
  }
  throw new Error('expected rejection')
}

const leftovers = (store: string): string[] => (existsSync(join(store, '.tmp')) ? readdirSync(join(store, '.tmp')) : [])

describe('unpackPack', () => {
  it('写 json / md / png / svg / txt / LICENSE*，保留子目录', async () => {
    const store = tempDir()
    const { src } = fake([
      { path: 'pixelsky-extension.json', text: '{}' },
      { path: 'icons/a.svg', text: '<svg/>' },
      { path: 'README.md' },
      { path: 'LICENSE' },
      { path: 'LICENSE-MIT' },
      { path: 'a/b/c.txt', text: 'hi' },
    ])
    const out = await unpackPack(src, store)
    expect(out.dir.startsWith(join(store, '.tmp'))).toBe(true)
    expect(out.files).toBe(6)
    expect(files(out.dir).sort()).toEqual(
      ['LICENSE', 'LICENSE-MIT', 'README.md', 'a/b/c.txt', 'icons/a.svg', 'pixelsky-extension.json'].sort(),
    )
    expect(readFileSync(join(out.dir, 'a/b/c.txt'), 'utf8')).toBe('hi')
  })

  it('samples/ 和白名单外的类型不写，也不读', async () => {
    const store = tempDir()
    const { src, read } = fake([
      { path: 'pixelsky-extension.json' },
      { path: 'samples/a.url' },
      { path: 'samples/b.json' },
      { path: 'tool.exe' },
      { path: 'x.lnk' },
    ])
    const out = await unpackPack(src, store)
    expect(files(out.dir)).toEqual(['pixelsky-extension.json'])
    expect(read.mock.calls.map(c => c[0])).toEqual(['pixelsky-extension.json'])
  })

  it('符号链接条目不写、不读（假来源）', async () => {
    const store = tempDir()
    const { src, read } = fake([{ path: 'pixelsky-extension.json' }, { path: 'icons/a.svg', kind: 'symlink' }])
    const out = await unpackPack(src, store)
    expect(files(out.dir)).toEqual(['pixelsky-extension.json'])
    expect(existsSync(join(out.dir, 'icons'))).toBe(false)
    expect(read.mock.calls.map(c => c[0])).toEqual(['pixelsky-extension.json'])
  })

  it('符号链接条目不写（真 zip 经 readPackZip）', async () => {
    const store = tempDir()
    const zip = zipSync({
      'pixelsky-extension.json': enc.encode('{}'),
      'icons/a.svg': [enc.encode('../../secret.txt'), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
    })
    const src = readPackZip(zip)
    expect(src.entries.find(e => e.path === 'icons/a.svg')?.kind).toBe('symlink')
    const out = await unpackPack(src, store)
    expect(files(out.dir)).toEqual(['pixelsky-extension.json'])
  })

  const BAD = [
    'a:b.json',
    'icons/x:stream.svg',
    'CON',
    'nul.txt',
    'dir/aux/a.json',
    'COM1.json',
    'x.json.',
    'x.json ',
    'dir./a.json',
    'dir /a.json',
    '../x.json',
    'a/../b.json',
    '/abs.json',
    'a\\b.json',
    'a//b.json',
    './a.json',
    `${'a'.repeat(130)}.json`,
  ]
  for (const bad of BAD) {
    it(`整包拒绝：${JSON.stringify(bad)}`, async () => {
      const store = tempDir()
      const { src } = fake([{ path: 'pixelsky-extension.json' }, { path: bad }])
      expect((await codeOf(unpackPack(src, store))).code).toBe('extstore.badFiles')
      expect(leftovers(store)).toEqual([])
    })
  }

  it('只有大小写不同的两个文件整包拒绝，参数带文件名', async () => {
    const store = tempDir()
    const { src } = fake([{ path: 'a/Readme.md' }, { path: 'a/README.md' }])
    const e = await codeOf(unpackPack(src, store))
    expect(e.code).toBe('extstore.badFiles')
    expect(JSON.stringify(e.params)).toContain('README.md')
  })

  it('危险的文件在 samples/ 里也整包拒绝', async () => {
    const store = tempDir()
    const { src } = fake([{ path: 'samples/a:b.txt' }])
    expect((await codeOf(unpackPack(src, store))).code).toBe('extstore.badFiles')
  })

  it('读不到内容就整包失败并清掉临时目录', async () => {
    const store = tempDir()
    const { src } = fake([{ path: 'a.json' }])
    src.read = () => null
    expect((await codeOf(unpackPack(src, store))).code).toBe('extstore.badFiles')
    expect(leftovers(store)).toEqual([])
  })

  it('已存在的文件不覆盖（wx）：同一路径出现两次时第二次写失败', async () => {
    const store = tempDir()
    const { src } = fake([
      { path: 'a.json', text: 'one' },
      { path: 'a.json', text: 'two' },
    ])
    await expect(unpackPack(src, store)).rejects.toThrow()
    expect(leftovers(store)).toEqual([])
  })

  it('每次解到不同的随机目录', async () => {
    const store = tempDir()
    const { src } = fake([{ path: 'a.json' }])
    const a = await unpackPack(src, store)
    const b = await unpackPack(src, store)
    expect(a.dir).not.toBe(b.dir)
  })
})

describe('unpackPack 重名', () => {
  it('完全相同的路径出现两次：抛 extstore.badFiles，不是裸 EEXIST', async () => {
    const dir = tempDir()
    const { src } = fake([{ path: 'a.json' }, { path: 'a.json' }])
    expect((await codeOf(unpackPack(src, dir))).code).toBe('extstore.badFiles')
  })
  it('NFC 与 NFD 写法的同名路径：抛 extstore.badFiles', async () => {
    const dir = tempDir()
    const { src } = fake([{ path: 'café.json' }, { path: 'café.json' }])
    expect((await codeOf(unpackPack(src, dir))).code).toBe('extstore.badFiles')
  })
})

describe('badPathReason', () => {
  it('正常路径返回 null', () => {
    for (const p of ['a.json', 'icons/a.svg', 'LICENSE', 'a/b-c_d.txt', 'console.json', 'com.json']) {
      expect(badPathReason(p), p).toBeNull()
    }
  })
  it('保留名带扩展名也算，conx 不算', () => {
    expect(badPathReason('con.json')).toBe('reserved name')
    expect(badPathReason('LPT9.txt')).toBe('reserved name')
    expect(badPathReason('conx.json')).toBeNull()
  })
  it('Windows 非法字符、上标数字保留名、CONIN$、保留名后带空格都拒绝', () => {
    for (const p of [
      'a*b.json',
      'a?b.json',
      'a"b.json',
      'a<b.json',
      'a>b.json',
      'a|b.json',
      'COM¹.txt',
      'conin$.txt',
      'nul .json',
    ]) {
      expect(badPathReason(p), p).not.toBeNull()
    }
  })
})

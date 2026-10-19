import { describe, expect, it } from 'vitest'
import { checkPack, dedupeIssues, readerFromFiles } from './check'
import { zipIssue } from './codes'
import type { ExtPackFiles, ExtPackIssue } from './types'
import { EXT_LIMITS, EXT_MANIFEST } from './types'

// 协议包没有 DOM / node 类型
declare class TextEncoder {
  encode(s: string): Uint8Array
}
const enc = (s: string) => new TextEncoder().encode(s)

/** 内存来源：和文件夹来源一样，stat / read 只认普通文件 */
function mem(
  files: Record<string, string | Uint8Array>,
  extra: { symlinks?: string[]; truncated?: boolean; pre?: ExtPackIssue[]; throwOn?: string } = {},
): ExtPackFiles {
  const bytes = (p: string) => (typeof files[p] === 'string' ? enc(files[p] as string) : (files[p] as Uint8Array))
  const entries = [
    ...Object.keys(files).map(path => ({ path, size: bytes(path).length, kind: 'file' as const })),
    ...(extra.symlinks ?? []).map(path => ({ path, size: 0, kind: 'symlink' as const })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    entries,
    truncated: extra.truncated ?? false,
    stat: p => (p in files ? bytes(p).length : null),
    read: (p, max) => {
      if (p === extra.throwOn) throw new Error('boom')
      return p in files ? bytes(p).slice(0, max) : null
    },
    preIssues: extra.pre,
  }
}

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'acme.demo',
  name: '演示',
  version: '1.0.0',
  publisher: 'acme',
  description: '一个演示扩展',
  license: 'MIT',
  engines: { pixelsky: '>=0.4.0' },
  contributes: { snippets: [{ language: 'go', path: 's.json' }] },
  main: null,
  permissions: [],
  price: null,
  ...over,
})
const good = (over: Record<string, unknown> = {}): Record<string, string | Uint8Array> => ({
  [EXT_MANIFEST]: JSON.stringify(manifest(over)),
  's.json': '{ "x": { "prefix": ["x"], "body": ["x"] } }',
  'README.md': '# demo',
  LICENSE: 'MIT',
})
const grammarManifest = (n = 1) =>
  manifest({
    contributes: {
      grammars: Array.from({ length: n }, (_, i) => ({
        language: `lang${i}`,
        extensions: [`.l${i}`],
        scopeName: `source.l${i}`,
        path: `g${i}.tmLanguage.json`,
        samples: ['samples/a.txt'],
      })),
    },
  })
const grammarFiles = (n = 1): Record<string, string> => ({
  [EXT_MANIFEST]: JSON.stringify(grammarManifest(n)),
  'README.md': '# demo',
  LICENSE: 'MIT',
  'samples/a.txt': 'x\n',
  ...Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`g${i}.tmLanguage.json`, '{"scopeName":"source.l' + i + '","patterns":[]}']),
  ),
})
const codes = (issues: ExtPackIssue[]) => issues.map(i => i.code)
const APP = '0.4.1'
const dev = { source: 'folder' as const, appVersion: APP }

describe('checkPack 清单', () => {
  it('正常的包：ok，没有问题，文件表只含普通文件', () => {
    const r = checkPack(mem(good(), { symlinks: [] }), dev)
    expect(r.issues).toEqual([])
    expect(r.status).toBe('ok')
    expect(r.id).toBe('acme.demo')
    expect([...r.files.keys()].sort()).toEqual(['LICENSE', 'README.md', 's.json', EXT_MANIFEST].sort())
  })
  it('没有清单：manifest.missing，到此为止', () => {
    const r = checkPack(mem({ 'README.md': 'x' }), dev)
    expect(codes(r.issues)).toEqual(['manifest.missing'])
    expect(r.status).toBe('error')
    expect(r.id).toBeNull()
    expect(r.files.size).toBe(0)
  })
  it('清单是符号链接：stat 为 null，当作没有清单', () => {
    const src = mem({ 'README.md': 'x' }, { symlinks: [EXT_MANIFEST] })
    expect(codes(checkPack(src, dev).issues)).toEqual(['manifest.missing'])
  })
  it('清单超过 256 KB：manifest.parse', () => {
    const r = checkPack(mem({ [EXT_MANIFEST]: ' '.repeat(EXT_LIMITS.manifestBytes + 1) }), dev)
    expect(codes(r.issues)).toEqual(['manifest.parse'])
    expect(r.issues[0].message.en).toContain('256 KB')
  })
  it('清单带 BOM：照常读取', () => {
    const files = good()
    files[EXT_MANIFEST] = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(JSON.stringify(manifest()))])
    // 清单本身带 BOM 会被读出来，只是文件检查会提醒去掉
    const r = checkPack(mem(files), dev)
    expect(r.id).toBe('acme.demo')
    expect(codes(r.issues)).toEqual(['files.encoding'])
  })
  it('清单不是 UTF-8：manifest.parse', () => {
    const r = checkPack(mem({ [EXT_MANIFEST]: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }), dev)
    expect(codes(r.issues)).toEqual(['manifest.parse'])
    expect(r.issues[0].message.en).toContain('UTF-8')
  })
  it('清单带注释：只有一条 manifest.jsonc（file 范围，上传拒绝），其余照常检查', () => {
    const files = good()
    files[EXT_MANIFEST] = `// 注释\n${JSON.stringify(manifest())}`
    const r = checkPack(mem(files), dev)
    expect(codes(r.issues)).toEqual(['manifest.jsonc'])
    expect(r.issues[0]).toMatchObject({ severity: 'warning', scope: 'file', path: EXT_MANIFEST, upload: 'reject' })
    expect(r.status).toBe('warning')
  })
  it('清单读不懂：manifest.parse，带行列', () => {
    const r = checkPack(mem({ [EXT_MANIFEST]: '{\n  "id" 1\n}' }), dev)
    expect(codes(r.issues)).toEqual(['manifest.parse'])
    expect(r.issues[0].loc?.file).toBe(EXT_MANIFEST)
    expect(r.issues[0].loc).toMatchObject({ line: 2, column: 8 })
  })
  it('清单读不出来的先于符号链接 / 扫描上限：只报清单的问题', () => {
    const r = checkPack(mem({ [EXT_MANIFEST]: '{' }, { symlinks: ['x'], truncated: true }), dev)
    expect(codes(r.issues)).toEqual(['manifest.parse'])
  })
})

describe('checkPack 文件表', () => {
  it('符号链接：files.symlink（error / file），不进文件表', () => {
    const r = checkPack(mem(good(), { symlinks: ['link.json'] }), dev)
    expect(r.issues.find(i => i.code === 'files.symlink')).toMatchObject({
      severity: 'error',
      scope: 'file',
      path: 'link.json',
    })
    expect(r.files.has('link.json')).toBe(false)
    expect(r.status).toBe('warning')
  })
  it('超出扫描上限：files.scanLimit，扩展不加载，后面的检查不做', () => {
    const r = checkPack(mem(good(), { truncated: true }), dev)
    expect(codes(r.issues)).toEqual(['files.scanLimit'])
    expect(r.status).toBe('error')
  })
  it('文件夹来源扫 svg 内容，大于 32 KB 的也扫', () => {
    const m = manifest({ icon: 'icon.svg' })
    const bad = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>' + ' '.repeat(40 * 1024) + '</svg>'
    const files = { ...good(), [EXT_MANIFEST]: JSON.stringify(m), 'icon.svg': bad }
    expect(EXT_LIMITS.iconBytes).toBeLessThan(bad.length)
    const r = checkPack(mem(files), dev)
    expect(r.issues.find(i => i.code === 'svg.unsafe')).toMatchObject({ path: 'icon.svg', scope: 'file' })
  })
  it('scanSvg：默认按来源（store 扫、builtin 不扫），显式传值优先', () => {
    const bad = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const files = { ...good({ icon: 'icon.svg' }), 'icon.svg': bad }
    const has = (opts: Parameters<typeof checkPack>[1]) =>
      codes(checkPack(mem(files), opts).issues).includes('svg.unsafe')
    expect(has({ source: 'store', appVersion: APP })).toBe(true)
    expect(has({ source: 'store', appVersion: APP, scanSvg: false })).toBe(false) // 启动时加载商店扩展：安装时扫过
    expect(has({ source: 'folder', appVersion: APP, scanSvg: false })).toBe(false)
    expect(has({ source: 'builtin', appVersion: APP })).toBe(false)
    expect(has({ source: 'builtin', appVersion: APP, scanSvg: true })).toBe(true)
  })
  it('内置来源不扫 svg，也只留 error', () => {
    const bad = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const files = { ...good({ icon: 'icon.svg' }), 'icon.svg': bad, '.hidden.json': '{}' }
    const r = checkPack(mem(files), { source: 'builtin', appVersion: APP })
    expect(codes(r.issues)).not.toContain('svg.unsafe')
    expect(r.issues.every(i => i.severity === 'error')).toBe(true)
  })
})

describe('checkPack 内容', () => {
  it('停用的贡献进 inactive', () => {
    const files = good()
    delete files['s.json']
    const r = checkPack(mem(files), dev)
    expect(codes(r.issues)).toContain('snippets.file')
    expect(r.inactive).toEqual({ snippets: [0] })
  })
  it('技能名字和说明从 SKILL.md 读出来', () => {
    const files = {
      ...good({ contributes: { skills: [{ path: 'skills/a' }] } }),
      'skills/a/SKILL.md': '---\nname: demo-skill\ndescription: "做点事"\n---\n正文',
    }
    const r = checkPack(mem(files), dev)
    expect(r.skills).toEqual([{ name: 'demo-skill', description: '做点事', engines: ['claude', 'codex'], index: 0 }])
  })
  it('读文件时抛错也不会抛出：内容检查记成 validate.internal，清单读取记成 pack.validate', () => {
    expect(codes(checkPack(mem(good(), { throwOn: 's.json' }), dev).issues)).toContain('validate.internal')
    const r = checkPack(mem(good(), { throwOn: EXT_MANIFEST }), dev)
    expect(codes(r.issues)).toEqual(['pack.validate'])
    expect(r.status).toBe('error')
  })
  it('appVersion 不传（上传级别）：不报 manifest.engineUnmet；传了才报', () => {
    const files = good({ engines: { pixelsky: '>=9.0.0' } })
    expect(codes(checkPack(mem(files), { source: 'folder' }).issues)).toEqual([])
    expect(codes(checkPack(mem(files), dev).issues)).toEqual(['manifest.engineUnmet'])
  })
})

describe('checkPack 语法引擎', () => {
  it('没给 grammar：有语法就报一条 grammar.regexUnchecked（warning / pack / hint）', () => {
    const r = checkPack(mem(grammarFiles(2)), dev)
    expect(codes(r.issues)).toEqual(['grammar.regexUnchecked'])
    expect(r.issues[0]).toMatchObject({ severity: 'warning', scope: 'pack', upload: 'hint' })
  })
  it('没有语法就不报', () => {
    expect(codes(checkPack(mem(good()), dev).issues)).toEqual([])
  })
  it('grammar: [] 表示引擎跑过且没问题：不报', () => {
    expect(checkPack(mem(grammarFiles()), { ...dev, grammar: [] }).issues).toEqual([])
  })
  it('引擎的 error / contribution 问题让那条语法停用', () => {
    const issue: ExtPackIssue = {
      severity: 'error',
      scope: 'contribution',
      code: 'grammar.regex',
      message: { zh: 'x', en: 'x' },
      contribution: { kind: 'grammars', index: 1 },
      upload: 'reject',
    }
    const r = checkPack(mem(grammarFiles(2)), { source: 'folder', grammar: [issue] })
    expect(codes(r.issues)).toEqual(['grammar.regex'])
    expect(r.inactive).toEqual({ grammars: [1] })
    expect(r.status).toBe('warning')
  })
})

describe('checkPack zip 层的问题', () => {
  it('致命的 zip 问题：到此为止，哪怕有清单', () => {
    for (const code of ['zip.invalid', 'zip.tooLarge', 'zip.nested'] as const) {
      const r = checkPack(mem(good(), { pre: [zipIssue(code, { dir: 'x/' })] }), { source: 'folder' })
      expect(codes(r.issues)).toEqual([code])
      expect(r.status).toBe('error')
      expect(r.files.size).toBe(0)
    }
  })
  it('非致命的 zip 问题放在最前面，其余照常检查', () => {
    const files = good()
    delete files['s.json']
    const r = checkPack(mem(files, { pre: [zipIssue('zip.entryName', { path: '../x' })] }), { source: 'folder' })
    expect(codes(r.issues).slice(0, 2)).toEqual(['zip.entryName', 'snippets.file'])
    expect(r.status).toBe('error')
  })
  it('zip 来源也一样：没有清单 + zip.corrupt 都报', () => {
    const r = checkPack(mem({ 'README.md': 'x' }, { pre: [zipIssue('zip.corrupt', { path: 'a.json' })] }), {
      source: 'folder',
    })
    expect(codes(r.issues)).toEqual(['zip.corrupt', 'manifest.missing'])
  })
})

describe('dedupeIssues / readerFromFiles', () => {
  it('同一个代码 / 路径 / 说明只留第一条', () => {
    const a = zipIssue('zip.duplicate', { path: 'a' })
    const b = zipIssue('zip.duplicate', { path: 'b' })
    expect(dedupeIssues([a, { ...a }, b])).toEqual([a, b])
  })
  it('readText：超过 2 MB、不是 UTF-8、不在文件表里返回 null；BOM 去掉；readBytes 封顶', () => {
    const big = new Uint8Array(EXT_LIMITS.fileBytes + 1)
    const store: Record<string, Uint8Array> = {
      'a.txt': new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]),
      'bad.txt': new Uint8Array([0xff]),
      'big.txt': big,
    }
    const files = new Map(Object.entries(store).map(([k, v]) => [k, v.length]))
    const reader = readerFromFiles(files, (p, max) => store[p]?.slice(0, max) ?? null)
    expect(reader.readText('a.txt')).toBe('hi')
    expect(reader.readText('bad.txt')).toBeNull()
    expect(reader.readText('big.txt')).toBeNull()
    expect(reader.readText('none.txt')).toBeNull()
    expect(reader.readBytes('big.txt', Infinity)?.length).toBe(EXT_LIMITS.fileBytes)
    expect(reader.list('a')).toEqual(['a.txt'])
  })
})

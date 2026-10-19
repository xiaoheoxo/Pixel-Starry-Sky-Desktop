import { describe, expect, it } from 'vitest'
import type { ExtPackFileEntry, ExtPackIssue, ExtPackManifest, ExtPackReader } from './types'
import {
  forSource,
  inactiveContributions,
  isExtId,
  isExtVersion,
  isPublisherName,
  loaderIssue,
  packStatus,
  validateContributions,
  validateManifest,
  validatePackFiles,
} from './validate'

// 协议包没有 DOM / node 类型
declare class TextEncoder {
  encode(s: string): Uint8Array
}
declare class TextDecoder {
  constructor(label: string, opts: { fatal: boolean })
  decode(b: Uint8Array): string
}

// ---- 测试用的假读取器：Map<路径, 文本或字节> ----
const enc = (s: string) => new TextEncoder().encode(s)
function fakeReader(files: Record<string, string | Uint8Array>): ExtPackReader {
  const bytes = (p: string) => (typeof files[p] === 'string' ? enc(files[p] as string) : (files[p] as Uint8Array))
  return {
    exists: p => p in files,
    size: p => (p in files ? bytes(p).length : null),
    readText: p => {
      if (!(p in files)) return null
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes(p)).replace(/^\uFEFF/, '')
      } catch {
        return null
      }
    },
    readBytes: (p, max) => (p in files ? bytes(p).slice(0, max) : null),
    list: prefix => Object.keys(files).filter(p => p.startsWith(prefix)),
  }
}
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}

const APP = '0.4.0'
const base = (over: Record<string, unknown> = {}) => ({
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
const manifestIssues = (raw: unknown, source: 'folder' | 'builtin' = 'folder') =>
  validateManifest(raw, { appVersion: APP, source }).issues
const codesOf = (issues: ExtPackIssue[]) => issues.map(i => i.code)
const find = (issues: ExtPackIssue[], code: string) => issues.filter(i => i.code === code)

/** dotenv 示例清单（inline 拷贝） */
const dotenv = {
  $schema: '../../schema/pixelsky-extension.schema.json',
  id: 'pixelsky.dotenv',
  name: '.env 文件支持',
  version: '1.0.0',
  publisher: 'pixelsky',
  description: '.env 文件的语法高亮、注释切换和常用片段',
  keywords: ['env', 'dotenv', '配置'],
  license: 'MIT',
  repository: 'https://github.com/pixelsky/ext-dotenv',
  homepage: null,
  engines: { pixelsky: '>=0.4.0' },
  l10n: {
    en: { name: '.env Support', description: 'Syntax highlighting, comment toggling and snippets for .env files' },
  },
  contributes: {
    grammars: [
      {
        language: 'dotenv',
        aliases: ['Dotenv', '.env'],
        extensions: ['.env'],
        filenames: ['.env', '.env.local'],
        filenamePatterns: ['.env.*'],
        scopeName: 'source.dotenv',
        path: 'syntaxes/dotenv.tmLanguage.json',
        configuration: 'language-configuration.json',
        samples: ['samples/example.env'],
      },
    ],
    snippets: [{ language: 'dotenv', path: 'snippets/dotenv.json' }],
  },
  main: null,
  permissions: [],
  price: null,
}
const dotenvFiles: Record<string, string> = {
  'pixelsky-extension.json': JSON.stringify(dotenv),
  'README.md': '# dotenv',
  LICENSE: 'MIT',
  'syntaxes/dotenv.tmLanguage.json': JSON.stringify({
    scopeName: 'source.dotenv',
    patterns: [{ include: '#x' }],
    repository: {},
  }),
  'language-configuration.json': '{ // 注释\n "comments": { "lineComment": "#" }, "brackets": [["(", ")"]], }',
  'snippets/dotenv.json': '{ "数据库": { "prefix": ["db"], "body": ["DATABASE_URL=$1", "$0"] } }',
  'samples/example.env': 'A=1\n',
}

// ---------------------------------------------------------------------------
describe('validateManifest', () => {
  it('dotenv 示例：零错误、零警告', () => {
    const r = validateManifest(dotenv, { appVersion: APP, source: 'folder' })
    expect(r.issues).toEqual([])
    expect(r.manifest?.id).toBe('pixelsky.dotenv')
  })
  it('M1 传原文：JSON 坏了报 manifest.parse，带注释给 manifest.jsonc 并继续', () => {
    const bad = validateManifest('{ nope', { appVersion: APP, source: 'folder' })
    expect(bad.manifest).toBeNull()
    expect(find(bad.issues, 'manifest.parse')[0]).toMatchObject({ severity: 'error', scope: 'pack' })
    const lenient = validateManifest(`// c\n${JSON.stringify(base())}`, { appVersion: APP, source: 'folder' })
    expect(codesOf(lenient.issues)).toEqual(['manifest.jsonc'])
    expect(lenient.issues[0]).toMatchObject({ scope: 'file', path: 'pixelsky-extension.json', upload: 'reject' })
    expect(lenient.manifest?.id).toBe('acme.demo')
  })
  it('M2 不是对象', () => {
    for (const raw of [null, [], 3, 'x']) {
      const r = validateManifest(raw === 'x' ? '"x"' : raw, { appVersion: APP, source: 'folder' })
      expect(r.manifest).toBeNull()
      expect(find(r.issues, 'manifest.notObject')[0]).toMatchObject({ severity: 'error', scope: 'pack' })
    }
  })
  it('M3 id 不合规是 pack 错误', () => {
    for (const id of ['Acme.demo', 'acme', 'a.demo', 'acme.d', '-acme.demo', undefined]) {
      expect(find(manifestIssues(base({ id })), 'manifest.id')[0]).toMatchObject({ severity: 'error', scope: 'pack' })
    }
  })
  it('M4 publisher 和 id 前缀不一致', () => {
    expect(codesOf(manifestIssues(base({ publisher: 'other' })))).toEqual(['manifest.publisherMismatch'])
    expect(codesOf(manifestIssues(base({ publisher: 'A' })))).toContain('manifest.publisherMismatch')
  })
  it('M5 name 长度和「官方」字样（内置不查字样）', () => {
    expect(codesOf(manifestIssues(base({ name: '' })))).toContain('manifest.name')
    expect(codesOf(manifestIssues(base({ name: 'x'.repeat(41) })))).toContain('manifest.name')
    expect(codesOf(manifestIssues(base({ name: '官方 Swift' })))).toContain('manifest.name')
    expect(codesOf(manifestIssues(base({ name: '像素星空图标' })))).toContain('manifest.name')
    expect(manifestIssues(base({ name: '像素星空图标' }), 'builtin')).toEqual([])
  })
  it('M6 M7 版本和说明', () => {
    expect(codesOf(manifestIssues(base({ version: '1.0' })))).toContain('manifest.version')
    expect(codesOf(manifestIssues(base({ version: '1.0.0-beta.1' })))).toEqual([])
    expect(codesOf(manifestIssues(base({ description: '' })))).toContain('manifest.description')
    expect(codesOf(manifestIssues(base({ description: 'x'.repeat(121) })))).toContain('manifest.description')
  })
  it('M8 icon 写法', () => {
    expect(codesOf(manifestIssues(base({ icon: 'a.jpg' })))).toContain('manifest.icon')
    expect(codesOf(manifestIssues(base({ icon: '../a.png' })))).toContain('manifest.icon')
    expect(codesOf(manifestIssues(base({ icon: 'icon.png' })))).toEqual([])
  })
  it('M9 keywords', () => {
    expect(codesOf(manifestIssues(base({ keywords: Array.from({ length: 11 }, (_v, i) => `k${i}`) })))).toContain(
      'manifest.keywords',
    )
    expect(codesOf(manifestIssues(base({ keywords: ['a', 'a'] })))).toContain('manifest.keywords')
    expect(codesOf(manifestIssues(base({ keywords: ['x'.repeat(21)] })))).toContain('manifest.keywords')
  })
  it('M10 M11 license 和网址', () => {
    expect(codesOf(manifestIssues(base({ license: '' })))).toContain('manifest.license')
    expect(codesOf(manifestIssues(base({ repository: 'http://x.com' })))).toContain('manifest.url')
    expect(codesOf(manifestIssues(base({ homepage: 'https://x.com', repository: null })))).toEqual([])
  })
  it('M12 engines：缺失、解析不了、版本不满足', () => {
    expect(codesOf(manifestIssues(base({ engines: undefined })))).toContain('manifest.engines')
    expect(codesOf(manifestIssues(base({ engines: { pixelsky: 'latest' } })))).toContain('manifest.engineRange')
    const unmet = find(manifestIssues(base({ engines: { pixelsky: '>=9.0.0' } })), 'manifest.engineUnmet')[0]
    expect(unmet.severity).toBe('error') // 低于要求版本的软件看不到这个扩展
    expect(unmet.message.zh).toContain('>=9.0.0')
  })
  it('M12 不传 appVersion（上传级别）：不判断版本够不够，写法解析不了仍然报', () => {
    const up = (engine: string) =>
      validateManifest(base({ engines: { pixelsky: engine } }), { source: 'folder' }).issues
    expect(codesOf(up('>=9.0.0'))).toEqual([])
    expect(codesOf(up('latest'))).toContain('manifest.engineRange')
  })
  it('M13 l10n', () => {
    expect(codesOf(manifestIssues(base({ l10n: { en: { name: 'x'.repeat(41) } } })))).toContain('manifest.l10n')
    expect(codesOf(manifestIssues(base({ l10n: { en: { description: 'x'.repeat(161) } } })))).toContain('manifest.l10n')
    expect(codesOf(manifestIssues(base({ l10n: { fr: {} } })))).toContain('manifest.unknownField')
  })
  it('M14 contributes：缺失、全空、不是数组都是 pack 错误；未知键只是警告', () => {
    for (const contributes of [undefined, {}, { grammars: [] }, { grammars: {} }]) {
      expect(find(manifestIssues(base({ contributes })), 'manifest.contributes')[0]).toMatchObject({
        severity: 'error',
        scope: 'pack',
      })
    }
    const unknown = manifestIssues(base({ contributes: { snippets: [{}], commands: [] } }))
    expect(find(unknown, 'manifest.unknownField')[0].severity).toBe('warning')
    expect(find(unknown, 'manifest.contributes')).toEqual([])
  })
  it('M15 main 非 null 是 pack 错误；permissions / price 是警告', () => {
    expect(find(manifestIssues(base({ main: 'x.js' })), 'manifest.main')[0]).toMatchObject({
      severity: 'error',
      scope: 'pack',
    })
    expect(find(manifestIssues(base({ main: undefined })), 'manifest.main')[0].severity).toBe('warning')
    expect(find(manifestIssues(base({ permissions: ['x'] })), 'manifest.permissions')[0].severity).toBe('warning')
    expect(find(manifestIssues(base({ price: 5 })), 'manifest.price')[0].severity).toBe('warning')
  })
  it('M16 顶层未知字段（x- 和 $schema 除外）', () => {
    const issues = manifestIssues(base({ foo: 1, 'x-mine': 2, $schema: 'a' }))
    expect(find(issues, 'manifest.unknownField').map(i => i.path)).toEqual(['foo'])
  })
  it('M16 嵌套对象里的未知字段：engines / l10n.en', () => {
    const issues = manifestIssues(
      base({ engines: { pixelsky: '>=0.4.0', node: '1' }, l10n: { en: { name: 'x', tagline: 'y' } } }),
    )
    expect(
      find(issues, 'manifest.unknownField')
        .map(i => i.path)
        .sort(),
    ).toEqual(['engines.node', 'l10n.en.tagline'])
  })
  it('即使有 pack 错误也返回清单对象（供界面显示），内容不是对象才是 null', () => {
    expect(validateManifest(base({ id: 'bad' }), { appVersion: APP, source: 'folder' }).manifest).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
describe('validatePackFiles', () => {
  const f = (path: string, size = 10, kind: 'file' | 'symlink' = 'file'): ExtPackFileEntry => ({ path, size, kind })
  const good = [f('pixelsky-extension.json'), f('README.md'), f('LICENSE'), f('samples/a.env')]
  const run = (files: ExtPackFileEntry[], m: unknown = null) =>
    validatePackFiles(files, m as ExtPackManifest | null, { source: 'folder' })

  it('正常的包没有问题', () => {
    expect(run(good)).toEqual([])
  })
  it('F1 不允许的类型；samples 下任意扩展名可以；LICENSE.md 可以', () => {
    const issues = run([...good, f('run.sh'), f('a.wasm'), f('samples/x.rb'), f('LICENSE.md')])
    expect(find(issues, 'files.type').map(i => i.path)).toEqual(['run.sh', 'a.wasm'])
  })
  it('F2 隐藏文件（samples 里的除外；.git/ 不再豁免，由来源层跳过）', () => {
    const issues = run([...good, f('.env'), f('a/.hidden/x.json'), f('samples/.env'), f('.git/config')])
    expect(find(issues, 'files.hidden').map(i => i.path)).toEqual(['.env', 'a/.hidden/x.json', '.git/config'])
  })
  it('F3 符号链接不在这里报（由加载器报），也不参与其他检查', () => {
    expect(run([...good, f('link.sh', 5, 'symlink')])).toEqual([])
  })
  it('F4 路径过长、反斜杠、只差大小写', () => {
    const issues = run([...good, f(`${'a/'.repeat(70)}x.json`), f('a\\b.json'), f('Icon.png'), f('icon.png')])
    expect(find(issues, 'files.path')).toHaveLength(3)
  })
  it('F4 路径里有冒号、Windows 保留名、某一段以 . 或空格结尾（上传拒绝）', () => {
    const bad = [
      'a:b.json',
      'docs/a:stream.txt',
      'CON/a.txt',
      'docs/nul.txt',
      'docs/Com1',
      'lpt9.md',
      'docs./a.txt',
      'notes /b.txt',
      'docs/c.txt.',
      'docs/d.txt ',
    ]
    const issues = find(run([...good, ...bad.map(p => f(p))]), 'files.path')
    expect(issues.map(i => i.path).sort()).toEqual([...bad].sort())
    for (const i of issues) expect(i).toMatchObject({ severity: 'warning', scope: 'file', upload: 'reject' })
  })
  it('F4 Windows 非法字符 * ? " < > |、上标数字保留名、CONIN$ / CONOUT$、保留名后带空格（上传拒绝）', () => {
    const bad = [
      'a*b.json',
      'a?b.json',
      'a"b.json',
      'a<b.json',
      'a>b.json',
      'a|b.json',
      'docs/COM¹.txt',
      'docs/com².txt',
      'LPT³.md',
      'conin$.txt',
      'CONOUT$',
      'nul .json',
      'docs/con  .txt',
    ]
    const issues = find(run([...good, ...bad.map(p => f(p))]), 'files.path')
    expect(issues.map(i => i.path).sort()).toEqual([...bad].sort())
    for (const i of issues) expect(i).toMatchObject({ severity: 'warning', scope: 'file', upload: 'reject' })
  })
  it('F4 NFC 与 NFD 写法的同名文件算撞名', () => {
    const issues = find(run([...good, f('café.json'), f('café.json')]), 'files.path')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ upload: 'reject' })
  })
  it('F4 不误伤：名字里只是含有保留名、com / lpt 后面不是一位数字、中间的点和空格', () => {
    const ok = [
      'console.json',
      'con-fig.json',
      'com10.txt',
      'lpt.txt',
      'a b/c d.json',
      'a.b/c.d.json',
      'auxiliary/x.json',
    ]
    expect(find(run([...good, ...ok.map(p => f(p))]), 'files.path')).toEqual([])
  })
  it('F4 同一个文件只算一条：有冒号又以点结尾也各报各的（每条规则一条）', () => {
    expect(find(run([...good, f('a:b.')]), 'files.path')).toHaveLength(2)
  })
  it('F5 超过 2 MB 是 file 错误', () => {
    const i = find(run([...good, f('big.json', 3 * 1024 * 1024)]), 'files.size')[0]
    expect(i).toMatchObject({ severity: 'error', scope: 'file', path: 'big.json' })
  })
  it('F6 文件数（带图标主题放宽到 3000）、总大小、samples 大小', () => {
    const many = Array.from({ length: 501 }, (_v, n) => f(`a/${n}.json`))
    expect(codesOf(run([...good, ...many]))).toContain('files.count')
    const withIcons = { contributes: { iconThemes: [{}] } }
    expect(codesOf(run([...good, ...many], withIcons))).not.toContain('files.count')
    expect(
      codesOf(
        run([
          ...good,
          f('a.json', 1_900_000),
          f('b.json', 1_900_000),
          f('c.json', 1_900_000),
          f('d.json', 1_900_000),
          f('e.json', 1_900_000),
          f('g.json', 1_900_000),
        ]),
      ),
    ).toContain('files.total')
    expect(codesOf(run([...good, f('samples/big.txt', 201 * 1024)]))).toContain('files.samples')
  })
  it('F9 缺 LICENSE / README', () => {
    expect(codesOf(run([f('pixelsky-extension.json')]))).toEqual(['files.license', 'files.readme'])
    expect(run([f('LICENSE.txt'), f('readme.md')])).toEqual([])
  })
  it('同类问题最多列 20 条，多的合成一条', () => {
    const issues = run([...good, ...Array.from({ length: 30 }, (_v, n) => f(`x${n}.sh`))])
    expect(find(issues, 'files.type')).toHaveLength(21)
  })
})

// ---------------------------------------------------------------------------
describe('validateContributions', () => {
  const run = (m: unknown, files: Record<string, string | Uint8Array>) =>
    validateContributions(m as ExtPackManifest, fakeReader(files), { source: 'folder' })
  const withContrib = (contributes: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    base({ contributes, ...over })
  const errs = (issues: ExtPackIssue[]) => issues.filter(i => i.severity === 'error')

  it('dotenv 示例：没有任何问题（「正则没检查」由 checkPack 报，见 check.test.ts）', () => {
    const r = run(dotenv, dotenvFiles)
    expect(errs(r.issues)).toEqual([])
    expect(codesOf(r.issues)).toEqual([])
  })

  describe('M8 清单图标', () => {
    it('不存在、超大、PNG 太大、不是 PNG', () => {
      const m = withContrib({ snippets: [] }, { icon: 'icon.png' })
      expect(codesOf(run(m, {}).issues)).toContain('manifest.icon')
      expect(codesOf(run(m, { 'icon.png': png(1025, 10) }).issues)).toContain('manifest.icon')
      expect(codesOf(run(m, { 'icon.png': enc('not a png at all, definitely not, no') }).issues)).toContain(
        'manifest.icon',
      )
      const huge = new Uint8Array(201 * 1024)
      huge.set(png(10, 10))
      expect(codesOf(run(m, { 'icon.png': huge }).issues)).toContain('manifest.icon')
      expect(find(run(m, { 'icon.png': png(256, 256) }).issues, 'manifest.icon')).toEqual([])
    })
  })

  describe('语法', () => {
    const g = (over: Record<string, unknown> = {}) => ({
      language: 'x',
      extensions: ['.x'],
      scopeName: 'source.x',
      path: 'syntaxes/x.tmLanguage.json',
      samples: ['samples/a.x'],
      ...over,
    })
    const files = (over: Record<string, string> = {}) => ({
      'syntaxes/x.tmLanguage.json': JSON.stringify({ scopeName: 'source.x', patterns: [] }),
      'samples/a.x': 'x',
      ...over,
    })
    const check = (grammar: unknown, f: Record<string, string> = files()) =>
      run(withContrib({ grammars: [grammar] }), f).issues

    it('G1 字段：缺 scopeName / path 后缀 / 没有匹配方式 / language 写法 / 缺 language', () => {
      expect(codesOf(check(g({ scopeName: undefined })))).toContain('grammar.fields')
      expect(codesOf(check(g({ path: 'x.json' })))).toContain('grammar.fields')
      expect(codesOf(check(g({ extensions: undefined })))).toContain('grammar.fields')
      expect(codesOf(check(g({ language: 'Bad Lang' })))).toContain('grammar.fields')
      expect(codesOf(check(g({ language: undefined })))).toContain('grammar.fields')
      expect(find(check(g({ extensions: ['x'] })), 'grammar.fields')).toHaveLength(1)
      const bad = find(check(g({ scopeName: undefined })), 'grammar.fields')[0]
      expect(bad.contribution).toEqual({ kind: 'grammars', index: 0 })
    })
    it('G1 注入语法可以没有 language', () => {
      const r = check(g({ language: undefined, extensions: undefined, injectTo: ['source.foo'] }))
      expect(errs(r)).toEqual([])
    })
    it('G2 文件缺失 / 不是 JSON / scopeName 不一致 / 太大', () => {
      expect(codesOf(check(g(), {}))).toContain('grammar.file')
      expect(codesOf(check(g(), files({ 'syntaxes/x.tmLanguage.json': '{ nope' })))).toContain('grammar.file')
      expect(codesOf(check(g(), files({ 'syntaxes/x.tmLanguage.json': '{"scopeName":"source.y"}' })))).toContain(
        'grammar.file',
      )
      expect(
        codesOf(
          check(
            g(),
            files({ 'syntaxes/x.tmLanguage.json': `{"scopeName":"source.x","pad":"${'a'.repeat(2 * 1024 * 1024)}"}` }),
          ),
        ),
      ).toContain('grammar.file')
      expect(errs(check(g()))).toEqual([])
    })
    it('G3 firstLine 正则', () => {
      expect(codesOf(check(g({ firstLine: '(' })))).toContain('grammar.firstLine')
      expect(errs(check(g({ firstLine: '^#!.*ruby' })))).toEqual([])
      expect(codesOf(check(g({ firstLine: '^(a+)+$' })))).toContain('grammar.firstLine') // 嵌套量词
      expect(codesOf(check(g({ firstLine: '^(a|aa)+$' })))).toContain('grammar.firstLine') // 被重复的分支组
      expect(errs(check(g({ firstLine: '^#!.*\\b(node|deno)\\b' })))).toEqual([])
      // 相邻且可以重叠的量词：多项式级回溯，截断到 200 字符也救不了
      expect(codesOf(check(g({ firstLine: '^a*a*a*a*a*a*a*a*a*a*b$' })))).toContain('grammar.firstLine')
      expect(errs(check(g({ firstLine: '^#!.*\\bpython[\\d\\.]*\\b' })))).toEqual([])
    })
    it('G4 配置文件缺失或不是 JSONC 是警告；G5 不生效的字段', () => {
      const missing = check(g({ configuration: 'c.json' }))
      expect(find(missing, 'grammar.configuration')[0].severity).toBe('warning')
      const unparsable = check(g({ configuration: 'c.json' }), files({ 'c.json': '{ nope' }))
      expect(codesOf(unparsable)).toContain('grammar.configuration')
      const extra = check(
        g({ configuration: 'c.json' }),
        files({ 'c.json': '{ "comments": {}, "folding": {}, "onEnterRules": [], }' }),
      )
      const ignored = find(extra, 'grammar.configIgnored')[0]
      expect(ignored.message.zh).toContain('folding')
      expect(ignored.message.zh).toContain('onEnterRules')
      expect(ignored.message.zh).not.toContain('comments')
    })
    it('G6 samples 缺失或不在 samples/ 下', () => {
      expect(codesOf(check(g({ samples: [] })))).toContain('grammar.samples')
      expect(codesOf(check(g({ samples: ['samples/none.x'] })))).toContain('grammar.samples')
      expect(codesOf(check(g({ samples: ['syntaxes/x.tmLanguage.json'] })))).toContain('grammar.samples')
    })
    it('G8 validateContributions 不再报 grammar.regexUnchecked（移到 checkPack）', () => {
      const r = run(withContrib({ grammars: [g(), g({ language: 'y', scopeName: 'source.y' })] }), files())
      expect(find(r.issues, 'grammar.regexUnchecked')).toHaveLength(0)
    })
    it('G9 include 内置作用域是警告，每个语法只报一次，# 前面才算', () => {
      const text = JSON.stringify({
        scopeName: 'source.x',
        patterns: [
          { include: 'source.js#expr' },
          { include: 'source.python' },
          { include: '#local' },
          { include: 'source.other' },
        ],
      })
      const r = check(g(), files({ 'syntaxes/x.tmLanguage.json': text }))
      expect(find(r, 'grammar.includeBuiltinScope')).toHaveLength(1)
      expect(find(r, 'grammar.includeBuiltinScope')[0].severity).toBe('warning')
    })
    it('G10 injectTo 内置作用域是警告', () => {
      const r = check(g({ extensions: undefined, injectTo: ['text.html.markdown'] }))
      expect(find(r, 'grammar.injectBuiltin')[0].severity).toBe('warning')
    })
    it('M16 语法条目里的未知字段', () => {
      expect(find(check(g({ colour: 1 })), 'manifest.unknownField')[0].path).toBe('colour')
    })
  })

  describe('主题', () => {
    const t = (over: Record<string, unknown> = {}) => ({
      id: 'dark',
      label: 'Dark',
      uiTheme: 'dark',
      path: 'themes/dark.json',
      ...over,
    })
    const theme = (colors: Record<string, string>, tokens: unknown[] = []) =>
      JSON.stringify({ colors, tokenColors: tokens })
    const okColors = { 'editor.background': '#1a1b26', 'editor.foreground': '#a9b1d6' }
    const check = (items: unknown[], files: Record<string, string>) => run(withContrib({ themes: items }), files).issues

    it('正例', () => {
      expect(
        check([t()], {
          'themes/dark.json': theme(okColors, [{ scope: 'comment', settings: { foreground: '#7a84b0' } }]),
        }),
      ).toEqual([])
    })
    it('TH1 id / uiTheme / path / 重复 id', () => {
      const files = { 'themes/dark.json': theme(okColors) }
      expect(codesOf(check([t({ id: 'Bad' })], files))).toContain('theme.fields')
      expect(codesOf(check([t({ uiTheme: 'auto' })], files))).toContain('theme.fields')
      expect(codesOf(check([t({ path: 'themes/dark.txt' })], files))).toContain('theme.fields')
      const dup = check([t(), t()], files)
      expect(find(dup, 'theme.fields')[0].contribution).toEqual({ kind: 'themes', index: 1 })
    })
    it('TH2 文件缺失 / 不是对象 / include 链', () => {
      expect(codesOf(check([t()], {}))).toContain('theme.file')
      expect(codesOf(check([t()], { 'themes/dark.json': '[1]' }))).toContain('theme.file')
      expect(codesOf(check([t()], { 'themes/dark.json': '{ "include": "./base.json" }' }))).toContain('theme.file')
      const loop = { 'themes/dark.json': '{ "include": "./b.json" }', 'themes/b.json': '{ "include": "./dark.json" }' }
      expect(find(check([t()], loop), 'theme.file')[0].message.zh).toContain('循环')
      const deep: Record<string, string> = { 'themes/dark.json': '{ "include": "./i1.json" }' }
      for (let n = 1; n <= 6; n++) deep[`themes/i${n}.json`] = `{ "include": "./i${n + 1}.json" }`
      deep['themes/i7.json'] = theme(okColors)
      expect(codesOf(check([t()], deep))).toContain('theme.file')
    })
    it('TH2 include 能合并颜色，并把被 include 的文件算作已使用', () => {
      const files = {
        'themes/dark.json': '{ // 注释\n "include": "./base.json", "colors": { "editor.foreground": "#ffffff" }, }',
        'themes/base.json': theme({ 'editor.background': '#000000', 'editor.foreground': '#111111' }),
      }
      const r = check([t()], files)
      expect(r).toEqual([])
    })
    it('TH3 缺必写颜色', () => {
      expect(codesOf(check([t()], { 'themes/dark.json': theme({ 'editor.background': '#000' }) }))).toContain(
        'theme.requiredColors',
      )
    })
    it('TH4 非法颜色被忽略并警告（含 tokenColors）', () => {
      const r = check([t()], {
        'themes/dark.json': theme({ ...okColors, 'editorCursor.foreground': 'red' }, [
          { scope: 'x', settings: { foreground: 'blue' } },
        ]),
      })
      expect(find(r, 'theme.color')).toHaveLength(1)
      expect(find(r, 'theme.color')[0].severity).toBe('warning')
    })
    it('TH5 对比度：正文 < 4.5、注释 < 3', () => {
      const low = check([t()], {
        'themes/dark.json': theme({ 'editor.background': '#1a1b26', 'editor.foreground': '#2a2b36' }),
      })
      expect(find(low, 'theme.contrast')).toHaveLength(1)
      const comment = check([t()], {
        'themes/dark.json': theme(okColors, [{ scope: ['string', 'comment'], settings: { foreground: '#1c1d28' } }]),
      })
      expect(find(comment, 'theme.contrast')).toHaveLength(1)
      expect(find(comment, 'theme.contrast')[0].upload).toBe('hint')
    })
  })

  describe('片段', () => {
    const check = (items: unknown[], files: Record<string, string>) =>
      run(withContrib({ snippets: items }), files).issues
    it('正例', () => {
      expect(
        check([{ language: 'go', path: 's.json' }], { 's.json': '{ "a": { "prefix": "x", "body": "y" }, // c\n }' }),
      ).toEqual([])
    })
    it('S1 language / path', () => {
      expect(codesOf(check([{ language: 'Go', path: 's.json' }], {}))).toContain('snippets.fields')
      expect(codesOf(check([{ language: 'go', path: 's.txt' }], {}))).toContain('snippets.fields')
    })
    it('S2 文件缺失 / 不是对象', () => {
      expect(codesOf(check([{ language: 'go', path: 's.json' }], {}))).toContain('snippets.file')
      expect(codesOf(check([{ language: 'go', path: 's.json' }], { 's.json': '[]' }))).toContain('snippets.file')
    })
    it('S3 坏条目是警告、前缀超长、超过 500 条截断', () => {
      const r = check([{ language: 'go', path: 's.json' }], {
        's.json': JSON.stringify({
          a: { prefix: 'x'.repeat(31), body: 'b' },
          b: { prefix: 'ok' },
          c: 'str',
          d: { prefix: ['p'], body: ['l1', 'l2'] },
        }),
      })
      expect(find(r, 'snippets.entry')).toHaveLength(3)
      expect(errs(r)).toEqual([])
      const many: Record<string, unknown> = {}
      for (let n = 0; n < 501; n++) many[`s${n}`] = { prefix: `p${n}`, body: 'b' }
      expect(
        find(check([{ language: 'go', path: 's.json' }], { 's.json': JSON.stringify(many) }), 'snippets.entry'),
      ).toHaveLength(1)
    })
  })

  describe('文件图标', () => {
    const it0 = (over: Record<string, unknown> = {}) => ({
      id: 'mini',
      label: 'Mini',
      path: 'icons/theme.json',
      ...over,
    })
    const theme = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        iconDefinitions: { _file: { iconPath: './file.svg' }, _folder: { iconPath: './../icons/folder.svg' } },
        file: '_file',
        folder: '_folder',
        ...over,
      })
    const svgs = { 'icons/file.svg': '<svg/>', 'icons/folder.svg': '<svg/>' }
    const check = (items: unknown[], files: Record<string, string>) =>
      run(withContrib({ iconThemes: items }), files).issues
    it('正例（iconPath 可以用 ../）', () => {
      expect(check([it0()], { 'icons/theme.json': theme(), ...svgs })).toEqual([])
    })
    it('I1 id / path / partial 类型 / 重复', () => {
      expect(codesOf(check([it0({ id: 'Bad' })], { 'icons/theme.json': theme() }))).toContain('iconTheme.fields')
      expect(codesOf(check([it0({ path: 'a.txt' })], {}))).toContain('iconTheme.fields')
      expect(codesOf(check([it0({ partial: 'yes' })], {}))).toContain('iconTheme.fields')
      expect(find(check([it0(), it0()], { 'icons/theme.json': theme(), ...svgs }), 'iconTheme.fields')).toHaveLength(1)
    })
    it('I2 文件缺失 / 没有 iconDefinitions', () => {
      expect(codesOf(check([it0()], {}))).toContain('iconTheme.file')
      expect(codesOf(check([it0()], { 'icons/theme.json': '{}' }))).toContain('iconTheme.file')
    })
    it('I3 字体图标被拒绝', () => {
      expect(codesOf(check([it0()], { 'icons/theme.json': theme({ fonts: [{ id: 'x' }] }) }))).toContain(
        'iconTheme.fonts',
      )
      const fc = JSON.stringify({ iconDefinitions: { a: { fontCharacter: '\\E001' } } })
      expect(codesOf(check([it0()], { 'icons/theme.json': fc }))).toContain('iconTheme.fonts')
    })
    it('I4 图标缺失 / 逃出包 / 太大 / 类型不对是警告；最多列 20 条', () => {
      const defs: Record<string, unknown> = {}
      for (let n = 0; n < 25; n++) defs[`d${n}`] = { iconPath: `./missing${n}.svg` }
      defs.escape = { iconPath: '../../x.svg' }
      const r = check([it0({ partial: true })], { 'icons/theme.json': JSON.stringify({ iconDefinitions: defs }) })
      expect(find(r, 'iconTheme.iconPath')).toHaveLength(21)
      expect(errs(r)).toEqual([])
      const big = check([it0()], {
        'icons/theme.json': theme(),
        'icons/file.svg': `<svg>${'a'.repeat(33 * 1024)}</svg>`,
        'icons/folder.svg': '<svg/>',
      })
      expect(find(big, 'iconTheme.iconPath')).toHaveLength(1)
      const wrongExt = check([it0()], {
        'icons/theme.json': theme({
          iconDefinitions: { _file: { iconPath: './f.gif' }, _folder: { iconPath: './folder.svg' } },
        }),
        'icons/f.gif': 'x',
        'icons/folder.svg': '<svg/>',
      })
      expect(find(wrongExt, 'iconTheme.iconPath')).toHaveLength(1)
    })
    it('I5 完整主题要有 file 和 folder；partial 不要求', () => {
      const noDefaults = JSON.stringify({ iconDefinitions: { _x: { iconPath: './x.svg' } } })
      expect(codesOf(check([it0()], { 'icons/theme.json': noDefaults, 'icons/x.svg': '<svg/>' }))).toContain(
        'iconTheme.default',
      )
      expect(check([it0({ partial: true })], { 'icons/theme.json': noDefaults, 'icons/x.svg': '<svg/>' })).toEqual([])
    })
  })

  describe('任务模板', () => {
    const tpl = (over: Record<string, unknown> = {}) => ({
      id: 'just',
      label: 'Just',
      files: ['justfile'],
      tasks: [{ name: 'build' }],
      command: 'just {name}',
      ...over,
    })
    const check = (items: unknown[], files: Record<string, string | Uint8Array> = {}) =>
      run(withContrib({ taskTemplates: items }), files).issues
    it('正例；错误带贡献下标，warning 不停用', () => {
      expect(check([tpl()])).toEqual([])
      const r = check([tpl(), tpl({ id: 'gradle' })])
      expect(find(r, 'task.idReserved')[0].contribution).toEqual({ kind: 'taskTemplates', index: 1 })
      const dropped = check([tpl({ tasks: [{ name: 'bad name' }, { name: 'ok' }] })])
      expect(find(dropped, 'task.nameDropped')[0].severity).toBe('warning')
    })
    it('图标缺失、太大是警告', () => {
      expect(find(check([tpl({ icon: 'i.svg' })]), 'task.icon')[0].severity).toBe('warning')
      expect(find(check([tpl({ icon: 'i.svg' })], { 'i.svg': 'x'.repeat(33 * 1024) }), 'task.icon')).toHaveLength(1)
      expect(find(check([tpl({ icon: 'i.svg' })], { 'i.svg': '<svg/>' }), 'task.icon')).toEqual([])
    })
    it('M16 嵌套未知字段：tasks[] / extract[] / runner', () => {
      const r = check([
        tpl({
          tasks: [{ name: 'a', hint: 1 }],
          extract: [{ pattern: '^(a)', name: 1, group: 2, description: { commentBefore: '#', x: 1 } }],
          runner: { default: './a', shell: 'x' },
          command: '{runner} {name}',
        }),
      ])
      expect(
        find(r, 'manifest.unknownField')
          .map(i => i.path)
          .sort(),
      ).toEqual(['extract[0].description.x', 'extract[0].group', 'runner.shell', 'tasks[0].hint'])
    })
  })

  describe('技能', () => {
    const skillMd = (name: string, desc = '什么时候用') => `---\nname: ${name}\ndescription: ${desc}\n---\n\n正文`
    const check = (items: unknown[], files: Record<string, string>) => run(withContrib({ skills: items }), files)
    it('正例：返回技能信息，engines 默认两个都给，下标是清单下标', () => {
      const r = check([{ path: 'skills/a' }, { path: 'skills/b/', engines: ['codex'] }], {
        'skills/a/SKILL.md': skillMd('a'),
        'skills/a/ref.md': '#',
        'skills/b/SKILL.md': skillMd('b', '"带引号的说明"'),
        'skills/b/pic.png': 'x',
      })
      expect(errs(r.issues)).toEqual([])
      expect(r.skills).toEqual([
        { name: 'a', description: '什么时候用', engines: ['claude', 'codex'], index: 0 },
        { name: 'b', description: '带引号的说明', engines: ['codex'], index: 1 },
      ])
    })
    it('SK1 没有 SKILL.md', () => {
      expect(codesOf(check([{ path: 'skills/a' }], {}).issues)).toContain('skill.path')
    })
    it('SK2 frontmatter：缺失 / name 写法 / 重复 / description 过长或缺失', () => {
      expect(codesOf(check([{ path: 'a' }], { 'a/SKILL.md': '没有头' }).issues)).toContain('skill.frontmatter')
      expect(codesOf(check([{ path: 'a' }], { 'a/SKILL.md': skillMd('Bad_Name') }).issues)).toContain(
        'skill.frontmatter',
      )
      expect(codesOf(check([{ path: 'a' }], { 'a/SKILL.md': skillMd('a', 'x'.repeat(1025)) }).issues)).toContain(
        'skill.frontmatter',
      )
      expect(codesOf(check([{ path: 'a' }], { 'a/SKILL.md': '---\nname: a\n---\n' }).issues)).toContain(
        'skill.frontmatter',
      )
      const dup = check([{ path: 'a' }, { path: 'b' }], {
        'a/SKILL.md': skillMd('same'),
        'b/SKILL.md': skillMd('same'),
      })
      expect(find(dup.issues, 'skill.frontmatter')[0].contribution).toEqual({ kind: 'skills', index: 1 })
      expect(dup.skills).toHaveLength(1)
    })
    it('SK3 文件夹里只能放 .md 和图片（脚本被拒）', () => {
      const r = check([{ path: 'a' }], { 'a/SKILL.md': skillMd('a'), 'a/run.sh': 'x' })
      expect(codesOf(r.issues)).toContain('skill.files')
      expect(r.skills).toEqual([])
    })
    it('SK4 engines 只能是 claude / codex', () => {
      for (const engines of [['gpt'], [], ['claude', 'claude']]) {
        expect(codesOf(check([{ path: 'a', engines }], { 'a/SKILL.md': skillMd('a') }).issues)).toContain(
          'skill.engines',
        )
      }
    })
  })

  describe('提示词', () => {
    const pr = (over: Record<string, unknown> = {}) => ({
      id: 'explain',
      title: '解释',
      path: 'p/explain.md',
      where: ['composer', 'editor'],
      requires: 'selection',
      ...over,
    })
    const check = (
      items: unknown[],
      files: Record<string, string | Uint8Array> = { 'p/explain.md': '解释 {{selection}}' },
    ) => run(withContrib({ prompts: items }), files).issues
    it('正例', () => {
      expect(check([pr()])).toEqual([])
    })
    it('PR1 id / title / path / where / requires / 重复 id', () => {
      expect(codesOf(check([pr({ id: 'Bad' })]))).toContain('prompt.fields')
      expect(codesOf(check([pr({ title: '' })]))).toContain('prompt.fields')
      expect(codesOf(check([pr({ path: 'p/explain.txt' })]))).toContain('prompt.fields')
      expect(codesOf(check([pr({ where: ['menu'] })]))).toContain('prompt.fields')
      expect(codesOf(check([pr({ requires: 'file' })]))).toContain('prompt.fields')
      expect(find(check([pr(), pr()]), 'prompt.fields')).toHaveLength(1)
    })
    it('PR2 正文缺失 / 不是 UTF-8 / 超过 8000 字符', () => {
      expect(codesOf(check([pr()], {}))).toContain('prompt.body')
      expect(codesOf(check([pr()], { 'p/explain.md': new Uint8Array([0xff, 0xfe, 0x41]) }))).toContain('prompt.body')
      expect(codesOf(check([pr()], { 'p/explain.md': 'x'.repeat(8001) }))).toContain('prompt.body')
      expect(errs(check([pr()], { 'p/explain.md': 'x'.repeat(8000) }))).toEqual([])
    })
  })

  describe('文件级规则', () => {
    it('F11 BOM 和非 UTF-8 的文本文件是警告', () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{}')])
      const r = run(withContrib({ snippets: [{ language: 'go', path: 's.json' }] }), {
        's.json': bom,
        'README.md': new Uint8Array([0xff, 0xfe, 0x41]),
      })
      expect(
        find(r.issues, 'files.encoding')
          .map(i => i.path)
          .sort(),
      ).toEqual(['README.md', 's.json'])
      expect(find(r.issues, 'files.encoding').every(i => i.severity === 'warning')).toBe(true)
    })
    it('F11 samples 下任意扩展名都查编码；.git/ 不再豁免', () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('A=1')])
      const r = run(withContrib({ snippets: [{ language: 'go', path: 's.json' }] }), {
        's.json': '{}',
        'samples/a.env': bom,
        'samples/b.rb': new Uint8Array([0xff, 0xfe]),
        'samples/ok.txt': 'x',
        '.git/notes.md': bom,
      })
      expect(
        find(r.issues, 'files.encoding')
          .map(i => i.path)
          .sort(),
      ).toEqual(['.git/notes.md', 'samples/a.env', 'samples/b.rb'])
    })
    it('F10 没被引用的文件（README / LICENSE / CHANGELOG / samples / 图标 / 被 include 的主题除外）', () => {
      const r = run(dotenv, { ...dotenvFiles, 'CHANGELOG.md': '#', 'notes.md': '#', 'icons/x.svg': '<svg/>' })
      expect(
        find(r.issues, 'files.unused')
          .map(i => i.path)
          .sort(),
      ).toEqual(['icons/x.svg', 'notes.md'])
      expect(find(r.issues, 'files.unused')[0].upload).toBe('hint')
    })
  })

  it('畸形清单不会抛异常', () => {
    for (const m of [
      {},
      { contributes: null },
      { contributes: { grammars: 'x', themes: [null, 3, []] } },
      { contributes: { skills: [{ path: 3 }], taskTemplates: [null] } },
    ]) {
      expect(() => run(m, {})).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
describe('inactiveContributions', () => {
  it('返回清单下标：坏语法 0、好语法 1 → {grammars:[0]}', () => {
    const grammar = (over: Record<string, unknown>) => ({
      language: 'x',
      extensions: ['.x'],
      scopeName: 'source.x',
      path: 'g.tmLanguage.json',
      samples: ['samples/a'],
      ...over,
    })
    const m = base({
      contributes: {
        grammars: [
          grammar({ scopeName: 'source.bad' }),
          grammar({ language: 'y', scopeName: 'source.y', path: 'y.tmLanguage.json' }),
        ],
      },
    })
    const reader = fakeReader({
      'g.tmLanguage.json': '{"scopeName":"source.x"}',
      'y.tmLanguage.json': '{"scopeName":"source.y"}',
      'samples/a': 'x',
    })
    const { issues } = validateContributions(m as unknown as ExtPackManifest, reader, { source: 'folder' })
    expect(inactiveContributions(m as unknown as ExtPackManifest, issues)).toEqual({ grammars: [0] })
  })
  it('警告不停用；多种 kind 分开、下标升序去重', () => {
    const e = (kind: 'themes' | 'prompts', index: number): ExtPackIssue => ({
      severity: 'error',
      scope: 'contribution',
      code: 'x',
      message: { zh: '', en: '' },
      contribution: { kind, index },
    })
    const w: ExtPackIssue = { ...e('themes', 9), severity: 'warning' }
    const pack: ExtPackIssue = { ...e('themes', 8), scope: 'pack' }
    expect(
      inactiveContributions({} as ExtPackManifest, [
        e('themes', 3),
        e('themes', 1),
        e('themes', 3),
        e('prompts', 0),
        w,
        pack,
      ]),
    ).toEqual({
      themes: [1, 3],
      prompts: [0],
    })
    expect(inactiveContributions({} as ExtPackManifest, [])).toEqual({})
  })
})

describe('packStatus / loaderIssue / forSource', () => {
  it('packStatus', () => {
    expect(packStatus([])).toBe('ok')
    expect(packStatus(manifestIssues(base({ version: 'x' })))).toBe('warning')
    expect(packStatus([loaderIssue('manifest.missing')])).toBe('error')
    expect(packStatus([loaderIssue('svg.unsafe', { path: 'a.svg' })])).toBe('warning') // 文件级错误不让整个扩展失败
  })
  it('loaderIssue 六个代码都有中英文本，严重度 / 范围正确', () => {
    const cases = [
      ['manifest.missing', 'error', 'pack'],
      ['files.scanLimit', 'error', 'pack'],
      ['pack.duplicateId', 'error', 'pack'],
      ['pack.storeBlocked', 'warning', 'pack'],
      ['svg.unsafe', 'error', 'file'],
      ['files.symlink', 'error', 'file'],
    ] as const
    for (const [code, severity, scope] of cases) {
      const i = loaderIssue(code, { path: 'a/b.svg', id: 'acme.demo' })
      expect(i).toMatchObject({ code, severity, scope })
      expect(i.message.zh).not.toBe(code)
      expect(i.message.en).not.toBe(code)
    }
    expect(loaderIssue('pack.duplicateId', { id: 'acme.demo' }).message.zh).toContain('acme.demo')
    expect(loaderIssue('svg.unsafe', { path: 'a/b.svg' }).path).toBe('a/b.svg')
  })
  it('pack.storeBlocked：带原因、只在本机产生（没有 upload）、不会让扩展变成错误', () => {
    const i = loaderIssue('pack.storeBlocked', { reason: '含恶意代码' })
    expect(i.message.zh).toContain('含恶意代码')
    expect(i.message.en).toContain('含恶意代码')
    expect(i.upload).toBeUndefined()
    expect(packStatus([i])).toBe('warning')
  })
  it('forSource：内置只留 error，folder 原样', () => {
    const issues = [...manifestIssues(base({ version: 'x' })), loaderIssue('manifest.missing')]
    expect(forSource(issues, 'builtin').map(i => i.code)).toEqual(['manifest.missing'])
    expect(forSource(issues, 'folder')).toEqual(issues)
  })
})

// ---------------------------------------------------------------------------
describe('isExtId / isExtVersion / isPublisherName', () => {
  it('isExtId：发布者.名字，全小写', () => {
    for (const ok of ['acme.demo', 'pixelsky.material-icons', 'a1b.cd', 'acme.' + 'a'.repeat(48)])
      expect(isExtId(ok), ok).toBe(true)
    const bad = [
      '',
      'acme',
      'Acme.demo',
      'acme.Demo',
      'ac.demo',
      '-acme.demo',
      'acme.demo-',
      'acme..demo',
      'acme.d',
      'acme.demo/x',
    ]
    for (const s of [...bad, 'acme.' + 'a'.repeat(49)]) expect(isExtId(s), s).toBe(false)
    expect(isExtId(undefined)).toBe(false)
    expect(isExtId(1)).toBe(false)
  })
  it('isExtVersion：三段数字加可选预发布后缀，总长不超过 64', () => {
    for (const ok of ['0.0.0', '1.2.3', '1.0.0-beta.1']) expect(isExtVersion(ok), ok).toBe(true)
    for (const bad of ['', '1.0', 'v1.0.0', '01.0.0', '1.0.0+build', '1.0.0-'])
      expect(isExtVersion(bad), bad).toBe(false)
    const at64 = '1.0.0-' + 'a'.repeat(58)
    expect(at64).toHaveLength(64)
    expect(isExtVersion(at64)).toBe(true)
    expect(isExtVersion(at64 + 'a')).toBe(false)
    expect(isExtVersion(null)).toBe(false)
  })
  it('isPublisherName：3–32 个字符，首尾不能是 -', () => {
    expect(isPublisherName('ab')).toBe(false)
    expect(isPublisherName('abc')).toBe(true)
    expect(isPublisherName('a'.repeat(32))).toBe(true)
    expect(isPublisherName('a'.repeat(33))).toBe(false)
    expect(isPublisherName('-abc')).toBe(false)
    expect(isPublisherName('abc-')).toBe(false)
    expect(isPublisherName('a-c')).toBe(true)
    expect(isPublisherName('ABC')).toBe(false)
    expect(isPublisherName(3)).toBe(false)
  })
})

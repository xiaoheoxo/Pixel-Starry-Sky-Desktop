import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolError } from '../src/lib/check'
import { main } from '../src/cli/main'
import { pickLang } from '../src/cli/i18n'
import type { CliHooks, CliIo } from '../src/cli/io'
import { withoutTiming } from './helpers/timing'

const BASES = resolve(dirname(fileURLToPath(import.meta.url)), '../../protocol/corpus/extpacks/bases')
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`)

const made: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pxext-cli-'))
  made.push(dir)
  return dir
}
function copyBase(name: string, into = tempDir()): string {
  const dir = join(into, name)
  cpSync(join(BASES, name), dir, { recursive: true })
  return dir
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Run {
  code: number
  out: string
  err: string
}
async function run(argv: string[], over: Partial<CliIo> = {}, hooks: CliHooks = {}): Promise<Run> {
  let out = ''
  let err = ''
  const io: CliIo = {
    out: s => void (out += s),
    err: s => void (err += s),
    cwd: tempDir(),
    env: {},
    isTTY: false,
    locale: 'zh-CN',
    ...over,
  }
  const code = await main(argv, io, { runner: 'inline', ...hooks })
  return { code, out, err }
}
const dotenv = (): string => join(BASES, 'pixelsky.dotenv')
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('语言和颜色', () => {
  it('pickLang 的优先级', () => {
    expect(pickLang('en', { PIXELSKY_LANG: 'zh' }, 'zh-CN')).toBe('en')
    expect(pickLang(undefined, { PIXELSKY_LANG: 'en', LANG: 'zh_CN.UTF-8' }, 'zh-CN')).toBe('en')
    expect(pickLang(undefined, { LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US' }, 'en-US')).toBe('zh')
    expect(pickLang(undefined, { LANG: 'C' }, 'zh-TW')).toBe('zh')
    expect(pickLang(undefined, {}, 'fr-FR')).toBe('en')
    expect(pickLang(undefined, {}, '')).toBe('en')
  })

  it('默认中文，--lang en 换英文，结构相同', async () => {
    const zh = await run(['validate', dotenv(), '--grammar', 'off'])
    const en = await run(['validate', dotenv(), '--grammar', 'off', '--lang', 'en'])
    expect(zh.out).toContain('提示（1）')
    expect(zh.out).toContain('结果：通过')
    expect(en.out).toContain('Result: pass')
    expect(en.out).toContain('grammar.regexUnchecked')
    expect(en.out).not.toMatch(/[一-鿿]/)
  })

  it('不是终端、NO_COLOR、--no-color 都不上色；FORCE_COLOR 强制上色', async () => {
    const base = ['validate', dotenv(), '--grammar', 'off']
    expect((await run(base)).out).not.toMatch(ANSI)
    expect((await run(base, { isTTY: true })).out).toMatch(ANSI)
    expect((await run(base, { isTTY: true, env: { NO_COLOR: '1' } })).out).not.toMatch(ANSI)
    expect((await run([...base, '--no-color'], { isTTY: true })).out).not.toMatch(ANSI)
    expect((await run(base, { isTTY: false, env: { FORCE_COLOR: '1' } })).out).toMatch(ANSI)
  })
})

describe('validate', () => {
  it('通过：退出码 0，文字里有语法测速行', async () => {
    const r = await run(['validate', dotenv()])
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toContain('pixelsky.dotenv 1.0.0')
    expect(r.out).toContain('7 个文件')
    expect(r.out).toContain('语法高亮 1，代码片段 1')
    expect(r.out).toContain('source.dotenv')
    expect(r.out).toContain('samples/example.env')
    expect(r.out).toContain('30 行重复到 5,000 行')
    expect(r.out).toContain('上传时云端另外检查')
  }, 30_000)

  it('不传路径检查当前目录', async () => {
    const cwd = copyBase('pixelsky.dotenv')
    const r = await run(['validate', '--grammar', 'off'], { cwd })
    expect(r.code).toBe(0)
    expect(r.out).toContain('pixelsky.dotenv 1.0.0')
  })

  it('不通过：退出码 1，按「会被拒绝」分组，写出问题代码', async () => {
    const r = await run(['validate', join(BASES, 'unsafe-svg'), '--grammar', 'off'])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/会被拒绝（\d+）/)
    expect(r.out).toContain('svg.unsafe')
    expect(r.out).toContain('结果：不通过')
  })

  it('dev 档按「错误 / 警告」分组，不列「上传时云端另外检查」', async () => {
    const r = await run(['validate', join(BASES, 'unsafe-svg'), '--level', 'dev'])
    expect(r.out).toMatch(/(错误|警告)（\d+）/)
    expect(r.out).not.toContain('会被拒绝')
    expect(r.out).not.toContain('上传时云端另外检查')
  })

  it('--level dev --app-version 0.3.0 → manifest.engineUnmet，退出码 1', async () => {
    const r = await run(['validate', dotenv(), '--level', 'dev', '--app-version', '0.3.0', '--json'])
    const j = JSON.parse(r.out)
    expect(r.code).toBe(1)
    expect(j.options).toEqual({ level: 'dev', grammar: 'off', appVersion: '0.3.0', strict: false })
    expect(j.issues.some((i: { code: string }) => i.code === 'manifest.engineUnmet')).toBe(true)
  })

  it('--level dev 默认拿构建时的软件版本', async () => {
    const j = JSON.parse((await run(['validate', dotenv(), '--level', 'dev', '--json'])).out)
    expect(j.options.appVersion).toBe(j.tool.appVersion)
    expect(j.verdict.pass).toBe(true)
  })

  it('--strict 把提示变成不通过', async () => {
    const loose = await run(['validate', dotenv(), '--grammar', 'off'])
    const strict = await run(['validate', dotenv(), '--grammar', 'off', '--strict'])
    expect(loose.code).toBe(0)
    expect(strict.code).toBe(1)
  })

  it('略过的文件列在最后一行', async () => {
    const dir = copyBase('pixelsky.dotenv')
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref')
    writeFileSync(join(dir, '.gitignore'), 'x')
    const r = await run(['validate', dir, '--grammar', 'off'])
    expect(r.out).toContain('略过：.git/、.gitignore')
    const j = JSON.parse((await run(['validate', dir, '--grammar', 'off', '--json'])).out)
    expect(j.skipped.sort()).toEqual(['.git/', '.gitignore'])
  })
})

describe('JSON', () => {
  it('结构固定：字段、类型，只写 JSON 到标准输出', async () => {
    const r = await run(['validate', dotenv(), '--json'])
    expect(r.err).toBe('')
    const j = JSON.parse(r.out)
    expect(Object.keys(j)).toEqual([
      'schema',
      'tool',
      'command',
      'input',
      'options',
      'pack',
      'status',
      'inactive',
      'verdict',
      'counts',
      'issues',
      'grammar',
      'skipped',
      'notChecked',
      'output',
    ])
    expect(j.schema).toBe(1)
    expect(j.tool).toMatchObject({ name: 'pixelsky-ext', rulesVersion: 2 })
    expect(j.command).toBe('validate')
    expect(j.input).toEqual({ kind: 'folder', path: dotenv(), bytes: null })
    expect(j.options).toEqual({ level: 'upload', grammar: 'full', appVersion: null, strict: false })
    expect(j.pack).toEqual({ id: 'pixelsky.dotenv', version: '1.0.0', files: 7, bytes: 8328 })
    // 慢机器上可能多一条测速提示（warning / hint，状态随之变成 warning），其余计数必须为 0
    const timing = j.issues.length - withoutTiming(j.issues as Array<{ code: string }>).length
    expect(j.status).toBe(timing ? 'warning' : 'ok')
    expect(j.verdict).toEqual({ pass: true, blocking: 0 })
    expect(j.counts).toEqual({ error: 0, warning: timing, reject: 0, hint: timing, note: 0 })
    expect(withoutTiming(j.issues as Array<{ code: string }>)).toEqual([])
    expect(j.notChecked).toEqual(['publisher', 'versionIncrement', 'listedConflicts'])
    expect(j.output).toBeNull()
    expect(j.grammar.mode).toBe('full')
    const s = j.grammar.grammars[0]
    expect(s).toMatchObject({ index: 0, scopeName: 'source.dotenv' })
    expect(s.regexes).toBeGreaterThan(0)
    expect(Object.keys(s.samples[0])).toEqual([
      'path',
      'sourceLines',
      'lines',
      'totalMs',
      'budgetMs',
      'slowestMs',
      'slowestLine',
    ])
    expect(s.samples[0]).toMatchObject({ path: 'samples/example.env', sourceLines: 30, lines: 5000, budgetMs: 1000 })
  }, 30_000)

  it('上传档每条问题带 outcome，dev 档不带', async () => {
    const up = JSON.parse((await run(['validate', dotenv(), '--grammar', 'off', '--json'])).out)
    expect(up.issues).toHaveLength(1)
    expect(up.issues[0]).toMatchObject({ code: 'grammar.regexUnchecked', outcome: 'hint', upload: 'hint' })
    expect(up.issues[0].message.zh).toBeTruthy()
    expect(up.issues[0].message.en).toBeTruthy()
    const dev = JSON.parse((await run(['validate', dotenv(), '--level', 'dev', '--json'])).out)
    expect(dev.issues[0]).not.toHaveProperty('outcome')
    expect(dev.notChecked).toEqual([])
    expect(dev.grammar).toEqual({ mode: 'off', skipped: 'dev', grammars: [] })
  })

  it('有位置的问题带 loc', async () => {
    const dir = copyBase('pixelsky.dotenv')
    const file = join(dir, 'syntaxes', 'dotenv.tmLanguage.json')
    const text = readFileSync(file, 'utf8')
    const broken = text.replace(/"match":\s*"/, '"match": "[abc')
    expect(broken).not.toBe(text)
    writeFileSync(file, broken)
    const r = await run(['validate', dir, '--grammar', 'regex', '--json'])
    expect(r.code).toBe(1)
    const bad = JSON.parse(r.out).issues.find((i: { code: string }) => i.code === 'grammar.regex')
    expect(bad.loc).toMatchObject({ file: 'syntaxes/dotenv.tmLanguage.json' })
    expect(bad.loc.line).toBeGreaterThan(0)
    const text2 = (await run(['validate', dir, '--grammar', 'regex'])).out
    expect(text2).toMatch(/syntaxes\/dotenv\.tmLanguage\.json:\d+:\d+/)
  })
})

describe('退出码 2 / 3', () => {
  it('用法错误：缺命令、未知命令、未知参数、多余参数', async () => {
    for (const argv of [
      [],
      ['frobnicate'],
      ['validate', '--nope'],
      ['validate', 'a', 'b'],
      ['validate', '--level', 'x'],
    ]) {
      const r = await run(argv)
      expect(r.code, argv.join(' ')).toBe(2)
      expect(r.out).toBe('')
      expect(r.err).toContain('help')
    }
  })

  it('路径不存在 / 既不是文件夹也不是 zip → 2', async () => {
    const cwd = tempDir()
    expect((await run(['validate', 'nope'], { cwd })).code).toBe(2)
    writeFileSync(join(cwd, 'a.txt'), 'x')
    expect((await run(['validate', 'a.txt'], { cwd })).code).toBe(2)
  })

  it('dev 档配 --grammar full / regex、给 zip → 2；upload 配 --app-version → 2', async () => {
    expect((await run(['validate', dotenv(), '--level', 'dev', '--grammar', 'full'])).code).toBe(2)
    expect((await run(['validate', dotenv(), '--level', 'dev', '--grammar', 'regex'])).code).toBe(2)
    expect((await run(['validate', dotenv(), '--level', 'dev', '--grammar', 'off'])).code).toBe(0)
    expect((await run(['validate', dotenv(), '--app-version', '0.4.0'])).code).toBe(2)
    expect((await run(['validate', dotenv(), '--level', 'dev', '--app-version', 'abc'])).code).toBe(2)
    expect((await run(['validate', dotenv(), '--out', 'x.zip'])).code).toBe(2)
    expect((await run(['pack', dotenv(), '--level', 'dev'])).code).toBe(2)
  })

  it('--json 时用法错误也写 JSON 到标准输出', async () => {
    const r = await run(['validate', 'nope', '--json'])
    expect(r.code).toBe(2)
    expect(r.err).toBe('')
    const j = JSON.parse(r.out)
    expect(j.schema).toBe(1)
    expect(j.error.code).toBe('usage')
    expect(typeof j.error.message).toBe('string')
  })

  it('工具出错（ToolError / 其他异常）→ 3', async () => {
    const hooks: CliHooks = {
      checkInput: () => Promise.reject(new ToolError('引擎起不来', 'engine failed')),
    }
    const text = await run(['validate', dotenv()], {}, hooks)
    expect(text.code).toBe(3)
    expect(text.err).toContain('引擎起不来')
    const en = await run(['validate', dotenv(), '--lang', 'en'], {}, hooks)
    expect(en.err).toContain('engine failed')
    const json = await run(['validate', dotenv(), '--json'], {}, hooks)
    expect(json.code).toBe(3)
    expect(JSON.parse(json.out).error).toEqual({ code: 'internal', message: '引擎起不来' })
    const boom = await run(['validate', dotenv()], {}, { checkInput: () => Promise.reject(new Error('boom')) })
    expect(boom.code).toBe(3)
    expect(boom.err).toContain('boom')
  })
})

describe('help / version', () => {
  it('--version 一行，规则版本和软件版本都在', async () => {
    const r = await run(['--version'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^pixelsky-ext \d+\.\d+\.\d+（规则 v2，同像素星空 .+）\n$/)
    expect((await run(['--version', '--lang', 'en'])).out).toMatch(/\(rules v2, matches PixelSky /)
  })

  it('help / --help / -h，可带命令名', async () => {
    for (const argv of [['help'], ['--help'], ['-h']]) {
      const r = await run(argv)
      expect(r.code).toBe(0)
      expect(r.out).toContain('pixelsky-ext validate')
      expect(r.out).toContain('pixelsky-ext pack')
    }
    const v = await run(['help', 'validate'])
    expect(v.out).toContain('--level')
    expect(v.out).not.toContain('--dry-run')
    const p = await run(['pack', '--help', '--lang', 'en'])
    expect(p.out).toContain('--dry-run')
    expect(p.out).toContain('Exit codes')
  })
})

describe('pack', () => {
  it('默认写到 <当前目录>/<id>-<version>.zip，输出路径、大小、文件数、sha256', async () => {
    const root = copyBase('pixelsky.dotenv')
    const cwd = tempDir()
    const r = await run(['pack', root, '--grammar', 'regex'], { cwd })
    expect(r.code).toBe(0)
    const zip = join(cwd, 'pixelsky.dotenv-1.0.0.zip')
    expect(existsSync(zip)).toBe(true)
    expect(readdirSync(cwd)).toEqual(['pixelsky.dotenv-1.0.0.zip'])
    expect(r.out).toContain(zip)
    expect(r.out).toContain(sha(zip))
    expect(r.out).toContain('文件：7 个')
  })

  it('打出来的 zip 再 validate 通过；同样的文件夹打两次 sha256 相同', async () => {
    const root = copyBase('pixelsky.dotenv')
    const a = tempDir()
    const b = tempDir()
    expect((await run(['pack', root, '--grammar', 'off', '-o', a])).code).toBe(0)
    expect((await run(['pack', root, '--grammar', 'off', '-o', join(b, 'x.zip')])).code).toBe(0)
    const za = join(a, 'pixelsky.dotenv-1.0.0.zip')
    expect(sha(za)).toBe(sha(join(b, 'x.zip')))
    const v = await run(['validate', za, '--grammar', 'off', '--json'])
    expect(v.code).toBe(0)
    const j = JSON.parse(v.out)
    expect(j.input.kind).toBe('zip')
    expect(j.pack.files).toBe(7)
  })

  it('JSON：output 带路径、大小、sha256、文件列表', async () => {
    const root = copyBase('pixelsky.dotenv')
    const out = tempDir()
    const r = await run(['pack', root, '--grammar', 'off', '-o', out, '--json'])
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out)
    const zip = join(out, 'pixelsky.dotenv-1.0.0.zip')
    expect(j.command).toBe('pack')
    expect(j.output.path).toBe(zip)
    expect(j.output.sha256).toBe(sha(zip))
    expect(j.output.bytes).toBe(readFileSync(zip).length)
    expect(j.output.files).toHaveLength(7)
    expect(j.output.files[0]).toEqual({ path: expect.any(String), size: expect.any(Number) })
  })

  it('-o 是 .zip 路径：直接用；上级不存在 → 2；不是 .zip 也不是已有文件夹 → 2', async () => {
    const root = copyBase('pixelsky.dotenv')
    const out = tempDir()
    expect((await run(['pack', root, '--grammar', 'off', '-o', join(out, 'my.zip')])).code).toBe(0)
    expect(existsSync(join(out, 'my.zip'))).toBe(true)
    expect((await run(['pack', root, '-o', join(out, 'no', 'my.zip')])).code).toBe(2)
    expect((await run(['pack', root, '-o', join(out, 'nodir')])).code).toBe(2)
    expect(readdirSync(out)).toEqual(['my.zip'])
  })

  it('同名文件被覆盖', async () => {
    const root = copyBase('pixelsky.dotenv')
    const out = tempDir()
    const target = join(out, 'a.zip')
    writeFileSync(target, 'old')
    expect((await run(['pack', root, '--grammar', 'off', '-o', target])).code).toBe(0)
    expect(readFileSync(target).length).toBeGreaterThan(100)
  })

  it('-o 指到扩展里的子文件夹 → 2；根目录直接放可以', async () => {
    const root = copyBase('pixelsky.dotenv')
    const before = readdirSync(root).sort()
    expect((await run(['pack', root, '--grammar', 'off', '-o', join(root, 'samples')])).code).toBe(2)
    expect((await run(['pack', root, '--grammar', 'off', '-o', join(root, 'samples', 'x.zip')])).code).toBe(2)
    expect(readdirSync(root).sort()).toEqual(before)
    expect((await run(['pack', root, '--grammar', 'off', '-o', join(root, 'out.zip')])).code).toBe(0)
    // 根目录的 .zip 下次会被自动略过，不影响再次检查
    const again = await run(['validate', root, '--grammar', 'off', '--json'])
    expect(again.code).toBe(0)
    expect(JSON.parse(again.out).skipped).toContain('out.zip')
  })

  it('不通过：退出码 1，不写任何文件，--dry-run 也一样', async () => {
    const root = copyBase('unsafe-svg')
    const cwd = tempDir()
    const r = await run(['pack', root, '--grammar', 'off'], { cwd })
    expect(r.code).toBe(1)
    expect(r.out).toContain('结果：不通过')
    expect(readdirSync(cwd)).toEqual([])
    expect((await run(['pack', root, '--grammar', 'off', '--dry-run'], { cwd })).code).toBe(1)
    expect(readdirSync(cwd)).toEqual([])
  })

  it('pack 给 zip → 2', async () => {
    const root = copyBase('pixelsky.dotenv')
    const out = tempDir()
    await run(['pack', root, '--grammar', 'off', '-o', out])
    const r = await run(['pack', join(out, 'pixelsky.dotenv-1.0.0.zip')])
    expect(r.code).toBe(2)
  })

  it('--dry-run：列出文件和大小，不写 zip', async () => {
    const root = copyBase('pixelsky.dotenv')
    const cwd = tempDir()
    const r = await run(['pack', root, '--grammar', 'off', '--dry-run'], { cwd })
    expect(r.code).toBe(0)
    expect(readdirSync(cwd)).toEqual([])
    expect(r.out).toContain('--dry-run')
    expect(r.out).toContain('samples/example.env')
    expect(r.out).toContain('pixelsky-extension.json')
    const j = JSON.parse((await run(['pack', root, '--grammar', 'off', '--dry-run', '--json'], { cwd })).out)
    expect(j.output.path).toBeNull()
    expect(j.output.files).toHaveLength(7)
    expect(j.output.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readdirSync(cwd)).toEqual([])
  })

  it('打包时略过 .git / 点文件，zip 里没有', async () => {
    const root = copyBase('pixelsky.dotenv')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref')
    writeFileSync(join(root, '.editorconfig'), 'x')
    const r = await run(['pack', root, '--grammar', 'off', '--dry-run', '--json'])
    const j = JSON.parse(r.out)
    expect(j.output.files.map((f: { path: string }) => f.path)).not.toContain('.editorconfig')
    expect(j.skipped.sort()).toEqual(['.editorconfig', '.git/'])
  })

  it('写文件失败 → 3，临时文件被清掉，没有留下 zip', async () => {
    const root = copyBase('pixelsky.dotenv')
    const out = tempDir()
    const tmps: string[] = []
    const r = await run(
      ['pack', root, '--grammar', 'off', '-o', out],
      {},
      {
        writeFile: async (path, bytes) => {
          tmps.push(path)
          writeFileSync(path, bytes.subarray(0, 10))
          throw new Error('disk full')
        },
      },
    )
    expect(r.code).toBe(3)
    expect(r.err).toContain('disk full')
    expect(tmps).toHaveLength(1)
    expect(tmps[0]).toContain('.tmp-')
    expect(readdirSync(out)).toEqual([])
  })

  it('--strict：提示也算不通过，不写文件', async () => {
    const root = copyBase('pixelsky.dotenv')
    const cwd = tempDir()
    const r = await run(['pack', root, '--grammar', 'off', '--strict'], { cwd })
    expect(r.code).toBe(1)
    expect(readdirSync(cwd)).toEqual([])
  })
})

describe('文字输出的细节', () => {
  const brokenGrammar = (): string => {
    const dir = copyBase('pixelsky.dotenv')
    // id 不合法是整个扩展级别的错误（status = error），语法引擎因此跳过
    const file = join(dir, 'pixelsky-extension.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"id": "pixelsky.dotenv"', '"id": "BAD id"'))
    return dir
  }

  it('符号跟着分组：提示 · ；会被拒绝按严重度（✗ 错误 / ! 警告）', async () => {
    const hint = await run(['validate', dotenv(), '--grammar', 'off'])
    expect(hint.out).toMatch(/提示（1）\n {2}· /)
    const reject = await run(['validate', join(BASES, 'unsafe-svg'), '--grammar', 'off'])
    expect(reject.out).toMatch(/ {2}✗ icons\/bad\.svg/)
    expect(reject.out).toMatch(/ {2}! icons\.json/)
  })

  it('dev 档按严重度：警告是 !，不出现「提示」组', async () => {
    const r = await run(['validate', dotenv(), '--level', 'dev', '--lang', 'en'])
    expect(r.out).toContain('Warnings (1)')
    expect(r.out).toMatch(/ {2}! \(pack\)/)
    expect(r.out).not.toContain('Hints')
  })

  it('略过的文件是整份输出的最后一行（validate、pack --dry-run）', async () => {
    const dir = copyBase('pixelsky.dotenv')
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'config'), '[core]')
    writeFileSync(join(dir, '.gitignore'), 'dist\n')
    for (const argv of [
      ['validate', dir, '--grammar', 'off'],
      ['pack', dir, '--grammar', 'off', '--dry-run'],
    ]) {
      const r = await run(argv)
      const lines = r.out.trimEnd().split('\n')
      expect(lines.at(-1)).toMatch(/^略过：/)
      expect(lines.filter(l => l.startsWith('略过：'))).toHaveLength(1)
    }
  })

  it('上传档 --grammar off：提示说明因为 --grammar off 没检查；dev 档文案不变', async () => {
    const off = await run(['validate', dotenv(), '--grammar', 'off'])
    expect(off.out).toContain('没有检查（--grammar off）')
    expect(off.out).not.toContain('用 pixelsky-ext validate 检查')
    const offJson = JSON.parse((await run(['validate', dotenv(), '--grammar', 'off', '--json'])).out) as {
      grammar: { skipped: string | null }
      issues: Array<{ code: string; message: { zh: string } }>
    }
    expect(offJson.grammar.skipped).toBe('off')
    expect(offJson.issues[0]!.message.zh).toContain('--grammar off')

    const dev = JSON.parse((await run(['validate', dotenv(), '--level', 'dev', '--json'])).out) as typeof offJson
    expect(dev.grammar.skipped).toBe('dev')
    expect(dev.issues[0]!.message.zh).toContain('用 pixelsky-ext validate 检查')
  })

  it('静态检查有错误：写明语法引擎没运行，JSON 有 grammar.skipped，提示不再让人去跑 validate', async () => {
    const dir = brokenGrammar()
    const r = await run(['validate', dir])
    expect(r.code).toBe(1)
    expect(r.out).toContain('语法引擎没有运行：上面有错误')
    const en = await run(['validate', dir, '--lang', 'en'])
    expect(en.out).toContain('The grammar engine did not run because of the errors above')
    const j = JSON.parse((await run(['validate', dir, '--json'])).out) as {
      grammar: { skipped: string | null; grammars: unknown[] }
      issues: Array<{ code: string; message: { zh: string } }>
    }
    expect(j.grammar).toMatchObject({ skipped: 'staticErrors', grammars: [] })
    for (const i of j.issues.filter(x => x.code === 'grammar.regexUnchecked')) {
      expect(i.message.zh).not.toContain('用 pixelsky-ext validate 检查')
      expect(i.message.zh).toContain('上面有错误')
    }
  })

  it('引擎正常运行时没有 skipped', async () => {
    const j = JSON.parse((await run(['validate', dotenv(), '--json'])).out) as { grammar: { skipped: unknown } }
    expect(j.grammar.skipped).toBeNull()
  }, 30_000)

  it('dev 档没有「上传时云端另外检查」，notChecked 为空', async () => {
    const r = await run(['validate', dotenv(), '--level', 'dev'])
    expect(r.out).not.toContain('上传时云端另外检查')
    const j = JSON.parse((await run(['validate', dotenv(), '--level', 'dev', '--json'])).out) as {
      notChecked: string[]
    }
    expect(j.notChecked).toEqual([])
  })
})

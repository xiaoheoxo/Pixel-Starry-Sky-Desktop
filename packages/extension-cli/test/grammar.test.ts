import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExtPackManifest, ExtPackReader } from '@pixelsky/protocol/extpacks'
import { collectRegexes, neutralizeBackrefs } from '../src/lib/grammar/collect'
import { createTmEngine } from '../src/lib/grammar/engine'
import type { TmTokenizer } from '../src/lib/grammar/engine'
import { measureSample } from '../src/lib/grammar/measure'
import { checkGrammars } from '../src/lib/grammar/run'
import { withoutTiming } from './helpers/timing'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const scratch = join(repo, 'scratch', '2026-10-15-extcli', `wp3-test-${process.pid}`)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function memoryReader(files: Record<string, string>): ExtPackReader {
  const enc = new TextEncoder()
  return {
    exists: p => p in files,
    size: p => (p in files ? enc.encode(files[p]).length : null),
    readText: p => files[p] ?? null,
    readBytes: (p, max) => (p in files ? enc.encode(files[p]).slice(0, max) : null),
    list: prefix => Object.keys(files).filter(p => p.startsWith(prefix)),
  }
}

interface GrammarSpec {
  language?: string
  scopeName: string
  path: string
  samples?: string[]
  injectTo?: string[]
}
function manifestOf(grammars: GrammarSpec[]): ExtPackManifest {
  return {
    id: 'test.pack',
    name: 'Test',
    version: '1.0.0',
    publisher: 'test',
    description: '',
    license: 'MIT',
    engines: { pixelsky: '>=0.4.0' },
    contributes: { grammars: grammars.map(g => ({ samples: [], ...g })) },
  } as ExtPackManifest
}

const SIMPLE = JSON.stringify(
  {
    scopeName: 'source.demo',
    patterns: [
      { match: '^#.*$', name: 'comment.demo' },
      { match: '\\bfoo\\b', name: 'kw' },
    ],
  },
  null,
  2,
)

async function run(
  files: Record<string, string>,
  grammars: GrammarSpec[],
  mode: 'full' | 'regex' = 'full',
  extra: { now?: () => number; inactive?: number[] } = {},
) {
  return checkGrammars(manifestOf(grammars), memoryReader(files), {
    inactive: extra.inactive ?? [],
    mode,
    runner: 'inline',
    ...(extra.now ? { now: extra.now } : {}),
  })
}
const codes = (r: { issues: Array<{ code: string }> }): string[] => r.issues.map(i => i.code)
/** 用真实引擎跑的用例：去掉测速类问题再比（慢的 CI 机器上会多一条测速提示，helpers/timing.ts） */
const stableCodes = (r: { issues: Array<{ code: string }> }): string[] => withoutTiming(r.issues).map(i => i.code)

describe('collectRegexes', () => {
  it('walks patterns, repository, injections and captures with JSON pointers', () => {
    const grammar = {
      patterns: [
        { match: 'a' },
        {
          begin: 'b',
          end: 'c',
          beginCaptures: { '1': { patterns: [{ match: 'in-begin-capture' }] } },
          patterns: [{ while: 'w', match: undefined }],
        },
      ],
      repository: {
        'a/b~c': { match: 'esc', captures: { '0': { patterns: [{ match: 'cap' }] } } },
      },
      injections: { 'L:source.x': { patterns: [{ match: 'inj' }] } },
    }
    const got = collectRegexes(grammar)
    expect(got).toEqual([
      { pointer: '/patterns/0/match', source: 'a', kind: 'match' },
      { pointer: '/patterns/1/begin', source: 'b', kind: 'begin' },
      { pointer: '/patterns/1/end', source: 'c', kind: 'end' },
      { pointer: '/patterns/1/beginCaptures/1/patterns/0/match', source: 'in-begin-capture', kind: 'match' },
      { pointer: '/patterns/1/patterns/0/while', source: 'w', kind: 'while' },
      { pointer: '/repository/a~1b~0c/match', source: 'esc', kind: 'match' },
      { pointer: '/repository/a~1b~0c/captures/0/patterns/0/match', source: 'cap', kind: 'match' },
      { pointer: '/injections/L:source.x/patterns/0/match', source: 'inj', kind: 'match' },
    ])
  })

  it('tolerates garbage', () => {
    expect(collectRegexes(null)).toEqual([])
    expect(collectRegexes([])).toEqual([])
    expect(collectRegexes({ patterns: 'x', repository: [1], injections: 3 })).toEqual([])
  })
})

describe('neutralizeBackrefs', () => {
  it('replaces \\1..\\99 and leaves escaped backslashes alone', () => {
    expect(neutralizeBackrefs('\\1')).toBe('(?:)')
    expect(neutralizeBackrefs('a\\12b')).toBe('a(?:)b')
    expect(neutralizeBackrefs('\\\\1')).toBe('\\\\1')
    expect(neutralizeBackrefs('\\\\\\2')).toBe('\\\\(?:)')
    expect(neutralizeBackrefs('\\0 \\d \\k<x>')).toBe('\\0 \\d \\k<x>')
    expect(neutralizeBackrefs('trailing\\')).toBe('trailing\\')
  })
})

describe('engine', () => {
  it('compileError returns the Oniguruma message or null', async () => {
    const engine = await createTmEngine()
    expect(engine.compileError('[abc')).toMatch(/\S/)
    expect(engine.compileError('(?<x>a)\\k<x>')).toBeNull()
    expect(engine.compileError('^\\s*#')).toBeNull()
  })

  it('tokenizes with state', async () => {
    const engine = await createTmEngine()
    const tok = await engine.tokenizer('source.demo', [{ scopeName: 'source.demo', text: SIMPLE }])
    expect(tok).not.toBeNull()
    const r = tok!.line('# hi', tok!.initial, 1000)
    expect(r.stoppedEarly).toBe(false)
    expect(await engine.tokenizer('source.other', [{ scopeName: 'source.demo', text: SIMPLE }])).toBeNull()
  })
})

// 假分词器：每行按内容推进一个假时钟，now 读这个时钟
function fakeClock(cost: (text: string, call: number) => number) {
  let clock = 0
  const calls = new Map<string, number>()
  const tok: TmTokenizer = {
    initial: null,
    line(text) {
      const n = (calls.get(text) ?? 0) + 1
      calls.set(text, n)
      clock += cost(text, n)
      return { state: null, stoppedEarly: false }
    },
  }
  return { tok, now: () => clock }
}

describe('measureSample', () => {
  it('repeats short samples cyclically up to stressLines and keeps original line numbers', () => {
    const { tok, now } = fakeClock(() => 0.01)
    const m = measureSample(tok, 'a\nb\nc\n', 's.txt', now)
    expect(m.sourceLines).toBe(3)
    expect(m.lines).toBe(5000)
    expect(m.budgetMs).toBe(1000)
    expect(m.slow).toEqual([])
    expect(m.totalMs).toBeCloseTo(50, 3)
  })

  it('uses long samples as they are and scales the budget by lines / 5000', () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n')
    const { tok, now } = fakeClock(() => 0.15)
    const m = measureSample(tok, text, 's.txt', now)
    expect(m.lines).toBe(10_000)
    expect(m.budgetMs).toBe(2000)
    expect(m.totalMs).toBeCloseTo(1500, 0) // 超过 1000 但没超缩放后的预算
  })

  it('skips lines over lineChars', () => {
    const { tok, now } = fakeClock(() => 0.01)
    const m = measureSample(tok, `${'x'.repeat(10_001)}\nshort`, 's.txt', now)
    expect(m.sourceLines).toBe(2)
    expect(m.lines).toBe(2500)
  })

  it('reports slow lines by original line number, slowest first, at most 3', () => {
    const { tok, now } = fakeClock(text => (text.startsWith('slow') ? 50 + Number(text.slice(4)) : 0.01))
    const lines = ['ok', ...Array.from({ length: 6 }, (_, i) => `slow${i}`), 'ok']
    const m = measureSample(tok, lines.join('\n'), 's.txt', now)
    expect(m.slow).toEqual([
      { line: 7, ms: 55 },
      { line: 6, ms: 54 },
      { line: 5, ms: 53 },
    ])
    expect(m.slowestLine).toBe(7)
    expect(m.slowestMs).toBe(55)
  })

  it('re-measures a slow line twice and keeps the minimum (a one-off spike is not slow)', () => {
    // 第一次测到 100 毫秒，重测都是 1 毫秒：不算慢
    const seen = new Map<string, number>()
    const { tok, now } = fakeClock((text, call) => {
      const k = (seen.get(text) ?? 0) + 1
      seen.set(text, k)
      void call
      return text === 'spike' && k === 2 ? 100 : 1 // k=1 是预热，k=2 是正式测的第一次
    })
    const m = measureSample(tok, 'spike', 's.txt', now)
    expect(m.slow).toEqual([])
    expect(m.slowestMs).toBe(1)
  })

  it('re-measures the whole pass once when over budget and keeps the minimum total', () => {
    let pass = 0
    const { tok, now } = fakeClock((text, call) => {
      void text
      void call
      return 0.3
    })
    const wrapped: TmTokenizer = {
      initial: null,
      line(text, state, limit) {
        pass += 1
        return tok.line(text, state, limit)
      },
    }
    const m = measureSample(wrapped, 'x', 's.txt', now)
    // 5000 行 * 0.3 = 1500 > 1000：重测一遍，两遍一样，取最小
    expect(m.totalMs).toBeCloseTo(1500, 0)
    expect(pass).toBe(1 + 5000 + 5000) // 预热 + 两遍
  })

  it('reports nothing for an empty sample', () => {
    const { tok, now } = fakeClock(() => 1)
    const m = measureSample(tok, '', 's.txt', now)
    expect(m.slow).toEqual([])
    expect(m.sourceLines).toBe(1)
  })
})

describe('checkGrammars (inline, real Oniguruma)', () => {
  const spec: GrammarSpec = { language: 'demo', scopeName: 'source.demo', path: 'g.json', samples: ['s.txt'] }

  it('passes a clean grammar and records the measurement', async () => {
    const r = await run({ 'g.json': SIMPLE, 's.txt': '# a\nfoo bar\n' }, [spec])
    expect(stableCodes(r)).toEqual([])
    expect(r.results).toHaveLength(1)
    expect(r.results[0]).toMatchObject({ index: 0, scopeName: 'source.demo', regexes: 2 })
    expect(r.results[0].samples[0]).toMatchObject({ path: 's.txt', sourceLines: 2, lines: 5000 })
  })

  it('reports an uncompilable regex with pointer, line and column', async () => {
    const text = '{\n  "scopeName": "source.demo",\n  "patterns": [\n    { "match": "[abc" }\n  ]\n}\n'
    const r = await run({ 'g.json': text, 's.txt': 'x' }, [spec])
    expect(codes(r)).toEqual(['grammar.regex'])
    const issue = r.issues[0]
    expect(issue.severity).toBe('error')
    expect(issue.contribution).toEqual({ kind: 'grammars', index: 0 })
    expect(issue.loc).toMatchObject({ file: 'g.json', pointer: '/patterns/0/match' })
    expect(issue.loc?.line).toBe(4)
    expect(issue.loc?.column).toBe(16)
    // 编译失败的语法不测分词速度
    expect(r.results[0].samples).toEqual([])
  })

  it('accepts named backreferences and neutralizes begin-capture backrefs in end / while', async () => {
    const text = JSON.stringify({
      scopeName: 'source.demo',
      patterns: [
        { match: '(?<x>a)\\k<x>' },
        { begin: '(<<)(\\w+)', end: '^\\2$', name: 'heredoc' },
        { begin: '(```)', while: '^\\1' },
      ],
    })
    const r = await run({ 'g.json': text, 's.txt': 'aa\n<<EOF\nbody\nEOF\n' }, [spec])
    expect(stableCodes(r)).toEqual([])
  })

  it('does not neutralize an escaped backslash followed by a digit in end', async () => {
    // end 里的 \\1 是「字面反斜杠 + 1」，原样编译，没问题
    const text = JSON.stringify({ scopeName: 'source.demo', patterns: [{ begin: 'a', end: '\\\\1' }] })
    expect(codes(await run({ 'g.json': text }, [{ ...spec, samples: [] }]))).toEqual([])
  })

  it('caps regex issues at 20 and merges the rest', async () => {
    const text = JSON.stringify({
      scopeName: 'source.demo',
      patterns: Array.from({ length: 25 }, () => ({ match: '[abc' })),
    })
    const r = await run({ 'g.json': text }, [{ ...spec, samples: [] }])
    expect(codes(r)).toEqual(Array(21).fill('grammar.regex'))
    expect(r.issues[20].message.zh).toContain('还有 5 条')
  })

  it('skips inactive grammars and unparseable grammar files', async () => {
    expect(codes(await run({ 'g.json': '{ nope' }, [spec]))).toEqual([])
    const bad = JSON.stringify({ scopeName: 'source.demo', patterns: [{ match: '[abc' }] })
    expect(codes(await run({ 'g.json': bad }, [spec], 'full', { inactive: [0] }))).toEqual([])
  })

  it('regex mode compiles only and adds one perfUnchecked', async () => {
    const r = await run({ 'g.json': SIMPLE, 's.txt': 'x' }, [spec], 'regex')
    expect(codes(r)).toEqual(['grammar.perfUnchecked'])
    expect(r.issues[0].scope).toBe('pack')
    expect(r.results[0].samples).toEqual([])
    const bad = JSON.stringify({ scopeName: 'source.demo', patterns: [{ match: '[abc' }] })
    expect(codes(await run({ 'g.json': bad }, [spec], 'regex'))).toEqual(['grammar.regex', 'grammar.perfUnchecked'])
  })

  it('tokenizes an injection grammar with its in-pack host, compiles it alone otherwise', async () => {
    const host = JSON.stringify({ scopeName: 'source.host', patterns: [{ match: 'host' }] })
    const inj = JSON.stringify({
      scopeName: 'inject.demo',
      injectionSelector: 'L:source.host',
      patterns: [{ match: 'todo' }],
    })
    const files = { 'h.json': host, 'i.json': inj, 's.txt': 'host todo\n' }
    const hostSpec: GrammarSpec = { language: 'host', scopeName: 'source.host', path: 'h.json' }
    const injSpec: GrammarSpec = {
      scopeName: 'inject.demo',
      path: 'i.json',
      injectTo: ['source.host'],
      samples: ['s.txt'],
    }
    const withHost = await run(files, [hostSpec, injSpec])
    expect(stableCodes(withHost)).toEqual([])
    expect(withHost.results[1].samples).toHaveLength(1)
    const alone = await run(files, [injSpec])
    expect(stableCodes(alone)).toEqual([])
    expect(alone.results[0]).toMatchObject({ regexes: 1, samples: [] })
  })

  it('drives slowLine (capped at 3), slowTotal and the near-limit hint from an injected clock', async () => {
    let t = 0
    const slowAll = await run(
      { 'g.json': SIMPLE, 's.txt': Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') },
      [spec],
      'full',
      {
        now: () => (t += 50),
      },
    )
    const c = codes(slowAll)
    expect(c.filter(x => x === 'grammar.slowLine')).toHaveLength(3)
    expect(c).toContain('grammar.slowTotal')
    const slow = slowAll.issues.filter(i => i.code === 'grammar.slowLine')
    expect(slow.map(i => i.loc?.line)).toEqual([1, 2, 3])
    expect(slow.every(i => i.severity === 'warning' && i.upload === 'reject' && i.loc?.file === 's.txt')).toBe(true)
  })

  it('gives perfNearLimit when the slowest line is over half the limit and nothing else is slow', async () => {
    // 每次 now() 推进 0.001 毫秒，只有第 4 次调用（第二行的结束）多走 20 毫秒：20 毫秒 < 30，不重测，也不算慢
    let calls = 0
    let t = 0
    const r = await run({ 'g.json': SIMPLE, 's.txt': 'a\nb' }, [spec], 'full', {
      now: () => {
        calls += 1
        t += calls === 4 ? 20 : 0.001
        return t
      },
    })
    expect(codes(r)).toEqual(['grammar.perfNearLimit'])
    expect(r.issues[0]).toMatchObject({ severity: 'warning', upload: 'hint' })
    expect(r.issues[0].loc).toMatchObject({ file: 's.txt', line: 2 })
  })
})

// ---- 打包产物里的 worker 路径（真 worker + 硬超时） ----

describe('worker runner (bundled)', () => {
  let bundle: string | null = null

  async function bundled(): Promise<string> {
    if (bundle) return bundle
    mkdirSync(scratch, { recursive: true })
    const entry = join(scratch, 'entry.ts')
    const src = (p: string): string => JSON.stringify(join(here, '..', 'src', p).replaceAll('\\', '/'))
    writeFileSync(
      entry,
      [
        "import { readFileSync } from 'node:fs'",
        "import { isMainThread, workerData } from 'node:worker_threads'",
        `import { checkGrammars } from ${src('lib/grammar/run')}`,
        `import { GRAMMAR_WORKER_KIND, grammarWorkerMain } from ${src('lib/grammar/worker')}`,
        'if (!isMainThread && workerData?.kind === GRAMMAR_WORKER_KIND) {',
        '  await grammarWorkerMain()',
        '} else {',
        "  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'))",
        '  const files = input.files',
        '  const reader = {',
        '    exists: p => p in files, size: () => 0, readText: p => files[p] ?? null,',
        '    readBytes: () => null, list: () => [],',
        '  }',
        "  const r = await checkGrammars(input.manifest, reader, { inactive: [], mode: input.mode ?? 'full', runner: 'worker', hangMs: input.hangMs, workerUrl: new URL(import.meta.url) })",
        '  console.log(JSON.stringify({ codes: r.issues.map(i => i.code), issues: r.issues, results: r.results }))',
        '}',
      ].join('\n'),
    )
    const out = join(scratch, 'bundle.mjs')
    // build.mjs 没有类型声明，动态导入
    const mod = (await import(pathToFileURL(join(here, '..', 'scripts', 'build.mjs')).href)) as {
      build(o: { outfile: string; entry: string; quiet: boolean }): Promise<unknown>
    }
    await mod.build({ outfile: out, entry, quiet: true })
    bundle = out
    return out
  }

  function runBundle(file: string, input: object) {
    const inputFile = join(scratch, `input-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(inputFile, JSON.stringify(input))
    const env = { ...process.env }
    delete env['PIXELSKY_EXT_HANG_MS']
    const r = spawnSync(process.execPath, [file, inputFile], { encoding: 'utf8', env, timeout: 50_000 })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  it('measures a sample in a real worker', async () => {
    const file = await bundled()
    const spec: GrammarSpec = { language: 'demo', scopeName: 'source.demo', path: 'g.json', samples: ['s.txt'] }
    const r = runBundle(file, { manifest: manifestOf([spec]), files: { 'g.json': SIMPLE, 's.txt': '# a\nfoo\n' } })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout) as { codes: string[]; results: Array<{ samples: Array<{ lines: number }> }> }
    expect(withoutTiming(out.codes.map(code => ({ code }))).map(i => i.code)).toEqual([])
    expect(out.results[0].samples[0].lines).toBe(5000)
  }, 60_000)

  it('terminates a catastrophic regex after the hard timeout and keeps going', async () => {
    const file = await bundled()
    const evil = JSON.stringify({ scopeName: 'source.evil', patterns: [{ match: '(a+)+$' }] })
    const specs: GrammarSpec[] = [
      { language: 'evil', scopeName: 'source.evil', path: 'evil.json', samples: ['evil.txt'] },
      { language: 'demo', scopeName: 'source.demo', path: 'g.json', samples: ['s.txt'] },
    ]
    const started = Date.now()
    const r = runBundle(file, {
      manifest: manifestOf(specs),
      files: { 'evil.json': evil, 'evil.txt': `${'a'.repeat(5000)}b\n`, 'g.json': SIMPLE, 's.txt': '# a\n' },
      hangMs: 1500,
    })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(Date.now() - started).toBeLessThan(40_000)
    const out = JSON.parse(r.stdout) as {
      issues: Array<{ code: string; path?: string; contribution?: { index: number } }>
      results: Array<{ samples: unknown[] }>
    }
    const hang = out.issues.filter(i => i.code === 'grammar.hang')
    expect(hang).toHaveLength(1)
    expect(hang[0].path).toBe('evil.txt')
    expect(hang[0].contribution?.index).toBe(0)
    // 终止后起了新 worker，第二个语法照常测完
    expect(out.results[1].samples).toHaveLength(1)
  }, 60_000)
})

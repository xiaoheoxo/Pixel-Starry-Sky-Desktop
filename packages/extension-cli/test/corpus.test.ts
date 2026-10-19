import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkPack, checkVerdict, EXT_ISSUE_CODES } from '@pixelsky/protocol/extpacks'
import type { ExtPackIssue } from '@pixelsky/protocol/extpacks'
import { checkInput } from '../src/lib/check'
import { readPackZip } from '../src/lib/zip-read'
import {
  CORPUS_DIR,
  REPO_ROOT,
  SymlinkUnsupported,
  canSymlink,
  caseTree,
  caseZipBytes,
  devCheck,
  expectOf,
  listCases,
  materializeFolder,
  memoryPackFiles,
  normalizeDev,
  normalizeIssues,
  writeExpect,
} from '../src/testing/corpus'
import type { CorpusCase, CorpusExpect } from '../src/testing/corpus'
import { withoutTiming } from './helpers/timing'

const UPDATE = process.env.CORPUS_UPDATE === '1'
const TIMEOUT = 60_000

/**
 * 没有用例的代码（见 corpus/extpacks/README.md「豁免」）：
 * - pack.duplicateId：只有多扩展并存时服务才会产生
 * - pack.storeBlocked：只有停用名单命中文件夹扩展时服务才会产生
 * - pack.validate、validate.internal：校验器自己崩溃的兜底，没有输入能触发
 * - grammar.hang、grammar.slowLine、grammar.slowTotal、grammar.perfNearLimit：和机器速度有关，由 grammar.test.ts / bundle.test.ts 覆盖
 */
const EXEMPT_CODES = new Set([
  'pack.duplicateId',
  'pack.storeBlocked',
  'pack.validate',
  'validate.internal',
  'grammar.hang',
  'grammar.slowLine',
  'grammar.slowTotal',
  'grammar.perfNearLimit',
])

const cases = listCases()
const scratch = join(REPO_ROOT, 'scratch', `extcli-corpus-${process.pid}`)
let symlinkOk = false

beforeAll(() => {
  mkdirSync(scratch, { recursive: true })
  symlinkOk = canSymlink(scratch)
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const mode = (c: CorpusCase): 'off' | 'regex' | 'full' => c.grammar ?? 'off'
const hasSymlink = (c: CorpusCase): boolean => c.needs?.includes('symlink') === true

function mustExpect(c: CorpusCase): CorpusExpect {
  const e = expectOf(c)
  if (!e) throw new Error(`${c.name} 没有期望文件：用 CORPUS_UPDATE=1 生成，并逐条核对`)
  return e
}

function uploadOf(issues: ExtPackIssue[]): NonNullable<CorpusExpect['upload']> {
  return {
    pass: checkVerdict(issues, { level: 'upload' }).pass,
    issues: normalizeIssues(withoutTiming(issues), true),
  }
}

/** 一个用例在内存里（不经过磁盘）算出的结果；语法引擎模式不是 off 的文件夹用例没有内存版的上传结果 */
function memoryResult(c: CorpusCase): Omit<CorpusExpect, 'rulesVersion'> {
  if (c.input === 'zip') {
    const files = readPackZip(caseZipBytes(c))
    return { upload: uploadOf(checkPack(files, { source: 'folder' }).issues) }
  }
  const out: Omit<CorpusExpect, 'rulesVersion'> = { dev: normalizeDev(devCheck(c)) }
  if (mode(c) === 'off') out.upload = uploadOf(checkPack(memoryPackFiles(c), { source: 'folder' }).issues)
  return out
}

async function folderRun(c: CorpusCase): Promise<Omit<CorpusExpect, 'rulesVersion'>> {
  const root = materializeFolder(c, scratch)
  try {
    const dev = await checkInput(root, { level: 'dev', grammar: 'off', appVersion: c.appVersion ?? '0.4.1-beta' })
    const up = await checkInput(root, { level: 'upload', grammar: mode(c), runner: 'inline' })
    return { dev: normalizeDev(dev.check), upload: uploadOf(up.check.issues) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('用例文件', () => {
  it('每个用例有标题、意图，名字带数字前缀且不重复', () => {
    expect(cases.length).toBeGreaterThan(50)
    const names = new Set<string>()
    for (const c of cases) {
      expect(c.name, c.name).toMatch(/^\d{3}-[a-z0-9-]+$/)
      expect(names.has(c.name), `重复：${c.name}`).toBe(false)
      names.add(c.name)
      expect(c.title.length, c.name).toBeGreaterThan(0)
      expect(Array.isArray(c.expectCodes), `${c.name} 缺 expectCodes`).toBe(true)
      expect(['folder', 'zip']).toContain(c.input)
    }
  })

  it('没有多余的期望文件；每个用例都有期望文件', () => {
    if (UPDATE) return
    const expects = readdirSync(join(CORPUS_DIR, 'cases')).filter(f => f.endsWith('.expect.json'))
    expect(expects.sort()).toEqual(cases.map(c => `${c.name}.expect.json`))
  })

  it('用例引用的底板都存在，文件树能算出来', () => {
    for (const c of cases) {
      if (c.base) expect(existsSync(join(CORPUS_DIR, 'bases', c.base)), c.name).toBe(true)
      expect(() => caseTree(c), c.name).not.toThrow()
    }
  })

  it('每个代码都有用例（豁免见 README）；豁免的代码确实没有用例', () => {
    if (UPDATE) return
    const seen = new Set<string>()
    for (const c of cases) {
      const e = mustExpect(c)
      for (const i of [...(e.dev?.issues ?? []), ...(e.upload?.issues ?? [])]) seen.add(i.code)
    }
    const missing = EXT_ISSUE_CODES.filter(code => !seen.has(code) && !EXEMPT_CODES.has(code))
    expect(missing).toEqual([])
    const stale = [...EXEMPT_CODES].filter(code => seen.has(code))
    expect(stale, '这些代码已经有用例了，请从豁免里去掉').toEqual([])
  })

  it('每个用例的 expectCodes 都出现在它的期望里（意图检查）', () => {
    if (UPDATE) return
    for (const c of cases) {
      const e = mustExpect(c)
      const codes = new Set([...(e.dev?.issues ?? []), ...(e.upload?.issues ?? [])].map(i => i.code))
      for (const want of c.expectCodes ?? []) expect(codes.has(want), `${c.name} 期望出现 ${want}`).toBe(true)
    }
  })

  it('用例里「期望没有问题」的写法没有被偷偷改成别的', () => {
    if (UPDATE) return
    // expectCodes 为空数组的用例：上传级别必须没有任何问题
    for (const c of cases.filter(x => (x.expectCodes ?? []).length === 0 && x.input === 'folder')) {
      const e = mustExpect(c)
      if (e.upload) expect(e.upload.issues, `${c.name} 上传级别应当没有问题`).toEqual([])
    }
  })

  it('docs 里的作者示例和底板逐字节一致（docs 不在仓库里时跳过）', () => {
    const docs = join(REPO_ROOT, 'docs', 'extensions', 'examples', 'pixelsky.dotenv')
    if (!existsSync(docs)) return
    const base = join(CORPUS_DIR, 'bases', 'pixelsky.dotenv')
    const list = (root: string, prefix = ''): string[] =>
      readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? list(root, `${prefix}${d.name}/`) : [`${prefix}${d.name}`],
      )
    const a = list(docs).sort()
    expect(a).toEqual(list(base).sort())
    for (const f of a) {
      expect(readFileSync(join(docs, f)).equals(readFileSync(join(base, f))), f).toBe(true)
    }
  })
})

describe('A 内存来源', () => {
  if (UPDATE) {
    it('生成期望文件（CORPUS_UPDATE=1）', { timeout: 600_000 }, async () => {
      for (const c of cases) {
        const mem = memoryResult(c)
        // 语法引擎模式不是 off 的文件夹用例：上传结果要走真正的引擎
        const full = mem.upload ? mem : { ...mem, ...(await folderRun(c)) }
        writeExpect(c, c.input === 'zip' ? { upload: full.upload } : { dev: full.dev, upload: full.upload })
      }
    })
    return
  }
  it.each(cases.map(c => [c.name, c] as const))('%s', { timeout: TIMEOUT }, (_name, c) => {
    const want = mustExpect(c)
    const got = memoryResult(c)
    expect(got.dev).toEqual(want.dev)
    if (got.upload) expect(got.upload).toEqual(want.upload)
    else expect(want.upload).toBeDefined()
  })
})

describe.skipIf(UPDATE)('B 文件夹', () => {
  const folders = cases.filter(c => c.input === 'folder')
  it.each(folders.map(c => [c.name, c] as const))('%s', { timeout: TIMEOUT }, async (_name, c) => {
    if (hasSymlink(c) && !symlinkOk) return // 这台机器不能建符号链接：内存和 zip 来源仍然覆盖
    const want = mustExpect(c)
    let got
    try {
      got = await folderRun(c)
    } catch (e) {
      if (e instanceof SymlinkUnsupported) return
      throw e
    }
    expect(got.dev).toEqual(want.dev)
    expect(got.upload).toEqual(want.upload)
  })
})

describe.skipIf(UPDATE)('C zip', () => {
  // 文件夹用例也打成 zip 检查；有符号链接或读不全（超过扫描上限）的除外，那两种在 zip 里本来就不同
  const zipped = cases.filter(c => c.input === 'zip' || (!hasSymlink(c) && !memoryPackFiles(c).truncated))
  it.each(zipped.map(c => [c.name, c] as const))('%s', { timeout: TIMEOUT }, async (_name, c) => {
    const want = mustExpect(c)
    const file = join(scratch, `${c.name}.zip`)
    writeFileSync(file, caseZipBytes(c))
    try {
      const report = await checkInput(file, { level: 'upload', grammar: mode(c), runner: 'inline' })
      expect(uploadOf(report.check.issues)).toEqual(want.upload)
    } finally {
      rmSync(file, { force: true })
    }
  })
})

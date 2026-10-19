import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkInput, ToolError, UsageError } from '../src/lib/check'
import { folderPackFiles } from '../src/lib/folder'
import { writePackZip } from '../src/lib/zip-write'
import { withoutTiming } from './helpers/timing'

const BASES = resolve(dirname(fileURLToPath(import.meta.url)), '../../protocol/corpus/extpacks/bases')
const DOTENV = join(BASES, 'pixelsky.dotenv')

const made: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pxext-check-'))
  made.push(dir)
  return dir
}
function copyBase(name: string): string {
  const dir = join(tempDir(), name)
  cpSync(join(BASES, name), dir, { recursive: true })
  return dir
}
/** 用工具自己的打包把文件夹打成 zip，写到临时文件夹里 */
async function zipOf(folder: string): Promise<string> {
  const files = await folderPackFiles(folder)
  const bytes = writePackZip(
    files,
    files.entries.map(e => e.path),
  )
  const file = join(tempDir(), 'pack.zip')
  writeFileSync(file, bytes)
  return file
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const keys = (r: { check: { issues: Array<{ code: string; path?: string }> } }): string[] =>
  r.check.issues.map(i => `${i.code}|${i.path ?? ''}`).sort()

describe('checkInput 用法错误', () => {
  it('路径不存在', async () => {
    const err = await checkInput(join(tempDir(), 'nope'), { level: 'upload', grammar: 'off' }).catch(e => e)
    expect(err).toBeInstanceOf(UsageError)
    expect(err.en).toMatch(/does not exist/)
  })

  it('既不是文件夹也不是 .zip', async () => {
    const file = join(tempDir(), 'a.txt')
    writeFileSync(file, 'x')
    await expect(checkInput(file, { level: 'upload', grammar: 'off' })).rejects.toBeInstanceOf(UsageError)
  })

  it('dev 档不接受 zip', async () => {
    const zip = await zipOf(DOTENV)
    await expect(checkInput(zip, { level: 'dev', grammar: 'off' })).rejects.toBeInstanceOf(UsageError)
  })

  it('dev 档配 --grammar full / regex 是用法错误', async () => {
    for (const grammar of ['full', 'regex'] as const) {
      await expect(checkInput(DOTENV, { level: 'dev', grammar })).rejects.toBeInstanceOf(UsageError)
    }
  })
})

describe('checkInput 流程', () => {
  it('上传档 full：编译正则并测速，结论通过', async () => {
    const r = await checkInput(DOTENV, { level: 'upload', grammar: 'full', runner: 'inline' })
    expect(r.input.kind).toBe('folder')
    expect(r.input.bytes).toBeNull()
    expect(r.verdict.pass).toBe(true)
    expect(withoutTiming(r.check.issues)).toEqual([])
    expect(r.grammar).toHaveLength(1)
    expect(r.grammar![0]!.regexes).toBeGreaterThan(0)
    expect(r.grammar![0]!.samples[0]!.lines).toBe(5000)
  }, 30_000)

  it('上传档 regex：只编译，多一条 grammar.perfUnchecked', async () => {
    const r = await checkInput(DOTENV, { level: 'upload', grammar: 'regex', runner: 'inline' })
    expect(r.check.issues.map(i => i.code)).toEqual(['grammar.perfUnchecked'])
    expect(r.grammar![0]!.samples).toEqual([])
    expect(r.verdict.pass).toBe(true)
  })

  it('上传档 off：不跑引擎，留一条 grammar.regexUnchecked', async () => {
    const r = await checkInput(DOTENV, { level: 'upload', grammar: 'off' })
    expect(r.grammar).toBeNull()
    expect(r.check.issues.map(i => i.code)).toEqual(['grammar.regexUnchecked'])
    expect(r.appVersion).toBeNull()
  })

  it('dev 档：不跑引擎，只剩 grammar.regexUnchecked，带 appVersion', async () => {
    const r = await checkInput(DOTENV, { level: 'dev', grammar: 'off', appVersion: '0.4.1-beta' })
    expect(r.grammar).toBeNull()
    expect(r.appVersion).toBe('0.4.1-beta')
    expect(r.check.issues.map(i => i.code)).toEqual(['grammar.regexUnchecked'])
    expect(r.verdict.pass).toBe(true)
  })

  it('dev 档按 --app-version 判断 engines.pixelsky', async () => {
    const r = await checkInput(DOTENV, { level: 'dev', grammar: 'off', appVersion: '0.3.0' })
    expect(r.check.issues.some(i => i.code === 'manifest.engineUnmet')).toBe(true)
    expect(r.verdict.pass).toBe(false)
  })

  it('上传档不判断 engineUnmet', async () => {
    const r = await checkInput(DOTENV, { level: 'upload', grammar: 'off', appVersion: '0.3.0' })
    expect(r.check.issues.some(i => i.code === 'manifest.engineUnmet')).toBe(false)
  })

  it('清单有错时不跑引擎', async () => {
    const r = await checkInput(join(BASES, 'bad-manifest'), { level: 'upload', grammar: 'full', runner: 'inline' })
    expect(r.grammar).toBeNull()
    expect(r.check.status).toBe('error')
    expect(r.verdict.pass).toBe(false)
  })

  it('略过 .git / 点文件：不报问题，列在 skipped', async () => {
    const dir = copyBase('pixelsky.dotenv')
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'config'), '[core]')
    writeFileSync(join(dir, '.gitignore'), 'dist\n')
    const r = await checkInput(dir, { level: 'upload', grammar: 'off' })
    expect(r.skipped.sort()).toEqual(['.git/', '.gitignore'])
    expect(r.check.issues.map(i => i.code)).toEqual(['grammar.regexUnchecked'])
  })

  it('--strict：提示也算不通过', async () => {
    const loose = await checkInput(DOTENV, { level: 'upload', grammar: 'off' })
    const strict = await checkInput(DOTENV, { level: 'upload', grammar: 'off', strict: true })
    expect(loose.verdict.pass).toBe(true)
    expect(strict.strict).toBe(true)
    expect(strict.verdict.pass).toBe(false)
  })
})

describe('文件夹和 zip 同一个扩展', () => {
  it('静态规则的结果相同', async () => {
    const folder = await checkInput(DOTENV, { level: 'upload', grammar: 'off' })
    const zip = await checkInput(await zipOf(DOTENV), { level: 'upload', grammar: 'off' })
    expect(zip.input.kind).toBe('zip')
    expect(zip.input.bytes).toBeGreaterThan(0)
    expect(keys(zip)).toEqual(keys(folder))
    expect([...zip.check.files]).toEqual([...folder.check.files])
    expect(zip.check.status).toBe(folder.check.status)
    expect(zip.skipped).toEqual([])
  })

  it('zip 也跑语法引擎', async () => {
    const r = await checkInput(await zipOf(DOTENV), { level: 'upload', grammar: 'regex', runner: 'inline' })
    expect(r.grammar).toHaveLength(1)
    expect(r.verdict.pass).toBe(true)
  })

  it('坏 zip：zip.invalid，结论不通过', async () => {
    const file = join(tempDir(), 'bad.zip')
    writeFileSync(file, 'not a zip at all')
    const r = await checkInput(file, { level: 'upload', grammar: 'full', runner: 'inline' })
    expect(r.check.issues.map(i => i.code)).toContain('zip.invalid')
    expect(r.grammar).toBeNull()
    expect(r.verdict.pass).toBe(false)
  })
})

describe('checkInput workerUrl', () => {
  it('runner 为 worker 时，语法 worker 跑的是传进来的 workerUrl', async () => {
    // 这个 worker 一启动就报 fatal：只要被它拿去跑，checkInput 就抛带这句话的 ToolError
    const file = join(tempDir(), 'fake-worker.mjs')
    writeFileSync(
      file,
      "import { parentPort } from 'node:worker_threads'\nparentPort.postMessage({ type: 'fatal', error: 'custom-worker-used' })\n",
    )
    const err = await checkInput(DOTENV, {
      level: 'upload',
      grammar: 'full',
      runner: 'worker',
      workerUrl: pathToFileURL(file),
    }).catch(e => e)
    expect(err).toBeInstanceOf(ToolError)
    expect(err.message).toContain('custom-worker-used')
  }, 30_000)
})

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkInput } from '@pixelsky/extension-cli/check'
import type { CheckInputOptions } from '@pixelsky/extension-cli/check'
import { folderPackFiles } from '@pixelsky/extension-cli/folder'
import { writePackZip } from '@pixelsky/extension-cli/zip'
import { handleCheck } from './ext-check'

const DOTENV = join(__dirname, '../../../../packages/protocol/corpus/extpacks/bases/pixelsky.dotenv')

const made: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pxext-worker-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function zipBytes(folder: string): Promise<Uint8Array> {
  const files = await folderPackFiles(folder)
  return writePackZip(
    files,
    files.entries.map(e => e.path),
  )
}

/** 测速耗时和机器快慢有关，比较前去掉（grammar.slowLine 等问题和样例的毫秒数） */
function stable(report: { check: { issues: Array<{ code: string }> }; grammar: unknown }) {
  const grammar = (
    report.grammar as Array<{ regexes: number | null; scopeName: string; samples: unknown[] }> | null
  )?.map(g => ({ scopeName: g.scopeName, regexes: g.regexes, samples: g.samples.length }))
  return {
    issues: report.check.issues.filter(i => !i.code.startsWith('grammar.slow') && i.code !== 'grammar.perfNearLimit'),
    grammar,
  }
}

describe('handleCheck', () => {
  it('按上传档 full 检查，runner 是 worker 并带上 workerUrl；报告里没有带函数的 files 和本机路径', async () => {
    const calls: Array<{ path: string; opts: CheckInputOptions }> = []
    const url = new URL('file:///x/ext-check.js')
    const report = await handleCheck(await zipBytes(DOTENV), tempDir(), {
      workerUrl: url,
      check: (path, opts) => {
        calls.push({ path, opts })
        return checkInput(path, { ...opts, runner: 'inline' })
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts).toMatchObject({ level: 'upload', grammar: 'full', runner: 'worker' })
    expect(calls[0]!.opts.workerUrl).toBe(url)
    expect(report).not.toHaveProperty('files')
    expect(report.input).toEqual({ kind: 'zip', bytes: expect.any(Number) })
    expect(structuredClone(report).verdict.pass).toBe(true)
  }, 30_000)

  it('和 checkInput(inline) 对同一个 zip 的结果一致', async () => {
    const dir = tempDir()
    const bytes = await zipBytes(DOTENV)
    const expected = await (async () => {
      const { writeFileSync } = await import('node:fs')
      const file = join(dir, 'same.zip')
      writeFileSync(file, bytes)
      return checkInput(file, { level: 'upload', grammar: 'full', runner: 'inline' })
    })()
    const actual = await handleCheck(bytes, join(dir, 'tmp'), {
      check: (path, opts) => checkInput(path, { ...opts, runner: 'inline' }),
    })
    expect(stable(actual)).toEqual(stable(expected))
    // verdict.counts 里算上了测速问题（慢的机器上两次检查可能一次超线一次没超），只比结论和阻塞数；其余问题上一行已经比过
    expect({ pass: actual.verdict.pass, blocking: actual.verdict.blocking }).toEqual({
      pass: expected.verdict.pass,
      blocking: expected.verdict.blocking,
    })
    expect(actual.grammar?.[0]?.regexes).toBeGreaterThan(0)
  }, 30_000)

  it('检查完删掉临时 zip，出错时也删，错误原样抛出', async () => {
    const tmp = join(tempDir(), 'tmp')
    await handleCheck(await zipBytes(DOTENV), tmp, { check: (p, o) => checkInput(p, { ...o, runner: 'inline' }) })
    expect(readdirSync(tmp)).toEqual([])
    const err = new Error('boom')
    await expect(handleCheck(new Uint8Array([1]), tmp, { check: () => Promise.reject(err) })).rejects.toBe(err)
    expect(readdirSync(tmp)).toEqual([])
  }, 30_000)

  it('不是 zip 的字节：报告里有 zip 层的问题，结论不通过，不抛错', async () => {
    const report = await handleCheck(new Uint8Array([1, 2, 3, 4]), tempDir(), {
      check: (p, o) => checkInput(p, { ...o, runner: 'inline' }),
    })
    expect(report.verdict.pass).toBe(false)
  })
})

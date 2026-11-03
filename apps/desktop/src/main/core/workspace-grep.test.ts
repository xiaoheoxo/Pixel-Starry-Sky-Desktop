// 内容搜索的查询形状：旧版字符串照旧，新版带区分大小写 / 整词 / 正则（docs/ui/coding-tier1.md §3）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { grepQuery, grepWorkspace } from './workspace-grep'

let folder: string
beforeEach(async () => {
  const scratch = resolve('../../scratch')
  await mkdir(scratch, { recursive: true })
  folder = await mkdtemp(join(scratch, 'grep-query-test-'))
  await writeFile(join(folder, 'a.ts'), 'const Foo = 1\nconst foobar = foo(2)\n')
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

const lines = async (query: unknown) =>
  (await grepWorkspace(folder, query)).matches.map(m => `${m.line}:${m.column}`).sort()

describe('内容搜索的查询', () => {
  it('字符串和对象都收，正则写错报 queryInvalid', () => {
    expect(grepQuery('x')).toEqual({ text: 'x', caseSensitive: false, wholeWord: false, regex: false })
    expect(grepQuery({ text: 'x', regex: true, wholeWord: 1 })).toMatchObject({ regex: true, wholeWord: false })
    expect(() => grepQuery({ text: '(a', regex: true })).toThrow('files.queryInvalid')
    expect(() => grepQuery({ text: '  ' })).toThrow('files.queryInvalid')
    expect(() => grepQuery(null)).toThrow('files.queryInvalid')
  })
  it.each([false, true])('逐个读文件 / git grep 都按开关匹配（git=%s）', async git => {
    if (git)
      try {
        execFileSync('git', ['init', '-q'], { cwd: folder })
      } catch {
        return // 没有 git 时跳过
      }
    expect(await lines('foo')).toEqual(['1:7', '2:7'])
    expect(await lines({ text: 'foo', caseSensitive: true })).toEqual(['2:7'])
    expect(await lines({ text: 'foo', wholeWord: true })).toEqual(['1:7', '2:16'])
    expect(await lines({ text: 'fo+\\(', regex: true })).toEqual(['2:16'])
    // CRLF 行尾的 $ 两边一样（git grep -P 拿到的行带 \r）
    await writeFile(join(folder, 'b.ts'), 'a;\r\nb\r\n')
    expect(await lines({ text: ';$', regex: true })).toEqual(['1:2'])
  })
  it('回溯停不下来的正则到截止时间就停，不卡住主进程', async () => {
    await writeFile(join(folder, 'a.ts'), 'ok:\nconst someLongIdentifierNameHereXyz\n')
    const started = Date.now()
    const result = await grepWorkspace(folder, { text: '(\\w+\\s?)+:', regex: true })
    expect(Date.now() - started).toBeLessThan(4500)
    expect(result).toMatchObject({ truncated: true, matches: [{ line: 1, column: 1 }] })
  }, 8000)
})

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Checks, addedLines, cleanCheckConfig, detectChecks, runCommand, textChecks } from './checks'
import type { ToolsHost } from './common'
import { checkProblems, fixRequest } from '../../../shared/types/checks'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checks-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

const git = (...args: string[]) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { windowsHide: true })
const node = (code: string) => `node -e "${code}"`

describe('识别检查命令', () => {
  it('package.json 有 check 就只跑它；没有就跑 typecheck / lint / test（默认的 test 不算）；包管理器按锁文件', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { check: 'x', test: 'vitest', lint: 'eslint' } }),
    )
    await writeFile(join(root, 'pnpm-lock.yaml'), '')
    expect(await detectChecks(root)).toEqual([{ label: 'check', command: 'pnpm run check' }])
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint', typecheck: 'tsc' },
      }),
    )
    expect((await detectChecks(root)).map(c => c.label)).toEqual(['typecheck', 'lint'])
  })
  it('没有 package.json 脚本时找 Makefile 的 check / test，再找 gradlew；都没有是空的', async () => {
    expect(await detectChecks(root)).toEqual([])
    await writeFile(join(root, 'Makefile'), 'build:\n\tgo build\ntest:\n\tgo test ./...\n')
    expect(await detectChecks(root)).toEqual([{ label: 'test', command: 'make test' }])
  })
  it('设置：命令去掉换行和空行，超过 6 条报错；没写的开关按默认', () => {
    expect(cleanCheckConfig({ commands: [' pnpm test\n', '', 'make lint'] })).toEqual({
      commands: ['pnpm test', 'make lint'],
      text: true,
      channel: true,
      page: '',
    })
    expect(cleanCheckConfig({ commands: null, text: false, channel: false })).toEqual({
      commands: null,
      text: false,
      channel: false,
      page: '',
    })
    expect(() => cleanCheckConfig({ commands: Array(7).fill('x') })).toThrow('最多 6 条')
  })
  it('设置：页面地址只收这台电脑上的', () => {
    expect(cleanCheckConfig({ page: ' localhost:5173 ' }).page).toBe('localhost:5173')
    expect(() => cleanCheckConfig({ page: 'https://example.com' })).toThrow('这台电脑')
  })
})

describe('文本检查', () => {
  it('diff 的新增行带新文件里的行号', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -3,0 +4,2 @@',
      '+one',
      '+two',
      '@@ -10 +12 @@',
      '-old',
      '+new',
    ].join('\n')
    expect(addedLines(diff).get('a.ts')).toEqual([
      { line: 4, text: 'one' },
      { line: 5, text: 'two' },
      { line: 12, text: 'new' },
    ])
  })
  it('只看这次改动：新增的 TODO、占位符、Markdown 坏链接；原来就有的不算；不是 Git 仓库时跳过', async () => {
    expect((await textChecks(root)).status).toBe('skipped')
    git('init', '-q')
    await writeFile(join(root, 'a.ts'), '// TODO old\nconst a = 1\n')
    await writeFile(join(root, 'ok.md'), '# ok\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(join(root, 'a.ts'), '// TODO old\nconst a = 1\n// FIXME new one\nconst name = "<填写名字>"\n')
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'new.md'), 'see [ok](../ok.md) and [gone](missing.md) and [web](https://x.y)\n')
    const result = await textChecks(root)
    expect(result.status).toBe('warn')
    expect(result.findings.map(f => [f.rule, f.file, f.line])).toEqual([
      ['todo', 'a.ts', 3],
      ['placeholder', 'a.ts', 4],
      ['link', 'docs/new.md', 1],
    ])
    expect(result.findings[2].text).toBe('missing.md')
    // 只看给出的文件
    expect((await textChecks(root, ['docs/new.md'])).findings.map(f => f.rule)).toEqual(['link'])
    // 项目是仓库里的子目录：只看子目录里的改动，路径相对子目录
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'b.ts'), 'x\n')
    git('add', 'sub')
    git('commit', '-qm', 'sub')
    await writeFile(join(root, 'sub', 'b.ts'), 'x\n// TODO in sub\n')
    expect((await textChecks(join(root, 'sub'))).findings.map(f => [f.file, f.line])).toEqual([['b.ts', 2]])
  })
})

describe('跑命令', () => {
  it('退出码 0 通过，非 0 失败带输出；超时结束进程', async () => {
    const far = Date.now() + 60_000
    const ok = await runCommand(root, { label: 'ok', command: node("console.log('fine')") }, far)
    expect(ok).toMatchObject({ status: 'pass', exitCode: 0 })
    const bad = await runCommand(root, { label: 'bad', command: node("console.error('boom');process.exit(3)") }, far)
    expect(bad).toMatchObject({ status: 'fail', exitCode: 3 })
    expect(bad.output).toContain('boom')
    // 命令末尾带注释时退出码照样传回来
    const commented = await runCommand(root, { label: 'c', command: `${node('process.exit(4)')} # note` }, far)
    expect(commented).toMatchObject({ status: 'fail', exitCode: 4 })
    const slow = await runCommand(root, { label: 'slow', command: node('setTimeout(()=>{},30000)') }, Date.now() + 1500)
    expect(slow.status).toBe('timeout')
  }, 90_000)

  it('Checks：频道检查关了不跑；同一目录排队；结果的问题和「让它修」的内容', async () => {
    const host = { resolve: () => ({ projectId: 'p1', name: 'p', path: root }) } as unknown as ToolsHost
    const checks = new Checks(join(root, '.store'), host)
    await checks.init()
    await checks.saveConfig('p1', { commands: [node('process.exit(1)')], text: false, channel: false })
    expect(await checks.run({ projectId: 'p1' }, { when: 'channel' })).toBeNull()
    const [a, b] = await Promise.all([checks.run({ projectId: 'p1' }), checks.run({ projectId: 'p1' })])
    expect(a!.status).toBe('done')
    // 先读设置再排队，谁先跑不定；两次不重叠
    const [first, second] = a!.at <= b!.at ? [a!, b!] : [b!, a!]
    expect(second.at).toBeGreaterThanOrEqual(first.endedAt!)
    expect(checkProblems(a!).failed).toHaveLength(1)
    expect(fixRequest(a!)).toContain('失败（退出码 1）')
    await checks.setSession('s1', true)
    expect(checks.sessionEnabled('s1')).toBe(true)
    await checks.setSession('s1', false)
    expect(checks.sessionEnabled('s1')).toBe(false)
  }, 90_000)
})

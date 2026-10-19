// 真实执行：特殊字符的目录名 / 任务名，用 taskCommand 拼出的命令实际跑 npm，标记文件要落在对的目录里。
// 没装 npm / pwsh / bash（或不在对应平台）时对应用例跳过
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RunTaskGroup } from '../../../../../shared/types/project-tools'
import { taskCommand } from './model'

vi.setConfig({ testTimeout: 120_000 })

const slashes = (path: string): string => path.replaceAll(String.fromCharCode(92), '/')
const IS_WINDOWS = process.platform === 'win32'
const found = (program: string, args: string[] = ['--version']): boolean =>
  spawnSync(program, args, { stdio: 'ignore', shell: false }).status === 0
// npm 在 Windows 上是 npm.cmd，spawnSync 直接启动不了，所以用 where / which 探测；真正的命令都在被测 shell 里跑
const HAS_NPM = spawnSync(IS_WINDOWS ? 'where' : 'which', ['npm'], { stdio: 'ignore' }).status === 0
const PWSH = found('pwsh', ['-NoProfile', '-Command', 'exit 0']) ? 'pwsh' : null
const WINDOWS_POWERSHELL = IS_WINDOWS && found('powershell', ['-NoProfile', '-Command', 'exit 0']) ? 'powershell' : null
const CMD = IS_WINDOWS && found('cmd', ['/d', '/c', 'exit 0']) ? 'cmd' : null
const BASH = found('bash', ['-c', 'exit 0']) ? 'bash' : null

// 目录名（Windows 目录名不能含 " * ? < > | : \ /，所以 ` ' ; & ( $ 空格 中文 可以；% 只在非 cmd 终端里测）
const NAMES = ['cash$box', "a'b", 'x;y', 'a&b', 'a^b', 'f(1)', 'tick`s', 'sp ace', '中文', '100%', 'a$(echo hi)b']
const TASKS = ['mark', 'do;it', 'x$y', "it's"]

// 每个目录名配一个任务名（轮流），再把每个任务名在第一个目录上各跑一遍；全组合太慢（每次都要起一个 npm）
const CASES: Array<[string, string]> = [
  ...NAMES.map((name, i) => [name, TASKS[i % TASKS.length]] as [string, string]),
  ...TASKS.map(task => [NAMES[0], task] as [string, string]),
]

let root = ''
beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'taskquote-')))
  for (const name of NAMES) {
    const dir = join(root, name)
    mkdirSync(dir)
    const scripts: Record<string, string> = {}
    // 标记文件写在 npm 执行脚本时的当前目录（= --prefix 指的目录）里
    for (const task of TASKS) scripts[task] = `node -e "require('fs').writeFileSync('marker.txt', process.cwd())"`
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts }))
  }
})
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const group = (dir: string): RunTaskGroup => ({
  kind: 'npm',
  file: `${dir}/package.json`,
  dir,
  manager: 'npm',
  tasks: [],
})

function check(
  run: (command: string) => { status: number | null; output: string },
  shell: string | undefined,
  // cmd 里 % 没法转义，taskCommand 直接拒绝，所以 cmd 不测含 % 的目录
  skip: (name: string) => boolean = () => false,
): void {
  for (const [name, task] of CASES) {
    if (skip(name)) continue
    const marker = join(root, name, 'marker.txt')
    rmSync(marker, { force: true })
    const command = taskCommand(group(name), { name: task, detail: '', line: null }, shell)
    const result = run(command)
    expect(result.status, `${command}\n${result.output}`).toBe(0)
    expect(existsSync(marker), command).toBe(true)
    expect(slashes(readFileSync(marker, 'utf8'))).toBe(slashes(join(root, name)))
  }
}

// package.json 的脚本名里有 ; $ ' 时，npm 自己在 Windows 上也能跑（脚本名只是 JSON 键）；这里只验证我们拼的命令
const runIn =
  (program: string, args: (command: string) => string[]) =>
  (command: string): { status: number | null; output: string } => {
    const r = spawnSync(program, args(command), { cwd: root, encoding: 'utf8' })
    return { status: r.status, output: `${r.stdout}${r.stderr}${r.error ?? ''}` }
  }

describe.skipIf(!HAS_NPM)('特殊字符目录 / 任务名：真实执行', () => {
  it.skipIf(!PWSH)('pwsh -Command', () => {
    check(
      runIn('pwsh', c => ['-NoProfile', '-NonInteractive', '-Command', c]),
      'pwsh',
    )
  })
  it.skipIf(!WINDOWS_POWERSHELL)('Windows PowerShell 5.1 -Command', () => {
    check(
      runIn('powershell', c => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c]),
      'powershell',
    )
  })
  it.skipIf(!CMD)('cmd /d /c（含 & ^ 的目录）', () => {
    // 整条命令外面再包一层引号，配 /s 和原样传参（verbatim），cmd 才不会改写里面的引号
    const run = (command: string): { status: number | null; output: string } => {
      const r = spawnSync('cmd', ['/d', '/s', '/c', `"${command}"`], {
        cwd: root,
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      })
      return { status: r.status, output: `${r.stdout}${r.stderr}${r.error ?? ''}` }
    }
    check(run, 'cmd', name => name.includes('%'))
  })
  it.skipIf(!BASH)('bash -c', () => {
    check(
      runIn('bash', c => ['-c', c]),
      'bash',
    )
  })
})

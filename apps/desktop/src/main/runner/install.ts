// 执行机的安装、配置、状态、升级、停用（docs/multica-learn.md §11.7）：在 SSH 辅助进程里执行（helper 的 runner:* 方法），
// 也给 `pixelsky-runner login <码>` 用。命令用 execFile，不拼 shell；执行命令从外面注入，测试里换成假的。
import { execFile } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TeamApi } from '../core/channels/team/api'
import type { RunnerConfig, RunnerStatus } from '../../shared/types/runner'
import { clearAccount, readAccount, writeAccount } from './account'
import { cleanRunnerConfig } from './config'
import { bundleVersion, nextScript, readConfig } from './files'
import { UNIT_NAME, unitText, wrapperText } from './unit'

export type Exec = (file: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>

export const execCommand: Exec = (file, args) =>
  new Promise(resolve => {
    execFile(file, args, { timeout: 60_000, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }),
    )
  })

export interface RunnerPaths {
  dir: string
  script: string
  unit: string
  wrapper: string
}

export function runnerPaths(home = homedir()): RunnerPaths {
  const dir = join(home, '.local', 'share', 'pixelsky', 'runner')
  return {
    dir,
    script: join(dir, 'runner.cjs'),
    unit: join(home, '.config', 'systemd', 'user', UNIT_NAME),
    wrapper: join(home, '.local', 'bin', 'pixelsky-runner'),
  }
}

/** 用配对码换令牌，存进 account.json（`pixelsky-runner login <码>` 和安装共用） */
export async function pairWithCode(dir: string, base: string, code: string, version: string): Promise<string> {
  const api = new TeamApi(async (method, path, body) => {
    if (path !== '/v1/teams/runners/pair') throw new Error('无效的团队接口')
    return fetch(base + path, {
      method,
      body: JSON.stringify(body ?? {}),
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
  })
  const paired = await api.pairRunner(code, version)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeAccount(dir, { base, runnerId: paired.runnerId, name: paired.name, token: paired.token })
  return paired.runnerId
}

/** linger 开着：用户没登录时用户服务也跑（重启机器后执行机自己起来） */
async function lingerOn(exec: Exec, user: string): Promise<boolean> {
  const r = await exec('loginctl', ['show-user', user, '-p', 'Linger'])
  return r.ok && /Linger=yes/.test(r.stdout)
}

export interface InstallInput {
  /** 一次性配对码 */
  code: string
  /** 云端地址 */
  base: string
  /** 桌面带的 helper 版本；执行机用自己这份 runner.cjs 的哈希 */
  helper: string
  node: string
  path: string
  user: string
}

export interface InstallResult {
  runnerId: string
  /** linger 没开成：重启机器后要登录一次执行机才会起来，机器页提示 sudo loginctl enable-linger */
  linger: boolean
}

export async function install(paths: RunnerPaths, input: InstallInput, exec: Exec): Promise<InstallResult> {
  if (process.platform !== 'linux') throw new Error('执行机第一版只支持 Linux')
  const probe = await exec('systemctl', ['--user', 'show-environment'])
  if (!probe.ok) throw new Error('这台机器没有 systemd 用户服务（容器里或没开 systemd 的 WSL 不行）')
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  copyFileSync(input.helper, paths.script)
  // 重新安装（可能换了一台桌面、换了账号）：旧配置不留，等这次装它的桌面推新的
  rmSync(join(paths.dir, 'config.json'), { force: true })
  const runnerId = await pairWithCode(paths.dir, input.base, input.code, bundleVersion(paths.script))
  writeUnit(paths, input)
  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', UNIT_NAME],
    // 已经在跑的（重新安装）也重启：旧进程手里还是作废了的令牌
    ['--user', 'restart', UNIT_NAME],
  ]) {
    const r = await exec('systemctl', args)
    if (!r.ok) throw new Error(`启动执行机失败：${(r.stderr || r.stdout).trim().slice(0, 300)}`)
  }
  await exec('loginctl', ['enable-linger', input.user])
  return { runnerId, linger: await lingerOn(exec, input.user) }
}

/** 写单元文件和小脚本；内容没变就不写（桌面每次连上都核对一次：node 路径会变） */
export function writeUnit(paths: RunnerPaths, input: { node: string; path: string }): boolean {
  const unit = unitText({ node: input.node, script: paths.script, path: input.path })
  const wrapper = wrapperText(input.node, paths.script)
  const read = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '')
  if (read(paths.unit) === unit && read(paths.wrapper) === wrapper) return false
  mkdirSync(join(paths.unit, '..'), { recursive: true })
  mkdirSync(join(paths.wrapper, '..'), { recursive: true })
  writeFileSync(paths.unit, unit)
  writeFileSync(paths.wrapper, wrapper)
  chmodSync(paths.wrapper, 0o755)
  return true
}

/** 桌面推配置：只认装它的那台桌面推的（同一账号别的桌面不来回覆盖） */
export function configure(paths: RunnerPaths, raw: unknown): RunnerConfig {
  const next = cleanRunnerConfig(raw)
  if (!next) throw new Error('执行机配置不对')
  const current = readConfig(paths.dir)
  if (current && current.installer !== next.installer) throw new Error('这台执行机是另一台电脑装的，只认那台电脑的设置')
  const file = join(paths.dir, 'config.json')
  writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 })
  renameSync(file + '.tmp', file)
  return next
}

export interface RunnerState {
  installed: boolean
  runnerId: string | null
  /** runner.cjs 的版本 */
  version: string | null
  status: RunnerStatus | null
  installer: string | null
  linger: boolean
}

export async function state(paths: RunnerPaths, user: string, exec: Exec): Promise<RunnerState> {
  const installed = existsSync(paths.script) && existsSync(paths.unit)
  let status: RunnerStatus | null = null
  try {
    status = JSON.parse(readFileSync(join(paths.dir, 'status.json'), 'utf8')) as RunnerStatus
  } catch {
    status = null
  }
  return {
    installed,
    runnerId: readAccount(paths.dir)?.runnerId ?? null,
    version: installed ? bundleVersion(paths.script) : null,
    status,
    installer: readConfig(paths.dir)?.installer ?? null,
    linger: installed ? await lingerOn(exec, user) : false,
  }
}

/** 升级：把新的 helper 放成 runner.next.cjs，执行机手上没活时自己换上、退出，systemd 拉起新版本 */
export function stageUpgrade(paths: RunnerPaths, helper: string): void {
  copyFileSync(helper, nextScript(paths.script))
}

/** 停用：停服务、删单元文件和小脚本、删令牌；数据目录（会话、副本）留着 */
export async function remove(paths: RunnerPaths, exec: Exec): Promise<void> {
  await exec('systemctl', ['--user', 'disable', '--now', UNIT_NAME])
  rmSync(paths.unit, { force: true })
  rmSync(paths.wrapper, { force: true })
  await exec('systemctl', ['--user', 'daemon-reload'])
  clearAccount(paths.dir)
}

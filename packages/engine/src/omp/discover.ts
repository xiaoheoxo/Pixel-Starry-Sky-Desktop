// 找用户自己装的 oh-my-pi（omp）、读版本（docs/omp-engine.md §2）
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codedError, type EngineInfo } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import { IS_WINDOWS, findOnPath, isFile, resolveCommand, run, timedLookup, versionAtLeast, warmPath } from '../exec'
import { engineBase } from '../registry'

/** 19.1.0 是试验里录过 RPC 的版本（docs/omp-engine-trial.md） */
export const OMP_MIN_VERSION = '19.1.0'

/** 第一次运行要把原生模块解到 ~/.omp/natives（约 140 MB），--version 可能要等一会儿 */
const VERSION_TIMEOUT_MS = 60_000

export function ompVersionStatus(version: string | null): { status: EngineInfo['status']; message: string | null } {
  // 中文原文，英文界面按词典翻（apps/desktop/src/shared/i18n/ompMessages.ts）
  if (!version) return { status: 'error', message: '读不出 oh-my-pi 的版本' }
  if (!versionAtLeast(version, OMP_MIN_VERSION))
    return {
      status: 'outdated',
      message: `oh-my-pi ${version} 版本太低（需要 ${OMP_MIN_VERSION} 以上）：点更新按钮，或在终端运行 omp update`,
    }
  return { status: 'ready', message: null }
}

/**
 * 官方安装方式放的位置（安装器把它写进用户 PATH，但已经开着的进程看不到）：
 * Windows install.ps1 → %LOCALAPPDATA%\omp\omp.exe；install.sh → ~/.local/bin/omp；bun install -g → ~/.bun/bin
 */
export function ompCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE || env.HOME || homedir()
  if (IS_WINDOWS) {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [join(local, 'omp', 'omp.exe'), join(home, '.bun', 'bin', 'omp.exe')]
  }
  return [join(home, '.local/bin/omp'), join(home, '.bun/bin/omp'), '/opt/homebrew/bin/omp', '/usr/local/bin/omp']
}

/** 用户替换的命令（docs/ui/engine-launch.md §3）：绝对路径或 PATH 上的命令名 */
export function customOmp(command: string, env: NodeJS.ProcessEnv): { path: string } | { error: string } {
  const r = resolveCommand(command, env)
  if (r.ok) return { path: r.path }
  if (r.reason === 'script') return { error: codedError('launch.script', { path: r.path }).message }
  return { error: codedError(`launch.${r.reason}`, { command: command.trim() }).message }
}

/** omp --version 输出「omp/19.1.0」 */
export const ompVersionOf = (stdout: string): string | null => stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null

/** 官方安装器：Windows 用 PowerShell 跑 install.ps1，其他系统 curl … | sh；都没有时 null（界面不给「安装」） */
export function ompInstaller(env: NodeJS.ProcessEnv): Launcher | null {
  if (IS_WINDOWS) {
    const ps =
      findOnPath('powershell.exe', env) ??
      [join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')].find(isFile)
    if (!ps) return null
    // PowerShell 5.1 画下载进度条会把下载拖得很慢
    const script = "$ProgressPreference='SilentlyContinue'; irm https://omp.sh/install.ps1 | iex"
    return { command: ps, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script] }
  }
  const sh = findOnPath('sh', env) ?? ['/bin/sh'].find(isFile)
  if (!sh || !findOnPath('curl', env)) return null
  return { command: sh, args: ['-c', 'curl -fsSL https://omp.sh/install | sh'] }
}

/** override 为用户替换的命令，null 按 PATH 和安装器的位置找 */
export async function discoverOmp(
  override: string | null,
  env: NodeJS.ProcessEnv,
): Promise<{ info: EngineInfo; launcher: Launcher | null }> {
  const base = { ...engineBase('omp'), launch: override ? ('custom' as const) : ('stock' as const) }
  await warmPath(env)
  const custom = override ? timedLookup('omp', () => customOmp(override, env)) : null
  if (custom && 'error' in custom)
    return { info: { ...base, status: 'missing', version: null, path: null, message: custom.error }, launcher: null }
  const path = custom
    ? custom.path
    : timedLookup(
        'omp',
        () =>
          (env.PIXELSKY_OMP_BIN?.trim() && isFile(env.PIXELSKY_OMP_BIN.trim()) ? env.PIXELSKY_OMP_BIN.trim() : null) ??
          findOnPath(IS_WINDOWS ? 'omp.exe' : 'omp', env) ??
          ompCandidates(env).find(isFile) ??
          null,
      )
  if (!path)
    return {
      info: {
        ...base,
        status: 'missing',
        version: null,
        path: null,
        installable: !override && ompInstaller(env) !== null,
        message: IS_WINDOWS
          ? '没找到 oh-my-pi（omp）。安装：在 PowerShell 运行 irm https://omp.sh/install.ps1 | iex'
          : '没找到 oh-my-pi（omp）。安装：在终端运行 curl -fsSL https://omp.sh/install | sh',
      },
      launcher: null,
    }
  const launcher = { command: path, args: [] }
  const result = await run(launcher, ['--version'], env, VERSION_TIMEOUT_MS)
  const version = ompVersionOf(result.stdout)
  const check = result.ok ? ompVersionStatus(version) : { status: 'error' as const, message: 'oh-my-pi 启动不了' }
  return { info: { ...base, status: check.status, version, path, message: check.message }, launcher }
}

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, delimiter } from 'node:path'
import { codedError, type EngineInfo } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import { isFile, resolveCommand, run, versionAtLeast } from '../exec'
import { globalNpm } from '../npm'
import { engineBase } from '../registry'
import { keepInWsl, windowsOnlyNote, type WslOpts } from '../wsl'

/** app-server 协议仍是实验接口，0.160.0 是实测通过的下限 */
export const CODEX_MIN_VERSION = '0.160.0'
/** 按 --version 的结果判定状态：读不到版本号为 error，低于下限为 outdated */
export function codexVersionStatus(version: string | null): { status: EngineInfo['status']; message: string | null } {
  if (!version) return { status: 'error', message: 'Could not read the Codex version' }
  if (!versionAtLeast(version, CODEX_MIN_VERSION))
    return {
      status: 'outdated',
      message: `Codex is too old (requires ${CODEX_MIN_VERSION} or later). Run npm i -g @openai/codex@latest`,
    }
  return { status: 'ready', message: null }
}

/** npm shim 只用于找安装目录；协议子进程直接启动原生二进制。 */
export function codexExecutable(path: string): string | null {
  // macOS / Linux 上 npm 的 codex 是指向 bin/codex.js 的链接（没有扩展名），先看它实际指着哪
  if (process.platform !== 'win32')
    try {
      path = realpathSync(path)
    } catch {
      return null
    }
  if (isFile(path) && !/\.(?:cmd|ps1|js)$/i.test(path)) return path
  const bases = [dirname(path), join(dirname(path), '..'), path]
  const triplet =
    process.platform === 'win32'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
      : process.platform === 'darwin'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
        : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
  const platform = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
  for (const base of bases)
    for (const root of [base, join(base, 'node_modules/@openai/codex'), join(base, '@openai/codex')]) {
      for (const vendor of [
        join(root, 'node_modules/@openai', `codex-${platform}`, 'vendor'),
        join(root, 'vendor'),
        join(root, '..', `codex-${platform}`, 'vendor'),
      ]) {
        const exe = join(vendor, triplet, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
        if (isFile(exe)) return exe
      }
    }
  return null
}
export function toolEnvironment(launcher: Launcher, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bin = dirname(launcher.command),
    key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  return { ...env, [key]: [bin, join(bin, '../path'), env[key]].filter(Boolean).join(delimiter) }
}
/**
 * 用户替换的命令（docs/ui/engine-launch.md §3）：绝对路径或 PATH 上的命令名。
 * 指到 npm 垫片（.cmd 等）时，和自带程序一样找包里的原生程序；找不到时给出原因（带代码的错误），不退回自带程序。
 */
export function customCodex(command: string, env: NodeJS.ProcessEnv): { path: string } | { error: string } {
  const r = resolveCommand(command, env)
  if (r.ok) return { path: r.path }
  if (r.reason === 'script') {
    const exe = codexExecutable(r.path)
    if (exe && exe !== r.path) return { path: exe }
    return { error: codedError('launch.script', { path: r.path }).message }
  }
  return { error: codedError(`launch.${r.reason}`, { command: command.trim() }).message }
}

/** override 为用户替换的命令，null 用自带程序 */
export async function discoverCodex(
  override: string | null,
  env: NodeJS.ProcessEnv,
  wsl: WslOpts = {},
): Promise<{ info: EngineInfo; launcher: Launcher | null }> {
  const base = { ...engineBase('codex'), launch: override ? ('custom' as const) : ('stock' as const) }
  const custom = override ? customCodex(override, env) : null
  if (custom && 'error' in custom)
    return { info: { ...base, status: 'missing', version: null, path: null, message: custom.error }, launcher: null }
  const skipped: string[] = []
  const keep = (p: string) => keepInWsl(p, env, skipped, wsl)
  // PIXELSKY_CODEX_BIN 是用户明确指定的，不做 WSL 过滤
  const explicit = !custom && env.PIXELSKY_CODEX_BIN ? codexExecutable(env.PIXELSKY_CODEX_BIN) : null
  const path = custom
    ? custom.path
    : (explicit ??
      [
        ...(env.PATH ?? env.Path ?? '')
          .split(delimiter)
          .flatMap(dir => ['codex.exe', 'codex.cmd', 'codex'].map(name => join(dir.replace(/^"|"$/g, ''), name))),
        ...(process.platform === 'win32'
          ? [
              join(homedir(), '.local/bin/codex.exe'),
              join(env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'npm/codex.cmd'),
            ]
          : // 从程序坞启动、没读到登录 shell 的 PATH 时：Homebrew、npm 全局、官方安装脚本的位置
            [
              '/opt/homebrew/bin/codex',
              '/usr/local/bin/codex',
              join(homedir(), '.local/bin/codex'),
              join(homedir(), '.npm-global/bin/codex'),
            ]),
      ]
        .filter((v): v is string => !!v)
        .filter(keep)
        .map(codexExecutable)
        // 垫片可能解析到 /mnt 下的原生程序，解析后要再检查一次
        .find(p => !!p && keep(p)))
  const note = windowsOnlyNote(skipped)
  if (!path)
    return {
      info: {
        ...base,
        status: 'missing',
        version: null,
        path: null,
        installable: !override && globalNpm(env) !== null,
        message:
          '没找到 Codex。安装：在终端运行 npm i -g @openai/codex@latest（需要先装 Node.js），或在下面指定 Codex 的位置' +
          (note ? `（${note}）` : ''),
      },
      launcher: null,
    }
  const launcher = { command: path, args: [] },
    result = await run(launcher, ['--version'], toolEnvironment(launcher, env), 12_000)
  const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  // 替换后的程序（套壳脚本等）可能不支持 --version：能启动就照常用，版本未知，不按最低版本拦截
  const check =
    custom && result.started && !version
      ? { status: 'ready' as const, message: null }
      : result.ok
        ? codexVersionStatus(version)
        : { status: 'error' as const, message: 'Codex executable could not start' }
  return {
    info: {
      ...base,
      status: check.status,
      version,
      path,
      message: check.message,
    },
    launcher,
  }
}

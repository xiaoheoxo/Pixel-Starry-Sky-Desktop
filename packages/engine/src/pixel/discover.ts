// 找像素星空命令行（docs/own-cli.md §3）：用户在设置里替换的命令 → 环境变量 PIXELSKY_CLI_BIN → 自带的入口（桌面端传 bundledCli）→ PATH 上的 pixelsky
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, win32 } from 'node:path'
import { codedError, type EngineInfo } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import { isFile, resolveCommand, run, startupReason } from '../exec'
import { engineBase } from '../registry'

/** 脚本入口：用当前的 node（Electron 里是 ELECTRON_RUN_AS_NODE 的 Electron 自带 Node）运行 */
const SCRIPT_ENTRY = /\.(?:[cm]?[jt]s)$/i

/** 入口是脚本就用 node 跑，否则当可执行文件直接启动 */
export function pixelLauncher(entry: string): Launcher {
  return SCRIPT_ENTRY.test(extname(entry)) ? { command: process.execPath, args: [entry] } : { command: entry, args: [] }
}

/** 脚本入口由当前进程的 node 跑：带 ELECTRON_RUN_AS_NODE=1（在普通 node 下无影响），Electron 才会当 node 用 */
export function pixelEnvironment(launcher: Launcher, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return launcher.command === process.execPath && launcher.args.length ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env
}

/** 把用户给的路径 / 命令名解析成启动方式；找不到时给出原因 */
function resolveEntry(value: string, env: NodeJS.ProcessEnv): { launcher: Launcher; path: string } | { error: string } {
  const entry = value.trim().replace(/^"(.*)"$/, '$1')
  if (SCRIPT_ENTRY.test(extname(entry))) {
    return isFile(entry)
      ? { launcher: pixelLauncher(entry), path: entry }
      : { error: codedError('launch.notFound', { command: entry }).message }
  }
  const r = resolveCommand(entry, env)
  if (r.ok) return { launcher: pixelLauncher(r.path), path: r.path }
  if (r.reason === 'script') return { error: codedError('launch.script', { path: r.path }).message }
  return { error: codedError(`launch.${r.reason}`, { command: entry }).message }
}

/** 保存前校验用户替换的命令 */
export function customPixel(command: string, env: NodeJS.ProcessEnv): { path: string } | { error: string } {
  const r = resolveEntry(command, env)
  return 'error' in r ? { error: r.error } : { path: r.path }
}

export async function discoverPixel(
  override: string | null,
  env: NodeJS.ProcessEnv,
  bundledCli: string | null,
): Promise<{ info: EngineInfo; launcher: Launcher | null }> {
  const base = { ...engineBase('pixel'), launch: override ? ('custom' as const) : ('stock' as const) }
  const missing = (message: string): { info: EngineInfo; launcher: null } => ({
    info: { ...base, status: 'missing', version: null, path: null, message },
    launcher: null,
  })
  // 用户替换的命令找不到时直接报它，不悄悄换成别的；否则依次试 PIXELSKY_CLI_BIN、自带入口、PATH 上的 pixelsky
  let found: { launcher: Launcher; path: string } | null = null
  if (override) {
    const r = resolveEntry(override, env)
    if ('error' in r) return missing(r.error)
    found = r
  } else {
    for (const candidate of [env.PIXELSKY_CLI_BIN, bundledCli, 'pixelsky']) {
      if (!candidate?.trim()) continue
      const r = resolveEntry(candidate, env)
      if (!('error' in r)) {
        found = r
        break
      }
    }
  }
  // 安装包里自带命令行：找不到、起不来多半是安装不完整（被杀毒软件删了等），重装就好
  if (!found)
    return missing(
      bundledCli
        ? `没有找到像素星空自带的命令行（${bundledCli}），安装可能不完整：请重新安装像素星空`
        : '没有找到 Pixel 命令行：设置环境变量 PIXELSKY_CLI_BIN 指向命令行入口，或把 pixelsky 装到 PATH 上',
    )
  const result = await run(found.launcher, ['--version'], pixelEnvironment(found.launcher, env), 12_000)
  const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  const ok = result.ok && !!version
  const why = startupReason(result.stderr) || result.error || ''
  return {
    info: {
      ...base,
      status: ok ? 'ready' : 'error',
      version,
      path: found.path,
      message: ok
        ? null
        : `Pixel 命令行启动不了${why ? `：${why}` : ''}${
            !override && bundledCli && found.path === bundledCli ? '。请重新安装像素星空' : ''
          }`,
    },
    launcher: found.launcher,
  }
}

type Exists = (path: string) => boolean

const pathDirs = (env: NodeJS.ProcessEnv): string[] => {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  return (env[key] ?? '')
    .split(';')
    .map(d => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

/** Pi 在 Windows 上找 bash 的顺序（utils/shell.js getShellConfig）：ProgramFiles 下的 Git Bash，再是 PATH 上第一个 bash.exe */
export function windowsBash(env: NodeJS.ProcessEnv, exists: Exists = isFile): string | null {
  for (const dir of [env.ProgramFiles, env['ProgramFiles(x86)']])
    if (dir && exists(win32.join(dir, 'Git', 'bin', 'bash.exe'))) return win32.join(dir, 'Git', 'bin', 'bash.exe')
  for (const dir of pathDirs(env)) if (exists(win32.join(dir, 'bash.exe'))) return win32.join(dir, 'bash.exe')
  return null
}

const isWslBash = (path: string): boolean =>
  /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/i.test(path.replace(/\//g, '\\'))

/**
 * Pi 自己找不到的 Git Bash：Git 装在别的盘、装在用户目录时，从 PATH 上的 git.exe（Git\cmd、Git\mingw64\bin）
 * 往上找 Git\bin\bash.exe，再看用户目录的默认安装位置。返回 bash.exe 所在的目录
 */
export function gitBashDir(env: NodeJS.ProcessEnv, exists: Exists = isFile): string | null {
  const roots: string[] = []
  for (const dir of pathDirs(env))
    if (exists(win32.join(dir, 'git.exe'))) roots.push(win32.dirname(dir), win32.dirname(win32.dirname(dir)))
  for (const base of [env.ProgramW6432, env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')])
    if (base) roots.push(win32.join(base, 'Git'))
  for (const root of roots) if (exists(win32.join(root, 'bin', 'bash.exe'))) return win32.join(root, 'bin')
  return null
}

/** 用户在 Pi 的设置（<配置目录>/settings.json）里写的 shellPath；没写、读不到为 null */
function settingsShellPath(env: NodeJS.ProcessEnv): string | null {
  const configured = env.PIXELSKY_CODING_AGENT_DIR?.trim()
  const dir = configured
    ? configured.replace(/^~(?=$|[\\/])/, homedir())
    : join(env.USERPROFILE || env.HOME || homedir(), '.pixelsky-cli', 'agent')
  try {
    const shell = (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { shellPath?: unknown }).shellPath
    return typeof shell === 'string' && shell.trim() ? shell.trim() : null
  } catch {
    return null
  }
}

/**
 * Windows 上命令工具（bash）用哪个 shell（Pi 没有命令行参数能指定，只认 settings.json 的 shellPath）：
 * Pi 只在 ProgramFiles 下找 Git Bash，找不到就用 PATH 上第一个 bash.exe，常常是 C:\Windows\System32 的 WSL bash
 * （命令跑在 Linux 子系统里，Windows 路径用不了），都没有就报错。
 * - pathDir：Git 装在别处，把它的 bin 目录放到 Pi 进程 PATH 的最前面，Pi 就会用它
 * - warning：找不到 Git Bash，放进设置 › 本机引擎的配置提示
 * 不是 Windows、Pi 自己找得到、用户自己指定了 shellPath 时两个都没有
 */
export function pixelShell(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: Exists = isFile,
): { pathDir?: string; warning?: string } {
  if (platform !== 'win32') return {}
  const bash = windowsBash(env, exists)
  if (bash && !isWslBash(bash)) return {}
  const custom = settingsShellPath(env)
  if (custom && exists(custom)) return {}
  const dir = gitBashDir(env, exists)
  if (dir) return { pathDir: dir }
  const install =
    '请安装 Git for Windows（https://git-scm.com/download/win），装好后点「重新检测」；' +
    '已经装了的话，在 ~/.pixelsky-cli/agent/settings.json 里用 "shellPath" 写上 bash.exe 的完整路径'
  return {
    warning: bash
      ? `没有找到 Git Bash，只找到了 WSL 的 bash（${bash}）：命令会在 Linux 子系统里运行，Windows 的路径和工具用不了。${install}`
      : `没有找到 Git Bash：Pixel 在 Windows 上用它运行命令，现在运行命令会失败。${install}`,
  }
}

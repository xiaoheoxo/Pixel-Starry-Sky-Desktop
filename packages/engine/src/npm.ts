// 用 npm 装 / 更新引擎（docs/ui/engine-update.md §6、§7）：不经过 shell，用 node 直接跑 npm 自带的 npm-cli.js。
// 没装 Node.js 的电脑上，由桌面端给一份只给像素星空用的 Node.js（NodeRuntime，装在应用数据目录，不改系统 PATH）
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { EngineUpdateResult } from '@pixelsky/protocol'
import { IS_WINDOWS, findOnPath, isFile, outputTail, runStream } from './exec'

/** 跑 npm 用的 node 和 npm-cli.js；prefix 是 --prefix（null 用 npm 默认的全局位置） */
export interface NpmTool {
  node: string
  cli: string
  prefix: string | null
}

/** 桌面端提供的私有 Node.js（apps/desktop/src/main/engine/node-runtime.ts） */
export interface NodeRuntime {
  /** 加到引擎 PATH 最后的目录：私有 node 所在目录、npm 全局目录（还没装时为空） */
  paths(): string[]
  /** 没装就下载、校验、解压（过程写进 onLine），返回私有 node 的 npm，装到私有的全局目录 */
  ensure(onLine: (line: string) => void): Promise<NpmTool>
}

/** 第一次按用户自己的 npm 配置（默认官方源）装；失败再换国内镜像 */
export const NPM_MIRROR = 'https://registry.npmmirror.com'
const NPM_ARGS = ['--no-fund', '--no-audit']

/** PATH 末尾补上 dirs（已有的不重复）；Windows 上沿用原来的键名（Path / PATH） */
export function withPath(env: NodeJS.ProcessEnv, dirs: readonly string[]): NodeJS.ProcessEnv {
  if (!dirs.length) return env
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const parts = (env[key] ?? '').split(delimiter).filter(Boolean)
  const same = (a: string, b: string): boolean =>
    IS_WINDOWS ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
  const extra = dirs.filter(d => !parts.some(p => same(p.replace(/^"|"$/g, ''), d)))
  return extra.length ? { ...env, [key]: [...parts, ...extra].join(delimiter) } : env
}

/** PATH 上的 node 自带的那份 npm-cli.js，装到 npm 默认的全局位置；找不到时为 null */
export function globalNpm(env: NodeJS.ProcessEnv, windows = IS_WINDOWS): { node: string; cli: string } | null {
  const node = findOnPath(windows ? 'node.exe' : 'node', env)
  if (!node) return null
  const cli = windows
    ? join(dirname(node), 'node_modules/npm/bin/npm-cli.js')
    : join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js')
  return isFile(cli) ? { node, cli } : null
}

const inside = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

/**
 * 装新引擎用哪份 npm：用户自己装了 Node.js 就用它（装到 npm 默认的全局位置，和用户手动 npm i -g 一样）；
 * 没有就让桌面端装私有的那份。PATH 末尾补的私有 node 不算用户自己的。都没有返回 null
 */
export async function npmForInstall(
  env: NodeJS.ProcessEnv,
  runtime: NodeRuntime | undefined,
  onLine: (line: string) => void,
): Promise<NpmTool | null> {
  const own = runtime?.paths() ?? []
  const system = globalNpm(env)
  if (system && !own.some(dir => inside(system.node, dir))) return { ...system, prefix: null }
  return runtime ? runtime.ensure(onLine) : null
}

/** npm install -g 包@latest；官方源（或用户配置的源）失败再换国内镜像试一次 */
export async function npmInstallGlobal(
  npm: NpmTool,
  pkg: string,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  timeout: number,
): Promise<EngineUpdateResult> {
  const run = (registry: string | null) =>
    runStream(
      { command: npm.node, args: [npm.cli] },
      [
        'install',
        '-g',
        ...(npm.prefix ? ['--prefix', npm.prefix] : []),
        `${pkg}@latest`,
        ...(registry ? ['--registry', registry] : []),
        ...NPM_ARGS,
      ],
      // 装包时的 postinstall 会调 node：让它找得到跑 npm 的这份
      withPath(env, [dirname(npm.node)]),
      timeout,
      onLine,
    )
  let r = await run(null)
  if (!r.ok) {
    onLine(`npm 没装成，换国内镜像重试：${NPM_MIRROR}`)
    r = await run(NPM_MIRROR)
  }
  return { ok: r.ok, output: outputTail(r), version: null }
}

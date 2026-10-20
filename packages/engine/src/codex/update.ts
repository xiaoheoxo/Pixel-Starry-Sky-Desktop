// Codex 的「一键更新」（docs/ui/engine-update.md）：npm 全局装的 Codex 用 npm install -g 换成最新版。
// 不经过 shell：用 PATH 上的 node 直接跑 npm 自带的 npm-cli.js（npm.ts），--prefix 指定成现在这份 Codex 所在的位置。
import { dirname, join } from 'node:path'
import type { EngineUpdateResult } from '@pixelsky/protocol'
import { IS_WINDOWS, findOnPath, isFile } from '../exec'
import { npmForInstall, npmInstallGlobal, type NodeRuntime } from '../npm'

export const CODEX_NPM_PACKAGE = '@openai/codex'

/**
 * 原生程序在 <前缀>/node_modules/@openai/codex/… 下（Linux / macOS 是 <前缀>/lib/node_modules/…）时，返回这个前缀；
 * 不是 npm 全局装的返回 null
 */
export function npmPrefixOf(exe: string, windows = IS_WINDOWS): string | null {
  const i = exe.replace(/\\/g, '/').toLowerCase().indexOf('/node_modules/@openai/codex/')
  if (i <= 0) return null
  const root = exe.slice(0, i)
  if (windows) return root
  return /[\\/]lib$/.test(root) ? dirname(root) : null
}

/** 找 npm-cli.js：node 自带的那份，或者用户 npm i -g npm 升级到前缀下的那份 */
export function npmCliCandidates(node: string, prefix: string, windows = IS_WINDOWS): string[] {
  const nodeDir = dirname(node)
  return windows
    ? [join(prefix, 'node_modules/npm/bin/npm-cli.js'), join(nodeDir, 'node_modules/npm/bin/npm-cli.js')]
    : [join(prefix, 'lib/node_modules/npm/bin/npm-cli.js'), join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')]
}

// 用户没装 Node.js 时由 NodeRuntime 给一份私有的（docs/ui/engine-update.md §7）
export { globalNpm } from '../npm'

/** 一键安装（docs/ui/engine-update.md）：npm install -g @openai/codex@latest */
export async function installCodexWithNpm(
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  runtime?: NodeRuntime,
): Promise<EngineUpdateResult> {
  const npm = await npmForInstall(env, runtime, onLine)
  if (!npm) throw new Error('没找到 node / npm，请先安装 Node.js，再在终端运行 npm i -g @openai/codex@latest')
  return npmInstallGlobal(npm, CODEX_NPM_PACKAGE, env, onLine, 10 * 60_000)
}

export async function updateCodexWithNpm(
  exe: string,
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void = () => undefined,
): Promise<EngineUpdateResult> {
  const prefix = npmPrefixOf(exe)
  if (!prefix) throw new Error('这个 Codex 不是用 npm 全局安装的，请用原来安装它的方式更新')
  const node = findOnPath(IS_WINDOWS ? 'node.exe' : 'node', env)
  const cli = node ? npmCliCandidates(node, prefix).find(isFile) : undefined
  if (!node || !cli) throw new Error('没找到 node / npm，请在终端运行 npm i -g @openai/codex@latest')
  return npmInstallGlobal({ node, cli, prefix }, CODEX_NPM_PACKAGE, env, onLine, 5 * 60_000)
}

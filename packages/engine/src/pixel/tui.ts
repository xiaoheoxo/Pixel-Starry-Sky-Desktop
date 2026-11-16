// 像素星空引擎的终端模式（docs/ui/tui-toggle.md §12.3、§12.8）：拼交互式命令、找跑命令行的 Node、切回时沿 parentId 补轮次
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { viaGateway, type Item, type SessionRecord, type TuiMark } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import { resolveCommand, run } from '../exec'
import type { NewerTurns } from '../native/types'
import { entries } from './agents'
import { piThinkingLevel } from './catalog'
import { string, type Message } from './process'
import { GATEWAY_PROVIDER } from './session'
import { messageItems } from './transcript'

/** packages/cli/package.json 的 engines.node */
export const MIN_NODE = [22, 19] as const

/**
 * 交互界面的参数：launchArgs 是 pixelLaunch 给的（权限档、技能、搜索工具、用户追加的），
 * 再接上会话文件、模型、思考档。会话进程里模型和档位是起来后用 set_model / set_thinking_level 设的，终端里只能走参数
 */
export function pixelTuiArgs(record: SessionRecord, sessionFile: string, launchArgs: readonly string[]): string[] {
  const args = [...launchArgs, '--session', sessionFile]
  if (record.model) {
    // 经网关的只能用网关扩展注册的 pixelsky/<id>，不能落到同名的内置模型（会用本机密钥直连厂商）
    const bare = record.model.replace(new RegExp(`^${GATEWAY_PROVIDER}/`), '')
    args.push('--model', viaGateway(record) ? `${GATEWAY_PROVIDER}/${bare}` : record.model)
  }
  if (record.effort) args.push('--thinking', piThinkingLevel(record.effort))
  return args
}

/**
 * 会话文件当前的叶子：Pi 只追加写，重新打开时叶子就是最后一条带 id 的条目。
 * 开头的 session 头也有 id（是会话 id，不在 parentId 链上），不算
 */
export function leafOf(list: readonly Message[]): string {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.type === 'session') continue
    const id = string(list[i]!.id)
    if (id) return id
  }
  return ''
}

/**
 * 切回时补上终端里新聊的：从当前叶子沿 parentId 往回走到切过去时的叶子，中间的消息翻成条目。
 * 走不到（终端里 /tree 换了分支、文件被换掉）返回 null，按「对不上了」处理；mark 不是 Pixel 的也返回 null。
 * tail：list 只是切过去之后追加的那段（readSinceMark），一条都没有＝终端里没说话
 */
export function sinceLeaf(list: readonly Message[], mark: TuiMark, cwd: string, tail = false): NewerTurns | null {
  if (!('leaf' in mark)) return null
  const byId = new Map<string, Message>()
  for (const e of list) if (string(e.id)) byId.set(string(e.id), e)
  const path: Message[] = []
  let at = leafOf(list) || (tail ? mark.leaf : '')
  const seen = new Set<string>()
  while (at && at !== mark.leaf) {
    const e = byId.get(at)
    if (!e || seen.has(at)) return null
    seen.add(at)
    path.push(e)
    at = string(e.parentId)
  }
  // 走到了根还没碰到记下的叶子：不在这条分支上
  if (at !== mark.leaf) return null
  const items: Item[] = messageItems(path.reverse(), cwd, 'px-tui')
  const turns = items.filter(i => i.kind === 'user').length
  return { items, turns, shown: turns, gap: 0, leafUuid: null, at: null, base: '' }
}

const fileSize = (file: string): number => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 找叶子只读文件末尾这么多（主会话文件可能有几百 MB，主进程里整份解析会卡住界面） */
const LEAF_WINDOW = 4 * 1024 * 1024

/** 切到终端时的位置：叶子 + 文件大小；末尾一段里找不到带 id 的条目（最后一行特别大）才整份读 */
export function markOfFile(file: string): TuiMark {
  const size = fileSize(file)
  const leaf =
    leafOf(entries(file, undefined, Math.max(0, size - LEAF_WINDOW))) ||
    (size > LEAF_WINDOW ? leafOf(entries(file)) : '')
  return { leaf, size }
}

/** 切回时：Pi 只追加写，只读切过去之后的那段；文件变小了（被重写过）整份读 */
export function readSinceMark(file: string, mark: TuiMark, cwd: string): NewerTurns | null {
  if (!('leaf' in mark)) return null
  const from = mark.size !== undefined && mark.size <= fileSize(file) ? mark.size : 0
  return sinceLeaf(entries(file, undefined, from), mark, cwd, from > 0)
}

export function nodeVersionOk(text: string): boolean {
  const m = /v?(\d+)\.(\d+)/.exec(text.trim())
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
}

/** 私有 Node.js（node-runtime.ts）的 node 程序；还没装为 null */
export function privateNode(paths: readonly string[], windows = process.platform === 'win32'): string | null {
  const dir = paths[0]
  if (!dir) return null
  const exe = join(dir, windows ? 'node.exe' : 'node')
  return existsSync(exe) ? exe : null
}

/**
 * 跑终端命令行的 Node：应用自己的 Electron 当 Node 在 ConPTY 里不出字（§12.1），按顺序找私有 Node → PATH 上的 node（版本够）。
 * 都没有返回 null（调用方去下载私有的）
 */
export async function findNode(env: NodeJS.ProcessEnv, privatePaths: readonly string[]): Promise<string | null> {
  const own = privateNode(privatePaths)
  if (own) return own
  const found = resolveCommand('node', env)
  if (!found.ok) return null
  const r = await run({ command: found.path, args: [] }, ['--version'], env, 10_000)
  return r.ok && nodeVersionOk(r.stdout) ? found.path : null
}

/** 自带命令行的启动方式是不是「用当前进程（Electron）跑脚本」：这时终端里要换成真正的 Node */
export function needsRealNode(launcher: Launcher): boolean {
  return launcher.command === process.execPath && launcher.args.length > 0 && !!process.versions.electron
}

// Antigravity 的终端模式（docs/ui/tui-toggle.md §12.2）：在内置终端里跑交互式 agy，接着同一个会话。
// ACP 的会话 id 就是 agy --conversation 认的 id（同一份 conversations/<id>.db，2026-11-16 本机实测）
import type { Item, SessionRecord, TuiMark } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import type { NewerTurns } from '../native/types'
import { withAgy } from './discover'

/**
 * 交互式 agy 的参数（不含启动器自己的参数）。模型传系列名、档位单独传（实测 `--model gemini-4-argon --effort high`
 * 状态栏就是「Gemini 4 Argon · high」）。权限：命令行的 --mode 只认 accept-edits / auto / plan（给 default 会退回 auto），
 * 询问不带 --mode（agy 默认）；完全放行用 --dangerously-skip-permissions（界面里是会话代答，终端里没人代答）
 */
export function agyTuiArgs(record: SessionRecord, conversation: string, userArgs: readonly string[]): string[] {
  const args = [...userArgs, '--conversation', conversation]
  if (record.model) args.push('--model', record.model)
  if (record.effort) args.push('--effort', record.effort)
  if (record.permissionMode === 'edits') args.push('--mode', 'accept-edits')
  else if (record.permissionMode === 'plan') args.push('--mode', 'plan')
  else if (record.permissionMode === 'full') args.push('--dangerously-skip-permissions')
  return args
}

/** 新对话还没有 agy 会话：临时 ACP 进程里 session/new 建一个（不发消息，不花额度），返回会话 id */
export async function agyNewSession(
  launcher: Launcher,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  const id = await withAgy(launcher, args, env, async conn => {
    const r = (await conn.request('session/new', { cwd, mcpServers: [] }, 60_000)) as { sessionId?: unknown } | null
    return typeof r?.sessionId === 'string' ? r.sessionId : ''
  })
  if (!id) throw new Error('Antigravity 没有返回会话 id，切不到终端')
  return id
}

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** 回放里的用户消息（含界面代发的提问回答、/compact：位置按回放里的全部用户消息算，不用分辨谁发的） */
function users(replay: readonly Item[]): { at: number; text: string }[] {
  return replay.flatMap((item, at) => (item.kind === 'user' ? [{ at, text: norm(item.text) }] : []))
}

/** 切到终端时记下位置：回放里有几条用户消息、最后一条的文字 */
export function markOf(replay: readonly Item[]): TuiMark {
  const list = users(replay)
  return { users: list.length, last: list.at(-1)?.text ?? '' }
}

/**
 * 切回时补上终端里新聊的：回放（session/load）的条目 id 每次随机生成，按切过去时记下的位置往后取。
 * 记下的那条不在原处了（终端里 /rewind、/clear 过）返回 null，按「对不上了」处理
 */
export function sinceMark(replay: readonly Item[], mark: TuiMark): NewerTurns | null {
  if (!('users' in mark)) return null
  const list = users(replay)
  if (list.length < mark.users) return null
  if (mark.users > 0 && list[mark.users - 1]!.text !== norm(mark.last)) return null
  const next = list[mark.users]
  const items = next ? replay.slice(next.at) : []
  const turns = list.length - mark.users
  // agy 不能从中间分叉（native.ts 的 at: null），没有分叉点
  return { items, turns, shown: turns, gap: 0, leafUuid: null, at: null, base: '' }
}

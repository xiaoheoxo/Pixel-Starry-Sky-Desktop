// 每轮的过程收成一行「执行」（docs/ui/conversation-concise.md §3）：纯函数，LiveTranscript 和测试共用。
// 一直显示：用户消息（含引导）、警告和错误、最后的回复、统计行；其余（思考、工具调用、待办、中间的过渡话、信息提示）是过程。
import type { Item } from './types'

export type TurnEntry =
  | { type: 'item'; item: Item }
  /** running：这一轮还在进行（只有最后一轮可能为真） */
  | { type: 'process'; key: string; items: Item[]; running: boolean; durationMs: number | null }

const isTool = (item: Item): boolean => item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool'

/**
 * 子智能体的显示方式（docs/ui/subagent-box.md）：
 * inline：和以前一样，派发和子智能体的工具调用都在执行块里；
 * box：派发和完成提示各是一个单独的小框、打断执行块，子智能体自己的工具调用不进主对话也不计数
 */
export interface FoldOptions {
  subagents?: 'box' | 'inline'
}

/** 主智能体派出子智能体的调用（Agent / Task / Workflow、Codex 协作智能体） */
export const isSubagentCall = (item: Item): boolean => item.kind === 'tool' && item.tool === 'task' && !item.subagent

/** 子智能体自己调用的工具（带 subagent 标签）：box 下不显示在主对话里 */
export const isSubagentWork = (item: Item): boolean =>
  (item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool') && !!item.subagent

/** 后台任务结束的提示带结构化信息：box 下画成完成小框 */
export const isTaskNotice = (item: Item): boolean => item.kind === 'notice' && !!item.task

/** box 下单独显示成小框的条目 */
export const isSubagentBox = (item: Item): boolean => isSubagentCall(item) || isTaskNotice(item)

/** 一直显示的条目（不看位置）：最后的回复另外判断 */
function alwaysVisible(item: Item, box: boolean): boolean {
  if (item.kind === 'user' || item.kind === 'turn_stats' || item.kind === 'compaction') return true
  if (box && isSubagentBox(item)) return true
  return item.kind === 'notice' && item.level !== 'info'
}

/** 排在回复后面也不算「回复之后又干了活」的条目：思考（有的模型 / 中转在回复后面还会发一段）、信息提示、只有空白的文字 */
function trailing(item: Item, box: boolean): boolean {
  if (alwaysVisible(item, box) || item.kind === 'reasoning') return true
  if (item.kind === 'notice') return item.level === 'info'
  return item.kind === 'assistant' && !item.text.trim()
}

/** 最后的回复在这一轮里的位置：最后一段有字的助手文字，后面只剩一直显示的内容、思考和信息提示；没有时 -1 */
function replyIndex(turn: Item[], box: boolean): number {
  for (let i = turn.length - 1; i >= 0; i--) {
    const item = turn[i]
    if (item.kind === 'assistant' && item.text.trim()) return i
    if (!trailing(item, box)) return -1
  }
  return -1
}

/** 打断执行块的条目：引导、警告和错误、压缩。执行块在这里断开，看得出它们是在哪一步之后发生的 */
const interrupts = (item: Item, box: boolean): boolean =>
  alwaysVisible(item, box) && item.kind !== 'turn_stats' && !isTurnUser(item)
const isTurnUser = (item: Item): boolean => item.kind === 'user' && item.mode !== 'guidance'

/**
 * 一轮里的条目 → 显示顺序：过程条目按先后收成执行块，被引导 / 警告 / 错误 / 压缩打断时分成几段；
 * 最后的回复、统计行一直显示。运行中正在输出、前面已经有过程的文字先留在执行块里（不然一调工具它就从外面跳进去），
 * 这一轮结束后才作为最后的回复显示在外面
 */
function foldTurn(turn: Item[], running: boolean, box: boolean): TurnEntry[] {
  let reply = replyIndex(turn, box)
  const candidate = turn[reply]
  // 不只看这段文字是不是还在输出：一段话说完、下一个工具调用还没到的那一会儿，它也要留在执行块里，
  // 不然先跳到外面（和执行块里的条目不对齐）、工具一来又跳回去。有了统计行才算这一轮结束
  const ended = turn.some(item => item.kind === 'turn_stats')
  if (running && !ended && candidate?.kind === 'assistant') {
    const before = turn.slice(0, reply).some(item => !alwaysVisible(item, box))
    if (before) reply = -1
  }
  const process = turn.filter((item, i) => i !== reply && !alwaysVisible(item, box))
  // 没有工具调用、只有一条（只有一段思考、一条信息提示）：照原样显示
  if (process.length === 0 || (process.length === 1 && !isTool(process[0])))
    return turn.map(item => ({ type: 'item', item }))
  const out: (TurnEntry | { type: 'segment'; items: Item[] })[] = []
  let segment: { type: 'segment'; items: Item[] } | null = null
  turn.forEach((item, i) => {
    if (i === reply || alwaysVisible(item, box)) {
      if (interrupts(item, box)) segment = null
      out.push({ type: 'item', item })
    } else if (segment) segment.items.push(item)
    else {
      segment = { type: 'segment', items: [item] }
      out.push(segment)
    }
  })
  const stats = turn.find(item => item.kind === 'turn_stats')
  const segments = out.filter(e => e.type === 'segment')
  const last = segments[segments.length - 1]
  return out.map((e): TurnEntry => {
    if (e.type !== 'segment') return e
    // 被打断后只剩一条、又不是工具调用的一段：照原样显示
    if (e.items.length === 1 && !isTool(e.items[0])) return { type: 'item', item: e.items[0] }
    return {
      type: 'process',
      key: `process-${e.items[0].id}`,
      items: e.items,
      running: running && e === last,
      // 用时是整轮的：放在最后一段上
      durationMs: e === last && stats?.kind === 'turn_stats' ? stats.usage.durationMs : null,
    }
  })
}

/**
 * running：会话还在进行，最后一轮没结束。
 * 按用户消息分轮；一轮的统计行之后、没等用户发消息引擎就接着干的活（后台任务完成的通知等）另算一段，
 * 不然前一轮的回答后面跟了工具调用，会被当成过渡话收进执行块。
 */
export function foldTurns(items: readonly Item[], running: boolean, options: FoldOptions = {}): TurnEntry[] {
  const box = options.subagents === 'box'
  const turns = splitTurns(box ? items.filter(item => !isSubagentWork(item)) : items)
  return turns.flatMap((turn, i) => foldTurn(turn, running && i === turns.length - 1, box))
}

export function splitTurns(items: readonly Item[]): Item[][] {
  const turns: Item[][] = [[]]
  for (const item of items) {
    const current = turns[turns.length - 1]
    const newTurn = item.kind === 'user' && item.mode !== 'guidance'
    if (current.length > 0 && (newTurn || current[current.length - 1].kind === 'turn_stats')) turns.push([])
    turns[turns.length - 1].push(item)
  }
  return turns
}

/** 每一轮统计行 id → 这一轮显示在外面的最后回复（「复制」用它；这一轮以工具调用结尾时没有，不拿过渡话充数） */
export function turnReplies(items: readonly Item[], options: FoldOptions = {}): Map<string, string> {
  const map = new Map<string, string>()
  const box = options.subagents === 'box'
  for (const turn of splitTurns(box ? items.filter(item => !isSubagentWork(item)) : items)) {
    const stats = turn.find(item => item.kind === 'turn_stats')
    const reply = turn[replyIndex(turn, box)]
    if (stats && reply?.kind === 'assistant') map.set(stats.id, reply.text)
  }
  return map
}

export interface ProcessSummary {
  commands: number
  /** 改过的文件（同一个文件算一次） */
  edits: number
  reads: number
  searches: number
  web: number
  mcp: number
  agents: number
  other: number
  failed: number
  /** 被自动审核拦下、用户还没同意重试的（docs/ui/codex-auto-review.md） */
  blocked: number
}

export function summarizeProcess(items: readonly Item[]): ProcessSummary {
  const s: ProcessSummary = {
    commands: 0,
    edits: 0,
    reads: 0,
    searches: 0,
    web: 0,
    mcp: 0,
    agents: 0,
    other: 0,
    failed: 0,
    blocked: 0,
  }
  const files = new Set<string>()
  for (const item of items) {
    if (item.kind === 'command') s.commands++
    else if (item.kind === 'file_change') item.changes.forEach(c => files.add(c.path))
    else if (item.kind === 'tool') {
      const key = (
        { read: 'reads', search: 'searches', web: 'web', mcp: 'mcp', task: 'agents', other: 'other' } as const
      )[item.tool]
      s[key]++
    }
    if ((item.kind === 'command' || item.kind === 'tool' || item.kind === 'file_change') && item.status === 'failed')
      s.failed++
  }
  s.blocked = items.filter(
    i =>
      (i.kind === 'command' || i.kind === 'tool' || i.kind === 'file_change') &&
      i.review?.status === 'denied' &&
      !i.review.overridden,
  ).length
  s.edits = files.size
  return s
}

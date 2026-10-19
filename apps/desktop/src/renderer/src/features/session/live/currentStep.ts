// 运行中突出「现在在干什么」（docs/ui/conversation-concise.md §7）：纯函数，TurnProcess、LiveTranscript 和测试共用。
// 只看对话里已有的条目，不猜引擎下一步要干什么（没有「准备调用工具」这类信号前，等待时只说看结果 / 准备下一步 / 思考）。
import type { Item } from '@pixelsky/protocol'
import { tr, type TranslationKey } from '../../../i18n/core'

export type StepItem = Extract<Item, { kind: 'command' | 'file_change' | 'tool' | 'reasoning' }>

const isStep = (item: Item): item is StepItem =>
  item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool' || item.kind === 'reasoning'

/**
 * 正在进行的一步：最后开始的那个还在跑的工具调用 / 思考；more 是另外还在跑的个数（并行的子智能体等）。
 * 没有在跑的时为 null
 */
export function currentStep(items: readonly Item[]): { item: StepItem; more: number } | null {
  let item: StepItem | null = null,
    count = 0
  for (const it of items)
    if (isStep(it) && it.status === 'running') {
      item = it
      count++
    }
  return item ? { item, more: count - 1 } : null
}

/**
 * 两步之间（没有在跑的步骤、也没在输出文字）在等什么，按最后一条条目推断：
 * - result：工具调用刚结束，模型在看结果；
 * - next：一段话说完了、这一轮还没结束，在准备下一步；
 * - thinking：刚发了消息（或刚想完、只有提示），模型在思考。
 */
export type Waiting = 'result' | 'next' | 'thinking'

export function waitingFor(items: readonly Item[]): Waiting {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    // 信息提示、空白文字不算一步：接着往前看
    if ((item.kind === 'notice' && item.level === 'info') || (item.kind === 'assistant' && !item.text.trim())) continue
    if (item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool') return 'result'
    if (item.kind === 'assistant') return 'next'
    return 'thinking'
  }
  return 'thinking'
}

/** 等待超过这么久才显示已经等了几秒（短的等待一闪就过去，不用数） */
export const WAIT_CLOCK_MS = 5000
/** 一步运行超过这么久才显示用时 */
export const STEP_CLOCK_MS = 3000

/** 文件路径 → 文件名（显示「修改 Composer.tsx」） */
export const baseName = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/** 命令行只取第一行（多行脚本、heredoc 只显示开头） */
export const firstLine = (text: string): string => text.split('\n', 1)[0].trim()

const TOOL_STEP: Record<Extract<Item, { kind: 'tool' }>['tool'], TranslationKey> = {
  read: 'session.step.read',
  search: 'session.step.search',
  web: 'session.step.web',
  mcp: 'session.step.mcp',
  task: 'session.step.agent',
  other: 'session.step.tool',
}

/** 「执行」行上写的这一步：运行 pnpm test、修改 Composer.tsx、读取 a.ts、子智能体：审查代码、思考中 */
export function stepText(item: StepItem): string {
  switch (item.kind) {
    case 'reasoning':
      return tr('session.step.thinking')
    case 'command':
      // 有说明就用说明（「运行单元测试」），没有写命令本身
      return item.description?.trim() || tr('session.step.command', { text: firstLine(item.command) })
    case 'file_change': {
      const [first] = item.changes
      if (item.changes.length > 1) return tr('session.step.files', { n: item.changes.length })
      if (!first) return tr('session.step.files', { n: 0 })
      return tr(first.kind === 'add' ? 'session.step.create' : 'session.step.edit', { name: baseName(first.path) })
    }
    case 'tool':
      return tr(TOOL_STEP[item.tool], { text: firstLine(item.title), name: item.name })
  }
}

/** 正在跑的一步、等待的时长：一分钟内写整秒（12s），再长按 formatDuration（1m 05s） */
export function clockText(ms: number, long: (ms: number) => string): string {
  return ms < 60_000 ? tr('session.step.seconds', { n: Math.floor(ms / 1000) }) : long(ms)
}

/** 本轮用时超过这么久才显示在状态行上（刚开始的几秒数字一直在跳，没有信息量；和等待计时同一个门槛） */
export const TURN_CLOCK_MS = WAIT_CLOCK_MS

/** 最近一轮（运行中的那一轮）的条目，以及它的开始时间 */
export interface TurnWindow {
  items: readonly Item[]
  /** 这一轮开始的时间（当前轮用户消息的 createdAt，重新加载窗口后也在）；对不上当前轮的用户消息时为 null */
  startedAt: number | null
}

/**
 * 这一轮从哪里开始。开始时间只认当前轮（turnId）的那条正式用户消息（引导也带 turnId，但不算）：
 * 中断 / 失败的轮次不写统计行，引擎之后自己接着开的轮次（后台任务完成等）没有用户消息，
 * 光往回找最近一条用户消息会把几分钟前的那一轮算进来，所以对不上就没有开始时间（不显示用时）。
 * 条目只看这一轮：没对上时退到最后一条统计行 / 用户消息之后，免得更早轮次里停在 running 的条目被当成「正在进行」
 */
export function turnWindow(items: readonly Item[], turnId: string | null = null): TurnWindow {
  if (turnId)
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'user' && item.mode !== 'guidance' && item.turnId === turnId)
        return { items: items.slice(i), startedAt: item.createdAt > 0 ? item.createdAt : null }
    }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'turn_stats') return { items: items.slice(i + 1), startedAt: null }
    if (item.kind === 'user' && item.mode !== 'guidance') return { items: items.slice(i), startedAt: null }
  }
  return { items, startedAt: null }
}

/** 本轮已经过了多久；没有开始时间或还没到门槛时为 null */
export function turnElapsed(startedAt: number | null, now: number): number | null {
  if (startedAt === null) return null
  const ms = Math.max(0, now - startedAt)
  return ms >= TURN_CLOCK_MS ? ms : null
}

/**
 * 状态行上写的「正在做什么」：verb 是动作，object 是对象（文件名、命令，用等宽字体）；
 * 说明、子智能体、MCP 这类没法干净拆开的整句放在 verb 里，object 为 null
 */
export interface LiveStatus {
  verb: string
  object: string | null
  /** 另外还在跑的个数（并行的子智能体等） */
  more: number
}

const LIVE_VERB = {
  command: 'session.live.verb.command',
  edit: 'session.live.verb.edit',
  create: 'session.live.verb.create',
  read: 'session.live.verb.read',
  search: 'session.live.verb.search',
  web: 'session.live.verb.web',
} as const satisfies Record<string, TranslationKey>

const split = (verb: keyof typeof LIVE_VERB, object: string): Pick<LiveStatus, 'verb' | 'object'> => ({
  verb: tr(LIVE_VERB[verb]),
  object: object || null,
})

/** 正在进行的一步 → 动作 + 对象 */
export function liveStep(item: StepItem): Pick<LiveStatus, 'verb' | 'object'> {
  switch (item.kind) {
    case 'reasoning':
      return { verb: tr('session.wait.thinking'), object: null }
    case 'command': {
      // 有说明就整句用说明（「运行单元测试」），没有写命令本身
      const description = item.description?.trim()
      return description ? { verb: description, object: null } : split('command', firstLine(item.command))
    }
    case 'file_change': {
      const [first] = item.changes
      if (item.changes.length !== 1 || !first) return { verb: stepText(item), object: null }
      return split(first.kind === 'add' ? 'create' : 'edit', baseName(first.path))
    }
    case 'tool':
      if (item.tool === 'read' || item.tool === 'search' || item.tool === 'web')
        return split(item.tool, firstLine(item.title))
      return { verb: stepText(item), object: null }
  }
}

/**
 * 运行中状态行的内容（传这一轮的条目）：
 * 正在输出回复文字写「正在写回复」；有在跑的一步写这一步；两步之间按最后一条条目写在等什么
 */
export function liveStatus(items: readonly Item[]): LiveStatus {
  const last = items[items.length - 1]
  if (last?.kind === 'assistant' && last.status === 'running' && last.text.trim())
    return { verb: tr('session.live.writing'), object: null, more: 0 }
  const step = currentStep(items)
  if (step) return { ...liveStep(step.item), more: step.more }
  return { verb: tr(`session.wait.${waitingFor(items)}`), object: null, more: 0 }
}

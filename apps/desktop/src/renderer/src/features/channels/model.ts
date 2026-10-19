// 协作频道的纯函数（docs/ui/channels.md §5–§6）。不依赖 window，可以直接单测。
import type {
  Channel,
  ChannelEvent,
  ChannelMember,
  ChannelMessage,
  ChannelTask,
  ChannelTextMessage,
} from '@/data/types'
import { MENTION_ALL, mentionBoundary, parseMentions } from '../../../../shared/channels/mentions'

export { excerpt, mentionsAll, parseMentions, splitMentions } from '../../../../shared/channels/mentions'

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

export type TimelineRow =
  | { kind: 'day'; key: string; at: number }
  | { kind: 'new'; key: string }
  | { kind: 'group'; key: string; authorId: string; items: ChannelTextMessage[] }
  | { kind: 'task'; key: string; message: ChannelTask }
  | { kind: 'event'; key: string; message: ChannelEvent }

/** 同一作者的连续消息在这个间隔内合并成一组 */
export const GROUP_GAP_MS = 5 * 60_000

export function dayStart(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 按时间排好的消息 → 时间线的行：跨天插日期分隔，`newFrom` 处插一次「新消息」分隔，
 * 同一作者 gap 内的连续普通消息合并成组；换人、超时、跨天、分隔线、任务卡 / 事件、带引用都会断开。
 */
export function buildTimeline(
  messages: readonly ChannelMessage[],
  opts: { newFrom?: number | null; gapMs?: number } = {},
): TimelineRow[] {
  const gap = opts.gapMs ?? GROUP_GAP_MS
  const rows: TimelineRow[] = []
  let lastDay: number | null = null
  let group: Extract<TimelineRow, { kind: 'group' }> | null = null
  let newPlaced = false
  for (const m of messages) {
    const day = dayStart(m.at)
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day-${day}`, at: day })
      lastDay = day
      group = null
    }
    if (opts.newFrom != null && !newPlaced && m.at >= opts.newFrom) {
      rows.push({ kind: 'new', key: 'new' })
      newPlaced = true
      group = null
    }
    if (m.kind === 'message') {
      const last = group?.items[group.items.length - 1]
      if (group && last && group.authorId === m.authorId && !m.replyToId && m.at - last.at <= gap) group.items.push(m)
      else {
        group = { kind: 'group', key: m.id, authorId: m.authorId, items: [m] }
        rows.push(group)
      }
    } else {
      rows.push(m.kind === 'task' ? { kind: 'task', key: m.id, message: m } : { kind: 'event', key: m.id, message: m })
      group = null
    }
  }
  return rows
}

/** 进入频道前最早一条未读的时间：别人发的（不含事件）里最后 unread 条中的第一条 */
export function firstUnreadAt(
  messages: readonly ChannelMessage[],
  unread: number,
  selfId: string | null,
): number | null {
  if (unread <= 0) return null
  const others = messages.filter(m => m.kind !== 'event' && m.authorId !== selfId)
  return others.slice(-unread)[0]?.at ?? null
}

// ---------------------------------------------------------------------------
// @提及
// ---------------------------------------------------------------------------

const MAX_QUERY = 32

/** 光标前正在输入的 @提及：@ 前面不能紧跟英文字母 / 数字，@ 到光标之间不能有空白 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0 && caret - i <= MAX_QUERY + 1; i--) {
    const ch = text[i]
    if (/\s/.test(ch)) return null
    if (ch === '@') return mentionBoundary(text, i) ? { start: i, query: text.slice(i + 1, caret) } : null
  }
  return null
}

/** 把 [start, end) 替换成 `@名字 `，返回新文本和光标位置；后面已经是空白时不再多加空格 */
export function insertMention(
  text: string,
  range: { start: number; end: number },
  name: string,
): { text: string; caret: number } {
  const rest = text.slice(range.end)
  const space = /^\s/.test(rest) ? '' : ' '
  const inserted = `@${name}${space}`
  return { text: text.slice(0, range.start) + inserted + rest, caret: range.start + inserted.length + (space ? 0 : 1) }
}

/** @ 菜单的候选：不含自己，按名字或引擎名过滤，AI 成员在前 */
export function filterMentionable(
  members: readonly ChannelMember[],
  query: string,
  selfId: string | null,
): ChannelMember[] {
  const q = query.trim().toLowerCase()
  const match = (m: ChannelMember) =>
    !q || m.name.toLowerCase().includes(q) || (m.kind === 'agent' && m.engine.includes(q))
  const list = members.filter(m => m.id !== selfId && match(m))
  return [...list.filter(m => m.kind === 'agent'), ...list.filter(m => m.kind === 'human')]
}

/**
 * @ 菜单默认选中哪一项（有「全体」时它是第 0 项）：只打了 @ 或输入和成员也对得上时选第一个成员，
 * 免得 @ + Enter 一下派给所有 AI；输入是「全」「全体」「al」「all」时才默认选「全体」
 */
export function defaultMentionIndex(query: string, hasAll: boolean, memberCount: number): number {
  if (!hasAll || memberCount === 0) return 0
  const q = query.trim().toLowerCase()
  const typingAll = (q.length >= 1 && MENTION_ALL.zh.startsWith(q)) || (q.length >= 2 && MENTION_ALL.en.startsWith(q))
  return typingAll ? 0 : 1
}

/**
 * 引用了任务卡时这条消息还算不算给那项活追加要求：没 @ 别的 AI 成员才算（和主进程 / 云端派活的规则一样）；
 * 写了 @全体 或 @ 了别的 AI 成员时，发出去会各开新任务卡
 */
export function continuesTask(text: string, members: readonly ChannelMember[], assigneeId: string): boolean {
  const agents = new Set(members.filter(m => m.kind === 'agent').map(m => m.id))
  return parseMentions(text, members).every(id => !agents.has(id) || id === assigneeId)
}

/** @ 菜单最上面的「全体 AI 成员」（issue #83）：频道里有 2 个以上 AI 成员、输入的字是「全体」或「all」的开头时出现 */
export function mentionAllOption(members: readonly ChannelMember[], query: string): { count: number } | null {
  const count = members.filter(m => m.kind === 'agent').length
  if (count < 2) return null
  const q = query.trim().toLowerCase()
  return !q || MENTION_ALL.zh.startsWith(q) || MENTION_ALL.en.startsWith(q) ? { count } : null
}

/** @全体 时会同时改同一个目录的 AI 成员（只算这个频道里的）；不到 2 个时空数组 */
export function sharedDirAgents(members: readonly ChannelMember[]): string[] {
  const agents = members.filter(m => m.kind === 'agent')
  const names = new Set(agents.map(a => a.name))
  const shared = agents.filter(a => a.sharesDirWith?.some(n => n !== a.name && names.has(n))).map(a => a.name)
  return shared.length >= 2 ? shared : []
}

// ---------------------------------------------------------------------------
// 状态更新（都返回新对象，不改原值）
// ---------------------------------------------------------------------------

/** 侧栏角标：归档的频道不算 */
export function unreadTotal(channels: readonly Channel[]): number {
  return channels.reduce((sum, c) => sum + (c.archivedAt ? 0 : Math.max(0, c.unread)), 0)
}

export function markRead(channels: Channel[], id: string): Channel[] {
  if (!channels.some(c => c.id === id && (c.unread > 0 || c.mentioned))) return channels
  return channels.map(c => (c.id === id ? { ...c, unread: 0, mentioned: false } : c))
}

export function appendMessage(
  messages: Record<string, ChannelMessage[]>,
  message: ChannelMessage,
): Record<string, ChannelMessage[]> {
  return { ...messages, [message.channelId]: [...(messages[message.channelId] ?? []), message] }
}

export function createMessage(input: {
  id: string
  channelId: string
  authorId: string
  text: string
  replyToId?: string | null
  members: readonly Pick<ChannelMember, 'id' | 'name'>[]
  now: number
}): ChannelTextMessage {
  const mentions = parseMentions(input.text, input.members).filter(id => id !== input.authorId)
  return {
    kind: 'message',
    id: input.id,
    channelId: input.channelId,
    at: input.now,
    authorId: input.authorId,
    text: input.text,
    format: 'plain',
    replyToId: input.replyToId ?? null,
    mentions,
  }
}

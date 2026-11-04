// 协作频道的纯函数（docs/ui/channels.md §5–§6）。不依赖 window，可以直接单测。
import type {
  AgentMember,
  Channel,
  ChannelEvent,
  ChannelMember,
  ChannelMessage,
  ChannelTask,
  ChannelTextMessage,
} from '@/data/types'
import type { FlowSchedule, FlowScheduleInput } from '../../../../shared/types/channels'
import { MENTION_ALL, mentionBoundary, parseMentions } from '../../../../shared/channels/mentions'
import { countsUnread } from '../../../../shared/channels/threads'

export { excerpt, mentionsAll, parseMentions, splitMentions } from '../../../../shared/channels/mentions'

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

export type TimelineRow =
  /** 跨天的日期分隔；first 是这天第一条消息的时间，分隔线上一起写 */
  | { kind: 'day'; key: string; at: number; first: number }
  /** 同一天里隔了一阵才有的消息：居中的时间分隔 */
  | { kind: 'time'; key: string; at: number }
  | { kind: 'new'; key: string }
  /**
   * tasks：从这组某条消息派出去的任务卡（按消息 id），状态条挂在那条消息下面；
   * flows：紧跟着这条消息、交给 AI 拟计划的流程（按消息 id），那条消息下面只写一行「交给谁 · 计划模式」，卡在 AI 那边
   */
  | {
      kind: 'group'
      key: string
      authorId: string
      items: ChannelTextMessage[]
      tasks?: Record<string, ChannelTask[]>
      flows?: Record<string, ChannelTextMessage[]>
    }
  | { kind: 'task'; key: string; message: ChannelTask }
  /**
   * 流程卡。拟计划的流程是拟计划的成员在说话，排在左边它的头像下面；
   * part：whole 一整张；你回答了问题（answersId 那条在时间线上）时拆成两行：原位置是问题（只读），
   * 你的回答后面是计划 / 进度。raw：拟计划的成员原样贴在回复里、已经读进卡里的计划 JSON（回复全文）
   */
  | { kind: 'flow'; key: string; message: ChannelTextMessage; part: FlowPart; raw?: string[] }
  | { kind: 'event'; key: string; message: ChannelEvent }

export type FlowPart = 'whole' | 'questions' | 'plan'

/** 同一作者的连续消息在这个间隔内合并成一组 */
export const GROUP_GAP_MS = 5 * 60_000
/** 同一天里前后两条隔了这么久，中间插一条时间分隔 */
export const TIME_GAP_MS = 10 * 60_000

export function dayStart(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 在主时间线上以普通消息（气泡）显示的消息：不在串里、不是流程卡 */
const bubbleMessage = (m: ChannelMessage): boolean => m.kind === 'message' && !m.threadId && !m.flow

/** 拟计划的活要你处理（等你确认、等主人同意）或失败了：照常显示任务卡，其余时候都在流程卡里 */
const plannerChipShown = (t: ChannelTask): boolean =>
  t.status === 'waiting' || t.status === 'approval' || t.status === 'failed'

/** 拟计划的流程问过的问题都答了、记着你回答的那条消息：时间线上可以拆成问题、计划两行 */
const splitFlow = (m: ChannelTextMessage): boolean => {
  const f = m.flow
  return !!f?.planner && !!f.answersId && !!f.questions?.length && f.questions.every(q => !!q.answer)
}

/** 是不是一份计划的 JSON（对象，带 steps 或 questions）：和主进程从回复里认计划的规则一样 */
function isPlanJson(text: string): boolean {
  const t = text.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return false
  try {
    const v = JSON.parse(t) as unknown
    return !!v && typeof v === 'object' && !Array.isArray(v) && ('steps' in v || 'questions' in v)
  } catch {
    return false
  }
}

/**
 * 拟计划的成员把计划 JSON 写在回复里（```json 代码块，或回复本身 / 中间就是一个 JSON 对象）：去掉这段，
 * 软件已经读进流程卡里了。found：去掉过；text：剩下的话（去掉后没剩下有意义的字时是空串）
 */
export function stripPlanJson(text: string): { text: string; found: boolean } {
  let found = false
  let rest = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, (all, body: string) => {
    if (!isPlanJson(body)) return all
    found = true
    return ''
  })
  if (!found) {
    const start = rest.indexOf('{'),
      end = rest.lastIndexOf('}')
    if (start >= 0 && end > start && isPlanJson(rest.slice(start, end + 1))) {
      found = true
      rest = rest.slice(0, start) + rest.slice(end + 1)
    }
  }
  if (!found) return { text, found }
  rest = rest.replace(/\n{3,}/g, '\n\n').trim()
  // 只剩标点，或只剩引出 JSON 的半句（一行、冒号结尾，如「计划如下：」）：算没话
  const lead = !rest.includes('\n') && rest.length <= 24 && /[:：]$/.test(rest)
  return { text: !lead && /[\p{L}\p{N}]{2,}/u.test(rest) ? rest : '', found }
}

/**
 * 按时间排好的消息 → 时间线的行：跨天插日期分隔，同一天隔了 TIME_GAP_MS 插时间分隔，`newFrom` 处插一次「新消息」分隔，
 * 同一作者 gap 内的连续普通消息合并成组；换人、超时、跨天、分隔线、任务卡 / 事件、带引用都会断开。
 * 派活的那条消息在时间线上时，任务卡挂到那条消息下面（组的 tasks），不单独占一行，也不打断分组。
 * 拟计划的流程卡单独一行（界面上排在拟计划的成员那边）；你紧跟着发的那条消息下面记一笔（组的 flows），写「交给谁」。
 * 你回答了问题时拆成两行：原位置是问题，你那条回答后面是计划。流程卡显示时，拟计划那项活不再单独出任务卡；
 * 拟计划的成员回复里贴的计划 JSON 不显示（收到流程卡的 raw 里），回复只剩 JSON 时整条不显示
 */
export function buildTimeline(
  messages: readonly ChannelMessage[],
  opts: { newFrom?: number | null; gapMs?: number; timeGapMs?: number } = {},
): TimelineRow[] {
  const gap = opts.gapMs ?? GROUP_GAP_MS
  const timeGap = opts.timeGapMs ?? TIME_GAP_MS
  const rows: TimelineRow[] = []
  let lastDay: number | null = null
  let lastAt: number | null = null
  let group: Extract<TimelineRow, { kind: 'group' }> | null = null
  let newPlaced = false
  // 消息 id → 它所在的组：任务卡找派活的那条消息
  const groupOf = new Map<string, Extract<TimelineRow, { kind: 'group' }>>()
  // 时间线上显示了的流程卡：它的拟计划任务卡收进流程卡里
  const shownFlows = new Set<string>()
  // 流程 id → 它最后一行流程卡：拟计划的回复里的原始 JSON 收到这里
  const flowRow = new Map<string, Extract<TimelineRow, { kind: 'flow' }>>()
  // 拟计划的活（任务 id → 流程 id）：它的结果消息要去掉计划 JSON
  const plannerTasks = new Map<string, string>()
  // 主时间线上的普通消息（不在串里）
  const onTimeline = new Set<string>()
  for (const m of messages) {
    if (m.kind === 'task' && m.flow?.stepId === '') plannerTasks.set(m.id, m.flow.messageId)
    if (m.kind === 'message' && !m.threadId) onTimeline.add(m.id)
  }
  // 你回答问题那条消息 id → 流程：计划排到那条后面
  const afterAnswers = new Map<string, ChannelTextMessage>()
  for (const m of messages)
    if (m.kind === 'message' && splitFlow(m) && onTimeline.has(m.flow!.answersId!))
      afterAnswers.set(m.flow!.answersId!, m)
  const pushFlow = (message: ChannelTextMessage, part: FlowPart) => {
    const row: Extract<TimelineRow, { kind: 'flow' }> = {
      kind: 'flow',
      key: part === 'plan' ? `${message.id}:plan` : message.id,
      message,
      part,
    }
    rows.push(row)
    flowRow.set(message.id, row)
    shownFlows.add(message.id)
  }
  for (let m of messages) {
    // 只在讨论串里的消息不上主时间线（docs/ui/channels-collab-v2.md §3）
    if (m.kind === 'message' && m.threadId) continue
    // 拟计划的成员回复里贴的计划 JSON：软件已经读进卡里，不再贴出来；只剩 JSON 的回复整条不显示
    const plannerFlow = m.kind === 'message' && m.taskId ? plannerTasks.get(m.taskId) : undefined
    if (plannerFlow && m.kind === 'message') {
      const stripped = stripPlanJson(m.text)
      if (stripped.found) {
        const row = flowRow.get(plannerFlow)
        if (row) (row.raw ??= []).push(m.text)
        if (!stripped.text) continue
        m = { ...m, text: stripped.text }
      }
    }
    // 牵头成员直接回答了、没拆出步骤的流程（docs/ui/channels-pipeline.md §8.3）：回答在任务卡下面，流程卡不显示
    if (m.kind === 'message' && m.flow?.planner?.auto && m.flow.status === 'stopped' && !m.flow.steps.length) continue
    if (m.kind === 'task' && m.flow?.stepId === '' && shownFlows.has(m.flow.messageId) && !plannerChipShown(m)) continue
    // 拟计划的流程卡紧跟在你那条消息后面（同一作者、没隔太久）：那条消息下面写一行「交给谁」，卡照常另起一行
    if (m.kind === 'message' && m.flow?.planner && group && group.authorId === m.authorId) {
      const last = group.items[group.items.length - 1]
      if (m.at - last.at <= gap) {
        const flows = (group.flows ??= {})
        ;(flows[last.id] ??= []).push(m)
      }
    }
    const host = m.kind === 'task' && m.sourceMessageId ? groupOf.get(m.sourceMessageId) : undefined
    if (host && m.kind === 'task') {
      const tasks = (host.tasks ??= {})
      ;(tasks[m.sourceMessageId!] ??= []).push(m)
      continue
    }
    const day = dayStart(m.at)
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day-${day}`, at: day, first: m.at })
      lastDay = day
      group = null
    } else if (lastAt != null && m.at - lastAt > timeGap) {
      rows.push({ kind: 'time', key: `time-${m.id}`, at: m.at })
      group = null
    }
    lastAt = m.at
    if (opts.newFrom != null && !newPlaced && m.at >= opts.newFrom) {
      rows.push({ kind: 'new', key: 'new' })
      newPlaced = true
      group = null
    }
    if (m.kind === 'message' && !m.flow) {
      const last = group?.items[group.items.length - 1]
      if (group && last && group.authorId === m.authorId && !m.replyToId && m.at - last.at <= gap) group.items.push(m)
      else {
        group = { kind: 'group', key: m.id, authorId: m.authorId, items: [m] }
        rows.push(group)
      }
      groupOf.set(m.id, group)
      // 你回答问题的那条：计划 / 进度排在它后面
      const split = afterAnswers.get(m.id)
      if (split) {
        pushFlow(split, 'plan')
        group = null
      }
    } else if (m.kind === 'message') {
      pushFlow(m, afterAnswers.has(m.flow?.answersId ?? '') ? 'questions' : 'whole')
      group = null
    } else {
      rows.push(m.kind === 'task' ? { kind: 'task', key: m.id, message: m } : { kind: 'event', key: m.id, message: m })
      group = null
    }
  }
  return rows
}

/** 主时间线上已经有结果消息的任务卡：卡上不再重复结果摘要 */
export function tasksWithResult(messages: readonly ChannelMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) if (bubbleMessage(m) && m.kind === 'message' && m.taskId) ids.add(m.taskId)
  return ids
}

/** 进入频道前最早一条未读的时间：算未读的（别人发的、不含事件和没 @ 你的串里回复）里最后 unread 条中的第一条 */
export function firstUnreadAt(
  messages: readonly ChannelMessage[],
  unread: number,
  selfId: string | null,
): number | null {
  if (unread <= 0) return null
  const others = messages.filter(m => countsUnread(m, selfId))
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

/** 这条消息会派给的 SSH 成员（@ 到的，或被追加要求的）：读不到本机路径 */
export function remoteAgents(text: string, members: readonly ChannelMember[], assigneeId?: string): AgentMember[] {
  const ids = new Set(parseMentions(text, members))
  if (assigneeId) ids.add(assigneeId)
  return members.filter((m): m is AgentMember => m.kind === 'agent' && m.machineId !== 'local' && ids.has(m.id))
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

/** 新建频道时按名字、项目筛 AI 成员（不分大小写）；空查询全部 */
export function matchAgents<T extends Pick<AgentMember, 'name' | 'project'>>(agents: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...agents]
  return agents.filter(a => a.name.toLowerCase().includes(q) || (a.project ?? '').toLowerCase().includes(q))
}

/** 定时 → 存定时时传给主进程的样子（去掉运行时字段，主进程按 id 保留） */
export function scheduleToInput(s: FlowSchedule): FlowScheduleInput {
  return {
    id: s.id,
    title: s.title,
    hour: s.hour,
    steps: s.steps,
    limits: s.limits,
    enabled: s.enabled,
    isolate: s.isolate,
  }
}

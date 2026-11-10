// 频道时间线的日期 / 时间格式（docs/ui/channels.md §5.1），流程卡和成员档案的用量文字
import { getLocale, tr } from '../../i18n/core'
import { costHint, formatCardCost, formatShortCost, formatTokens } from '@/features/usage/format'
import type { FlowUsage } from '../../../../shared/types/channels'
import type { ChannelMember, ChannelMessage } from '@/data/types'
import { dayStart } from './model'
import { lastSeen } from './teamModel'

const WEEKDAYS = '日一二三四五六'

/** 日期分隔：今天 / 昨天 / 10月6日 星期一（英文 Mon, Oct 6）；不是今年时带上年份 */
export function formatDay(at: number, now = Date.now()): string {
  const day = dayStart(at),
    today = dayStart(now)
  if (day === today) return tr('channels.today')
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === yesterday.getTime()) return tr('channels.yesterday')
  const d = new Date(at)
  const otherYear = d.getFullYear() !== new Date(now).getFullYear()
  if (getLocale() === 'en-US')
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(otherYear ? { year: 'numeric' } : {}),
    }).format(d)
  return `${otherYear ? `${d.getFullYear()}年` : ''}${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]}`
}

/** 用时：12 秒、2 分 40 秒、1 小时 5 分 */
export function durText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return tr('channels.flow.dur.s', { s })
  const m = Math.floor(s / 60)
  return m < 60
    ? tr('channels.flow.dur.ms', { m, s: s % 60 })
    : tr('channels.flow.dur.hm', { h: Math.floor(m / 60), m: m % 60 })
}

/** 消息时间：中文 09:05，英文 9:05 AM */
export function formatClock(at: number): string {
  const d = new Date(at)
  if (getLocale() === 'en-US') return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 搜索结果的时间（列表窄）：今天只写时间，其它只写日期，不是今年时带上年份 */
export function formatShortTime(at: number, now = Date.now()): string {
  if (dayStart(at) === dayStart(now)) return formatClock(at)
  const d = new Date(at)
  const otherYear = d.getFullYear() !== new Date(now).getFullYear()
  const en = getLocale() === 'en-US'
  // 中文 10月6日 / 2025年10月6日，英文 Oct 6 / Oct 6, 2025
  return new Intl.DateTimeFormat(en ? 'en-US' : 'zh-CN', {
    month: en ? 'short' : 'long',
    day: 'numeric',
    ...(otherYear ? { year: 'numeric' } : {}),
  }).format(d)
}

const SEEN_KEY = { minutes: 'team.seen.minutes', hours: 'team.seen.hours', days: 'team.seen.days' } as const

/** 「N 分钟前在线」等；没有记录或太久以前返回 null */
export function formatLastSeen(at: number | null | undefined, now = Date.now()): string | null {
  const seen = lastSeen(at, now)
  if (!seen) return null
  if (seen.unit === 'justNow') return tr('team.seen.justNow')
  return tr(SEEN_KEY[seen.unit], { count: seen.count })
}

/** 同步时间：今天只写时间，其它带日期 */
export function formatSyncTime(at: number, now = Date.now()): string {
  return dayStart(at) === dayStart(now) ? formatClock(at) : `${formatDay(at, now)} ${formatClock(at)}`
}

/** 没有费用的原因（用量页的 costState）→ 词条 channels.flow.usage.reason.* */
export const WHY_KEY = {
  engine: 'engine',
  pending: 'pending',
  platform: 'platform',
  'no-price': 'noPrice',
} as const

/** 没有费用的记录里最常见的原因；empty 等不认识的不算 */
function topWhy(u: FlowUsage): keyof typeof WHY_KEY | undefined {
  return (Object.entries(u.why) as [keyof typeof WHY_KEY, number][])
    .filter(([k]) => k in WHY_KEY)
    .sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** 一步（或整条流程、频道合计）的用量文字：token + 费用；没有费用时写最常见的原因 */
export function usageText(u: FlowUsage | null | undefined): { text: string; title: string } | null {
  if (!u || u.records <= 0) return null
  const tokens = tr('channels.flow.usage.tokens', {
    n: formatTokens(u.input + u.cacheRead + u.cacheWrite + u.output),
  })
  let cost = formatCardCost(u)
  let title = ''
  if (u.costKnown === 0) {
    const top = topWhy(u)
    if (top) {
      cost += ' ' + tr(`channels.flow.usage.reason.${WHY_KEY[top]}`)
      title = costHint(top)
    }
  }
  return { text: `${u.unrecorded > 0 ? '≥ ' : ''}${tokens} · ${cost}`, title }
}

/**
 * 档案「费用」「今天」格、成员行的今天花费：没有记录「—」，有记录但一条费用都没有时写原因（未计价 / 结算中），
 * 否则是金额（short：满 1 美分留 2 位小数）
 */
export function costCell(u: FlowUsage | null | undefined, short = false): { text: string; title: string } {
  if (!u || u.records <= 0) return { text: '—', title: '' }
  const top = u.costKnown === 0 ? topWhy(u) : undefined
  if (top) return { text: tr(`channels.flow.usage.reason.${WHY_KEY[top]}`), title: costHint(top) }
  return { text: (short ? formatShortCost : formatCardCost)(u), title: '' }
}

export function sumUsage(list: readonly FlowUsage[]): FlowUsage {
  const t: FlowUsage = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
    costKnown: 0,
    costActual: 0,
    records: 0,
    turns: 0,
    unrecorded: 0,
    why: {},
  }
  for (const u of list) {
    t.input += u.input
    t.cacheRead += u.cacheRead
    t.cacheWrite += u.cacheWrite
    t.output += u.output
    t.costUsd += u.costUsd
    t.costKnown += u.costKnown
    t.costActual = (t.costActual ?? 0) + (u.costActual ?? 0)
    t.records += u.records
    t.turns += u.turns
    t.unrecorded += u.unrecorded
    for (const [k, n] of Object.entries(u.why) as [keyof FlowUsage['why'], number][]) t.why[k] = (t.why[k] ?? 0) + n
  }
  return t
}

/**
 * 频道消息里的路径按哪个目录认（docs/ui/channels-local-rest.md §3.3 b）：任务结果按那张卡的会话（合并过的卡副本没了，按成员项目），
 * 否则按作者成员的项目；都没有是 null（真人发的纯文字不做）
 */
export function messageWorkspace(
  m: { taskId?: string | null; authorId: string },
  messagesById: ReadonlyMap<string, ChannelMessage>,
  membersById: ReadonlyMap<string, ChannelMember>,
): { sessionId: string | null; projectId: string | null } | null {
  const task = m.taskId ? messagesById.get(m.taskId) : undefined
  if (task?.kind === 'task' && task.sessionId && task.land?.kind !== 'merged')
    return { sessionId: task.sessionId, projectId: null }
  const author = membersById.get(task?.kind === 'task' ? task.assigneeId : m.authorId)
  // shortcut: 不退到频道项目（MessageGroup 拿不到频道），AI 成员都有自己的项目，有人要再传进来
  return author?.kind === 'agent' && author.config ? { sessionId: null, projectId: author.config.projectId } : null
}

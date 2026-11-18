// 事项唤醒（docs/multica-learn.md §11.6）的界面数据：卡上那一行的文字、唤醒卡是哪条规则开的、看板事项的「下次 …」，
// 以及唤醒对话框的默认值和要发给主进程的参数。纯函数（时间按这台电脑的时区，和主进程的 nextSlot 一致）
import { tr, type TranslationKey } from '@/i18n/core'
import { WAKEUP_MAX_DAYS, WAKEUP_WAIT_DAYS, wakeupFirst } from '../../../../shared/channels/wakeup'
import type {
  Channel,
  ChannelMember,
  ChannelMessage,
  ChannelRun,
  ChannelTask,
  ChannelWakeup,
  WakeupFreq,
  WakeupKind,
  WakeupOp,
  WakeupWhen,
} from '../../../../shared/types/channels'

const MINUTE = 60_000
const DAY = 86_400_000
const pad = (n: number): string => String(n).padStart(2, '0')

/** 挂唤醒的那张卡：任务卡，或流程卡（流程那条消息） */
export interface WakeupOn {
  channelId: string
  /** 任务卡 id 或流程消息 id */
  on: string
  kind: 'task' | 'flow'
  title: string
  /** 任务卡的负责人：「等它结束」不能叫它（会自己叫醒自己）；流程卡没有 */
  assigneeId: string | null
  /** 流程已经全部交付：不能再「等它结束」 */
  ended?: boolean
}

export const clockText = (hour: number, minute: number): string => `${pad(hour)}:${pad(minute)}`

/** 11-25 */
export function dateText(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 今天 09:00 / 明天 09:00 / 11-25 09:00 */
export function dayClock(ts: number, now: number): string {
  const d = new Date(ts)
  const days = Math.round((new Date(ts).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY)
  const day = days === 0 ? tr('wakeup.today') : days === 1 ? tr('wakeup.tomorrow') : dateText(ts)
  return `${day} ${clockText(d.getHours(), d.getMinutes())}`
}

/** 定期检查的频率：每小时第 05 分 / 每天 09:00 / 工作日 09:00 */
export function everyText(when: { freq: WakeupFreq; hour: number; minute: number }): string {
  if (when.freq === 'hourly') return tr('wakeup.when.hourly', { minute: pad(when.minute) })
  return tr(when.freq === 'daily' ? 'wakeup.when.daily' : 'wakeup.when.weekdays', {
    time: clockText(when.hour, when.minute),
  })
}

/** 规则那一行的前半句：「每天 09:00 叫 审查员」「明天 09:00 叫 审查员」「做完后叫 审查员」 */
export function wakeupHead(rule: Pick<ChannelWakeup, 'when'>, name: string, now: number, flow = false): string {
  const w = rule.when
  if (w.kind === 'at') return tr('wakeup.line.at', { time: dayClock(w.at, now), name })
  if (w.kind === 'every') return tr('wakeup.line.every', { when: everyText(w), name })
  if (flow) return tr('wakeup.line.endedFlow', { name })
  const key: TranslationKey =
    w.failed && w.stopped
      ? 'wakeup.line.endedAny'
      : w.failed
        ? 'wakeup.line.endedFailed'
        : w.stopped
          ? 'wakeup.line.endedStopped'
          : 'wakeup.line.ended'
  return tr(key, { name })
}

/** 后半句的几段：定期检查写下次和截止，等结束写最多等到哪天；「到某个时间」前半句已经写了时间 */
export function wakeupMeta(rule: Pick<ChannelWakeup, 'when' | 'next' | 'until'>, now: number): string[] {
  if (rule.when.kind === 'every')
    return [
      rule.next !== null ? tr('wakeup.line.next', { time: dayClock(rule.next, now) }) : '',
      rule.until !== null ? tr('wakeup.line.until', { date: dateText(rule.until) }) : '',
    ].filter(Boolean)
  if (rule.when.kind === 'ended' && rule.until !== null)
    return [tr('wakeup.line.waitUntil', { date: dateText(rule.until) })]
  return []
}

/** 挂在这张卡上、还活着的规则：有下次时间的按时间排在前，等结束的在后 */
export function liveWakeups(channel: Pick<Channel, 'wakeups'> | null | undefined, on: string): ChannelWakeup[] {
  return (channel?.wakeups ?? [])
    .filter(w => w.state === 'active' && w.on === on)
    .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity) || a.createdAt - b.createdAt)
}

/** 最近一天里自己结束的（失效取消、等到截止没等到）：卡上淡淡写一行，免得以为还挂着；你自己点掉的不写 */
export function recentEndedWakeup(
  channel: Pick<Channel, 'wakeups'> | null | undefined,
  on: string,
  now: number,
): ChannelWakeup | null {
  let hit: ChannelWakeup | null = null
  for (const w of channel?.wakeups ?? []) {
    if (w.on !== on || (w.state !== 'expired' && !(w.state === 'cancelled' && w.endNote))) continue
    const at = w.lastAt ?? w.createdAt
    if (now - at > DAY) continue
    if (!hit || at > (hit.lastAt ?? hit.createdAt)) hit = w
  }
  return hit
}

/**
 * 是不是唤醒卡（不用读消息）：有规则的 card 是它；规则被清掉了（结束的只留最近 50 条），它跑过的轮次上还带着唤醒标记
 */
export function isWakeupCard(
  channel: Pick<Channel, 'wakeups'> | null | undefined,
  task: Pick<ChannelTask, 'id' | 'runs'>,
): boolean {
  return !!channel?.wakeups?.some(w => w.card === task.id) || !!task.runs?.some(r => r.wakeup)
}

/** 唤醒卡是哪条规则开的、盯着哪张卡；规则已经被清掉了就看来源那条系统消息上的标记。不是唤醒卡返回 null */
export function wakeupOrigin(
  channel: Pick<Channel, 'wakeups'> | null | undefined,
  task: Pick<ChannelTask, 'id' | 'sourceMessageId'>,
  messages: readonly ChannelMessage[] | undefined,
): { rule: ChannelWakeup | null; on: string | null } | null {
  const rule = channel?.wakeups?.find(w => w.card === task.id) ?? null
  if (rule) return { rule, on: rule.on }
  const source = task.sourceMessageId ? messages?.find(m => m.id === task.sourceMessageId) : undefined
  return source?.kind === 'message' && source.wakeup ? { rule: null, on: source.replyToId ?? null } : null
}

/** 运行记录一行上的标签：唤醒 / 唤醒 · 没有要说的（×N） */
export function runWakeupTag(run: Pick<ChannelRun, 'wakeup'>): string | null {
  const w = run.wakeup
  if (!w) return null
  if (!w.silent) return tr('wakeup.tag')
  return w.silent > 1 ? tr('wakeup.tag.silentMany', { n: w.silent }) : tr('wakeup.tag.silent')
}

/** 消息上的标签：为什么叫的 */
export const messageWakeupTag = (kind: WakeupKind): string => tr(`wakeup.tag.${kind}`)

/** 看板事项上的提示：最近一次到点「下次 明天 09:00」，只有等结束的写「做完后叫 审查员」；悬停看全部 */
export function wakeupHint(
  channel: Pick<Channel, 'wakeups'> | null | undefined,
  on: string,
  nameOf: (memberId: string) => string,
  now: number,
): { text: string; title: string } | null {
  const live = liveWakeups(channel, on)
  if (!live.length) return null
  const first = live[0]
  const text =
    first.next !== null
      ? tr('wakeup.line.next', { time: dayClock(first.next, now) })
      : wakeupHead(first, nameOf(first.memberId), now)
  const title = live
    .map(w => [wakeupHead(w, nameOf(w.memberId), now), ...wakeupMeta(w, now)].join(' · ') + `\n${w.text}`)
    .join('\n\n')
  return { text, title }
}

// ── 对话框 ──

export type AtPreset = 'm10' | 'h1' | 'tomorrow' | 'custom'
export const AT_PRESETS: readonly AtPreset[] = ['m10', 'h1', 'tomorrow', 'custom']
export const WAKEUP_FREQS: readonly WakeupFreq[] = ['hourly', 'daily', 'weekdays']
export type WaitDays = (typeof WAKEUP_WAIT_DAYS)[number]

export interface WakeupDraft {
  kind: WakeupKind
  preset: AtPreset
  /** 自定义时间（datetime-local 的值：YYYY-MM-DDTHH:MM） */
  custom: string
  freq: WakeupFreq
  hour: number
  minute: number
  /** 定期检查截止那一天（date 的值：YYYY-MM-DD），过了这一天不再叫 */
  untilDay: string
  failed: boolean
  stopped: boolean
  waitDays: WaitDays
  memberId: string
  text: string
}

/** datetime-local 的值 */
export function localInput(ts: number): string {
  const d = new Date(ts)
  return `${dayInput(ts)}T${clockText(d.getHours(), d.getMinutes())}`
}

/** date 的值 */
export function dayInput(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** datetime-local 的值 → 本地时间；不合法返回 null（不用 Date.parse：带不带 T、时区各浏览器不一样） */
export function parseLocal(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const date = new Date(y, mo - 1, d, h, mi)
  return date.getMonth() === mo - 1 && date.getDate() === d ? date.getTime() : null
}

/** 截止那一天 → 那天结束的时刻（最远 30 天，按现在算）；不合法或已经过了返回 null */
export function untilOf(day: string, now: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const [y, mo, d] = m.slice(1).map(Number)
  const end = new Date(y, mo - 1, d + 1).getTime() - 1
  if (!Number.isFinite(end) || end <= now) return null
  return Math.min(end, now + WAKEUP_MAX_DAYS * DAY)
}

/** 「到某个时间」选的预设算成时间点：明天 9:00 按本地时间 */
export function atOf(draft: Pick<WakeupDraft, 'preset' | 'custom'>, now: number): number | null {
  if (draft.preset === 'm10') return now + 10 * MINUTE
  if (draft.preset === 'h1') return now + 60 * MINUTE
  if (draft.preset === 'tomorrow') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  return parseLocal(draft.custom)
}

/** 能叫谁：频道里的 AI 成员；「等它结束」盯的是任务卡时去掉它自己的负责人 */
export function wakeupChoices(
  kind: WakeupKind,
  target: Pick<WakeupOn, 'kind' | 'assigneeId'>,
  agents: readonly ChannelMember[],
): ChannelMember[] {
  return agents.filter(
    m => m.kind === 'agent' && !(kind === 'ended' && target.kind === 'task' && m.id === target.assigneeId),
  )
}

/** 默认叫谁：选着的还能叫就留着，否则这张卡的负责人，再否则第一个能叫的 */
export function pickMember(
  kind: WakeupKind,
  target: Pick<WakeupOn, 'kind' | 'assigneeId'>,
  agents: readonly ChannelMember[],
  current?: string,
): string {
  const ok = wakeupChoices(kind, target, agents)
  if (current && ok.some(m => m.id === current)) return current
  return ok.find(m => m.id === target.assigneeId)?.id ?? ok[0]?.id ?? ''
}

export function wakeupDraft(target: WakeupOn, agents: readonly ChannelMember[], now: number): WakeupDraft {
  return {
    kind: 'at',
    preset: 'h1',
    custom: localInput(now + 60 * MINUTE),
    freq: 'daily',
    hour: 9,
    minute: 0,
    untilDay: dayInput(now + 7 * DAY),
    failed: false,
    stopped: false,
    waitDays: 7,
    memberId: pickMember('at', target, agents),
    text: '',
  }
}

/** 换条件：「等它结束」不能叫负责人，叫的人跟着换 */
export function withKind(
  draft: WakeupDraft,
  kind: WakeupKind,
  target: Pick<WakeupOn, 'kind' | 'assigneeId'>,
  agents: readonly ChannelMember[],
): WakeupDraft {
  return { ...draft, kind, memberId: pickMember(kind, target, agents, draft.memberId) }
}

/** 定期检查的条件 */
export const everyWhen = (draft: Pick<WakeupDraft, 'freq' | 'hour' | 'minute'>): WakeupWhen => ({
  kind: 'every',
  freq: draft.freq,
  hour: draft.freq === 'hourly' ? 0 : draft.hour,
  minute: draft.minute,
})

/** 填得不对的地方：member 没人能叫、text 没写要做什么、past / far 时间不对、until 截止不对、never 截止前一次都不叫 */
export type WakeupDraftError = 'member' | 'text' | 'past' | 'far' | 'until' | 'never'

/** 对话框填的 → channels:wakeup 的 add；主进程还会再校验一遍（cleanWakeupAdd） */
export function buildWakeup(
  draft: WakeupDraft,
  target: WakeupOn,
  now: number,
): { op: Extract<WakeupOp, { op: 'add' }> } | { error: WakeupDraftError } {
  const text = draft.text.trim()
  if (!draft.memberId) return { error: 'member' }
  if (!text) return { error: 'text' }
  const base = { op: 'add' as const, on: target.on, memberId: draft.memberId, text }
  if (draft.kind === 'at') {
    const at = atOf(draft, now)
    if (at === null || at <= now) return { error: 'past' }
    if (at > now + WAKEUP_MAX_DAYS * DAY) return { error: 'far' }
    return { op: { ...base, when: { kind: 'at', at } } }
  }
  if (draft.kind === 'every') {
    const until = untilOf(draft.untilDay, now)
    if (until === null) return { error: 'until' }
    const when = everyWhen(draft)
    if ((wakeupFirst(when, now) ?? 0) >= until) return { error: 'never' }
    return { op: { ...base, when, until } }
  }
  const task = target.kind === 'task'
  return {
    op: {
      ...base,
      when: {
        kind: 'ended',
        ...(task && draft.failed ? { failed: true } : {}),
        ...(task && draft.stopped ? { stopped: true } : {}),
      },
      until: now + Math.min(draft.waitDays, WAKEUP_MAX_DAYS) * DAY,
    },
  }
}

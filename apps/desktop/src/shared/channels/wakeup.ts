// 事项唤醒（docs/multica-learn.md §11.6）的纯函数：整理界面 / AI 传来的规则、算下次时间、上限常量。
// 主进程（core/channels/service.ts 的巡检）和界面（显示「下次 …」）共用；时间按这台电脑的时区（shared/schedule.ts）
import { nextSlot } from '../schedule'
import { appendRun } from './runReason'
import type { ChannelRun, ChannelTaskStatus, ChannelWakeup, WakeupFreq, WakeupWhen } from '../types/channels'
import type { ManualTask } from '../types/project-tools'

const DAY = 86_400_000

/** 唤醒指令最多这么多字 */
export const WAKEUP_TEXT_MAX = 2000
/** 截止、「到某个时间」最远这么多天；没写截止时按这么多天 */
export const WAKEUP_MAX_DAYS = 30
export const WAKEUP_DEFAULT_DAYS = 7
/** 「等结束」最多等几天（界面的选项） */
export const WAKEUP_WAIT_DAYS = [1, 3, 7, 30] as const
/** 一张卡上活着的最多几条；AI 自己挂的（schedule_wakeup）活着最多几条、一共最多几条；一个频道活着的最多几条 */
export const WAKEUP_LIVE_MAX = 5
export const WAKEUP_AI_LIVE_MAX = 3
export const WAKEUP_AI_TOTAL_MAX = 10
export const WAKEUP_CHANNEL_MAX = 50
/** 结束了的规则留最近这么多条（卡上显示「已取消：原因」），更早的丢掉 */
export const WAKEUP_KEEP_ENDED = 50
/** 「到某个时间」允许稍微过去一点（界面算好时间到主进程收到之间）：到了马上叫 */
const AT_SLACK_MS = 60_000

const FREQS: readonly WakeupFreq[] = ['hourly', 'daily', 'weekdays']

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

const id = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v || v.length > 200) throw new Error(`${what}不对`)
  return v
}

/** 界面 / AI 传来的条件整理成合法的：不认识的字段丢掉，不对时抛中文错误 */
export function cleanWakeupWhen(raw: unknown, now: number): WakeupWhen {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (r.kind === 'at') {
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) throw new Error('唤醒时间不对')
    if (r.at < now - AT_SLACK_MS) throw new Error('唤醒时间已经过了')
    if (r.at > now + WAKEUP_MAX_DAYS * DAY) throw new Error(`唤醒时间最远 ${WAKEUP_MAX_DAYS} 天`)
    return { kind: 'at', at: Math.floor(r.at) }
  }
  if (r.kind === 'every') {
    if (!FREQS.includes(r.freq as WakeupFreq)) throw new Error('检查频率不对')
    const freq = r.freq as WakeupFreq
    if (!isInt(r.minute, 0, 59) || (freq !== 'hourly' && !isInt(r.hour, 0, 23))) throw new Error('检查的钟点不对')
    return { kind: 'every', freq, hour: freq === 'hourly' ? 0 : (r.hour as number), minute: r.minute }
  }
  if (r.kind === 'ended')
    return {
      kind: 'ended',
      ...(r.failed === true ? { failed: true } : {}),
      ...(r.stopped === true ? { stopped: true } : {}),
    }
  throw new Error('唤醒条件不对')
}

/** 第一次到点：「到某个时间」就是它，定期检查是下一个钟点；「等结束」没有 */
export function wakeupFirst(when: WakeupWhen, now: number): number | null {
  if (when.kind === 'at') return when.at
  if (when.kind === 'every') return nextSlot({ ...when, weekday: 0 }, now)
  return null
}

/**
 * 挂规则时传来的（channels:wakeup 的 add；schedule_wakeup 也先拼成这个形状）：整理好，不对时抛中文错误。
 * 运行时的字段（next、fired、state、card…）一律不认。定期检查、等结束的截止没写按 7 天，最多 30 天
 */
export function cleanWakeupAdd(
  raw: unknown,
  now: number,
): { on: string; memberId: string; when: WakeupWhen; text: string; until: number | null } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const on = id(r.on, '要盯的卡')
  const memberId = id(r.memberId, '要叫的成员')
  const text = typeof r.text === 'string' ? r.text.trim() : ''
  if (!text) throw new Error('唤醒指令不能为空')
  if (text.length > WAKEUP_TEXT_MAX) throw new Error(`唤醒指令最多 ${WAKEUP_TEXT_MAX} 字`)
  const when = cleanWakeupWhen(r.when, now)
  let until: number | null = null
  if (when.kind !== 'at') {
    const u = r.until
    if (u === undefined || u === null) until = now + WAKEUP_DEFAULT_DAYS * DAY
    else if (typeof u !== 'number' || !Number.isFinite(u) || u <= now) throw new Error('截止时间不对')
    else if (u > now + WAKEUP_MAX_DAYS * DAY) throw new Error(`截止最多 ${WAKEUP_MAX_DAYS} 天`)
    else until = Math.floor(u)
    if (when.kind === 'every' && (wakeupFirst(when, now) ?? 0) >= until)
      throw new Error('截止之前一次都不会叫，把截止往后挪一点')
  }
  return { on, memberId, when, text, until }
}

/** 叫过一次之后：只一次的、等结束的就结束；定期检查排下一个钟点（错过几次也只补一次，从现在算），过了截止就结束 */
export function wakeupAfterFire(rule: ChannelWakeup, now: number): ChannelWakeup {
  const fired = { ...rule, fired: rule.fired + 1, lastAt: now }
  if (rule.when.kind !== 'every') return { ...fired, state: 'done', next: null }
  const next = nextSlot({ ...rule.when, weekday: 0 }, now)
  return rule.until !== null && next >= rule.until ? { ...fired, state: 'done', next: null } : { ...fired, next }
}

/** 结束一条规则（note 是取消、失效的原因） */
export function endWakeup(
  rule: ChannelWakeup,
  state: Exclude<ChannelWakeup['state'], 'active'>,
  note: string | null,
  now: number,
): ChannelWakeup {
  return { ...rule, state, endNote: note, next: null, lastAt: now }
}

/**
 * 「等结束」看盯的任务卡：fire 该叫了；cancel 卡停了、没勾「停下也算」；null 接着等。
 * 做完了还要等产出检查跑完（检查在做完之后才开始）；还有一轮在排队或在做（追加要求马上开了下一轮）不算结束。
 * sig：挂规则时卡已经是结束的那一轮，这一轮不再叫
 */
export function endedVerdict(
  when: Extract<WakeupWhen, { kind: 'ended' }>,
  card: { status: ChannelTaskStatus; round: number; checksRunning: boolean; active: boolean },
  sig: string | null | undefined,
): 'fire' | 'cancel' | null {
  if (card.active) return null
  const ended =
    card.status === 'done'
      ? !card.checksRunning
      : card.status === 'failed'
        ? !!when.failed
        : card.status === 'stopped' && !!when.stopped
  if (ended) return String(card.round) === sig ? null : 'fire'
  return card.status === 'stopped' ? 'cancel' : null
}

/** 只留活着的和最近结束的 WAKEUP_KEEP_ENDED 条 */
export function pruneWakeups(list: readonly ChannelWakeup[]): ChannelWakeup[] {
  const ended = list.filter(w => w.state !== 'active')
  if (ended.length <= WAKEUP_KEEP_ENDED) return [...list]
  const drop = new Set(
    ended
      .sort((a, b) => (a.lastAt ?? a.createdAt) - (b.lastAt ?? b.createdAt))
      .slice(0, ended.length - WAKEUP_KEEP_ENDED)
      .map(w => w.id),
  )
  return list.filter(w => !drop.has(w.id))
}

/** 唤醒那一轮的运行记录：同一条规则连续回 [silent] 的合成一条（计数加一），不把真实的记录挤掉 */
export function appendWakeupRun(list: readonly ChannelRun[] | undefined, run: ChannelRun): ChannelRun[] {
  const last = list?.at(-1)
  const silent = run.wakeup?.silent
  if (list && silent && last?.status === 'done' && last.wakeup?.silent && last.wakeup.ruleId === run.wakeup!.ruleId)
    return [...list.slice(0, -1), { ...run, wakeup: { ...run.wakeup!, silent: last.wakeup.silent + silent } }]
  return appendRun(list, run)
}

/**
 * 看板事项刚改成完成（projectTools:updateTask 返回的那份）：给出它派出去的那张卡，挂在上面的唤醒要一起取消
 * （§11.6，免得验收完还在花钱）。tasks.update 改成完成时完成时间就是这次的修改时间，本来就是完成的不算
 */
export function issueJustDone(task: unknown): { channelId: string; taskId: string } | null {
  const t = (task && typeof task === 'object' ? task : {}) as Partial<ManualTask>
  if (t.status !== 'completed' || !t.link || !t.completedAt || t.completedAt !== t.updatedAt) return null
  return { channelId: t.link.channelId, taskId: t.link.taskId }
}

// 账号额度的纯函数（docs/ui/account-quota.md §6.3，样稿第 8 节）：窗口命名、最紧一项、颜色级别、按钮文字、
// 恢复时间、卡片布局。不碰 React / bridge；时间一律由调用方传 now，测试可以固定时间。
import type { AccountQuota, EngineId, QuotaModelLimit, QuotaProvider, QuotaWindow } from '@pixelsky/protocol'
import { QUOTA_WINDOW_MINS } from '@pixelsky/protocol'
import { getLocale, tr } from '@/i18n/core'
import { formatAmount, formatBalance } from '@/features/account/format'
import type { ChannelId } from '@/features/model-channels/channelModel'
import { planInfo, type PlanInfo } from '@/features/model-channels/plans'
import type { QuotaShowWhen } from '@/features/settings/quotaDisplay'

/** 到橙色的百分比 */
export const WARN_PERCENT = 80
/** 官方用量页 */
export const QUOTA_LINKS = {
  claude: 'https://claude.ai/settings/usage',
  chatgpt: 'https://chatgpt.com/codex/settings/usage',
} as const

export type QuotaLevel = 'normal' | 'warn' | 'full'

/** 颜色级别：正常（主色）、80–99 橙、100 或引擎报已拒绝 红 */
export const quotaLevel = (percent: number, rejected = false): QuotaLevel =>
  rejected || percent >= 100 ? 'full' : percent >= WARN_PERCENT ? 'warn' : 'normal'

const clamp = (v: number): number => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0)

/** 百分比文字：整数；0 到 1 之间写「<1%」；99.6 这样四舍五入到 100 但还没用完的写 99% */
export function percentText(percent: number): string {
  const p = clamp(percent)
  if (p > 0 && p < 1) return '<1%'
  const rounded = Math.round(p)
  return `${rounded >= 100 && p < 100 ? 99 : rounded}%`
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0')
const english = (): boolean => getLocale() === 'en-US'
const DAY = 86_400_000

/** 本机时区的时刻：中文 16:45，英文 4:45 PM */
export function clockText(ms: number): string {
  const d = new Date(ms)
  if (!english()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d).replace(/\s/g, ' ')
}

const weekdayText = (ms: number): string =>
  new Intl.DateTimeFormat(english() ? 'en-US' : 'zh-CN', { weekday: 'short' }).format(new Date(ms))

const monthDayText = (ms: number): string => {
  const d = new Date(ms)
  const month = english() ? new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d) : String(d.getMonth() + 1)
  return tr('quota.date.monthDay', { p0: month, p1: d.getDate() })
}

/** 本机日历上差几天（0 今天、1 明天…）；用年月日算，不受夏令时和跨午夜影响 */
export function calendarDaysFrom(now: number, ms: number): number {
  const a = new Date(now),
    b = new Date(ms)
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY,
  )
}

/** 不带「恢复」的时间点：今天 16:45，明天 明天 09:00，2–6 天后 周四 09:00，更远 10 月 23 日 */
export function resetClock(resetsAt: number, now: number): string {
  const days = calendarDaysFrom(now, resetsAt)
  if (days === 0) return clockText(resetsAt)
  if (days === 1) return tr('quota.when.tomorrow', { p0: clockText(resetsAt) })
  if (days >= 2 && days < 7) return `${weekdayText(resetsAt)} ${clockText(resetsAt)}`
  return monthDayText(resetsAt)
}

/** 卡片里的短写：今天「16:45 恢复」、明天「明天 09:00 恢复」、2–6 天后「周四 09:00 恢复」、更远「10 月 23 日恢复」 */
export function resetShort(resetsAt: number, now: number): string {
  if (resetsAt <= now) return tr('quota.reset.passed')
  const days = calendarDaysFrom(now, resetsAt)
  if (days === 0) return tr('quota.reset.today', { p0: clockText(resetsAt) })
  if (days === 1) return tr('quota.reset.tomorrow', { p0: clockText(resetsAt) })
  if (days >= 2 && days < 7) return tr('quota.reset.week', { p0: weekdayText(resetsAt), p1: clockText(resetsAt) })
  return tr('quota.reset.date', { p0: monthDayText(resetsAt) })
}

function durationText(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000))
  if (mins < 60) return tr('quota.duration.min', { p0: mins })
  if (mins < 1_440) {
    const h = Math.floor(mins / 60),
      m = mins % 60
    return m ? tr('quota.duration.hourMin', { p0: h, p1: m }) : tr('quota.duration.hour', { p0: h })
  }
  const d = Math.floor(mins / 1_440),
    h = Math.floor((mins % 1_440) / 60)
  return h ? tr('quota.duration.dayHour', { p0: d, p1: h }) : tr('quota.duration.day', { p0: d })
}

/** 悬停的全写：「2 小时 13 分后恢复（今天 16:45）」「3 天 4 小时后恢复（10 月 23 日 周四 09:00）」 */
export function resetFull(resetsAt: number, now: number): string {
  if (resetsAt <= now) return tr('quota.tip.expiredFull')
  const days = calendarDaysFrom(now, resetsAt)
  const when =
    days === 0
      ? tr('quota.when.today', { p0: clockText(resetsAt) })
      : days === 1
        ? tr('quota.when.tomorrow', { p0: clockText(resetsAt) })
        : tr('quota.when.date', { p0: monthDayText(resetsAt), p1: weekdayText(resetsAt), p2: clockText(resetsAt) })
  return tr('quota.reset.full', { p0: durationText(resetsAt - now), p1: when })
}

// ---------------------------------------------------------------------------
// 窗口命名（按时长，不按位置）
// ---------------------------------------------------------------------------

const hoursOf = (mins: number): number => Number((mins / 60).toFixed(1))
const isDays = (mins: number): boolean => mins >= 1_440 && mins % 1_440 === 0

/** 300 →「5 小时内」，10080 →「本周」，其它 < 1440 写「{n} 小时内」，1440 的倍数写「{n} 天内」，null 写「额度」 */
export function windowName(mins: number | null): string {
  if (mins === null || !(mins > 0)) return tr('quota.window.generic')
  if (mins === QUOTA_WINDOW_MINS.fiveHour) return tr('quota.window.fiveHour')
  if (mins === QUOTA_WINDOW_MINS.week) return tr('quota.window.week')
  if (isDays(mins)) return tr('quota.window.days', { p0: mins / 1_440 })
  return tr('quota.window.hours', { p0: hoursOf(mins) })
}

/** 按钮上的简称：5h、周、日、{n}h、{n}d；时长不明为空 */
export function windowShort(mins: number | null): string {
  if (mins === null || !(mins > 0)) return ''
  if (mins === QUOTA_WINDOW_MINS.fiveHour) return '5h'
  if (mins === QUOTA_WINDOW_MINS.week) return tr('quota.short.week')
  if (mins === QUOTA_WINDOW_MINS.day) return tr('quota.short.day')
  if (isDays(mins)) return `${mins / 1_440}d`
  return `${hoursOf(mins)}h`
}

/** 「已用完」前面的窗口名：5 小时、本周、{n} 天；时长不明为空 */
function exhaustedWindow(mins: number | null): string {
  if (mins === null || !(mins > 0)) return ''
  if (mins === QUOTA_WINDOW_MINS.fiveHour) return tr('quota.exhausted.fiveHour')
  if (mins === QUOTA_WINDOW_MINS.week) return tr('quota.exhausted.week')
  if (isDays(mins)) return tr('quota.exhausted.days', { p0: mins / 1_440 })
  return tr('quota.exhausted.hours', { p0: hoursOf(mins) })
}

// ---------------------------------------------------------------------------
// 套餐名、账号
// ---------------------------------------------------------------------------

/** 套餐的显示名和档位（Max 20x、Pro 5x…，plans.ts）；平台直接用套餐名、不上色；没有为 null */
export function planBadge(provider: QuotaProvider, plan: string | null | undefined): PlanInfo | null {
  if (provider === 'platform') return plan?.trim() ? { label: plan.trim(), tone: 'std' } : null
  return planInfo(provider, plan)
}

/** 套餐显示名（提示、读屏用）；没有为空串 */
export const planName = (provider: QuotaProvider, plan: string | null | undefined): string =>
  planBadge(provider, plan)?.label ?? ''

/** 邮箱只露第一个字（同模型通道菜单的 maskEmail）；平台的显示名原样 */
export function maskAccount(account: string | null | undefined): string {
  if (!account) return ''
  const at = account.indexOf('@')
  return at > 1 ? `${account[0]}•••${account.slice(at)}` : account
}

export const providerTitle = (provider: QuotaProvider): string => tr(`quota.title.${provider}`)

// ---------------------------------------------------------------------------
// 条目：全部窗口 + 分模型额度
// ---------------------------------------------------------------------------

export interface QuotaEntry {
  id: string
  kind: 'window' | 'model' | 'plan'
  /** 卡片 / 行名：5 小时内、本周 · Opus */
  name: string
  /** 句子里的名字：5 小时内、本周 Opus */
  label: string
  /** 按钮简称：5h、周；时长不明为空 */
  short: string
  /** 「已用完」前面的名字：5 小时、本周、本周 Opus；时长不明为空 */
  exhausted: string
  /** 分模型额度的模型名（窗口为空） */
  model: string
  durationMins: number | null
  /** 已用百分比 0–100；已过恢复时间的按 0 */
  percent: number
  rejected: boolean
  level: QuotaLevel
  resetsAt: number | null
  /** 已过恢复时间：显示 0%，等下次更新 */
  expired: boolean
  money?: QuotaWindow['money']
}

const byDuration = (a: { durationMins: number | null }, b: { durationMins: number | null }): number => {
  const x = a.durationMins ?? Infinity,
    y = b.durationMins ?? Infinity
  return x === y ? 0 : x < y ? -1 : 1
}

function entryOf(
  base: Pick<QuotaEntry, 'id' | 'kind' | 'durationMins' | 'resetsAt' | 'model' | 'money'>,
  usedPercent: number,
  rejected: boolean,
  now: number,
): QuotaEntry {
  const expired = base.resetsAt !== null && base.resetsAt <= now
  const percent = expired ? 0 : clamp(usedPercent)
  const rej = !expired && (rejected || percent >= 100)
  const window = windowName(base.durationMins)
  const model = base.model
  const exhausted = exhaustedWindow(base.durationMins)
  return {
    ...base,
    name: model ? tr('quota.model.row', { p0: window, p1: model }) : window,
    label: model ? tr('quota.model.label', { p0: window, p1: model }) : window,
    short: windowShort(base.durationMins),
    exhausted: model ? tr('quota.model.label', { p0: exhausted, p1: model }).trim() : exhausted,
    percent: rej ? 100 : percent,
    rejected: rej,
    level: expired ? 'normal' : quotaLevel(percent, rejected),
    expired,
  }
}

/** 全部条目：窗口按时长排在前，分模型额度在后 */
export function quotaEntries(q: AccountQuota, now: number): QuotaEntry[] {
  const windows = [...q.windows]
    .sort(byDuration)
    .map(w =>
      entryOf(
        { id: w.id, kind: 'window', durationMins: w.durationMins, resetsAt: w.resetsAt, model: '', money: w.money },
        w.usedPercent,
        !!w.rejected,
        now,
      ),
    )
  const models = [...(q.extras.models ?? [])].sort(byDuration).map((m: QuotaModelLimit) =>
    entryOf(
      {
        id: `model:${m.name}:${m.durationMins ?? ''}`,
        kind: 'model',
        durationMins: m.durationMins,
        resetsAt: m.resetsAt,
        model: m.name,
      },
      m.usedPercent,
      !!m.rejected,
      now,
    ),
  )
  return [...windows, ...models]
}

const PERIOD = { daily: 'quota.period.daily', weekly: 'quota.period.weekly', monthly: 'quota.period.monthly' } as const
const PLAN_SHORT = {
  daily: 'quota.short.planDaily',
  weekly: 'quota.short.planWeekly',
  monthly: 'quota.short.planMonthly',
} as const
const PLAN_MINS = { daily: QUOTA_WINDOW_MINS.day, weekly: QUOTA_WINDOW_MINS.week, monthly: null } as const

/** 平台套餐的每天 / 每周 / 每月额度已用百分比 */
export const planPercent = (p: { used: number; limit: number }): number => clamp((p.used / p.limit) * 100)

/** 平台套餐额度 → 条目（只用来挑按钮上最紧的一项；limit 不大于 0 的跳过）。没有恢复时间 */
export function planEntries(limits: readonly PlanLimit[] | undefined, now: number): QuotaEntry[] {
  const out: QuotaEntry[] = []
  for (const p of limits ?? []) {
    if (!(p.limit > 0)) continue
    const base = {
      id: `plan:${p.id}`,
      kind: 'plan' as const,
      durationMins: PLAN_MINS[p.id],
      resetsAt: null,
      model: '',
      money: { used: p.used, limit: p.limit, currency: p.currency },
    }
    const e = entryOf(base, planPercent(p), false, now)
    const name = tr('quota.row.plan', { p0: tr(PERIOD[p.id]) })
    out.push({ ...e, name, label: name, exhausted: name, short: tr(PLAN_SHORT[p.id]) })
  }
  return out
}

/** 最紧的一项：先看用完（rejected 或 ≥100），再按已用百分比从大到小，同分取时长短的 */
export function tightestEntry(entries: readonly QuotaEntry[]): QuotaEntry | null {
  let best: QuotaEntry | null = null
  for (const e of entries) {
    if (!best) best = e
    else {
      const full = e.level === 'full',
        bestFull = best.level === 'full'
      if (full !== bestFull ? full : e.percent !== best.percent ? e.percent > best.percent : byDuration(e, best) < 0)
        best = e
    }
  }
  return best
}

/** 快用完：任一项（含平台套餐额度）到 80%、有用完的、或账号整体被拒绝 */
export function isNearLimit(q: AccountQuota, now: number, planLimits?: readonly PlanLimit[]): boolean {
  if (q.blocked) return true
  return [...quotaEntries(q, now), ...planEntries(planLimits, now)].some(e => e.level !== 'normal')
}

/** 整体级别：最紧一项的级别；blocked 按用完 */
export function overallLevel(q: AccountQuota, now: number): QuotaLevel {
  if (q.blocked) return 'full'
  return tightestEntry(quotaEntries(q, now))?.level ?? 'normal'
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

export interface QuotaBar {
  percent: number
  level: QuotaLevel
}

const hasExtras = (q: AccountQuota): boolean =>
  !!q.extras.credits || !!q.extras.extraUsage || q.extras.balance !== undefined

/** 两根小条：上面 5 小时窗口（没有就取最短的窗口），下面时长 ≥ 1 天的窗口和分模型额度里最紧的；只有一种一根；只有点数一根空条 */
export function quotaBars(q: AccountQuota, entries: readonly QuotaEntry[]): QuotaBar[] {
  const bar = (e: QuotaEntry): QuotaBar => ({ percent: e.percent, level: e.level })
  const windows = entries.filter(e => e.kind === 'window')
  const first = windows.find(e => e.durationMins === QUOTA_WINDOW_MINS.fiveHour) ?? windows[0]
  if (!first) {
    const only = tightestEntry(entries)
    if (only) return [bar(only)]
    if (q.blocked) return [{ percent: 100, level: 'full' }]
    return hasExtras(q) ? [{ percent: 0, level: 'normal' }] : []
  }
  const second = tightestEntry(entries.filter(e => e !== first && e.durationMins !== null && e.durationMins >= 1_440))
  return second ? [bar(first), bar(second)] : [bar(first)]
}

export interface QuotaButtonView {
  /** ok 有数据；loading 读取中（没有任何数据）；error 最近一次读取失败 */
  state: 'ok' | 'loading' | 'error'
  level: QuotaLevel
  /** 空数组 = 两根空条（读取中、失败） */
  bars: QuotaBar[]
  /** 简称（周、5h），没有为空 */
  short: string
  /** 百分比 / 已用完 / 点数；没有文字为空 */
  value: string
  label: string
  title: string
}

export function formatCredits(balance: number): string {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 2 }).format(balance)
}

const creditsValue = (q: AccountQuota): string | null => {
  const c = q.extras.credits
  if (!c) return null
  if (c.unlimited) return tr('quota.credits.unlimited')
  if (!c.hasCredits || c.balance === null) return null
  return formatCredits(c.balance)
}

/** 「5 小时内已用 42%」「本周已用完」 */
export function usedLine(e: QuotaEntry): string {
  const p1 = percentText(e.percent)
  if (e.level === 'full') return tr(e.model ? 'quota.line.exhaustedModel' : 'quota.line.exhausted', { p0: e.label })
  return tr(e.model ? 'quota.line.usedModel' : 'quota.line.used', { p0: e.label, p1 })
}

const moneyPair = (m: { used: number; limit: number; currency: string }): string =>
  `${formatBalance(m.used, m.currency)} / ${formatBalance(m.limit, m.currency)}`

function extraText(q: AccountQuota): string | null {
  const x = q.extras.extraUsage
  if (!x?.enabled) return null
  if (x.used !== null && x.limit !== null)
    return `${formatAmount(x.used, x.currency ?? 'USD')} / ${formatAmount(x.limit, x.currency ?? 'USD')}`
  const p = x.usedPercent ?? null
  return p === null ? null : percentText(p)
}

/** 悬停提示（多行）：标题（套餐）、每个窗口一行、分模型、平台套餐额度、额外用量、点数、更新时间 */
export function quotaTooltip(
  q: AccountQuota,
  provider: QuotaProvider,
  now: number,
  planRows: readonly QuotaEntry[] = [],
): string {
  const plan = planName(provider, q.plan)
  const head = plan ? tr('quota.tip.withPlan', { p0: providerTitle(provider), p1: plan }) : providerTitle(provider)
  const lines = [head]
  for (const e of [...quotaEntries(q, now), ...planRows]) {
    const extra = e.expired
      ? tr('quota.tip.expired')
      : e.money
        ? moneyPair(e.money)
        : e.resetsAt !== null
          ? resetShort(e.resetsAt, now)
          : ''
    lines.push(extra ? `${usedLine(e)} · ${extra}` : usedLine(e))
  }
  if (q.blocked) lines.push(tr('quota.button.exhaustedPlain'))
  const extra = extraText(q)
  if (extra) lines.push(tr('quota.tip.pair', { p0: tr('quota.row.extra'), p1: extra }))
  const credits = creditsValue(q)
  if (credits) lines.push(tr('quota.tip.pair', { p0: tr('quota.card.credits'), p1: credits }))
  if (q.extras.balance)
    lines.push(
      tr('quota.tip.pair', {
        p0: tr('quota.card.balance'),
        p1: formatBalance(q.extras.balance.amount, q.extras.balance.currency),
      }),
    )
  if (q.observedAt !== null) lines.push(tr('quota.updatedAt', { p0: clockText(q.observedAt) }))
  return lines.join('\n')
}

/** 无障碍名称：「Claude 账号额度：5 小时内已用 42%，本周已用 18%，本周 Opus 已用 61%」；平台套餐额度跟在窗口后面 */
export function quotaAriaLabel(
  q: AccountQuota | null,
  provider: QuotaProvider,
  state: QuotaButtonView['state'],
  now: number,
  planRows: readonly QuotaEntry[] = [],
): string {
  const title = providerTitle(provider)
  if (state === 'loading' || !q) return tr('quota.aria.label', { p0: title, p1: tr('quota.aria.loading') })
  if (state === 'error') return tr('quota.aria.label', { p0: title, p1: tr('quota.aria.error') })
  const parts = [...quotaEntries(q, now), ...planRows].map(usedLine)
  if (q.blocked) parts.push(tr('quota.button.exhaustedPlain'))
  const credits = creditsValue(q)
  if (!parts.length && credits) parts.push(tr('quota.tip.pair', { p0: tr('quota.card.credits'), p1: credits }))
  return tr('quota.aria.label', { p0: title, p1: parts.join(tr('quota.aria.join')) })
}

const hasData = (q: AccountQuota): boolean => q.windows.length > 0 || hasExtras(q) || !!q.extras.models?.length

export interface QuotaViewOptions {
  provider: QuotaProvider
  /** 正在读取（没有任何数据时才显示读取中） */
  loading: boolean
  now: number
  /** 平台套餐的每天 / 每周 / 每月额度：参与挑最紧一项（文字和颜色），不画进小进度条 */
  planLimits?: readonly PlanLimit[]
}

/** 按钮要画的东西：两根条、简称 + 文字、悬停提示、无障碍名称 */
export function quotaButtonView(q: AccountQuota | null, o: QuotaViewOptions): QuotaButtonView {
  const blank = (state: 'loading' | 'error'): QuotaButtonView => ({
    state,
    level: 'normal',
    bars: [],
    short: '',
    value: '',
    label: quotaAriaLabel(q, o.provider, state, o.now),
    title:
      state === 'loading'
        ? tr('quota.aria.label', { p0: providerTitle(o.provider), p1: tr('quota.aria.loading') })
        : `${providerTitle(o.provider)}\n${tr('quota.aria.error')}`,
  })
  if (!q || q.status === 'empty' || q.status === 'unsupported') return blank('loading')
  if (q.status === 'error') return blank('error')
  const entries = quotaEntries(q, o.now)
  const planRows = planEntries(o.planLimits, o.now)
  const tight = tightestEntry([...entries, ...planRows])
  let short = '',
    value = ''
  if (tight && tight.level === 'full') {
    value = tight.model
      ? tr('quota.button.exhaustedModel', { p0: exhaustedWindow(tight.durationMins), p1: tight.model })
      : tight.exhausted
        ? tr('quota.button.exhausted', { p0: tight.exhausted })
        : tr('quota.button.exhaustedPlain')
  } else if (q.blocked) value = tr('quota.button.exhaustedPlain')
  else if (tight) {
    short = tight.short
    value = percentText(tight.percent)
  } else {
    const credits = creditsValue(q)
    if (credits) value = tr('quota.button.credits', { p0: credits })
  }
  return {
    state: 'ok',
    level: q.blocked ? 'full' : (tight?.level ?? 'normal'),
    bars: quotaBars(q, entries),
    short,
    value,
    label: quotaAriaLabel(q, o.provider, 'ok', o.now, planRows),
    title: quotaTooltip(q, o.provider, o.now, planRows),
  }
}

// ---------------------------------------------------------------------------
// 什么时候有按钮
// ---------------------------------------------------------------------------

export interface QuotaTargetInput {
  /** 设置里的开关 */
  enabled: boolean
  /** 对话所在的机器；不是 'local' 不显示 */
  machine: string
  /** 对话实际用的通道（输入框控制器的 channel） */
  channel: ChannelId
  engines: ReadonlyArray<{ id: EngineId; status: string; auth?: { kind: string } }>
  /** 平台账号已登录，且换算出来的窗口数 */
  platformSignedIn: boolean
  platformWindows: number
}

/** 按这个对话实际用的通道定额度属于谁；不该显示按钮时为 null（§6.1） */
export function quotaTarget(i: QuotaTargetInput): QuotaProvider | null {
  if (!i.enabled || i.machine !== 'local') return null
  const engine = (id: EngineId) => i.engines.find(e => e.id === id)
  if (i.channel === 'claude') return engine('claude')?.status === 'ready' ? 'claude' : null
  if (i.channel === 'chatgpt') {
    const codex = engine('codex')
    return codex?.status === 'ready' && codex.auth?.kind !== 'apiKey' && codex.auth?.kind !== 'provider'
      ? 'chatgpt'
      : null
  }
  if (i.channel === 'platform') return i.platformSignedIn && i.platformWindows > 0 ? 'platform' : null
  return null
}

/** 拿到快照后再判：unsupported 不显示；empty 且没在读取不显示；「快用完时才显示」只在到橙色或用完时出现（弹窗开着时不收） */
export function quotaButtonVisible(
  q: AccountQuota | null,
  loading: boolean,
  when: QuotaShowWhen,
  now: number,
  keep = false,
  planLimits?: readonly PlanLimit[],
): boolean {
  if (q?.status === 'unsupported') return false
  if (!q || q.status === 'empty') {
    if (!loading) return false
    return when === 'always' || keep
  }
  if (when === 'always' || keep) return true
  return q.status === 'ok' && isNearLimit(q, now, planLimits)
}

// ---------------------------------------------------------------------------
// 弹窗：卡片、小列表、提示
// ---------------------------------------------------------------------------

export interface QuotaCard {
  id: string
  /** meter 有进度条；plain 只有数字（点数、余额） */
  type: 'meter' | 'plain'
  name: string
  level: QuotaLevel
  percent: number
  /** 大数字：42% / <1% / 已用完；plain 是数值 */
  value: string
  /** 大数字旁的小字：已用 / 剩余 */
  unit: string
  /** 卡片底部一行 */
  note: string
  /** 悬停全写 */
  hover: string
}

export interface QuotaRow {
  id: string
  name: string
  /** null 没有条 */
  percent: number | null
  level: QuotaLevel
  value: string
}

export interface PlanLimit {
  id: 'daily' | 'weekly' | 'monthly'
  used: number
  limit: number
  currency: string
}

export interface QuotaAlert {
  kind: 'warn' | 'full' | 'info'
  /** 加粗的前半句 */
  strong: string
  rest: string
  /** 带「换通道」按钮 */
  switchChannel: boolean
}

export interface QuotaLayout {
  cards: QuotaCard[]
  rows: QuotaRow[]
  alert: QuotaAlert | null
}

export interface LayoutOptions {
  provider: QuotaProvider
  now: number
  /** 平台余额的显示文字（useAccount().balanceText） */
  balanceText?: string | null
  /** 平台套餐额度（platformQuota.ts） */
  planLimits?: readonly PlanLimit[]
}

function meterCard(e: QuotaEntry, now: number): QuotaCard {
  const note = e.money
    ? moneyPair(e.money)
    : e.expired
      ? tr('quota.reset.passed')
      : e.resetsAt !== null
        ? resetShort(e.resetsAt, now)
        : ''
  return {
    id: e.id,
    type: 'meter',
    name: e.name,
    level: e.level,
    percent: e.percent,
    value: e.level === 'full' ? tr('quota.card.exhausted') : percentText(e.percent),
    unit: e.level === 'full' ? '' : tr('quota.card.used'),
    note,
    hover: e.expired ? tr('quota.tip.expiredFull') : e.resetsAt !== null ? resetFull(e.resetsAt, now) : '',
  }
}

function creditsCard(q: AccountQuota): QuotaCard | null {
  const c = q.extras.credits
  if (!c) return null
  const unlimited = c.unlimited
  return {
    id: 'credits',
    type: 'plain',
    name: tr('quota.card.credits'),
    level: 'normal',
    percent: 0,
    value: unlimited ? tr('quota.credits.unlimited') : c.balance === null ? '—' : formatCredits(c.balance),
    unit: unlimited || c.balance === null ? '' : tr('quota.card.left'),
    note: tr('quota.card.creditsNote'),
    hover: '',
  }
}

/** 弹窗里的内容：两张卡片、「其它」小列表、提示。规则见 §6.3「卡片怎么放」「其它小列表」「提示」 */
export function quotaLayout(q: AccountQuota, o: LayoutOptions): QuotaLayout {
  const { now } = o
  const entries = quotaEntries(q, now)
  const windows = entries.filter(e => e.kind === 'window')
  const models = entries.filter(e => e.kind === 'model')
  const cards: QuotaCard[] = []
  const rows: QuotaRow[] = []
  let rest = windows

  if (o.provider === 'platform') {
    const first = windows.find(e => e.durationMins === QUOTA_WINDOW_MINS.fiveHour) ?? windows[0]
    if (first) {
      cards.push(meterCard(first, now))
      rest = windows.filter(e => e !== first)
    }
    const balance = q.extras.balance
    cards.push({
      id: 'balance',
      type: 'plain',
      name: tr('quota.card.balance'),
      level: 'normal',
      percent: 0,
      value: o.balanceText ?? (balance ? formatBalance(balance.amount, balance.currency) : '—'),
      unit: '',
      note: tr('quota.card.balanceNote'),
      hover: '',
    })
  } else if (windows.length) {
    const five = windows.find(e => e.durationMins === QUOTA_WINDOW_MINS.fiveHour)
    const week = windows.find(e => e.durationMins === QUOTA_WINDOW_MINS.week)
    const picked = five && week ? [five, week] : windows.slice(0, 2)
    for (const e of picked) cards.push(meterCard(e, now))
    rest = windows.filter(e => !picked.includes(e))
  }
  let creditsAsRow = false
  if (!cards.length) {
    const credits = creditsCard(q)
    if (credits) cards.push(credits)
  } else creditsAsRow = !!q.extras.credits && o.provider !== 'platform'

  for (const e of models)
    rows.push({
      id: e.id,
      name: e.name,
      percent: e.percent,
      level: e.level,
      value: e.level === 'full' ? tr('quota.card.exhausted') : percentText(e.percent),
    })
  for (const e of rest)
    rows.push({
      id: e.id,
      name: e.name,
      percent: e.percent,
      level: e.level,
      value: e.money ? moneyPair(e.money) : e.level === 'full' ? tr('quota.card.exhausted') : percentText(e.percent),
    })
  const x = q.extras.extraUsage
  if (x?.enabled) {
    const percent = x.usedPercent ?? (x.used !== null && x.limit ? clamp((x.used / x.limit) * 100) : null)
    rows.push({
      id: 'extra',
      name: tr('quota.row.extra'),
      percent,
      level: x.reached ? 'full' : percent === null ? 'normal' : quotaLevel(percent),
      value: extraText(q) ?? '—',
    })
  }
  if (creditsAsRow) {
    const c = q.extras.credits!
    if (c.unlimited)
      rows.push({
        id: 'credits',
        name: tr('quota.card.credits'),
        percent: null,
        level: 'normal',
        value: tr('quota.credits.unlimited'),
      })
    else if (c.hasCredits && c.balance !== null)
      rows.push({
        id: 'credits',
        name: tr('quota.card.credits'),
        percent: null,
        level: 'normal',
        value: tr('quota.row.creditsLeft', { p0: formatCredits(c.balance) }),
      })
  }
  for (const p of o.planLimits ?? []) {
    if (!(p.limit > 0)) continue
    const percent = planPercent(p)
    rows.push({
      id: `plan:${p.id}`,
      name: tr('quota.row.plan', { p0: tr(PERIOD[p.id]) }),
      percent,
      level: quotaLevel(percent),
      value: moneyPair(p),
    })
  }
  return { cards, rows, alert: quotaAlert(q, entries, now) }
}

/** 提示：正在用额外用量 > 用完（带「换通道」）> 快用完 */
export function quotaAlert(q: AccountQuota, entries: readonly QuotaEntry[], now: number): QuotaAlert | null {
  const tight = tightestEntry(entries)
  if (q.extras.extraUsage?.inUse)
    return { kind: 'warn', strong: '', rest: tr('quota.alert.extraInUse'), switchChannel: false }
  if (tight && tight.level === 'full') {
    const time = tight.resetsAt !== null && tight.resetsAt > now ? resetClock(tight.resetsAt, now) : null
    if (tight.model) {
      return {
        kind: 'full',
        strong: tr('quota.alert.fullModelStrong', { p0: tight.exhausted }),
        rest: time ? tr('quota.alert.fullModel', { p0: time }) : tr('quota.alert.fullModelNoTime'),
        switchChannel: true,
      }
    }
    return {
      kind: 'full',
      strong: tr('quota.alert.fullStrong', { p0: tight.exhausted || tr('quota.window.generic') }),
      rest: time ? tr('quota.alert.full', { p0: time }) : tr('quota.alert.fullNoTime'),
      switchChannel: true,
    }
  }
  if (q.blocked) {
    const at = q.blocked.resetsAt
    const time = at !== null && at > now ? resetClock(at, now) : null
    return {
      kind: 'full',
      strong: tr('quota.alert.blockedStrong'),
      rest: time ? tr('quota.alert.full', { p0: time }) : tr('quota.alert.fullNoTime'),
      switchChannel: true,
    }
  }
  if (tight && tight.level === 'warn') {
    const time = tight.resetsAt !== null && tight.resetsAt > now ? resetClock(tight.resetsAt, now) : null
    return {
      kind: 'warn',
      strong: usedLine(tight),
      rest: time ? tr('quota.alert.warn', { p0: time }) : tr('quota.alert.warnNoTime'),
      switchChannel: false,
    }
  }
  return null
}

/** 弹窗里有没有能显示的数据 */
export function quotaHasData(q: AccountQuota | null): boolean {
  return !!q && hasData(q)
}

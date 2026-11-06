import { tr, getLocale, type TranslationKey } from '../../i18n/core'
// 用量相关的数字格式（docs/ui/usage.md）：「不知道」显示「—」，估算加「≈」，有缺失加「≥」
import { costState, type CostState } from '@pixelsky/protocol'
import type { UsageDimension, UsageGroupRow, UsageRecord, UsageRoute, UsageTotals } from './types'

/** 1234 → 1.2k，3456789 → 3.5M */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${trim(n / 1000)}k`
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}

/** 明细和分布表：534、1,017、48K、175K、30.7M、1.1B（docs/ui/usage-learn.md §1.2） */
export function formatCount(n: number): string {
  const v = Math.round(n)
  if (v < 10_000) return v.toLocaleString('en-US')
  if (v < 1_000_000) return `${Math.round(v / 1000)}K`
  if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  return `${(v / 1_000_000_000).toFixed(1)}B`
}

/** 首字：毫秒 → 11.7s；没有时「—」 */
export function formatFirstToken(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`
}

function trim(x: number): string {
  return x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, '')
}

/** 单条费用：null → 「—」；引擎报告的费用本身是估算，前面加「≈」 */
export function formatCost(
  usd: number | null,
  source: import('@pixelsky/protocol').CostSource = 'estimate',
  billing?: import('@pixelsky/protocol').BillingSource,
): string {
  if (source === 'pending') return tr('billing.pending')
  if (source === 'unavailable') return '—'
  if (usd === null) return '—'
  if (source === 'platform')
    return `${billing === 'subscription' ? tr('billing.subscription') + ' ' : ''}${actualMoney(usd)}`
  if (usd > 0 && usd < 0.01) return '≈ <$0.01'
  return `≈ $${usd.toFixed(2)}`
}

/** 明细里一条记录的费用：没有费用时按原因显示（结算中 / 「—」），见 costState */
export function formatRecordCost(r: UsageRecord): string {
  const state = costState(r)
  if (state === 'pending') return tr('billing.pending')
  if (state === 'no-price') return tr('usageColumns.unpriced')
  if (state !== 'known') return '—'
  return formatCost(r.costUsd, r.costSource, r.billing)
}

/** 费用情况（docs/ui/usage.md §12）：短名 + 一句说明；'missing' 是「所有没有费用的」 */
const COST_TEXT: Record<CostState | 'missing', [TranslationKey, TranslationKey]> = {
  missing: ['usageCost.missing', 'usageCost.missingHint'],
  known: ['usageCost.known', 'usageCost.knownHint'],
  pending: ['usageCost.pending', 'usageCost.pendingHint'],
  empty: ['usageCost.empty', 'usageCost.emptyHint'],
  platform: ['usageCost.platform', 'usageCost.platformHint'],
  'no-price': ['usageCost.noPrice', 'usageCost.noPriceHint'],
  engine: ['usageCost.engine', 'usageCost.engineHint'],
}

/** 费用情况的说明（分布表、明细里的悬停提示）；不认识的值返回空串 */
export function costHint(key: string): string {
  const t = COST_TEXT[key as CostState]
  return t ? tr(t[1]) : ''
}

/**
 * 费用卡副标题写什么：有没有费用的记录 → missing（可以点开）；全是实扣 → actual；
 * 有费用的全是自定义 API 按官方价格估算 → official；其余 → engine（引擎报告的估算值）
 */
export function costSubtitle(
  t: Pick<UsageTotals, 'costKnown' | 'records' | 'costActual'>,
  routes?: Array<Pick<UsageGroupRow, 'key' | 'costKnown'>>,
): 'missing' | 'actual' | 'official' | 'engine' {
  if (t.costKnown < t.records) return 'missing'
  if (t.costKnown > 0 && t.costActual === t.costKnown) return 'actual'
  if (t.costKnown > 0 && routes?.every(r => r.costKnown === 0 || r.key === 'api-key')) return 'official'
  return 'engine'
}

/** 合计费用：一条都不知道 → 「—」；部分不知道 → 「≥」 */
export function actualMoney(usd: number): string {
  return usd > 0 && usd < 0.000001 ? '<$0.000001' : '$' + usd.toFixed(6).replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')
}

type CostTotals = Pick<UsageTotals, 'costUsd' | 'costKnown' | 'records' | 'costActual'>
const costPrefix = (t: CostTotals): string =>
  t.costKnown < t.records ? '≥ ' : t.costActual === t.costKnown ? '' : '≈ '

export function formatTotalCost(t: CostTotals): string {
  if (t.costKnown === 0) return '—'
  return costPrefix(t) + actualMoney(t.costUsd)
}

/**
 * 费用卡上的大数字（docs/ui/ui-polish-2026-10-13.md §3）：满 1 美元只留 2 位小数（「≥ $10.58」），
 * 不到 1 美元照合计的精度（小额才看得出差别）；完整金额放悬停提示，分布表、明细、导出不变
 */
export function formatCardCost(t: CostTotals): string {
  if (t.costKnown === 0 || t.costUsd < 1) return formatTotalCost(t)
  return `${costPrefix(t)}$${t.costUsd.toFixed(2)}`
}

/** 分布表、今天的费用：放不下 6 位小数，满 1 美分留 2 位；完整金额放悬停提示 */
export function formatShortCost(t: CostTotals): string {
  if (t.costKnown === 0 || t.costUsd < 0.01) return formatTotalCost(t)
  return `${costPrefix(t)}$${t.costUsd.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function formatPercent(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 明细里的时间：今天只显示时分，今年显示月-日 时分 */
export function formatTime(t: number, now = Date.now()): string {
  const d = new Date(t)
  const n = new Date(now)
  if (getLocale() === 'en-US')
    return new Intl.DateTimeFormat(getLocale(), {
      ...(d.toDateString() === n.toDateString()
        ? {}
        : { month: 'short', day: 'numeric', ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }) }),
      hour: 'numeric',
      minute: '2-digit',
    }).format(d)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === n.toDateString()) return hm
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`
  return `${d.getFullYear()}-${d.getMonth() + 1}-${pad(d.getDate())} ${hm}`
}

export const DIMENSION_LABEL: Record<UsageDimension, string> = {
  get model() {
    return tr('session.ModelSourceMenu.model')
  },
  get project() {
    return tr('sidebar.Sidebar.projects')
  },
  get engine() {
    return tr('session.ModelSourceMenu.engine')
  },
  get route() {
    return tr('session.ModelSourceMenu.route')
  },
  get cost() {
    return tr('usageCost.dimension')
  },
  get session() {
    return tr('settings.usage.Distribution.session')
  },
}

const ROUTE_LABEL: Record<UsageRoute, string> = {
  get cli() {
    return tr('usage.format.cliSignIn')
  },
  get pixelsky() {
    return tr('usage.format.pixelStarrySkyAccount')
  },
  get 'api-key'() {
    return tr('customApi.route')
  },
  get unknown() {
    return tr('settings.usage.RemoteCallsTable.unknown')
  },
}

const ENGINE_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  get pixel() {
    return tr('engine.pixel.name')
  },
}

/** 会话 ID 的前 8 位（去掉远端机器前缀） */
export function shortId(id: string): string {
  return id.slice(id.indexOf('~') + 1, id.indexOf('~') + 9)
}

/** 分布表、筛选圆片里显示的名称 */
export function dimLabel(dim: UsageDimension, key: string): string {
  if (dim === 'route') return ROUTE_LABEL[key as UsageRoute] ?? key
  if (dim === 'engine') return ENGINE_LABEL[key] ?? key
  if (dim === 'project') return key || tr('usage.format.noProject')
  if (dim === 'session') return shortId(key)
  if (dim === 'cost') {
    const t = COST_TEXT[key as CostState]
    return t ? tr(t[0]) : key
  }
  return key
}

/** 和上一期比较：返回「▲12%」「▼3%」，上一期为 0 时返回 null */
export function formatDelta(cur: number, prev: number): { text: string; up: boolean } | null {
  if (prev <= 0) return null
  const pct = Math.round(((cur - prev) / prev) * 100)
  if (pct === 0)
    return {
      get text() {
        return tr('settings.usage.KpiCards.unchanged')
      },
      up: true,
    }
  return { text: `${pct > 0 ? '▲' : '▼'}${Math.abs(pct)}%`, up: pct > 0 }
}

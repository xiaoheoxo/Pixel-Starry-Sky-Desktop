import type { QuotaProvider, UsageGroupRow } from '@pixelsky/protocol'
import { estimateCost, officialPrice } from '@pixelsky/protocol'
import type { QuotaEntry } from './quotaModel'
import type { QuotaHistory, QuotaObservation } from './observations'

const HOUR = 3_600_000
const RECENT_SAMPLES = 3

export type ForecastCollection =
  | { state: 'waiting' | 'stale' | 'elapsed' | 'exhausted' }
  | {
      state: 'collecting'
      samples: number
      requiredSamples: number
      spanMs: number
      requiredSpanMs: number
      rounded: boolean
    }

export interface WindowEstimate {
  elapsed: number
  projected: number | null
  emptyAt: number | null
  basis: 'recent' | 'window' | null
  collection?: ForecastCollection
  /** Percentage points available per hour (short windows) or day. This is a budget, not a forecast. */
  budget: { percent: number; unit: 'hour' | 'day' } | null
}

function recentTrend(points: readonly QuotaObservation[], latest: QuotaObservation, span: number) {
  const lookback = Math.min(48 * HOUR, span * 0.6)
  const minSpan = Math.min(6 * HOUR, span * 0.1)
  const candidates = points.filter(p => p.time >= latest.time - lookback && p.time <= latest.time - minSpan)
  const samples = candidates.length + 1 // Including the current official reading.
  const spanMs = candidates.length ? latest.time - candidates[0]!.time : 0
  const requiredSpanMs = minSpan * 1.5
  const growth = candidates.length ? latest.used - candidates[0]!.used : 0
  const rounded = samples >= RECENT_SAMPLES && spanMs >= requiredSpanMs && growth > 0 && growth < 2
  if (samples < RECENT_SAMPLES || spanMs < requiredSpanMs || rounded) {
    const collection: ForecastCollection = {
      state: 'collecting',
      samples,
      requiredSamples: RECENT_SAMPLES,
      spanMs,
      requiredSpanMs,
      rounded,
    }
    return { rate: null, collection }
  }
  // Reduce the influence of an unusually bursty or idle interval. Don't estimate from a one-point rounding step.
  const rates = candidates.map(p => Math.max(0, latest.used - p.used) / (latest.time - p.time)).sort((a, b) => a - b)
  const middle = Math.floor(rates.length / 2)
  return { rate: rates.length % 2 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2 }
}

/** Extrapolate only observed, account-specific percentages, never local API dollars or turn counts. */
export function windowEstimate(
  e: QuotaEntry,
  now: number,
  observedAt: number | null,
  history?: QuotaHistory,
): WindowEstimate | null {
  if (e.kind !== 'window' || !e.durationMins || e.resetsAt === null || e.expired || e.resetsAt <= now) return null
  const span = e.durationMins * 60_000
  const start = e.resetsAt - span
  if (now < start && (observedAt === null || observedAt < start)) return null
  const elapsed = Math.max(0, Math.min(1, (now - start) / span))
  const result: WindowEstimate = { elapsed, projected: null, emptyAt: null, basis: null, budget: null }
  const left = 100 - e.percent
  if (left <= 0 || e.rejected) return { ...result, collection: { state: 'exhausted' } }
  if (observedAt === null || observedAt < start || observedAt >= e.resetsAt)
    return { ...result, collection: { state: 'waiting' } }
  // The render clock runs once a minute, so a fresh packet can predate its next tick.
  const clock = Math.max(now, observedAt)
  if (clock - observedAt > Math.min(6 * HOUR, span * 0.1)) return { ...result, collection: { state: 'stale' } }
  const unit = span < 24 * HOUR ? 'hour' : 'day'
  result.budget = {
    percent: Math.min(left, (left * (unit === 'hour' ? HOUR : 24 * HOUR)) / (e.resetsAt - clock)),
    unit,
  }

  const { rate: recent, collection } = recentTrend(history?.points ?? [], { time: observedAt, used: e.percent }, span)
  if (collection) result.collection = collection
  const sinceStart = observedAt - start
  const wholeWindow = !history?.discontinuity && sinceStart >= span * 0.1 && e.percent >= 1
  if (recent === null && !wholeWindow) return result
  const rate = recent ?? e.percent / sinceStart
  result.basis = recent === null ? 'window' : 'recent'
  result.projected = Math.min(100, e.percent + (e.resetsAt - observedAt) * rate)
  const emptyAt = rate > 0 ? observedAt + left / rate : Infinity
  if (emptyAt < e.resetsAt && emptyAt > clock) result.emptyAt = emptyAt
  // Do not imply that an elapsed prediction is an observed exhaustion; wait for a new measurement.
  if (emptyAt <= clock) {
    result.projected = null
    result.basis = null
    result.collection = { state: 'elapsed' }
  }
  return result
}

export interface MonthValue {
  usd: number
  unpricedModels: number
  /** 按模型，从多到少 */
  models: { model: string; usd: number }[]
}

/** 近 30 天按模型的合计折合多少：整组都有引擎报的费用就用它，否则整组按 Token × 官方价（混着用会重复算） */
export function monthValue(rows: readonly UsageGroupRow[]): MonthValue | null {
  let unpricedModels = 0
  const models = rows
    .map(r => {
      const price = officialPrice(r.key)
      if (!price && r.costKnown < r.records && r.input + r.output + r.cacheRead + r.cacheWrite > 0) unpricedModels++
      return { model: r.key, usd: r.costKnown === r.records ? r.costUsd : (estimateCost(r, price) ?? r.costUsd) }
    })
    .filter(m => m.usd > 0)
    .sort((a, b) => b.usd - a.usd)
  return models.length || unpricedModels ? { usd: models.reduce((s, m) => s + m.usd, 0), models, unpricedModels } : null
}

/** 明细里能选的月费（美元）；id 存在本机 */
export const PLAN_FEES: Record<'claude' | 'chatgpt' | 'google', { id: string; label: string; usd: number }[]> = {
  claude: [
    { id: 'pro', label: 'Pro $20', usd: 20 },
    { id: 'max_5x', label: 'Max 5x $100', usd: 100 },
    { id: 'max_20x', label: 'Max 20x $200', usd: 200 },
  ],
  chatgpt: [
    { id: 'plus', label: 'Plus $20', usd: 20 },
    { id: 'prolite', label: 'Pro 100 · $100', usd: 100 },
    { id: 'pro', label: 'Pro 200 · $200', usd: 200 },
    { id: 'promax', label: 'Pro 500 · $500', usd: 500 },
  ],
  google: [
    { id: 'pro', label: 'AI Pro $20', usd: 20 },
    { id: 'ultra_5x', label: 'AI Ultra 5x $100', usd: 100 },
    { id: 'ultra_20x', label: 'AI Ultra 20x $200', usd: 200 },
  ],
}

/** 默认月费：按套餐值；Claude 只写「max」、Google 只写「Ultra」分不出 5x / 20x 时按 20x；认不出（Team、企业、免费）为 null，不比 */
export function defaultFeeId(provider: QuotaProvider, plan: string | null): string | null {
  if (provider === 'platform' || !plan) return null
  if (provider === 'claude') return plan === 'max' ? 'max_20x' : PLAN_FEES.claude.some(f => f.id === plan) ? plan : null
  if (provider === 'google') {
    if (/\bultra\b|-ultra-/i.test(plan)) return /\b5x\b/i.test(plan) ? 'ultra_5x' : 'ultra_20x'
    if (/\bpro\b|-pro-/i.test(plan)) return 'pro'
    return null
  }
  return PLAN_FEES.chatgpt.some(f => f.id === plan) ? plan : null
}

/** 引擎记录里的 engine：Claude 账号是 claude，ChatGPT 账号是 codex，Google 账号是 antigravity */
export const PROVIDER_ENGINE: Partial<Record<QuotaProvider, string>> = {
  claude: 'claude',
  chatgpt: 'codex',
  google: 'antigravity',
}

/** 估计的金额：「≈ $36」「≈ $4.5」，不到 $0.1 写「≈ <$0.1」 */
export function usdText(usd: number): string {
  if (usd > 0 && usd < 0.1) return '≈ <$0.1'
  return `≈ $${usd >= 10 ? Math.round(usd) : usd.toFixed(1)}`
}

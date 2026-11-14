// 订阅额度估算（docs/ui/quota-estimate.md）：每个窗口照现在的速度会不会提前用完、还能跑多少额度（按官方 API 价折合）、
// 大约几轮；近 30 天按 API 价折合多少、是月费的几倍。纯函数，时间由调用方传 now。
import type { QuotaProvider, UsageGroupRow, UsageRecord } from '@pixelsky/protocol'
import { estimateCost, officialPrice } from '@pixelsky/protocol'
import type { QuotaEntry } from './quotaModel'

/** 窗口里至少用了这么多、至少有这么多轮，才按「每 1% 多少钱」往后推；不够就不写估计 */
const MIN_PERCENT = 1
const MIN_TURNS = 2
/** 窗口过了这么多时间才按均速推用完时间（同概况的 quotaPace） */
const MIN_ELAPSED = 0.1

/** 一条记录按官方 API 价值多少：引擎报了费用用它，没报（Codex）按 Token × 官方价；算不出为 null */
export function recordUsd(r: Pick<UsageRecord, 'costUsd' | 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) {
  return r.costUsd ?? estimateCost(r, officialPrice(r.model))
}

export interface WindowEstimate {
  /** 窗口过了多少时间（0–1），条上的竖线 */
  elapsed: number
  /** 照现在的均速到恢复时会用到多少（0–100，顶到 100 = 会提前用完）；窗口刚开始、时长不明时为 null */
  projected: number | null
  /** 会提前用完时：大约哪一刻用完 */
  emptyAt: number | null
  /** 剩下的百分比按这个窗口里每 1% 的价钱折合多少美元；数据不够为 null */
  usd: number | null
  /** 剩下的大约还能跑几轮；数据不够为 null */
  turns: number | null
}

/**
 * 一个窗口的估计。records 是这个账号走订阅的记录（时间不限，这里按窗口开始筛）。
 * shortcut: 速度用窗口开始以来的均速，不看最近的斜率（没有额度快照历史）；要更准时记快照再算最近 60 分钟
 */
export function windowEstimate(
  e: QuotaEntry,
  records: readonly Pick<
    UsageRecord,
    'endedAt' | 'sessionId' | 'turnId' | 'costUsd' | 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'
  >[],
  now: number,
): WindowEstimate | null {
  if (e.kind !== 'window' || !e.durationMins || e.resetsAt === null || e.expired || e.resetsAt <= now) return null
  const span = e.durationMins * 60_000
  const start = e.resetsAt - span
  const elapsed = (now - start) / span
  const used = Math.min(100, Math.max(0, e.percent))
  let projected: number | null = null
  let emptyAt: number | null = null
  if (elapsed >= MIN_ELAPSED && elapsed <= 1) {
    projected = Math.min(100, used / elapsed)
    if (used > 0 && projected >= 100) emptyAt = Math.min(e.resetsAt, start + ((now - start) * 100) / used)
  }
  if (used >= 100) emptyAt = null
  let usd = 0
  const turns = new Set<string>()
  for (const r of records) {
    // 不卡 now：now 是按分钟走的时钟，刚记下的一轮会比它晚
    if (r.endedAt < start) continue
    const v = recordUsd(r)
    if (v !== null) usd += v
    turns.add(`${r.sessionId}:${r.turnId}`)
  }
  const enough = used >= MIN_PERCENT && used < 100 && turns.size >= MIN_TURNS && usd > 0
  const left = 100 - used
  return {
    elapsed: Math.min(1, Math.max(0, elapsed)),
    projected,
    emptyAt,
    usd: enough ? (usd / used) * left : used >= 100 ? 0 : null,
    turns: enough ? Math.floor((turns.size / used) * left) : used >= 100 ? 0 : null,
  }
}

export interface MonthValue {
  usd: number
  /** 按模型，从多到少 */
  models: { model: string; usd: number }[]
}

/** 近 30 天按模型的合计折合多少：整组都有引擎报的费用就用它，否则整组按 Token × 官方价（混着用会重复算） */
export function monthValue(rows: readonly UsageGroupRow[]): MonthValue | null {
  const models = rows
    .map(r => ({
      model: r.key,
      usd: r.costKnown === r.records ? r.costUsd : (estimateCost(r, officialPrice(r.key)) ?? r.costUsd),
    }))
    .filter(m => m.usd > 0)
    .sort((a, b) => b.usd - a.usd)
  return models.length ? { usd: models.reduce((s, m) => s + m.usd, 0), models } : null
}

/** 明细里能选的月费（美元）；id 存在本机 */
export const PLAN_FEES: Record<'claude' | 'chatgpt', { id: string; label: string; usd: number }[]> = {
  claude: [
    { id: 'pro', label: 'Pro $20', usd: 20 },
    { id: 'max_5x', label: 'Max 5x $100', usd: 100 },
    { id: 'max_20x', label: 'Max 20x $200', usd: 200 },
  ],
  chatgpt: [
    { id: 'plus', label: 'Plus $20', usd: 20 },
    { id: 'pro', label: 'Pro $200', usd: 200 },
  ],
}

/** 默认月费：按套餐值；Claude 只写「max」分不出 5x / 20x 时按 20x；认不出（Team、企业、免费）为 null，不比 */
export function defaultFeeId(provider: QuotaProvider, plan: string | null): string | null {
  if (provider === 'platform' || !plan) return null
  if (provider === 'claude') return plan === 'max' ? 'max_20x' : PLAN_FEES.claude.some(f => f.id === plan) ? plan : null
  return PLAN_FEES.chatgpt.some(f => f.id === plan) ? plan : null
}

/** 引擎记录里的 engine：Claude 账号是 claude，ChatGPT 账号是 codex */
export const PROVIDER_ENGINE: Partial<Record<QuotaProvider, string>> = { claude: 'claude', chatgpt: 'codex' }

/** 估计的金额：「≈ $36」「≈ $4.5」，不到 $0.1 写「≈ <$0.1」 */
export function usdText(usd: number): string {
  if (usd > 0 && usd < 0.1) return '≈ <$0.1'
  return `≈ $${usd >= 10 ? Math.round(usd) : usd.toFixed(1)}`
}

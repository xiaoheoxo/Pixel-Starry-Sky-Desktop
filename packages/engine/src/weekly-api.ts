import { createHash } from 'node:crypto'
import {
  estimateCost,
  officialPrice,
  totalTokens,
  type UsageRecord,
  type WeeklyApiQuery,
  type WeeklyApiSample,
} from '@pixelsky/protocol'

export const subscriptionUsageKey = (account: string): string =>
  createHash('sha256')
    .update('pixelsky:codex-usage:' + account.trim().toLowerCase())
    .digest('hex')

/** Compare at standard API rates, not subscription credits, actual charges or model speed surcharges. */
export function weeklyApiSample(rows: readonly UsageRecord[], query: WeeklyApiQuery): WeeklyApiSample {
  const key = subscriptionUsageKey(query.account)
  const sample: WeeklyApiSample = { usd: 0, records: 0, incomplete: false }
  for (const row of rows) {
    if (
      row.engine !== 'codex' ||
      row.route !== 'cli' ||
      (row.subscriptionUsageKey && row.subscriptionUsageKey !== key) ||
      row.endedAt < query.from ||
      row.startedAt >= query.to ||
      totalTokens(row) <= 0
    )
      continue
    // Don't guess ownership of historical rows or prorate tokens from a turn straddling a reading.
    const price = officialPrice(row.model)
    const cost = price?.vendor === 'openai' ? estimateCost(row, price) : null
    if (row.subscriptionUsageKey !== key || row.startedAt < query.from || row.endedAt >= query.to || cost === null) {
      sample.incomplete = true
      continue
    }
    sample.usd += cost
    sample.records++
  }
  return sample
}

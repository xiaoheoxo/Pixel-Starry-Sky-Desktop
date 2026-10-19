import type { AccountUsageWindow, EngineAccountUsage } from '@pixelsky/protocol'
import { object } from './process'

const number = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** read 回包和 updated 通知具有相同的 rateLimits / rateLimitsByLimitId 外层。 */
export function codexAccountUsage(raw: unknown, previous?: EngineAccountUsage | null): EngineAccountUsage {
  const body = object(raw)
  const byId = object(body.rateLimitsByLimitId)
  const buckets = Object.keys(byId).length
    ? Object.entries(byId)
    : body.rateLimits && typeof body.rateLimits === 'object'
      ? [
          [
            typeof object(body.rateLimits).limitId === 'string'
              ? (object(body.rateLimits).limitId as string)
              : 'default',
            body.rateLimits,
          ] as const,
        ]
      : []
  if (!buckets.length)
    return {
      status: body.rateLimits === null ? 'unavailable' : 'error',
      reason: 'no_data',
      windows: [],
      observedAt: Date.now(),
    }
  const windows: AccountUsageWindow[] = []
  let plan: string | undefined = previous?.plan
  for (const [id, rawBucket] of buckets) {
    const bucket = object(rawBucket)
    if (typeof bucket.planType === 'string') plan = bucket.planType
    for (const slot of ['primary', 'secondary'] as const) {
      if (!bucket[slot] || typeof bucket[slot] !== 'object') continue
      const window = object(bucket[slot]),
        minutes = number(window.windowDurationMins)
      const percent = number(window.usedPercent),
        reset = number(window.resetsAt)
      const name = typeof bucket.limitName === 'string' ? bucket.limitName : undefined
      windows.push({
        id: `${id}:${slot}`,
        kind: minutes === 300 ? 'five_hour' : minutes === 10080 ? 'weekly' : 'other',
        ...(name ? { label: name } : {}),
        usedPercent: percent === null ? null : Math.max(0, percent),
        resetsAt: reset !== null && reset > 0 && reset < 8.64e12 ? reset * 1000 : null,
        ...(minutes !== null && minutes > 0 ? { windowMinutes: minutes } : {}),
      })
    }
  }
  const prefixes = buckets.map(([id]) => `${id}:`)
  const preserved = previous?.windows.filter(w => !prefixes.some(prefix => w.id.startsWith(prefix))) ?? []
  return {
    status: 'ready',
    windows: [...preserved, ...windows],
    observedAt: Date.now(),
    ...(plan ? { plan } : {}),
    ...(previous?.account ? { account: previous.account } : {}),
  }
}

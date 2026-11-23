import {
  QUOTA_WINDOW_MINS,
  quotaWindowObservedAt,
  type AccountQuota,
  type WeeklyApiQuery,
  type WeeklyApiSample,
} from '@pixelsky/protocol'
import type { QuotaHistory } from './observations'

const HOUR = 3_600_000
const MIN_POINTS = 10

export function weeklyApiCalibration(
  quota: AccountQuota,
  id: string,
  now: number,
  history?: QuotaHistory,
): { query: WeeklyApiQuery; pointsUsed: number } | null {
  const account = quota.account?.trim()
  const week = quota.windows.find(w => w.id === id)
  const to = quotaWindowObservedAt(quota, id)
  const resetsAt = week?.resetsAt
  if (
    quota.provider !== 'chatgpt' ||
    quota.status !== 'ok' ||
    quota.pending ||
    !account ||
    week?.durationMins !== QUOTA_WINDOW_MINS.week ||
    resetsAt == null ||
    resetsAt <= Math.max(now, to ?? 0) ||
    to === null ||
    now - to > 6 * HOUR ||
    !history ||
    history.discontinuity ||
    history.resetsAt !== resetsAt ||
    history.plan !== quota.plan ||
    !Number.isFinite(week.usedPercent) ||
    week.usedPercent > 100 ||
    (week.rejected && week.usedPercent !== 100)
  )
    return null
  const start = resetsAt - QUOTA_WINDOW_MINS.week * 60_000
  const readings = history.points.filter(p => p.time >= Math.max(start, to - 72 * HOUR) && p.time < to)
  if (readings.length < 2) return null
  const first = readings[0]!
  const pointsUsed = week.usedPercent - first.used
  if (pointsUsed < MIN_POINTS || to - first.time < HOUR) return null
  return { query: { account, plan: quota.plan, from: first.time, to, resetsAt }, pointsUsed }
}

export function weeklyApiValue(sample: WeeklyApiSample | null, pointsUsed: number) {
  if (
    !sample ||
    sample.incomplete ||
    sample.records < 3 ||
    pointsUsed < MIN_POINTS ||
    !Number.isFinite(sample.usd) ||
    sample.usd <= 0
  )
    return null
  const full = sample.usd * (100 / pointsUsed)
  return Number.isFinite(full) ? { full, pointsUsed } : null
}

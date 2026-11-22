import { quotaWindowObservedAt, type AccountQuota } from '@pixelsky/protocol'

const MAX_SERIES = 32
const MAX_POINTS = 96
/** Collapse reads made in the same short observation interval; keep the newest measurement. */
const SAMPLE_INTERVAL = 15 * 60_000

export interface QuotaObservation {
  time: number
  used: number
}
export interface QuotaHistory {
  plan: string | null
  resetsAt: number
  durationMins: number
  points: readonly QuotaObservation[]
  discontinuity: boolean
}

const windowKey = (q: AccountQuota, window: string): string | null =>
  q.account?.trim() ? JSON.stringify([q.provider, q.account.trim().toLowerCase(), window]) : null

/** Local account snapshots only. No network polling or disk writes are added. */
export function createQuotaObservations() {
  const windows = new Map<string, QuotaHistory>()
  return {
    record(q: AccountQuota) {
      if (q.status !== 'ok' || q.pending) return
      for (const w of q.windows) {
        const time = quotaWindowObservedAt(q, w.id)
        if (time === null || !Number.isFinite(time)) continue
        const key = windowKey(q, w.id)
        if (!key || !w.durationMins || w.resetsAt === null || w.resetsAt <= time || !Number.isFinite(w.usedPercent))
          continue
        const previous = windows.get(key)
        const last = previous?.points.at(-1)
        const used = w.rejected ? 100 : w.usedPercent
        if (last && last.time >= time) continue
        const sameWindow =
          previous?.resetsAt === w.resetsAt && previous.durationMins === w.durationMins && previous.plan === q.plan
        const backwards = !!last && used < last.used
        const continuous = sameWindow && !backwards
        // A new natural period starts from zero; a drop inside the previous period is a rebase/reset.
        const discontinuity = continuous
          ? previous.discontinuity
          : !!previous && (previous.plan !== q.plan || time < previous.resetsAt)
        const points = continuous ? [...previous.points] : []
        if (points.length && Math.floor(points.at(-1)!.time / SAMPLE_INTERVAL) === Math.floor(time / SAMPLE_INTERVAL))
          points.pop()
        points.push({ time, used })
        windows.delete(key)
        windows.set(key, {
          plan: q.plan,
          resetsAt: w.resetsAt,
          durationMins: w.durationMins,
          points: points.slice(-MAX_POINTS),
          discontinuity,
        })
        if (windows.size > MAX_SERIES) windows.delete(windows.keys().next().value!)
      }
    },
    forWindow(q: AccountQuota, id: string): QuotaHistory | undefined {
      const key = windowKey(q, id)
      const window = q.windows.find(w => w.id === id)
      const history = key ? windows.get(key) : undefined
      return history &&
        window &&
        history.plan === q.plan &&
        history.resetsAt === window.resetsAt &&
        history.durationMins === window.durationMins
        ? history
        : undefined
    },
  }
}

export const quotaObservations = createQuotaObservations()

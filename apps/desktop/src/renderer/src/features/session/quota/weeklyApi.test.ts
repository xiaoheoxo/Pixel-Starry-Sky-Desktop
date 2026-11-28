import { expect, it } from 'vitest'
import { quotaWindowId, type AccountQuota } from '@pixelsky/protocol'
import type { QuotaHistory } from './observations'
import { weeklyApiCalibration, weeklyApiValue } from './weeklyApi'

const h = 3_600_000
const to = 100 * h
const id = quotaWindowId(10_080)
const week = { id, durationMins: 10_080, resetsAt: to + 20 * h, usedPercent: 55 }
const q: AccountQuota = {
  provider: 'chatgpt',
  status: 'ok',
  account: 'test@example.org',
  plan: 'plus',
  windows: [week],
  source: 'usage',
  fetchedAt: to,
  observedAt: to,
  refreshable: true,
  blocked: null,
  extras: {},
  error: null,
}
const history: QuotaHistory = {
  plan: q.plan,
  durationMins: 10_080,
  resetsAt: week.resetsAt,
  discontinuity: false,
  points: [
    { time: to - 80 * h, used: 1 },
    { time: to - 8 * h, used: 25 },
    { time: to - 4 * h, used: 40 },
    { time: to, used: 55 },
  ],
}

it('values the full week using observed delta and matched local usage, not monthly fees or calendar days', () => {
  const calibration = weeklyApiCalibration(q, id, to, history)!
  expect(calibration.pointsUsed).toBe(30)
  expect(calibration.query).toMatchObject({ from: to - 8 * h, to, resetsAt: week.resetsAt, account: q.account })
  expect(weeklyApiValue({ records: 9, usd: 90, incomplete: false }, calibration.pointsUsed)).toEqual({
    full: 300,
    pointsUsed: 30,
  })
})

it('suppresses stale, rebased, wrong cycle, pending or thin samples', () => {
  expect(weeklyApiCalibration(q, id, to + 7 * h, history)).toBeNull()
  expect(weeklyApiCalibration(q, id, week.resetsAt, history)).toBeNull()
  expect(weeklyApiCalibration(q, id, to, { ...history, discontinuity: true })).toBeNull()
  expect(weeklyApiCalibration(q, id, to, { ...history, resetsAt: to })).toBeNull()
  expect(weeklyApiCalibration({ ...q, pending: true }, id, to, history)).toBeNull()
  expect(weeklyApiCalibration({ ...q, windows: [{ ...week, usedPercent: 30 }] }, id, to, history)).toBeNull()
  expect(weeklyApiCalibration({ ...q, windows: [{ ...week, rejected: true }] }, id, to, history)).toBeNull()
  expect(weeklyApiValue({ records: 2, usd: 90, incomplete: false }, 30)).toBeNull()
  expect(weeklyApiValue({ records: 9, usd: 90, incomplete: true }, 30)).toBeNull()
})

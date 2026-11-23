import { expect, it } from 'vitest'
import type { AccountQuota } from '@pixelsky/protocol'
import { createQuotaObservations } from './observations'

const HOUR = 3_600_000
const quota = (
  observedAt: number,
  usedPercent: number,
  account = 'a@example.test',
  plan = 'prolite',
): AccountQuota => ({
  provider: 'chatgpt',
  status: 'ok',
  plan,
  account,
  windows: [{ id: 'seven_day', durationMins: 10_080, usedPercent, resetsAt: 160 * HOUR }],
  extras: {},
  blocked: null,
  observedAt,
  fetchedAt: observedAt,
  source: 'usage',
  refreshable: true,
  error: null,
})

it('isolates accounts and ignores duplicate or old responses', () => {
  const store = createQuotaObservations()
  store.record(quota(HOUR, 7))
  store.record(quota(2 * HOUR, 9))
  store.record(quota(2 * HOUR, 6))
  store.record(quota(HOUR, 4))
  const other = quota(2 * HOUR, 33, 'other@example.test')
  store.record(other)
  expect(store.forWindow(other, 'seven_day')?.points).toEqual([{ time: 2 * HOUR, used: 33 }])
  expect(store.forWindow(quota(2 * HOUR, 9, ' A@example.test '), 'seven_day')?.points).toEqual([
    { time: HOUR, used: 7 },
    { time: 2 * HOUR, used: 9 },
  ])
})

it('drops old baselines when usage regresses or a plan changes, but starts natural windows cleanly', () => {
  const store = createQuotaObservations()
  store.record(quota(2 * HOUR, 40))
  const reset = quota(3 * HOUR, 0)
  store.record(reset)
  expect(store.forWindow(reset, 'seven_day')).toMatchObject({
    discontinuity: true,
    points: [{ time: 3 * HOUR, used: 0 }],
  })
  const upgrade = quota(4 * HOUR, 5, reset.account!, 'pro')
  store.record(upgrade)
  expect(store.forWindow(upgrade, 'seven_day')).toMatchObject({
    discontinuity: true,
    points: [{ time: 4 * HOUR, used: 5 }],
  })
  const natural = quota(162 * HOUR, 1, reset.account!, 'pro')
  natural.windows[0]!.resetsAt = 320 * HOUR
  store.record(natural)
  expect(store.forWindow(natural, 'seven_day')).toMatchObject({
    discontinuity: false,
    points: [{ time: 162 * HOUR, used: 1 }],
  })
})

it('keeps unchanged weekly data out of the latest samples after a short-window event', () => {
  const store = createQuotaObservations()
  const initial = quota(24 * HOUR, 42)
  store.record(initial)
  const partial: AccountQuota = {
    ...initial,
    source: 'event',
    observedAt: 33 * HOUR,
    windows: [...initial.windows, { id: 'five_hour', durationMins: 300, usedPercent: 30, resetsAt: 36 * HOUR }],
    windowObservedAt: { seven_day: 24 * HOUR, five_hour: 33 * HOUR },
  }
  store.record(partial)
  expect(store.forWindow(partial, 'seven_day')?.points).toEqual([{ time: 24 * HOUR, used: 42 }])
  expect(store.forWindow(partial, 'five_hour')?.points).toEqual([{ time: 33 * HOUR, used: 30 }])
})

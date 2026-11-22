import { describe, expect, it } from 'vitest'
import type { UsageGroupRow } from '@pixelsky/protocol'
import { defaultFeeId, monthValue, windowEstimate } from './estimate'
import type { QuotaHistory } from './observations'
import type { QuotaEntry } from './quotaModel'

const HOUR = 3_600_000
const now = 100 * HOUR
const entry = (percent: number, elapsedHours: number, over: Partial<QuotaEntry> = {}): QuotaEntry =>
  ({
    id: '5h',
    kind: 'window',
    durationMins: 300,
    percent,
    resetsAt: now + (5 - elapsedHours) * HOUR,
    expired: false,
    ...over,
  }) as QuotaEntry
describe('windowEstimate', () => {
  it('uses the official account percentage, anchors to the observation and labels a window-average fallback', () => {
    const e = windowEstimate(entry(50, 2), now, now)!
    expect(e).toMatchObject({
      basis: 'window',
      projected: 100,
      emptyAt: now + 2 * HOUR,
      budget: { percent: 50 / 3, unit: 'hour' },
    })
    const staleClock = now + 5 * 60_000
    expect(windowEstimate(entry(50, 2), staleClock, now)?.emptyAt).toBe(e.emptyAt)
  })

  it('uses the recent median rate instead of extrapolating an old burst across the week', () => {
    const week = entry(45, 72, { durationMins: 10_080, resetsAt: now + 96 * HOUR })
    const history: QuotaHistory = {
      plan: 'prolite',
      resetsAt: week.resetsAt!,
      durationMins: 10_080,
      discontinuity: false,
      points: [
        { time: now - 18 * HOUR, used: 42 },
        { time: now - 12 * HOUR, used: 43 },
        { time: now - 6 * HOUR, used: 44 },
        { time: now, used: 45 },
      ],
    }
    const e = windowEstimate(week, now, now, history)!
    expect(e.basis).toBe('recent')
    expect(e.projected).toBeCloseTo(61)
    expect(e.emptyAt).toBeNull()
    expect(e.budget).toEqual({ percent: 13.75, unit: 'day' })
  })

  it('does not extrapolate from stale, reset, partial, failed, or exhausted windows', () => {
    const window = entry(35, 2)
    const reset: QuotaHistory = {
      plan: 'pro',
      resetsAt: window.resetsAt!,
      durationMins: 300,
      discontinuity: true,
      points: [{ time: now, used: 35 }],
    }
    expect(windowEstimate(window, now, now, reset)?.basis).toBeNull()
    expect(windowEstimate(window, now, now - HOUR)?.budget).toBeNull()
    expect(windowEstimate(window, now, null)?.projected).toBeNull()
    expect(windowEstimate(entry(30, 0.2), now, now)?.projected).toBeNull()
    expect(windowEstimate(entry(100, 2), now, now)?.projected).toBeNull()
    expect(windowEstimate(entry(40, 2, { expired: true }), now, now)).toBeNull()
    expect(windowEstimate(entry(40, 2, { durationMins: null }), now, now)).toBeNull()
  })

  it('does not turn a forecast already in the past into an observed quota block', () => {
    const dataTime = now - 10 * 60_000
    expect(windowEstimate(entry(97, 2), now, dataTime)).toMatchObject({ basis: null, projected: null, emptyAt: null })
  })
})

describe('monthValue', () => {
  const row = (key: string, costUsd: number, costKnown: number, records: number, output = 0) =>
    ({ key, costUsd, costKnown, records, input: 0, cacheRead: 0, cacheWrite: 0, output }) as UsageGroupRow
  it('整组有费用用费用；缺的整组按官方价算，不混着加；从多到少', () => {
    const m = monthValue([row('claude-opus-4-1', 30, 3, 3), row('gpt-5', 0, 0, 2, 1_000_000)])!
    expect(m.models[0]).toEqual({ model: 'claude-opus-4-1', usd: 30 })
    expect(m.models[1].usd).toBeGreaterThan(0)
    expect(m.usd).toBeCloseTo(30 + m.models[1].usd)
  })
  it('distinguishes unpriced usage from no use and picks up verified GPT-6.2 pricing', () => {
    expect(monthValue([row('unknown-x', 0, 0, 2, 100)])).toEqual({ usd: 0, models: [], unpricedModels: 1 })
    expect(monthValue([row('unknown-x', 0, 0, 2)])).toBeNull()
    expect(monthValue([row('gpt-6.2-sol', 0, 0, 1, 1_000_000), row('unknown-x', 0, 0, 1, 10)])).toMatchObject({
      usd: 10,
      unpricedModels: 1,
    })
  })
})

describe('defaultFeeId', () => {
  it('按套餐值；分不出倍数的 max / Ultra 按 20x；认不出的不比', () => {
    expect(defaultFeeId('claude', 'max')).toBe('max_20x')
    expect(defaultFeeId('claude', 'max_5x')).toBe('max_5x')
    expect(defaultFeeId('claude', 'team_5x')).toBeNull()
    expect(defaultFeeId('chatgpt', 'pro')).toBe('pro')
    expect(defaultFeeId('chatgpt', 'prolite')).toBe('prolite')
    expect(defaultFeeId('chatgpt', 'promax')).toBe('promax')
    expect(defaultFeeId('chatgpt', 'team')).toBeNull()
    expect(defaultFeeId('google', 'Google AI Ultra')).toBe('ultra_20x')
    expect(defaultFeeId('google', 'Google AI Ultra 5x')).toBe('ultra_5x')
    expect(defaultFeeId('google', 'Google AI Pro')).toBe('pro')
    expect(defaultFeeId('google', 'Free')).toBeNull()
    expect(defaultFeeId('platform', 'pro')).toBeNull()
  })
})

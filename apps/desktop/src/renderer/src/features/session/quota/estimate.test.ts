import { describe, expect, it } from 'vitest'
import type { UsageGroupRow } from '@pixelsky/protocol'
import { defaultFeeId, monthValue, windowEstimate } from './estimate'
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
const rec = (hoursAgo: number, costUsd: number | null, turnId: string, model = 'claude-sonnet-4-5') => ({
  endedAt: now - hoursAgo * HOUR,
  sessionId: 's',
  turnId,
  costUsd,
  model,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})

describe('windowEstimate', () => {
  it('用得比时间快：顶到 100、写出用完时刻；剩余按每 1% 的价钱和轮数折合', () => {
    // 2 小时用了 50%：再 2 小时用完；窗口里 4 轮共 $10 → 每 1% $0.2，剩 50% ≈ $10、4 轮
    const records = [rec(0.5, 2, 'a'), rec(1, 3, 'b'), rec(1.5, 4, 'c'), rec(1.9, 1, 'd'), rec(3, 99, 'old')]
    const e = windowEstimate(entry(50, 2), records, now)!
    expect(e.projected).toBe(100)
    expect(e.emptyAt).toBe(now + 2 * HOUR)
    expect(e.usd).toBeCloseTo(10)
    expect(e.turns).toBe(4)
  })
  it('够用：写恢复时会用到多少，没有用完时刻', () => {
    const e = windowEstimate(entry(20, 2), [rec(1, 1, 'a'), rec(1, 1, 'b')], now)!
    expect(e.projected).toBeCloseTo(50)
    expect(e.emptyAt).toBeNull()
  })
  it('刚记下、比按分钟走的 now 晚几十秒的一轮也算进去', () => {
    const e = windowEstimate(entry(20, 2), [rec(1, 1, 'a'), rec(-0.01, 1, 'b')], now)!
    expect(e.usd).toBeCloseTo(8)
  })
  it('数据不够不写估计：轮数太少、记录没价钱、窗口刚开始', () => {
    expect(windowEstimate(entry(30, 2), [rec(1, 5, 'a')], now)!.usd).toBeNull()
    expect(
      windowEstimate(entry(30, 2), [rec(1, null, 'a', 'unknown-x'), rec(1, null, 'b', 'unknown-x')], now)!.usd,
    ).toBeNull()
    expect(windowEstimate(entry(30, 0.2), [], now)!.projected).toBeNull()
    expect(windowEstimate(entry(30, 2, { durationMins: null }), [], now)).toBeNull()
    expect(windowEstimate(entry(30, 2, { expired: true }), [], now)).toBeNull()
  })
  it('已用完：剩 0，不再写用完时刻', () => {
    const e = windowEstimate(entry(100, 2), [], now)!
    expect(e.emptyAt).toBeNull()
    expect(e.usd).toBe(0)
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
  it('一分钱都算不出为 null', () => {
    expect(monthValue([row('unknown-x', 0, 0, 2, 100)])).toBeNull()
  })
})

describe('defaultFeeId', () => {
  it('按套餐值；分不出倍数的 max 按 20x；认不出的不比', () => {
    expect(defaultFeeId('claude', 'max')).toBe('max_20x')
    expect(defaultFeeId('claude', 'max_5x')).toBe('max_5x')
    expect(defaultFeeId('claude', 'team_5x')).toBeNull()
    expect(defaultFeeId('chatgpt', 'pro')).toBe('pro')
    expect(defaultFeeId('chatgpt', 'team')).toBeNull()
    expect(defaultFeeId('platform', 'pro')).toBeNull()
  })
})

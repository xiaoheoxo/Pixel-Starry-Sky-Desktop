import { describe, expect, it } from 'vitest'
import type { RemoteCall, RemoteUsageSummary } from '@pixelsky/protocol'
import { formatTotalCost } from './format'
import { callSpeed, callTiming, summarizeCalls, toUsageSummary } from './remoteSummary'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const stat = (requests: number, costUsd: number) => ({
  requests,
  input: requests * 10,
  output: requests * 2,
  cacheRead: requests * 5,
  cacheWrite: 0,
  costUsd,
})
// 本地时间 2026-10-12 15:30
const now = new Date(2026, 9, 12, 15, 30).getTime()
const day = (d: number) => new Date(2026, 9, d).getTime()

describe('account usage summary', () => {
  it('fills the same bucket grid as local records and counts every request as an actual charge', () => {
    const remote: RemoteUsageSummary = {
      buckets: [
        { ...stat(2, 0.5), start: day(10) },
        { ...stat(1, 0.25), start: day(12) },
        // 云端时区比本机早几小时：算进第一格
        { ...stat(1, 0.1), start: day(6) - 3 * HOUR },
      ],
      models: [
        { ...stat(1, 0.1), model: 'small' },
        { ...stat(3, 0.75), model: 'big' },
      ],
      total: stat(4, 0.85),
      prevTotal: stat(2, 0.4),
    }
    const s = toUsageSummary(remote, '7d', now)
    expect(s.bucket).toBe('day')
    expect(s.buckets).toHaveLength(7)
    expect(s.buckets[0].start).toBe(day(6))
    expect(s.buckets.map(b => b.requests)).toEqual([1, 0, 0, 0, 2, 0, 1])
    expect(s.buckets[4]).toMatchObject({ costUsd: 0.5, costKnown: 2, costActual: 2, records: 2, input: 20 })
    expect(s.groups.model.map(r => r.key)).toEqual(['big', 'small'])
    expect(s.groups.project).toEqual([])
    expect(s.groups.cost).toEqual([])
    expect(s.totals).toMatchObject({ requests: 4, turns: 4, costKnown: 4, costActual: 4 })
    expect(s.prevTotals.requests).toBe(2)
    // 实扣金额不带 ≈ / ≥；空的格子显示 —
    expect(formatTotalCost(s.totals)).toBe('$0.85')
    expect(formatTotalCost(s.buckets[1])).toBe('—')
  })

  it('uses hourly buckets for today', () => {
    const remote: RemoteUsageSummary = {
      buckets: [{ ...stat(1, 0.1), start: day(12) + 9 * HOUR }],
      models: [],
      total: stat(1, 0.1),
      prevTotal: stat(0, 0),
    }
    const s = toUsageSummary(remote, 'today', now)
    expect(s.bucket).toBe('hour')
    expect(s.buckets).toHaveLength(16)
    expect(s.buckets[9].requests).toBe(1)
  })

  it('summarizes demo calls the way the cloud does', () => {
    const call = (createdAt: number, model: string, costUsd: number | null): RemoteCall => ({
      id: `${createdAt}`,
      createdAt,
      model,
      client: 'pixelsky-desktop',
      device: null,
      keyName: null,
      stream: true,
      status: 'success',
      httpStatus: 200,
      input: 10,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1,
      costUsd,
      firstTokenMs: null,
      durationMs: 1,
      turnId: null,
    })
    const calls = [
      call(day(12) + HOUR, 'a', 0.1),
      call(day(11) + HOUR, 'b', null),
      call(day(11) + 2 * HOUR, 'a', 0.2),
      call(day(1), 'a', 1),
      call(now + DAY, 'a', 1),
    ]
    const s = summarizeCalls(calls, '7d', null, now)
    expect(s.total).toMatchObject({ requests: 3, input: 30 })
    expect(s.total.costUsd).toBeCloseTo(0.3)
    expect(s.prevTotal.requests).toBe(1)
    expect(s.buckets.map(b => [b.start, b.requests])).toEqual([
      [day(11), 2],
      [day(12), 1],
    ])
    expect(s.models.map(m => [m.model, m.requests])).toEqual([
      ['a', 2],
      ['b', 1],
    ])
    expect(summarizeCalls(calls, '7d', 'b', now).total.requests).toBe(1)
  })
})

describe('账号调用的速度（docs/ui/usage-learn.md §7）', () => {
  const call = (output: number, firstTokenMs: number | null, durationMs: number): RemoteCall => ({
    id: '1',
    createdAt: 0,
    model: 'm',
    client: 'pixelsky-desktop',
    device: null,
    keyName: null,
    stream: true,
    status: 'success',
    httpStatus: 200,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output,
    costUsd: null,
    firstTokenMs,
    durationMs,
    turnId: null,
  })
  it('正常流式：输出 ÷（耗时 − 首字）', () => {
    expect(callSpeed(call(1436, 862, 17_207))).toBeCloseTo(87.9, 1)
  })
  it('首字后只剩几毫秒、首字晚于耗时 80%：量不了，也不进合计', () => {
    expect(callSpeed(call(1641, 21_055, 21_064))).toBeNull()
    expect(callSpeed(call(2386, 29_270, 35_605))).toBeNull()
    const t = callTiming([call(1641, 21_055, 21_064), call(1436, 862, 17_207)])
    expect(t.total).toMatchObject({ genMs: 16_345, genOutput: 1436 })
  })
})

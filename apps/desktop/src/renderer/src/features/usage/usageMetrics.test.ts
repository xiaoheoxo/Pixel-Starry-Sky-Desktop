import { describe, expect, it } from 'vitest'
import type { RemoteCall } from '@pixelsky/protocol'
import { averageFirstToken, emptyTotals, heatmapDays, outputSpeed, successRate, summarize } from './aggregate'
import { metricValue } from './chartGeometry'
import { parseChartPrefs } from './chartStyle'
import { formatCount, formatFirstToken, formatRecordCost, formatShortCost } from './format'
import { heatLevels, monthLabels } from './heatmap'
import { callSpeed, callTiming, remoteDays, withCallTiming } from './remoteSummary'
import type { UsageBucket, UsageRecord } from './types'

const bucket = (over: Partial<UsageBucket> = {}): UsageBucket => ({ ...emptyTotals(), start: 0, ...over })
const call = (over: Partial<RemoteCall> = {}): RemoteCall =>
  ({
    id: 'r',
    createdAt: 0,
    model: 'm',
    client: 'pixelsky-desktop',
    device: null,
    keyName: null,
    stream: true,
    status: 'success',
    httpStatus: 200,
    input: 1,
    cacheRead: 0,
    cacheWrite: 0,
    output: 300,
    costUsd: 0.1,
    firstTokenMs: 1000,
    durationMs: 4000,
    turnId: null,
    ...over,
  }) as RemoteCall

describe('指标的值', () => {
  it('不知道的是 null，不是 0：费用全缺、没有输入、没量到速度', () => {
    expect(metricValue('cost', bucket({ records: 2, costKnown: 0 }))).toBeNull()
    expect(metricValue('cost', bucket())).toBe(0)
    expect(metricValue('hit', bucket())).toBeNull()
    expect(metricValue('speed', bucket({ output: 900 }))).toBeNull()
    expect(metricValue('hit', bucket({ input: 10, cacheRead: 30 }))).toBe(0.75)
    expect(metricValue('tokens', bucket({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }))).toBe(10)
  })

  it('速度按量到的那部分算；太少不算；平均首字、成功率', () => {
    expect(outputSpeed({ genMs: 2000, genOutput: 400 })).toBe(200)
    expect(outputSpeed({ genMs: 100, genOutput: 99 })).toBeNull()
    expect(averageFirstToken(bucket({ firstTokenMs: 3000, firstTokens: 2 }))).toBe(1500)
    expect(averageFirstToken(bucket())).toBeNull()
    expect(successRate({ records: 4, failed: 1 })).toBe(0.75)
    // 旧版远端没有 failed：不知道，不是 100%
    expect(successRate({ records: 4 })).toBeNull()
    expect(successRate({ records: 0, failed: 0 })).toBeNull()
  })

  it('中断不算失败；合计把旧记录排除在速度之外', () => {
    const now = new Date(2026, 10, 6, 12).getTime()
    const record = (over: Partial<UsageRecord>): UsageRecord => ({
      v: 1,
      id: String(Math.random()),
      sessionId: 's',
      turnId: String(Math.random()),
      startedAt: now - 1000,
      endedAt: now - 1000,
      durationMs: 1,
      sessionTitle: '',
      project: null,
      engine: 'claude',
      model: 'm',
      route: 'cli',
      input: 1,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1000,
      costUsd: null,
      outcome: 'completed',
      ...over,
    })
    const s = summarize(
      [
        record({ outcome: 'interrupted' }),
        record({ outcome: 'failed' }),
        record({ genMs: 2000, genOutput: 200, firstTokenMs: 500 }),
        record({ genMs: 2000, genOutput: 200, firstTokenMs: 1500 }),
      ],
      'today',
      {},
      now,
    )
    expect(successRate(s.totals)).toBe(0.75)
    expect(outputSpeed(s.totals)).toBe(100)
    expect(averageFirstToken(s.groups.model[0])).toBe(1000)
    expect(outputSpeed(s.buckets.find(b => b.records > 0)!)).toBe(100)
  })

  it('图表偏好：指标坏值回到 Token，好值留着', () => {
    expect(parseChartPrefs({ metric: 'cost' }).metric).toBe('cost')
    expect(parseChartPrefs({ metric: 'nope' }).metric).toBe('tokens')
    expect(parseChartPrefs(null).metric).toBe('tokens')
  })
})

describe('数字格式', () => {
  it('和参考图一样：534、1,017、175K', () => {
    expect([534, 1017, 9999, 48200, 175000, 30_700_000, 1_100_000_000].map(formatCount)).toEqual([
      '534',
      '1,017',
      '9,999',
      '48K',
      '175K',
      '30.7M',
      '1.1B',
    ])
    expect(formatFirstToken(11_700)).toBe('11.7s')
    expect(formatFirstToken(undefined)).toBe('—')
    expect(formatFirstToken(null)).toBe('—')
  })

  it('分布表的费用不带 6 位小数；一条都不知道是「—」', () => {
    expect(formatShortCost({ costUsd: 425.123456, costKnown: 3, records: 3 })).toBe('≈ $425.12')
    expect(formatShortCost({ costUsd: 1.5, costKnown: 1, records: 2 })).toBe('≥ $1.50')
    expect(formatShortCost({ costUsd: 0, costKnown: 0, records: 2 })).toBe('—')
  })

  it('对不上价格的写未定价，别的原因还是「—」', () => {
    const r = { costUsd: null, route: 'api-key', input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } as UsageRecord
    expect(formatRecordCost(r)).toMatch(/未定价|Unpriced/)
    expect(formatRecordCost({ ...r, route: 'cli' })).toBe('—')
  })
})

describe('热力图', () => {
  it('按四分位分档；没有数据和 0 是最浅的一档', () => {
    expect(heatLevels([null, 0, 1, 2, 3, 4])).toEqual([0, 0, 1, 2, 3, 4])
    expect(heatLevels([null, null])).toEqual([0, 0])
    // 有一天特别多，其余不至于全贴底
    expect(heatLevels([1, 2, 3, 1000]).at(0)).toBe(1)
    expect(heatLevels([1, 2, 3, 1000]).at(-1)).toBe(4)
  })

  it('月份标在有 1 号的那一列；第一列附近没有就标第一列', () => {
    const now = new Date(2026, 10, 6).getTime()
    const days = heatmapDays([], now)
    const labels = monthLabels(days, start => String(new Date(start).getMonth() + 1))
    expect(labels).toHaveLength(53)
    expect(labels.filter(Boolean).length).toBeGreaterThanOrEqual(12)
    expect(labels).toContain('11')
    expect(labels[0]).toBeTruthy()
  })

  it('周一开头、连续不断；跨夏令时也不错位', () => {
    const now = new Date(2026, 10, 6, 15).getTime()
    const days = heatmapDays([], now)
    expect(new Date(days[0].start).getDay()).toBe(1)
    expect(Math.ceil(days.length / 7)).toBe(53)
    for (let i = 1; i < days.length; i++)
      expect(new Date(days[i].start).getDay()).toBe((new Date(days[i - 1].start).getDay() + 1) % 7)
  })

  it('云端的格子落到本地日期，范围外的丢掉；没有 failed', () => {
    const now = new Date(2026, 10, 6, 15).getTime()
    const stat = { requests: 2, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.5 }
    const days = remoteDays(
      {
        buckets: [
          { ...stat, start: now - 1000 },
          { ...stat, start: new Date(2020, 0, 1).getTime() },
        ],
        models: [],
        total: stat,
        prevTotal: stat,
      },
      now,
    )
    expect(days.at(-1)).toMatchObject({ requests: 2, turns: 2, costUsd: 0.5 })
    expect(days.reduce((n, d) => n + d.requests, 0)).toBe(2)
  })
})

describe('账号调用的速度和首字', () => {
  it('从首字到结束；非流式、失败、没首字的不算；输出太少单条没有', () => {
    expect(callSpeed(call())).toBe(100)
    expect(callSpeed(call({ stream: false }))).toBeNull()
    expect(callSpeed(call({ status: 'error' }))).toBeNull()
    expect(callSpeed(call({ firstTokenMs: null }))).toBeNull()
    expect(callSpeed(call({ output: 42 }))).toBeNull()
    expect(callSpeed(call({ firstTokenMs: 9000 }))).toBeNull()
  })

  it('按模型合计，并到合计和分布里；别的数字不动', () => {
    const t = callTiming([
      call(),
      call({ durationMs: 7000, firstTokenMs: 3000 }),
      call({ model: 'n', status: 'error' }),
    ])
    expect(t.total).toMatchObject({ genMs: 7000, genOutput: 600, firstTokens: 2, firstTokenMs: 4000 })
    expect(t.models.get('n')).toEqual({})
    const base = summarize([], 'today', {}, Date.now())
    const merged = withCallTiming(
      {
        ...base,
        totals: { ...base.totals, requests: 9 },
        groups: { ...base.groups, model: [{ ...emptyTotals(), key: 'm', requests: 2 }] },
      },
      t,
    )
    expect(merged.totals.requests).toBe(9)
    expect(averageFirstToken(merged.groups.model[0])).toBe(2000)
    expect(outputSpeed(merged.groups.model[0])).toBeCloseTo((600 / 7000) * 1000)
  })
})

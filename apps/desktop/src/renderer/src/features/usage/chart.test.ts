import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageBucket } from './types'
import {
  NODE_MIN_SPACING,
  columnCenter,
  lineMax,
  nearestColumn,
  niceMax,
  showAllNodes,
  stackMax,
} from './chartGeometry'
import { CHART_KEY, DEFAULT_CHART, parseChartPrefs } from './chartStyle'
import { searchSettings } from '../settings/searchIndex'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const bucket = (input: number, cacheRead: number, output: number, cacheWrite = 0): UsageBucket => ({
  start: 0,
  input,
  cacheRead,
  cacheWrite,
  output,
  costUsd: 0,
  costKnown: 0,
  records: 0,
  turns: 0,
  requests: 0,
})

describe('用量图表样式的设置', () => {
  it('默认折线、全部显示；损坏的值回到默认', () => {
    expect(DEFAULT_CHART).toEqual({ style: 'line', hidden: [], metric: 'tokens' })
    for (const value of [undefined, null, 'line', 1, [], { style: 'pie' }])
      expect(parseChartPrefs(value)).toEqual(DEFAULT_CHART)
    expect(parseChartPrefs({ style: 'bar', hidden: ['cache', 'nope', 3] })).toMatchObject({
      style: 'bar',
      hidden: ['cache'],
    })
  })

  it('三个系列全关了当作全部显示', () => {
    expect(parseChartPrefs({ style: 'line', hidden: ['input', 'cache', 'output'] }).hidden).toEqual([])
  })

  it('图例开关记在本机，最后一个显示的系列关不掉', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    })
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
    const m = await import('./chartStyle')
    m.toggleSeries('cache')
    m.toggleSeries('input')
    m.toggleSeries('output')
    expect(JSON.parse(store.get(CHART_KEY)!)).toMatchObject({ style: 'line', hidden: ['input', 'cache'] })
    m.setChartStyle('bar')
    expect(JSON.parse(store.get(CHART_KEY)!).style).toBe('bar')
    m.toggleSeries('cache')
    expect(JSON.parse(store.get(CHART_KEY)!).hidden).toEqual(['input'])
  })
})

describe('用量图表的坐标', () => {
  it('纵轴取整到 1 / 2 / 4 / 5 / 10 × 10^k，一半也是整数', () => {
    expect(niceMax(0)).toBe(0)
    expect(niceMax(Number.NaN)).toBe(0)
    expect(niceMax(7)).toBe(10)
    expect(niceMax(1_000)).toBe(1_000)
    expect(niceMax(1_001)).toBe(2_000)
    expect(niceMax(34_500_000)).toBe(40_000_000)
    expect(niceMax(4_200)).toBe(5_000)
    for (const max of [3, 17, 260, 9_999, 123_456]) {
      const top = niceMax(max)
      expect(top).toBeGreaterThanOrEqual(max)
      expect(top).toBeLessThan(max * 2.5)
    }
  })

  it('关掉缓存读后纵轴按剩下的系列重新取整', () => {
    const buckets = [bucket(1_000, 30_000_000, 2_000), bucket(3_000, 100, 5_000, 500)]
    expect(niceMax(lineMax(buckets, ['input', 'cache', 'output']))).toBe(40_000_000)
    expect(niceMax(lineMax(buckets, ['input', 'output']))).toBe(5_000)
    // 输入含缓存写；柱状图按堆叠高度
    expect(lineMax(buckets, ['input'])).toBe(3_500)
    expect(stackMax(buckets, ['input', 'output'])).toBe(8_500)
  })

  it('整列都是热区：按横坐标落到最近的一格，两边越界取首尾', () => {
    expect(nearestColumn(0, 7, 700)).toBe(0)
    expect(nearestColumn(99, 7, 700)).toBe(0)
    expect(nearestColumn(100, 7, 700)).toBe(1)
    expect(nearestColumn(699, 7, 700)).toBe(6)
    expect(nearestColumn(-20, 7, 700)).toBe(0)
    expect(nearestColumn(900, 7, 700)).toBe(6)
    expect(nearestColumn(10, 0, 700)).toBe(0)
    expect(columnCenter(0, 7, 700)).toBe(50)
    expect(columnCenter(6, 7, 700)).toBe(650)
  })

  it('两点间距不到 12px 时收起节点', () => {
    expect(showAllNodes(7, 600)).toBe(true)
    expect(showAllNodes(30, 600)).toBe(true)
    expect(showAllNodes(90, 600)).toBe(false)
    expect(showAllNodes(90, 90 * NODE_MIN_SPACING)).toBe(true)
    expect(showAllNodes(1, 10)).toBe(true)
  })

  it('设置搜索能找到用量图表样式', () => {
    for (const q of ['折线', '柱状', 'chart'])
      expect(searchSettings(q, () => '用量').map(e => e.title)).toContain('用量图表样式')
  })
})

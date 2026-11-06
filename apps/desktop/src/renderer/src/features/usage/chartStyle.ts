// 用量图表的样式（折线节点图 / 堆叠柱状图）和图例里关掉的系列（docs/ui/usage-chart-style.md §3.1、§3.4）。
// 保存在 localStorage，多窗口同步；读到损坏的值回到默认（折线、全部显示）。
import { useSyncExternalStore } from 'react'
import { SERIES_KEYS, USAGE_METRICS, type SeriesKey, type UsageMetric } from './chartGeometry'

export type ChartStyle = 'line' | 'bar'
export interface ChartPrefs {
  style: ChartStyle
  /** 图例里关掉的系列；至少留一个显示 */
  hidden: SeriesKey[]
  /** 图表和热力图看什么 */
  metric: UsageMetric
}

export const CHART_KEY = 'pixelsky.usage-chart'
export const DEFAULT_CHART: ChartPrefs = { style: 'line', hidden: [], metric: 'tokens' }

export function parseChartPrefs(value: unknown): ChartPrefs {
  if (!value || typeof value !== 'object') return DEFAULT_CHART
  const v = value as Partial<Record<keyof ChartPrefs, unknown>>
  const style = v.style === 'bar' || v.style === 'line' ? v.style : DEFAULT_CHART.style
  const hidden = Array.isArray(v.hidden)
    ? SERIES_KEYS.filter(key => (v.hidden as unknown[]).includes(key))
    : DEFAULT_CHART.hidden
  const metric = USAGE_METRICS.includes(v.metric as UsageMetric) ? (v.metric as UsageMetric) : DEFAULT_CHART.metric
  // 全关了等于没法看，当作全部显示
  return { style, hidden: hidden.length >= SERIES_KEYS.length ? [] : hidden, metric }
}

function read(): ChartPrefs {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_CHART
    const raw = localStorage.getItem(CHART_KEY)
    return raw ? parseChartPrefs(JSON.parse(raw)) : DEFAULT_CHART
  } catch {
    return DEFAULT_CHART
  }
}

let prefs = read()
const listeners = new Set<() => void>()

const same = (a: ChartPrefs, b: ChartPrefs): boolean =>
  a.style === b.style && a.metric === b.metric && a.hidden.join() === b.hidden.join()

function save(next: ChartPrefs): void {
  if (same(next, prefs)) return
  prefs = next
  try {
    localStorage.setItem(CHART_KEY, JSON.stringify(prefs))
  } catch {
    /* 存储不可用时，本次仍然可切换。 */
  }
  listeners.forEach(listener => listener())
}

export function setChartMetric(metric: UsageMetric): void {
  save(parseChartPrefs({ ...prefs, metric }))
}

export function setChartStyle(style: ChartStyle): void {
  save(parseChartPrefs({ ...prefs, style }))
}

/** 图例开关：最后一个显示的系列关不掉 */
export function toggleSeries(key: SeriesKey): void {
  const hidden = prefs.hidden.includes(key) ? prefs.hidden.filter(k => k !== key) : [...prefs.hidden, key]
  if (hidden.length >= SERIES_KEYS.length) return
  save(parseChartPrefs({ ...prefs, hidden }))
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== localStorage || (event.key !== CHART_KEY && event.key !== null)) return
  const next = read()
  if (same(next, prefs)) return
  prefs = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}

export function useChartPrefs(): ChartPrefs {
  return useSyncExternalStore(
    subscribe,
    () => prefs,
    () => DEFAULT_CHART,
  )
}

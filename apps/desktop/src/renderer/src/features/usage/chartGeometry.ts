// 用量图表两种样式共用的纯函数：系列、纵轴取整、横向位置、节点收起（docs/ui/usage-chart-style.md §3）。
import { cacheHitRate, outputSpeed, totalTokens } from './aggregate'
import type { UsageBucket } from './types'

/** 图表和热力图看什么（docs/ui/usage-learn.md §1）；speed 账号调用没有按天的数据 */
export const USAGE_METRICS = ['tokens', 'turns', 'cost', 'hit', 'speed'] as const
export type UsageMetric = (typeof USAGE_METRICS)[number]

/** 一格的数值；这一格没有这个数（不知道，不是 0）时为 null */
export function metricValue(metric: UsageMetric, b: UsageBucket): number | null {
  if (metric === 'tokens') return totalTokens(b)
  if (metric === 'turns') return b.turns
  if (metric === 'cost') return b.records > 0 && b.costKnown === 0 ? null : b.costUsd
  return metric === 'hit' ? cacheHitRate(b) : outputSpeed(b)
}

/** 画一条线（或柱子的一段）要的东西 */
export interface PlotSeries {
  key: string
  color: string
  value: (b: UsageBucket) => number | null
}

/** 三个系列（颜色已用 dataviz 校验脚本验证，见 tokens.css --chart-*）。输入含缓存写 */
export const SERIES_KEYS = ['input', 'cache', 'output'] as const
export type SeriesKey = (typeof SERIES_KEYS)[number]

export const SERIES_VALUE: Record<SeriesKey, (b: UsageBucket) => number> = {
  input: b => b.input + b.cacheWrite,
  cache: b => b.cacheRead,
  output: b => b.output,
}

export const SERIES_COLOR: Record<SeriesKey, string> = {
  input: 'var(--chart-input)',
  cache: 'var(--chart-cache)',
  output: 'var(--chart-output)',
}

/** 两点之间少于这么多像素时，平时不画节点（只画悬停那一格和最后一格） */
export const NODE_MIN_SPACING = 12

/**
 * 纵轴最大值取整到 1 / 2 / 4 / 5 / 10 × 10^k，一半处也是整数（0、一半、最大三条网格线）。
 * 没有用量时返回 0。
 */
export function niceMax(max: number): number {
  if (!(max > 0)) return 0
  const exp = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 4, 5, 10]) if (m * exp >= max) return m * exp
  return 10 * exp
}

/** 第 i 格的中心（像素）：每格等宽，和柱子、横轴刻度对齐 */
export function columnCenter(i: number, count: number, width: number): number {
  return ((i + 0.5) / count) * width
}

/** 横坐标落在哪一格（整列都是热区），超出两边取最近的一格 */
export function nearestColumn(x: number, count: number, width: number): number {
  if (count <= 0 || width <= 0) return 0
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)))
}

export function showAllNodes(count: number, width: number): boolean {
  return count <= 1 || width / count >= NODE_MIN_SPACING
}

/** 折线图：每格每个显示系列的值，取它们的最大值做纵轴 */
export function lineMax(buckets: UsageBucket[], keys: readonly SeriesKey[]): number {
  let max = 0
  for (const b of buckets) for (const k of keys) max = Math.max(max, SERIES_VALUE[k](b))
  return max
}

/** 柱状图：每格显示系列的和（堆叠高度），取最大值做纵轴 */
export function stackMax(buckets: UsageBucket[], keys: readonly SeriesKey[]): number {
  let max = 0
  for (const b of buckets)
    max = Math.max(
      max,
      keys.reduce((sum, k) => sum + SERIES_VALUE[k](b), 0),
    )
  return max
}

/** 柱状图用的颜色：参考图那样同一冷色系、三档明暗（主体缓存读最深、输入居中、输出最浅压在顶上）。tokens.css --chart-bar-* */
export const BAR_COLOR: Record<SeriesKey, string> = {
  input: 'var(--chart-bar-input)',
  cache: 'var(--chart-bar-cache)',
  output: 'var(--chart-bar-output)',
}

/** 一格里柱子的位置：柱间留柱宽约 15%（至少 1px），太宽时最多 36px、居中 */
export function barGeometry(count: number, width: number): { slot: number; bar: number; offset: number } {
  const slot = count > 0 ? width / count : 0
  const bar = Math.max(1, Math.min(36, slot - Math.max(1, slot * 0.15)))
  return { slot, bar, offset: (slot - bar) / 2 }
}

/**
 * 横轴标哪几格：从最后一格（今天 / 现在）往前每隔 step 格标一个，step 取能让标签之间至少 minGap 像素的最小值；
 * 小时用 1 / 2 / 3 / 6 / 12，天用 1 / 2 / 5 / 7 / 14 / 30。最左边离下一个标签够远时也标上起始日期
 */
export function axisTicks(count: number, width: number, bucket: 'hour' | 'day', minGap = 72): number[] {
  if (count <= 0) return []
  if (count === 1) return [0]
  const slot = width / count
  const steps = bucket === 'hour' ? [1, 2, 3, 6, 12] : [1, 2, 5, 7, 14, 30]
  const step = steps.find(s => s * slot >= minGap) ?? steps.at(-1)!
  const ticks: number[] = []
  for (let i = count - 1; i >= 0; i -= step) ticks.unshift(i)
  // 最左边也标上起始日期，离下一个标签够远才标
  if (ticks[0] !== 0 && ticks[0] * slot >= minGap * 0.8) ticks.unshift(0)
  return ticks
}

export interface Point {
  x: number
  y: number
}

/**
 * 单调三次曲线（Fritsch–Carlson，和 d3 的 curveMonotoneX 一样）：经过每个点，两点之间不会冲过这两点的值
 * （不会画到 0 以下、不会把峰值画高），升的一段一直升、降的一段一直降。返回每一段的三次贝塞尔控制点
 */
export function monotoneSegments(points: Point[]): Array<{ from: Point; c1: Point; c2: Point; to: Point }> {
  const n = points.length
  if (n < 2) return []
  const dx: number[] = [],
    slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x)
    slope.push(dx[i] === 0 ? 0 : (points[i + 1].y - points[i].y) / dx[i])
  }
  // 每个点的切线：两边斜率同号时取调和平均，异号或有一边平时为 0（峰、谷处切线水平，所以不会冲过头）
  const tangent: number[] = points.map((_, i) => {
    if (i === 0) return slope[0]
    if (i === n - 1) return slope[n - 2]
    const a = slope[i - 1],
      b = slope[i]
    if (a * b <= 0) return 0
    return (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / a + (dx[i] + 2 * dx[i - 1]) / b)
  })
  // 两端用单边的斜率时也要限住，免得第一 / 最后一段冲过头
  for (const i of [0, n - 1]) {
    const s = slope[i === 0 ? 0 : n - 2]
    if (s === 0 || Math.sign(tangent[i]) !== Math.sign(s)) tangent[i] = 0
    else tangent[i] = Math.sign(s) * Math.min(Math.abs(tangent[i]), 3 * Math.abs(s))
  }
  return slope.map((_, i) => {
    const h = dx[i] / 3,
      from = points[i],
      to = points[i + 1]
    return {
      from,
      c1: { x: from.x + h, y: from.y + tangent[i] * h },
      c2: { x: to.x - h, y: to.y - tangent[i + 1] * h },
      to,
    }
  })
}

const f = (v: number): string => v.toFixed(1)

/** 一串曲线段 → SVG path 的 d（第一段带 M） */
export function segmentsPath(segments: ReturnType<typeof monotoneSegments>): string {
  if (!segments.length) return ''
  return (
    `M${f(segments[0].from.x)},${f(segments[0].from.y)}` +
    segments.map(s => `C${f(s.c1.x)},${f(s.c1.y)} ${f(s.c2.x)},${f(s.c2.y)} ${f(s.to.x)},${f(s.to.y)}`).join('')
  )
}

// 热力图的纯函数（docs/ui/usage-learn.md §2）：分档、月份标签。周一开头，一列 7 格。
import type { UsageBucket } from './types'

/** 一格的深浅：0 = 没有数据，1～4 按有数据的日子的四分位分档（有一天特别多时其余不至于全贴底） */
export function heatLevels(values: Array<number | null>): number[] {
  const sorted = values.filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b)
  const quantile = (p: number) => sorted[Math.floor((sorted.length - 1) * p)]
  const cuts = sorted.length ? [quantile(0.25), quantile(0.5), quantile(0.75)] : []
  return values.map(v => (v === null || v <= 0 ? 0 : 1 + cuts.filter(c => v > c).length))
}

/** 每一列的月份标签：一列里有 1 号就标；第一列太靠近下一个标签时不标 */
export function monthLabels(days: UsageBucket[], format: (start: number) => string): Array<string | null> {
  const columns = Math.ceil(days.length / 7)
  const labels: Array<string | null> = new Array(columns).fill(null)
  days.forEach((d, i) => {
    if (new Date(d.start).getDate() === 1) labels[Math.floor(i / 7)] = format(d.start)
  })
  if (days.length && !labels.slice(0, 3).some(Boolean)) labels[0] = format(days[0].start)
  return labels
}

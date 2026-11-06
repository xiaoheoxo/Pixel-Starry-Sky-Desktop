import { useId } from 'react'
import type { UsageBucket } from '@/features/usage/types'
import {
  columnCenter,
  monotoneSegments,
  segmentsPath,
  showAllNodes,
  type PlotSeries,
} from '@/features/usage/chartGeometry'

/** 曲线下的渐变填充：顶上这么不透明，到底边变成 0 */
const FILL_OPACITY = 0.1

/**
 * 折线节点图（docs/ui/usage-chart-style.md §3.2、§8）：每个显示的系列一条 2px 单调三次曲线（经过每个点、
 * 两点之间不冲过真实值），下面一层很淡的渐变填充，不堆叠。
 * 节点 8px、外圈 2px 卡片底色；两点太近时平时只画最后一格和悬停那一格。
 * 最后一格还在累积：最后一段虚线、节点空心。
 * 某一格没有这个数（费用不知道、没量到速度）：线从两边接过去，这一格不画节点。
 */
export function LinePlot({
  buckets,
  series,
  scale,
  width,
  height,
  hover,
}: {
  buckets: UsageBucket[]
  series: readonly PlotSeries[]
  /** 纵轴最大值（niceMax 之后），0 表示没有用量 */
  scale: number
  width: number
  height: number
  hover: number | null
}) {
  // useId 带冒号，放进 url(#…) 前去掉
  const id = 'usage-fill' + useId().replace(/[^\w-]/g, '')
  if (width <= 0 || !buckets.length) return null
  const n = buckets.length
  const last = n - 1
  const x = (i: number) => columnCenter(i, n, width)
  const y = (v: number) => (scale > 0 ? height - (v / scale) * height : height)
  const allNodes = showAllNodes(n, width)
  const points = (s: PlotSeries) =>
    buckets.flatMap((b, i) => {
      const v = s.value(b)
      return v === null ? [] : [{ x: x(i), y: y(v) }]
    })
  const gradient = (key: string) => `${id}-${key}`

  return (
    <svg aria-hidden width={width} height={height} className="absolute inset-0 overflow-visible">
      <defs>
        {series.map(s => (
          <linearGradient key={s.key} id={gradient(s.key)} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity={FILL_OPACITY} />
            <stop offset="100%" stopColor={s.color} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>
      {hover !== null && (
        <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} stroke="var(--border-strong)" strokeWidth={1} />
      )}
      {/* 先画所有填充，再画线：线不会被别的系列的填充盖住 */}
      {series.map(s => {
        const pts = points(s)
        if (pts.length < 2) return null
        const line = segmentsPath(monotoneSegments(pts))
        return (
          <path
            key={`fill-${s.key}`}
            d={`${line}L${pts[pts.length - 1].x.toFixed(1)},${height}L${pts[0].x.toFixed(1)},${height}Z`}
            fill={`url(#${gradient(s.key)})`}
            stroke="none"
          />
        )
      })}
      {series.map(s => {
        const pts = points(s)
        if (pts.length < 2) return null
        const segments = monotoneSegments(pts)
        // 最后一格有数才是「还在累积」的虚线
        const solid = s.value(buckets[last]) === null ? segments.length : segments.length - 1
        return (
          <g key={s.key} stroke={s.color} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
            {solid > 0 && <path d={segmentsPath(segments.slice(0, solid))} />}
            {solid < segments.length && <path d={segmentsPath(segments.slice(solid))} strokeDasharray="4 3" />}
          </g>
        )
      })}
      {series.map(s =>
        buckets.map((b, i) => {
          const active = hover === i
          const v = s.value(b)
          if (v === null || (!allNodes && !active && i !== last)) return null
          const cx = x(i),
            cy = y(v)
          return i === last && !active ? (
            // 进行中的一格：空心节点
            <circle
              key={`${s.key}-${i}`}
              cx={cx}
              cy={cy}
              r={3.5}
              fill="var(--bg-surface)"
              stroke={s.color}
              strokeWidth={2}
            />
          ) : (
            <circle
              key={`${s.key}-${i}`}
              cx={cx}
              cy={cy}
              r={active ? 5 : 4}
              fill={s.color}
              stroke="var(--bg-surface)"
              strokeWidth={2}
            />
          )
        }),
      )}
    </svg>
  )
}

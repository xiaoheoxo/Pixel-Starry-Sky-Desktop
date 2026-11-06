import { useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, getLocale } from '../../../i18n/core'
import { HEATMAP_WEEKS } from '@pixelsky/protocol'
import { cacheHitRate, emptyTotals, mergeTotals, outputSpeed, totalTokens } from '@/features/usage/aggregate'
import { metricValue, type UsageMetric } from '@/features/usage/chartGeometry'
import { formatPercent, formatShortCost, formatTokens } from '@/features/usage/format'
import { heatLevels, monthLabels } from '@/features/usage/heatmap'
import type { UsageBucket } from '@/features/usage/types'
import { formatMetric, metricLabel } from './UsageChart'

const LEVEL_BG = [
  'var(--bg-subtle)',
  'color-mix(in srgb, var(--chart-output) 28%, var(--bg-surface))',
  'color-mix(in srgb, var(--chart-output) 52%, var(--bg-surface))',
  'color-mix(in srgb, var(--chart-output) 76%, var(--bg-surface))',
  'var(--chart-output)',
]

const GRID_COLUMNS = { gridTemplateColumns: `repeat(${HEATMAP_WEEKS}, minmax(0, 1fr))` }

/**
 * 每天用量（docs/ui/usage-learn.md §2）：最近 53 周，一列一周、周一开头，单色四档；悬停看当天。
 * 本机记录的旧日子是空的：记录以前只留 90 天，速度从这个版本才开始记。
 */
export function UsageHeatmap({
  days,
  metric,
  account = false,
}: {
  days: UsageBucket[]
  metric: UsageMetric
  account?: boolean
}) {
  useI18n()
  const [hover, setHover] = useState<{ i: number; x: number; y: number; flip: boolean } | null>(null)
  const levels = heatLevels(days.map(d => metricValue(metric, d)))
  const locale = getLocale()
  const months = monthLabels(days, start => new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(start)))
  const sum = emptyTotals()
  for (const d of days) mergeTotals(sum, d)
  const firstUsed = days.findIndex(d => d.records > 0)
  const hint =
    account || firstUsed < 0
      ? null
      : metric === 'speed' && days.some(d => d.records > 0 && outputSpeed(d) === null)
        ? tr('usageColumns.heatSpeed')
        : days.length - firstUsed <= 100
          ? tr('usageColumns.heatRetention')
          : null
  const summary = tr(account ? 'usageColumns.heatSumAccount' : 'usageColumns.heatSum', {
    p0: formatTokens(totalTokens(sum)),
    p1: (account ? sum.requests : sum.turns).toLocaleString('en-US'),
    p2: formatShortCost(sum),
  })
  const shown = hover && days[hover.i]
  // 周一、周三、周五、周日：2024-01-01 是周一
  const weekday = (offset: number) =>
    new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(2024, 0, 1 + offset))

  return (
    <div data-usage-heatmap className="min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-ui font-medium text-fg">{tr('usageColumns.heatTitle')}</h4>
        <span className="text-meta text-fg-muted">
          {tr(account ? 'usageColumns.heatNoteAccount' : 'usageColumns.heatNote')} · {metricLabel(metric, account)}
        </span>
      </div>
      {hint && <p className="mb-2 rounded-md bg-subtle px-2.5 py-1.5 text-meta text-fg-secondary">{hint}</p>}
      <div
        className="relative"
        onMouseMove={e => {
          const index = (e.target as HTMLElement).dataset?.heatDay
          if (index === undefined) return setHover(null)
          const box = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - box.left
          setHover({ i: Number(index), x, y: e.clientY - box.top, flip: x > box.width / 2 })
        }}
        onMouseLeave={() => setHover(null)}
      >
        <div aria-hidden className="mb-1 ml-5 grid h-4 gap-[3px] text-label text-fg-muted" style={GRID_COLUMNS}>
          {months.map((label, i) => (
            <span key={i} className="overflow-visible whitespace-nowrap">
              {label}
            </span>
          ))}
        </div>
        <div className="flex">
          <div aria-hidden className="grid w-5 shrink-0 grid-rows-7 gap-[3px] text-label text-fg-muted">
            {[0, 1, 2, 3, 4, 5, 6].map(i => (
              <span key={i} className="flex items-center leading-none">
                {i % 2 === 0 ? weekday(i) : ''}
              </span>
            ))}
          </div>
          <div
            role="img"
            aria-label={`${tr('usageColumns.heatTitle')}，${summary}`}
            className="grid flex-1 grid-flow-col grid-rows-7 gap-[3px]"
            style={GRID_COLUMNS}
          >
            {days.map((d, i) => (
              <i
                key={d.start}
                data-heat-day={i}
                className="aspect-square rounded-[2px]"
                style={{ background: LEVEL_BG[levels[i]] }}
              />
            ))}
          </div>
        </div>
        {shown && hover && (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-line bg-popover px-3 py-2 text-meta whitespace-nowrap shadow-popover"
            style={{
              left: hover.x,
              top: hover.y,
              transform: `translate(${hover.flip ? 'calc(-100% - 12px)' : '12px'}, -100%)`,
            }}
          >
            <div className="mb-1 font-medium text-fg">
              {new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(shown.start))}
            </div>
            {shown.records === 0 ? (
              <div className="text-fg-muted">{tr('usageColumns.heatEmpty')}</div>
            ) : (
              <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
                {[
                  ['Token', formatTokens(totalTokens(shown))],
                  [metricLabel('turns', account), String(shown.turns)],
                  [tr('settings.replyStats.cost'), formatShortCost(shown)],
                  [tr('settings.usage.KpiCards.cacheHit'), formatPercent(cacheHitRate(shown))],
                  ...(account ? [] : [[tr('usageColumns.tokenSpeed'), formatMetric('speed', shown)]]),
                ].map(([name, value]) => (
                  <div key={name} className="contents">
                    <span className="text-fg-muted">{name}</span>
                    <span className="text-right text-fg tabular-nums">{value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-meta text-fg-muted tabular-nums">
        <span>{summary}</span>
        <span aria-hidden className="inline-flex items-center gap-[3px]">
          {tr('usageColumns.heatLess')}
          {LEVEL_BG.map(bg => (
            <i key={bg} className="size-2.5 rounded-[2px]" style={{ background: bg }} />
          ))}
          {tr('usageColumns.heatMore')}
        </span>
      </div>
    </div>
  )
}

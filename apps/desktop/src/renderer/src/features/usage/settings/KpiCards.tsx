import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cacheHitRate, outputSpeed, totalTokens } from '@/features/usage/aggregate'
import {
  costSubtitle,
  formatCardCost,
  formatDelta,
  formatPercent,
  formatTokens,
  formatTotalCost,
} from '@/features/usage/format'
import type { UsageGroupRow, UsageTotals } from '@/features/usage/types'

/**
 * 4 个统计卡：调用轮次、Token、缓存命中、费用；都和上一个同样长度的时间段比较。
 * 账号调用（account）没有轮次，第一张卡改成调用次数，副标题是用到的模型数。
 * 有没有费用的记录时，费用卡副标题「N 条没有费用 ›」可以点：只看这些记录、分布表按原因分开（docs/ui/usage.md §12）。
 */
export function KpiCards({
  totals,
  prev,
  account,
  routes,
  onShowMissing,
}: {
  totals: UsageTotals
  prev: UsageTotals
  account?: { models: number }
  /** 按线路的分组：有费用的全是自定义 API 时，副标题写「按官方模型定价估算」而不是「引擎报告的估算值」 */
  routes?: UsageGroupRow[]
  onShowMissing?: () => void
}) {
  useI18n()
  const hit = cacheHitRate(totals)
  const prevHit = cacheHitRate(prev)
  const hitDelta = hit !== null && prevHit !== null ? Math.round((hit - prevHit) * 100) : null
  const missingCost = totals.records - totals.costKnown
  const costSub = costSubtitle(totals, routes)
  const [more, setMore] = useState(false)
  const speed = outputSpeed(totals)
  const MoreIcon = more ? ChevronUp : ChevronDown

  return (
    <div>
      <div className="grid grid-cols-4 gap-3 @max-[700px]:grid-cols-2">
        {account ? (
          <Card
            label={tr('settings.usage.KpiCards.accountRequests')}
            value={`${totals.requests}`}
            unit={tr('settings.usage.KpiCards.callsUnit')}
            sub={tr('settings.usage.KpiCards.models', { p0: account.models })}
            delta={formatDelta(totals.requests, prev.requests)}
          />
        ) : (
          <Card
            label={tr('settings.usage.KpiCards.conversationTurns')}
            value={`${totals.turns}`}
            unit={tr('settings.usage.KpiCards.turns')}
            sub={tr('settings.usage.KpiCards.requests', { p0: totals.requests })}
            delta={formatDelta(totals.turns, prev.turns)}
          />
        )}
        <Card
          label="Token"
          value={formatTokens(totalTokens(totals))}
          sub={tr('settings.usage.KpiCards.inputOutput', {
            p0: formatTokens(totals.input + totals.cacheRead + totals.cacheWrite),
            p1: formatTokens(totals.output),
          })}
          delta={formatDelta(totalTokens(totals), totalTokens(prev))}
        />
        <Card
          label={tr('settings.usage.KpiCards.cacheHit')}
          value={formatPercent(hit)}
          sub={tr('settings.usage.KpiCards.cacheRead', { p0: formatTokens(totals.cacheRead) })}
          delta={
            hitDelta === null
              ? null
              : {
                  text:
                    hitDelta === 0
                      ? tr('settings.usage.KpiCards.unchanged')
                      : `${hitDelta > 0 ? '▲' : '▼'}${Math.abs(hitDelta)}pt`,
                  up: hitDelta >= 0,
                }
          }
        />
        <Card
          label={tr('settings.replyStats.cost')}
          value={formatCardCost(totals)}
          valueTitle={formatTotalCost(totals)}
          sub={
            costSub === 'missing'
              ? tr('settings.usage.KpiCards.missingCost', { p0: missingCost })
              : costSub === 'actual'
                ? tr('billing.actual')
                : costSub === 'official'
                  ? tr('customApi.costEstimateShort')
                  : tr('settings.usage.KpiCards.estimateReportedByEngine')
          }
          onSub={costSub === 'missing' ? onShowMissing : undefined}
          subTitle={tr('usageCost.kpiMissingTitle')}
          delta={totals.costKnown > 0 && prev.costKnown > 0 ? formatDelta(totals.costUsd, prev.costUsd) : null}
        />
      </div>
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore(v => !v)}
          className="inline-flex items-center gap-0.5 text-meta text-fg-muted hover:text-fg"
        >
          {tr(more ? 'usageColumns.less' : 'usageColumns.more')}
          <MoreIcon size={12} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
      {more && (
        <div className="mt-1.5 grid grid-cols-5 gap-3 rounded-lg border border-line bg-surface px-3.5 py-2.5 @max-[700px]:grid-cols-3">
          {[
            [tr('usageColumns.freshInput'), formatTokens(totals.input)],
            [tr('session.live.SessionStrips.output'), formatTokens(totals.output)],
            [tr('session.turnStatsData.cacheWrite'), formatTokens(totals.cacheWrite)],
            [tr('session.turnStatsData.cacheRead'), formatTokens(totals.cacheRead)],
            [tr('usageColumns.tokenSpeed'), speed === null ? '—' : `${Math.round(speed)} tok/s`],
          ].map(([name, value]) => (
            <div key={name} className="min-w-0 text-meta text-fg-muted">
              <div className="truncate">{name}</div>
              <div className="mt-0.5 truncate text-ui font-medium text-fg tabular-nums">{value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Card({
  label,
  value,
  valueTitle,
  unit,
  sub,
  delta,
  onSub,
  subTitle,
}: {
  label: string
  value: string
  /** 大数字的悬停提示（费用卡放完整金额） */
  valueTitle?: string
  unit?: string
  sub: string
  delta: { text: string; up: boolean } | null
  /** 副标题可以点（没有费用的记录 → 只看这些） */
  onSub?: () => void
  subTitle?: string
}) {
  useI18n()
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2 text-meta text-fg-muted">
        <span className="truncate">{label}</span>
        {delta && (
          <span className="shrink-0 tabular-nums" title={tr('settings.usage.KpiCards.comparedWithPreviousPeriod')}>
            {delta.text}
          </span>
        )}
      </div>
      <div
        className="mt-1 truncate text-[calc(22px*var(--font-scale,1))] leading-tight font-semibold text-fg tabular-nums"
        title={valueTitle !== value ? valueTitle : undefined}
      >
        {value}
        {unit && <span className="ml-1 text-meta font-normal text-fg-muted">{unit}</span>}
      </div>
      {onSub ? (
        <button
          type="button"
          onClick={onSub}
          title={subTitle}
          className="mt-1 block max-w-full truncate text-left text-meta text-fg-muted tabular-nums hover:text-fg"
        >
          {sub} ›
        </button>
      ) : (
        <div className="mt-1 truncate text-meta text-fg-muted tabular-nums" title={sub}>
          {sub}
        </div>
      )}
    </div>
  )
}

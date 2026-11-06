import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { Segmented, type SegmentedOption } from '@/ui'
import { averageFirstToken, cacheHitRate, outputSpeed, successRate, totalTokens } from '@/features/usage/aggregate'
import {
  DIMENSION_LABEL,
  costHint,
  dimLabel,
  formatCount,
  formatFirstToken,
  formatPercent,
  formatShortCost,
  formatTokens,
  formatTotalCost,
  shortId,
} from '@/features/usage/format'
import { COST_CELL_CLASS, CostCell, SpeedCell, UsageGrid, type UsageColumn } from './UsageTable'
import { isLive } from '@/features/engine/hooks'
import { sessionExists } from '@/features/engine/openRequests'
import { useEngineState } from '@/features/engine/store'
import type { UsageDimension, UsageGroupRow } from '@/features/usage/types'

const DIM_OPTIONS: Array<SegmentedOption<UsageDimension>> = (
  ['model', 'project', 'engine', 'route', 'cost', 'session'] as const
).map(d => ({
  value: d,
  get label() {
    return DIMENSION_LABEL[d]
  },
}))

/**
 * 分布表：按模型 / 项目 / 引擎 / 线路 / 费用情况切换；点一行把它加为筛选条件。
 * 按费用情况时每行是一种原因，悬停看说明；别的维度里有没有费用的记录时，费用格悬停提示去哪看原因（GitHub #22）。
 * 按会话（docs/ui/usage.md §13）：名称格显示会话标题 + 项目，会话已删除时显示「已删除的会话」和短 ID；最后一行可能是「其余 N 个会话」，不能点。
 * 账号调用（account）只有按模型一个维度，不显示切换；轮次换成请求数，没有成功率（账本基本只记成功的）。
 * 列和明细表一样（docs/ui/usage-learn.md §1.2）：Token 合计放到悬停占比，平均费用放到悬停费用。
 */
export function Distribution({
  dim,
  onDim,
  rows,
  activeKey,
  onPick,
  account = false,
}: {
  dim: UsageDimension
  onDim: (d: UsageDimension) => void
  account?: boolean
  rows: UsageGroupRow[]
  /** 这个维度当前的筛选值（有筛选时只剩这一行） */
  activeKey: string | undefined
  onPick: (key: string) => void
}) {
  useI18n()
  const sessions = useEngineState(s => s.sessions) // 会话增删时重新判断「已删除」
  const sum = rows.reduce((s, r) => s + totalTokens(r), 0)
  const session = dim === 'session'
  // 会话列表还没读到（或演示模式的假数据）时不判断，免得全部显示成已删除
  const gone = (r: UsageGroupRow) =>
    session && isLive && sessions.length > 0 && r.sessionId !== undefined && !sessionExists(r.sessionId)
  const nameOf = (r: UsageGroupRow) =>
    r.others
      ? tr('settings.usage.Distribution.otherSessions', { p0: r.others })
      : session
        ? gone(r)
          ? tr('settings.usage.Distribution.deletedSession')
          : r.title || tr('settings.usage.RecordsTable.untitledConversation')
        : dimLabel(dim, r.key)
  const subOf = (r: UsageGroupRow) =>
    session && !r.others ? [r.project, shortId(r.sessionId ?? r.key)].filter(Boolean).join(' · ') : ''
  const tokens = tr('usageColumns.groupTokens')
  const costs = tr('usageColumns.groupCost')
  const performance = tr('usageColumns.groupPerformance')
  const columns: Array<UsageColumn<UsageGroupRow>> = [
    {
      key: 'name',
      fill: true,
      label: DIMENSION_LABEL[dim],
      cellClass: () => 'text-fg',
      title: r =>
        dim === 'cost' ? costHint(r.key) : session ? [r.title, subOf(r)].filter(Boolean).join(' · ') : nameOf(r),
      render: r => (
        <>
          {nameOf(r)}
          {subOf(r) && <div className="truncate text-meta text-fg-faint">{subOf(r)}</div>}
        </>
      ),
    },
    {
      key: 'share',
      label: tr('settings.usage.Distribution.share'),
      hideBelow: 36,
      title: r => tr('usageColumns.tokenTotal', { p0: formatTokens(totalTokens(r)) }),
      render: r => {
        const share = sum > 0 ? totalTokens(r) / sum : 0
        return (
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-[4em] overflow-hidden rounded-full bg-subtle @max-[62em]:hidden">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share * 100)}%` }} />
            </div>
            <span className="text-meta text-fg-muted">{Math.round(share * 100)}%</span>
          </div>
        )
      },
    },
    {
      key: 'input',
      group: tokens,
      label: tr('usageColumns.freshInput'),
      help: tr('usageColumns.freshInputHelp'),
      align: 'right',
      render: r => formatCount(r.input),
    },
    {
      key: 'output',
      group: tokens,
      label: tr('session.live.SessionStrips.output'),
      align: 'right',
      render: r => formatCount(r.output),
    },
    {
      key: 'cache',
      group: tokens,
      label: tr('usageColumns.cacheHit'),
      help: tr('usageColumns.cacheHitHelp'),
      align: 'right',
      hideBelow: 58,
      title: r => tr('usageColumns.hitRate', { p0: formatPercent(cacheHitRate(r)) }),
      render: r => formatCount(r.cacheRead),
    },
    {
      key: 'cost',
      group: costs,
      label: account ? tr('settings.usage.RemoteCallsTable.charge') : tr('settings.replyStats.cost'),
      align: 'right',
      cellClass: () => COST_CELL_CLASS,
      title: r => {
        const count = account ? r.requests : r.turns
        const average = r.costKnown > 0 && count > 0 ? r.costUsd / count : null
        return [
          formatTotalCost(r),
          average !== null &&
            tr(account ? 'usageColumns.avgCall' : 'usageColumns.avgTurn', {
              p0: `${average.toFixed(average < 0.01 ? 4 : 2)}`,
            }),
          dim !== 'cost' &&
            r.costKnown < r.records &&
            tr('settings.usage.Distribution.missingCost', { p0: r.records - r.costKnown }),
        ]
          .filter(Boolean)
          .join('\n')
      },
      render: r => <CostCell text={formatShortCost(r)} />,
    },
    {
      key: 'count',
      group: costs,
      label: account ? tr('settings.usage.Distribution.requests') : tr('settings.usage.Distribution.turns'),
      align: 'right',
      hideBelow: 40,
      render: r => (account ? r.requests : r.turns),
    },
    ...(account
      ? []
      : [
          {
            key: 'success',
            group: costs,
            label: tr('usageColumns.success'),
            help: tr('usageColumns.successHelp'),
            align: 'right',
            hideBelow: 44,
            cellClass: r => {
              const success = successRate(r)
              return success !== null && success < 0.95 ? 'text-danger' : 'text-fg-secondary'
            },
            render: r => {
              const success = successRate(r)
              return success === null ? '—' : `${(success * 100).toFixed(1)}%`
            },
          } satisfies UsageColumn<UsageGroupRow>,
        ]),
    {
      key: 'speed',
      group: performance,
      label: tr('usageColumns.speed'),
      help: account
        ? `${tr('usageColumns.speedHelp')} ${tr('usageColumns.sampleNote')}`
        : tr('usageColumns.speedHelpLocal'),
      align: 'right',
      hideBelow: 50,
      render: r => <SpeedCell speed={outputSpeed(r)} />,
    },
    {
      key: 'first',
      group: performance,
      label: tr('settings.usage.RemoteCallsTable.firstToken'),
      help: account
        ? `${tr('usageColumns.firstTokenHelp')} ${tr('usageColumns.sampleNote')}`
        : tr('usageColumns.firstTokenHelpLocal'),
      align: 'right',
      hideBelow: 70,
      cellClass: () => 'text-fg-muted',
      render: r => formatFirstToken(averageFirstToken(r)),
    },
  ]
  return (
    // 容器查询的 em 按这里的字号算，和表格一样
    <div className="@container min-w-0 text-list">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-ui font-medium text-fg">{tr('settings.usage.Distribution.distribution')}</h4>
        {!account && (
          <Segmented
            label={tr('settings.usage.Distribution.distributionDimension')}
            options={DIM_OPTIONS}
            value={dim}
            onChange={onDim}
          />
        )}
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-meta text-fg-faint">{tr('settings.usage.Distribution.noData')}</p>
      ) : (
        <UsageGrid
          columns={columns}
          rows={rows}
          rowKey={r => r.key}
          rowProps={r => {
            const pickable = !(dim === 'session' && r.others)
            const active = activeKey === r.key
            return {
              onClick: () => pickable && !active && onPick(r.key),
              title: !pickable
                ? undefined
                : active
                  ? tr('settings.usage.Distribution.filteredByThisItem')
                  : tr('settings.usage.Distribution.clickToFilterBy'),
              className: pickable ? 'hover:bg-selected' : undefined,
            }
          }}
        />
      )}
    </div>
  )
}

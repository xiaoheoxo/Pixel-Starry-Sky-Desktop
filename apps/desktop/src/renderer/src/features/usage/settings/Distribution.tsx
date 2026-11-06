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
import { HelpMark, SpeedCell } from './UsageTable'
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
  return (
    // 隐藏条件和列宽都用 em，字号变大时名称列才不会被挤没；容器查询的 em 按这里的字号算，和表格一样
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
        <table className="w-full table-fixed text-list tabular-nums">
          <thead>
            <tr className="text-left text-meta text-fg-muted">
              <th className="pb-2 font-normal">{DIMENSION_LABEL[dim]}</th>
              <th className="w-[5.6em] pb-2 font-normal @max-[53.5em]:w-[3em]">
                {tr('settings.usage.Distribution.share')}
              </th>
              <th className="w-[6em] pb-2 pl-2 text-right font-normal">
                {tr('usageColumns.freshInput')}
                <HelpMark text={tr('usageColumns.freshInputHelp')} />
              </th>
              <th className="w-[4.2em] pb-2 pl-2 text-right font-normal @max-[43.5em]:hidden">
                {tr('session.live.SessionStrips.output')}
              </th>
              <th className="w-[6em] pb-2 pl-2 text-right font-normal @max-[50.2em]:hidden">
                {tr('usageColumns.cacheHit')}
                <HelpMark text={tr('usageColumns.cacheHitHelp')} />
              </th>
              <th className="w-[5.4em] pb-2 pl-2 text-right font-normal">
                {account ? tr('settings.usage.RemoteCallsTable.charge') : tr('settings.replyStats.cost')}
              </th>
              <th className="w-[3.4em] pb-2 pl-2 text-right font-normal @max-[43.5em]:hidden">
                {account ? tr('settings.usage.Distribution.requests') : tr('settings.usage.Distribution.turns')}
              </th>
              {!account && (
                <th className="w-[5em] pb-2 pl-2 text-right font-normal @max-[51.8em]:hidden">
                  {tr('usageColumns.success')}
                  <HelpMark text={tr('usageColumns.successHelp')} />
                </th>
              )}
              <th className="w-[6em] pb-2 pl-2 text-right font-normal">
                {tr('usageColumns.speed')}
                <HelpMark
                  text={
                    account
                      ? `${tr('usageColumns.speedHelp')} ${tr('usageColumns.sampleNote')}`
                      : tr('usageColumns.speedHelpLocal')
                  }
                />
              </th>
              <th className="w-[4.2em] pb-2 pl-2 text-right font-normal @max-[50.2em]:hidden">
                {tr('settings.usage.RemoteCallsTable.firstToken')}
                <HelpMark
                  text={
                    account
                      ? `${tr('usageColumns.firstTokenHelp')} ${tr('usageColumns.sampleNote')}`
                      : tr('usageColumns.firstTokenHelpLocal')
                  }
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const share = sum > 0 ? totalTokens(r) / sum : 0
              const active = activeKey === r.key
              const session = dim === 'session'
              const pickable = !(session && r.others)
              // 会话列表还没读到（或演示模式的假数据）时不判断，免得全部显示成已删除
              const gone =
                session && isLive && sessions.length > 0 && r.sessionId !== undefined && !sessionExists(r.sessionId)
              const name = r.others
                ? tr('settings.usage.Distribution.otherSessions', { p0: r.others })
                : session
                  ? gone
                    ? tr('settings.usage.Distribution.deletedSession')
                    : r.title || tr('settings.usage.RecordsTable.untitledConversation')
                  : dimLabel(dim, r.key)
              const sub =
                session && !r.others ? [r.project, shortId(r.sessionId ?? r.key)].filter(Boolean).join(' · ') : ''
              const success = successRate(r)
              const count = account ? r.requests : r.turns
              const average = r.costKnown > 0 && count > 0 ? r.costUsd / count : null
              return (
                <tr
                  key={r.key}
                  onClick={() => pickable && !active && onPick(r.key)}
                  title={
                    !pickable
                      ? undefined
                      : active
                        ? tr('settings.usage.Distribution.filteredByThisItem')
                        : tr('settings.usage.Distribution.clickToFilterBy')
                  }
                  className={`cursor-default border-t border-line-subtle ${pickable ? 'hover:bg-hover' : ''}`}
                >
                  <td
                    className="truncate py-2 pr-3 text-fg"
                    title={
                      dim === 'cost' ? costHint(r.key) : session ? [r.title, sub].filter(Boolean).join(' · ') : name
                    }
                  >
                    {name}
                    {sub && <div className="truncate text-meta text-fg-faint">{sub}</div>}
                  </td>
                  <td className="py-2 pr-2" title={tr('usageColumns.tokenTotal', { p0: formatTokens(totalTokens(r)) })}>
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle @max-[53.5em]:hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.max(2, share * 100)}%` }}
                        />
                      </div>
                      <span className="w-[2.4em] shrink-0 text-right text-meta text-fg-muted">
                        {Math.round(share * 100)}%
                      </span>
                    </div>
                  </td>
                  <td className="truncate py-2 pl-2 text-right text-fg-secondary">{formatCount(r.input)}</td>
                  <td className="truncate py-2 pl-2 text-right text-fg-secondary @max-[43.5em]:hidden">
                    {formatCount(r.output)}
                  </td>
                  <td
                    className="truncate py-2 pl-2 text-right text-fg-secondary @max-[50.2em]:hidden"
                    title={tr('usageColumns.hitRate', { p0: formatPercent(cacheHitRate(r)) })}
                  >
                    {formatCount(r.cacheRead)}
                  </td>
                  <td
                    className="truncate py-2 pl-2 text-right text-fg-secondary"
                    title={[
                      formatTotalCost(r),
                      average !== null &&
                        tr(account ? 'usageColumns.avgCall' : 'usageColumns.avgTurn', {
                          p0: `$${average.toFixed(average < 0.01 ? 4 : 2)}`,
                        }),
                      dim !== 'cost' &&
                        r.costKnown < r.records &&
                        tr('settings.usage.Distribution.missingCost', { p0: r.records - r.costKnown }),
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  >
                    {formatShortCost(r)}
                  </td>
                  <td className="truncate py-2 pl-2 text-right text-fg-secondary @max-[43.5em]:hidden">{count}</td>
                  {!account && (
                    <td
                      className={`truncate py-2 pl-2 text-right @max-[51.8em]:hidden ${success !== null && success < 0.95 ? 'text-danger' : 'text-fg-secondary'}`}
                    >
                      {success === null ? '—' : `${(success * 100).toFixed(1)}%`}
                    </td>
                  )}
                  <td className="truncate py-2 pl-2 text-right text-fg-secondary">
                    <SpeedCell speed={outputSpeed(r)} />
                  </td>
                  <td className="truncate py-2 pl-2 text-right text-fg-muted @max-[50.2em]:hidden">
                    {formatFirstToken(averageFirstToken(r))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

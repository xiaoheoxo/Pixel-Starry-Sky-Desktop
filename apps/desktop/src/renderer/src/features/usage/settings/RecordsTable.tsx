import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/ui'
import { cacheHitRate, costState, outputSpeed } from '@/features/usage/aggregate'
import {
  costHint,
  dimLabel,
  formatCount,
  formatDuration,
  formatFirstToken,
  formatPercent,
  formatRecordCost,
  formatTime,
  formatTokens,
} from '@/features/usage/format'
import type { UsagePage, UsageRecord } from '@/features/usage/types'
import {
  COST_CELL_CLASS,
  CostCell,
  GROUP_GAP_WITHOUT_SPEED,
  ModelCell,
  ResultCell,
  SpeedCell,
  TimeCell,
  UsageDetailCard,
  UsageTable,
  type UsageColumn,
} from './UsageTable'

const OUTCOME: Record<UsageRecord['outcome'], { text: string; cls: string; dot: string }> = {
  completed: {
    get text() {
      return tr('settings.usage.RecordsTable.completed')
    },
    cls: 'text-fg-muted',
    dot: 'bg-success',
  },
  interrupted: {
    get text() {
      return tr('settings.usage.RecordsTable.interrupted')
    },
    cls: 'text-warn',
    dot: 'bg-warn',
  },
  failed: {
    get text() {
      return tr('session.live.agentTrace.failed')
    },
    cls: 'text-danger',
    dot: 'bg-danger',
  },
}

/**
 * 和账号调用表同样的列（docs/ui/usage-learn.md §6）：时间 · 模型和会话 · 新增输入 · 输出 · 缓存命中 · 费用 · 速度 · 首字 · 耗时 · 结果。
 * 窄时隐藏的时间、新增输入、缓存命中、速度、首字在点开的详情里还有；耗时和结果一直显示，详情里就不重复了。
 */
export const COLUMNS: Array<UsageColumn<UsageRecord>> = [
  {
    key: 'time',
    get label() {
      return tr('settings.usage.RecordsTable.time')
    },
    hideBelow: 44,
    render: r => <TimeCell text={formatTime(r.endedAt)} />,
    title: r => new Date(r.endedAt).toLocaleString('zh-CN'),
    cellClass: () => 'text-fg-muted',
  },
  {
    key: 'model',
    fill: true,
    get label() {
      return `${tr('session.ModelSourceMenu.model')} · ${tr('settings.usage.RecordsTable.conversation')}`
    },
    render: r => (
      <ModelCell model={r.model} source={r.sessionTitle || tr('settings.usage.RecordsTable.untitledConversation')} />
    ),
  },
  {
    key: 'input',
    get group() {
      return tr('usageColumns.groupTokens')
    },
    get label() {
      return tr('usageColumns.freshInput')
    },
    get help() {
      return tr('usageColumns.freshInputHelp')
    },
    align: 'right',
    hideBelow: 50,
    render: r => formatCount(r.input),
  },
  {
    key: 'output',
    get group() {
      return tr('usageColumns.groupTokens')
    },
    get label() {
      return tr('session.live.SessionStrips.output')
    },
    align: 'right',
    render: r => formatCount(r.output),
  },
  {
    key: 'cache',
    get group() {
      return tr('usageColumns.groupTokens')
    },
    get label() {
      return tr('usageColumns.cacheHit')
    },
    get help() {
      return tr('usageColumns.cacheHitHelp')
    },
    align: 'right',
    hideBelow: 64,
    render: r => formatCount(r.cacheRead),
    title: r => tr('usageColumns.hitRate', { p0: formatPercent(cacheHitRate(r)) }),
  },
  {
    key: 'cost',
    group: '',
    get label() {
      return tr('settings.replyStats.cost')
    },
    align: 'right',
    render: r => <CostCell text={formatRecordCost(r)} />,
    cellClass: () => COST_CELL_CLASS,
    // 没有费用时悬停说明原因（GitHub #22）
    title: r => (r.costUsd === null ? costHint(costState(r)) : undefined),
  },
  {
    key: 'speed',
    get group() {
      return tr('usageColumns.groupPerformance')
    },
    get label() {
      return tr('usageColumns.speed')
    },
    get help() {
      return tr('usageColumns.speedHelpLocal')
    },
    align: 'right',
    hideBelow: 56,
    render: r => <SpeedCell speed={outputSpeed(r)} />,
  },
  {
    key: 'first',
    get group() {
      return tr('usageColumns.groupPerformance')
    },
    get label() {
      return tr('settings.usage.RemoteCallsTable.firstToken')
    },
    get help() {
      return tr('usageColumns.firstTokenHelpLocal')
    },
    align: 'right',
    hideBelow: 70,
    render: r => formatFirstToken(r.firstTokenMs),
    cellClass: () => 'text-fg-muted',
  },
  {
    key: 'duration',
    get group() {
      return tr('usageColumns.groupPerformance')
    },
    get label() {
      return tr('session.live.AgentTracePanel.duration')
    },
    get help() {
      return tr('usageColumns.durationHelpLocal')
    },
    align: 'right',
    className: GROUP_GAP_WITHOUT_SPEED,
    render: r => formatDuration(r.durationMs),
    title: r => formatDuration(r.durationMs),
    cellClass: () => 'text-fg-muted',
  },
  {
    key: 'result',
    get label() {
      return tr('settings.usage.RecordsTable.outcome')
    },
    align: 'right',
    render: r => <ResultCell text={OUTCOME[r.outcome].text} dot={OUTCOME[r.outcome].dot} />,
    title: r => OUTCOME[r.outcome].text,
    cellClass: r => OUTCOME[r.outcome].cls,
  },
]

/** 本机记录：每一轮 × 每个模型一条，最新在前、分页；点一行展开详情 */
export function RecordsTable({
  page,
  pageSize,
  onPage,
  onOpenSession,
}: {
  page: UsagePage
  pageSize: number
  onPage: (offset: number) => void
  onOpenSession: (sessionId: string) => void
}) {
  useI18n()
  return (
    <UsageTable
      title={tr('settings.usage.RecordsTable.requestRecords')}
      rows={page.records}
      rowKey={r => r.id}
      columns={COLUMNS}
      detail={r => <RecordDetail r={r} onOpenSession={onOpenSession} />}
      offset={page.offset}
      total={page.total}
      pageSize={pageSize}
      onPage={onPage}
    />
  )
}

function RecordDetail({ r, onOpenSession }: { r: UsageRecord; onOpenSession: (id: string) => void }) {
  useI18n()
  return (
    <UsageDetailCard
      fields={[
        [
          tr('settings.usage.RecordsTable.conversation'),
          r.sessionTitle || tr('settings.usage.RecordsTable.untitledConversation'),
        ],
        [tr('sidebar.Sidebar.projects'), dimLabel('project', r.project ?? '')],
        [tr('session.ModelSourceMenu.engine'), dimLabel('engine', r.engine)],
        [tr('session.ModelSourceMenu.route'), dimLabel('route', r.route)],
        [tr('settings.usage.RecordsTable.requestCount'), String(r.requests)],
        [tr('settings.usage.RecordsTable.inputCacheMisses'), formatTokens(r.input)],
        [tr('session.turnStatsData.cacheWrite'), formatTokens(r.cacheWrite)],
        [tr('session.turnStatsData.cacheRead'), formatTokens(r.cacheRead)],
        [tr('session.live.SessionStrips.output'), formatTokens(r.output)],
        [tr('settings.replyStats.cost'), formatRecordCost(r)],
        ...(r.costUsd === null ? [[tr('usageCost.reason'), costHint(costState(r))] as [string, string]] : []),
        [tr('settings.usage.KpiCards.cacheHit'), formatPercent(cacheHitRate(r))],
        [tr('usageColumns.tokenSpeed'), outputSpeed(r) === null ? '—' : `${Math.round(outputSpeed(r) ?? 0)} tok/s`],
        [tr('settings.usage.RemoteCallsTable.firstToken'), formatFirstToken(r.firstTokenMs)],
        [tr('settings.usage.RecordsTable.started'), new Date(r.startedAt).toLocaleString('zh-CN')],
        [tr('settings.usage.RecordsTable.ended'), new Date(r.endedAt).toLocaleString('zh-CN')],
      ]}
      footer={
        <>
          <span className="selectable min-w-0 truncate font-mono text-label text-fg-faint" title={r.id}>
            {r.id}
          </span>
          <Button variant="ghost" icon={ExternalLink} onClick={() => onOpenSession(r.sessionId)}>
            {tr('settings.usage.RecordsTable.openConversation')}{' '}
          </Button>
        </>
      }
    />
  )
}

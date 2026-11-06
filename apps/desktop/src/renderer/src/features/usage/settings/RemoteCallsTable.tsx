import { formatCost } from '../format'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { CloudOff } from 'lucide-react'
import { cacheHitRate } from '@/features/usage/aggregate'
import { callSpeed } from '@/features/usage/remoteSummary'
import {
  formatCount,
  formatDuration,
  formatFirstToken,
  formatPercent,
  formatTime,
  formatTokens,
} from '@/features/usage/format'
import type { RemoteCall, RemoteCallPage } from '@/features/usage/remote-types'
import {
  ModelCell,
  SpeedCell,
  TIME_COL_WIDTH,
  TimeCell,
  UsageDetailCard,
  UsageTable,
  type UsageColumn,
} from './UsageTable'

const STATUS: Record<RemoteCall['status'], { text: string; cls: string }> = {
  success: {
    get text() {
      return tr('settings.usage.RemoteCallsTable.succeeded')
    },
    cls: 'text-fg-muted',
  },
  error: {
    get text() {
      return tr('session.live.agentTrace.failed')
    },
    cls: 'text-danger',
  },
  rate_limited: {
    get text() {
      return tr('settings.usage.RemoteCallsTable.rateLimited')
    },
    cls: 'text-warn',
  },
}

const CLIENT_LABEL: Record<RemoteCall['client'], string> = {
  get 'pixelsky-desktop'() {
    return tr('settings.usage.RemoteCallsTable.desktop')
  },
  'jucode-cli': 'CLI',
  get api() {
    return tr('settings.usage.RemoteCallsTable.directApiKey')
  },
  get unknown() {
    return tr('settings.usage.RemoteCallsTable.unknown')
  },
}

/** 远端是实际扣费，不加 ≈（usage.md §9.1） */
function cost(c: RemoteCall): string {
  if (c.status !== 'success' || c.costUsd === null) return '—'
  return formatCost(c.costUsd, 'platform', c.billing)
}

/**
 * 两张表同样的列（docs/ui/usage-learn.md §6）：时间 · 模型和客户端 · 新增输入 · 输出 · 缓存命中 · 扣费 · 速度 · 首字 · 耗时 · 结果。
 * 窄时隐藏的新增输入、缓存命中、速度、首字在点开的详情里还有；耗时和结果一直显示，详情里就不重复了。
 */
export const COLUMNS: Array<UsageColumn<RemoteCall>> = [
  {
    key: 'time',
    get label() {
      return tr('settings.usage.RecordsTable.time')
    },
    width: TIME_COL_WIDTH,
    render: c => <TimeCell text={formatTime(c.createdAt)} />,
    title: c => new Date(c.createdAt).toLocaleString('zh-CN'),
    cellClass: () => 'text-fg-muted',
  },
  {
    key: 'model',
    get label() {
      return `${tr('session.ModelSourceMenu.model')} · ${tr('settings.usage.RemoteCallsTable.client')}`
    },
    render: c => <ModelCell model={c.model} source={CLIENT_LABEL[c.client]} />,
  },
  {
    key: 'input',
    get label() {
      return tr('usageColumns.freshInput')
    },
    get help() {
      return tr('usageColumns.freshInputHelp')
    },
    width: 'w-[5.9em]',
    align: 'right',
    hideBelow: 33,
    render: c => formatCount(c.input),
  },
  {
    key: 'output',
    get label() {
      return tr('session.live.SessionStrips.output')
    },
    width: 'w-[3.6em]',
    align: 'right',
    render: c => formatCount(c.output),
  },
  {
    key: 'cache',
    get label() {
      return tr('usageColumns.cacheHit')
    },
    get help() {
      return tr('usageColumns.cacheHitHelp')
    },
    width: 'w-[5.9em]',
    align: 'right',
    hideBelow: 50,
    render: c => formatCount(c.cacheRead),
    title: c => tr('usageColumns.hitRate', { p0: formatPercent(cacheHitRate(c)) }),
  },
  {
    key: 'cost',
    get label() {
      return tr('settings.usage.RemoteCallsTable.charge')
    },
    width: 'w-[5.6em]',
    align: 'right',
    render: cost,
  },
  {
    key: 'speed',
    get label() {
      return tr('usageColumns.speed')
    },
    get help() {
      return tr('usageColumns.speedHelp')
    },
    width: 'w-[5.8em]',
    align: 'right',
    hideBelow: 44,
    render: c => <SpeedCell speed={callSpeed(c)} />,
  },
  {
    key: 'ttft',
    get label() {
      return tr('settings.usage.RemoteCallsTable.firstToken')
    },
    get help() {
      return tr('usageColumns.firstTokenHelp')
    },
    width: 'w-[3.9em]',
    align: 'right',
    hideBelow: 54,
    render: c => formatFirstToken(c.firstTokenMs),
    cellClass: () => 'text-fg-muted',
  },
  {
    key: 'duration',
    get label() {
      return tr('session.live.AgentTracePanel.duration')
    },
    get help() {
      return tr('usageColumns.durationHelp')
    },
    width: 'w-[4.8em]',
    align: 'right',
    render: c => formatDuration(c.durationMs),
    title: c => formatDuration(c.durationMs),
    cellClass: () => 'text-fg-muted',
  },
  {
    key: 'result',
    get label() {
      return tr('settings.usage.RecordsTable.outcome')
    },
    width: 'w-[3.8em]',
    align: 'right',
    render: c => STATUS[c.status].text,
    title: c => STATUS[c.status].text,
    cellClass: c => STATUS[c.status].cls,
  },
]

/** 账号调用记录：每一次模型请求一条（docs/ui/usage.md §9.4）。点一行展开详情 */
export function RemoteCallsTable({
  page,
  pageSize,
  onPage,
}: {
  page: RemoteCallPage
  pageSize: number
  onPage: (offset: number) => void
}) {
  useI18n()
  return (
    <UsageTable
      title={tr('settings.usage.RemoteCallsTable.accountRequests')}
      rows={page.calls}
      rowKey={c => c.id}
      columns={COLUMNS}
      detail={c => <CallDetail c={c} />}
      offset={page.offset}
      total={page.total}
      pageSize={pageSize}
      onPage={onPage}
    />
  )
}

function CallDetail({ c }: { c: RemoteCall }) {
  useI18n()
  return (
    <UsageDetailCard
      fields={[
        [tr('settings.usage.RemoteCallsTable.client'), CLIENT_LABEL[c.client]],
        [tr('settings.usage.RemoteCallsTable.device'), c.device ?? '—'],
        ['Key', c.keyName ?? '—'],
        [
          tr('settings.usage.RemoteCallsTable.requestType'),
          c.stream
            ? tr('settings.usage.RemoteCallsTable.streaming')
            : tr('settings.usage.RemoteCallsTable.nonStreaming'),
        ],
        ['HTTP', `${c.httpStatus}`],
        [tr('settings.usage.RecordsTable.inputCacheMisses'), formatTokens(c.input)],
        [tr('session.turnStatsData.cacheWrite'), formatTokens(c.cacheWrite)],
        [tr('session.turnStatsData.cacheRead'), formatTokens(c.cacheRead)],
        [tr('session.live.SessionStrips.output'), formatTokens(c.output)],
        [tr('settings.usage.RemoteCallsTable.charge'), formatCost(c.costUsd, 'platform', c.billing)],
        [
          tr('settings.usage.RemoteCallsTable.timeToFirstToken'),
          c.firstTokenMs === null ? '—' : `${c.firstTokenMs} ms`,
        ],
        [tr('usageColumns.tokenSpeed'), callSpeed(c) === null ? '—' : `${Math.round(callSpeed(c) ?? 0)} tok/s`],
        [tr('settings.usage.RemoteCallsTable.relatedTurn'), c.turnId ?? '—'],
        [tr('settings.usage.RemoteCallsTable.requestedAt'), new Date(c.createdAt).toLocaleString('zh-CN')],
      ]}
      footer={
        <span className="selectable min-w-0 truncate font-mono text-label text-fg-faint" title={c.id}>
          {c.id}
        </span>
      }
    />
  )
}

/** 远端接口还没上线时的占位（真实模式现在走到这里；docs/ui/usage.md §9.4） */
export function RemoteCallsPlaceholder({ onBack }: { onBack: () => void }) {
  useI18n()
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-subtle text-fg-muted">
        <CloudOff size={20} strokeWidth={1.5} />
      </span>
      <div className="mt-3 text-ui font-medium text-fg-secondary">
        {tr('settings.usage.RemoteCallsTable.accountRequestDetailsAre')}
      </div>
      <p className="mt-1 max-w-md text-meta text-fg-muted">
        {tr('settings.usage.RemoteCallsTable.eachModelRequestWill')}{' '}
        <code className="rounded-sm bg-subtle px-1 font-mono">pnpm dev:demo</code>
        {tr('settings.usage.RemoteCallsTable.text')}{' '}
      </p>
      <button type="button" onClick={onBack} className="mt-3 text-meta text-accent-fg hover:underline">
        {tr('settings.usage.RemoteCallsTable.backToLocalRecords')}{' '}
      </button>
    </div>
  )
}

/** 未登录时的占位（docs/ui/usage.md §9.4） */
export function RemoteCallsSignInPlaceholder({ onSignIn }: { onSignIn: () => void }) {
  useI18n()
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-subtle text-fg-muted">
        <CloudOff size={20} strokeWidth={1.5} />
      </span>
      <div className="mt-3 text-ui font-medium text-fg-secondary">
        {tr('settings.usage.RemoteCallsTable.signInToView')}
      </div>
      <p className="mt-1 max-w-md text-meta text-fg-muted">{tr('settings.usage.RemoteCallsTable.signInToPixel')}</p>
      <button type="button" onClick={onSignIn} className="mt-3 text-meta text-accent-fg hover:underline">
        {tr('settings.usage.RemoteCallsTable.signIn')}{' '}
      </button>
    </div>
  )
}

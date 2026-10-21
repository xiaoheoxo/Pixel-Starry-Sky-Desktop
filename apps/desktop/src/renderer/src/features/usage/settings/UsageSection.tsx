import { translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useState } from 'react'
import { ChartColumn, Download, Trash2, X } from 'lucide-react'
import { Button, Segmented, type SegmentedOption } from '@/ui'
import { useAccount } from '@/features/account'
import { PAGE_SIZE, useUsage, useUsageActions } from '@/features/usage/source'
import { remoteCallsAvailable, useRemoteCalls, useRemoteSummary } from '@/features/usage/remote'
import { COST_MISSING } from '@pixelsky/protocol'
import { DIMENSION_LABEL, dimLabel } from '@/features/usage/format'
import type { UsageDimension, UsageFilter, UsageRangeId } from '@/features/usage/types'
import { SectionTitle } from '../../settings/SettingRow'
import { UsageChart } from './UsageChart'
import { Distribution } from './Distribution'
import { KpiCards } from './KpiCards'
import { RecordsTable } from './RecordsTable'
import { RemoteCallsPlaceholder, RemoteCallsSignInPlaceholder, RemoteCallsTable } from './RemoteCallsTable'

const MODE_OPTIONS: Array<SegmentedOption<'local' | 'account'>> = [
  {
    value: 'local',
    get label() {
      return tr('settings.usage.UsageSection.localRecords')
    },
  },
  {
    value: 'account',
    get label() {
      return tr('settings.usage.RemoteCallsTable.accountRequests')
    },
  },
]

const RANGE_OPTIONS: Array<SegmentedOption<UsageRangeId>> = [
  {
    value: 'today',
    get label() {
      return tr('settings.usage.DailyChart.today')
    },
  },
  {
    value: '7d',
    get label() {
      return tr('settings.usage.UsageSection.n7Days')
    },
  },
  {
    value: '30d',
    get label() {
      return tr('settings.usage.UsageSection.n30Days')
    },
  },
  {
    value: '90d',
    get label() {
      return tr('settings.usage.UsageSection.n90Days')
    },
  },
]

/**
 * 设置 › 用量（docs/ui/usage.md §3 + §9）：
 * 「本机记录」是引擎在本机每轮记账；「账号调用」是账号服务端的每一次模型请求（框架，§9，接口未上线时显示占位）。
 */
export function UsageSection({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  useI18n()
  const [range, setRange] = useState<UsageRangeId>('7d')
  const [filter, setFilter] = useState<UsageFilter>({})
  const [dim, setDim] = useState<UsageDimension>('model')
  const [offset, setOffset] = useState(0)
  const [mode, setMode] = useState<'local' | 'account'>('local')
  const [accountOffset, setAccountOffset] = useState(0)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 导出 / 清空没做成的原因（清空失败时记录还在，不能看起来像清掉了） */
  const [actionError, setActionError] = useState<string | null>(null)
  const { summary, page, error } = useUsage({ range, filter }, offset)
  const { exportCsv, clear } = useUsageActions()
  const acc = useAccount()
  const signedIn = acc.status === 'signed-in' || (acc.status === 'signing-in' && acc.user !== null)
  const remoteQuery = { range, model: filter.model ?? null, offset: accountOffset, limit: PAGE_SIZE }
  // mode === 'local' 时也传同一个查询形，hook 内部自己判断要不要读，避免条件调用 hook
  const rm = useRemoteCalls(remoteQuery)
  const rs = useRemoteSummary({ range, model: filter.model ?? null })

  const changeRange = (r: UsageRangeId) => {
    setRange(r)
    setOffset(0)
    setAccountOffset(0)
  }
  const changeFilter = (next: UsageFilter) => {
    setFilter(next)
    setOffset(0)
    setAccountOffset(0)
  }
  const changeMode = (m: 'local' | 'account') => {
    setMode(m)
    setOffset(0)
    setAccountOffset(0)
    setConfirmClear(false)
  }

  // 账号调用只认模型筛选，别的圆片先不显示（切回本机记录还在）
  const chips = (Object.entries(filter) as Array<[UsageDimension, string | undefined]>).filter(
    (e): e is [UsageDimension, string] => e[1] !== undefined && (mode === 'local' || e[0] === 'model'),
  )
  const empty = mode === 'local' && summary !== null && summary.totals.records === 0
  const accountEmpty = mode === 'account' && rm.page !== null && rm.page.total === 0

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <SectionTitle>{tr('nav.TopNav.usage')}</SectionTitle>
          <Segmented
            label={tr('settings.usage.UsageSection.recordSource')}
            options={MODE_OPTIONS}
            value={mode}
            onChange={changeMode}
          />
        </div>
        <div className="-mt-4 flex items-center gap-2">
          <Button
            icon={Download}
            disabled={busy || empty || mode !== 'local'}
            onClick={async () => {
              setBusy(true)
              setActionError(null)
              try {
                await exportCsv({ range, filter })
              } catch (e) {
                setActionError(tr('settings.usage.UsageSection.exportFailed', { p0: errorText(e) }))
              } finally {
                setBusy(false)
              }
            }}
          >
            {tr('settings.usage.UsageSection.exportCsv')}{' '}
          </Button>
          {confirmClear ? (
            <span className="flex items-center gap-1.5 text-meta text-fg-secondary">
              {tr('settings.usage.UsageSection.clearAllRecords')}{' '}
              <Button variant="ghost" onClick={() => setConfirmClear(false)}>
                {tr('account.AccountMenu.cancel')}{' '}
              </Button>
              <Button
                variant="primary"
                className="bg-danger!"
                onClick={async () => {
                  setConfirmClear(false)
                  setActionError(null)
                  await clear().catch((e: unknown) =>
                    setActionError(tr('settings.usage.UsageSection.clearFailed', { p0: errorText(e) })),
                  )
                }}
              >
                {tr('files.FileTree.clear')}{' '}
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              icon={Trash2}
              disabled={(empty && chips.length === 0) || mode !== 'local'}
              onClick={() => setConfirmClear(true)}
            >
              {tr('files.FileTree.clear')}{' '}
            </Button>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented
          label={tr('settings.usage.UsageSection.timeRange')}
          options={RANGE_OPTIONS}
          value={range}
          onChange={changeRange}
        />
        {chips.map(([d, v]) => (
          <span
            key={d}
            className="inline-flex h-7 items-center gap-1 rounded-full border border-accent-line bg-accent-soft pr-1 pl-2.5 text-meta text-accent-fg"
          >
            {DIMENSION_LABEL[d]}：{dimLabel(d, v)}
            <button
              type="button"
              aria-label={tr('settings.usage.UsageSection.removeFilter', { p0: DIMENSION_LABEL[d] })}
              onClick={() => changeFilter({ ...filter, [d]: undefined })}
              className="inline-flex size-5 items-center justify-center rounded-full hover:bg-hover"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </span>
        ))}
        {chips.length > 1 && (
          <button type="button" onClick={() => changeFilter({})} className="text-meta text-fg-muted hover:text-fg">
            {tr('settings.usage.UsageSection.clearFilters')}{' '}
          </button>
        )}
      </div>

      {actionError && <ErrorLine>{actionError}</ErrorLine>}
      {mode === 'local' && error && (
        <ErrorLine>{tr('settings.usage.UsageSection.loadFailed', { p0: translateMessage(error) })}</ErrorLine>
      )}

      {mode === 'account' ? (
        <AccountModeBody
          rm={rm}
          rs={rs}
          model={filter.model}
          onPickModel={model => changeFilter({ ...filter, model })}
          empty={accountEmpty}
          signedIn={signedIn}
          available={remoteCallsAvailable()}
          onPage={setAccountOffset}
          onSignIn={() => void acc.login()}
          onBack={() => changeMode('local')}
        />
      ) : (
        summary &&
        page &&
        (empty ? (
          <EmptyState filtered={chips.length > 0} />
        ) : (
          <div className="flex flex-col gap-4">
            <KpiCards
              totals={summary.totals}
              prev={summary.prevTotals}
              routes={summary.groups.route}
              // 没有费用的记录：只看这些，分布表按原因分开（GitHub #22）；旧版远端电脑没有这个维度，不能点
              onShowMissing={
                summary.groups.cost
                  ? () => {
                      if (filter.cost === undefined) changeFilter({ ...filter, cost: COST_MISSING })
                      setDim('cost')
                    }
                  : undefined
              }
            />
            <Panel>
              <UsageChart buckets={summary.buckets} bucket={summary.bucket} />
            </Panel>
            <Panel>
              <Distribution
                dim={dim}
                onDim={setDim}
                rows={summary.groups[dim] ?? []}
                activeKey={filter[dim]}
                onPick={key => changeFilter({ ...filter, [dim]: key })}
              />
            </Panel>
            <Panel>
              <RecordsTable page={page} pageSize={PAGE_SIZE} onPage={setOffset} onOpenSession={onOpenSession} />
            </Panel>
            <p className="text-meta text-fg-faint">{tr('settings.usage.UsageSection.recordsStayOnThis')} </p>
          </div>
        ))
      )}
    </section>
  )
}

function AccountModeBody({
  rm,
  rs,
  model,
  onPickModel,
  empty,
  signedIn,
  available,
  onPage,
  onSignIn,
  onBack,
}: {
  rm: ReturnType<typeof useRemoteCalls>
  rs: ReturnType<typeof useRemoteSummary>
  model: string | undefined
  onPickModel: (model: string) => void
  empty: boolean
  signedIn: boolean
  available: boolean
  onPage: (n: number) => void
  onSignIn: () => void
  onBack: () => void
}) {
  useI18n()
  if (!signedIn) return <RemoteCallsSignInPlaceholder onSignIn={onSignIn} />
  if (!available) return <RemoteCallsPlaceholder onBack={onBack} />
  // 出错时 page 也是 null：先判断出错，再判断读取中
  if (rm.status === 'error') return <ErrorLine>{translateMessage(rm.error)}</ErrorLine>
  if (rm.status === 'loading' || rm.page === null) {
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-surface p-4 text-meta text-fg-muted tabular-nums">
        {tr('settings.usage.UsageSection.loadingAccountRequests')}
      </div>
    )
  }
  if (empty) {
    return <EmptyState filtered={false} />
  }
  // 和本机记录同样的卡片、图表、分布表；合计读不到时只显示明细
  const summary = rs.summary
  return (
    <div className="flex flex-col gap-4">
      {summary ? (
        <>
          <KpiCards
            totals={summary.totals}
            prev={summary.prevTotals}
            account={{ models: summary.groups.model.length }}
          />
          <Panel>
            <UsageChart buckets={summary.buckets} bucket={summary.bucket} />
          </Panel>
          <Panel>
            <Distribution
              account
              dim="model"
              onDim={() => {}}
              rows={summary.groups.model}
              activeKey={model}
              onPick={onPickModel}
            />
          </Panel>
        </>
      ) : (
        rs.status === 'unavailable' && (
          <p className="text-meta text-fg-muted">{tr('settings.usage.UsageSection.accountTotalsUnavailable')}</p>
        )
      )}
      <Panel>
        <RemoteCallsTable page={rm.page} pageSize={PAGE_SIZE} onPage={onPage} />
      </Panel>
      <p className="text-meta text-fg-faint">{tr('settings.usage.UsageSection.accountRecordsNote')}</p>
    </div>
  )
}

const errorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

function ErrorLine({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-meta text-danger">{children}</p>
}

function Panel({ children }: { children: React.ReactNode }) {
  useI18n()
  return <div className="overflow-hidden rounded-lg border border-line bg-surface p-4">{children}</div>
}

function EmptyState({ filtered }: { filtered: boolean }) {
  useI18n()
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-subtle text-fg-muted">
        <ChartColumn size={20} strokeWidth={1.5} />
      </span>
      <div className="mt-3 text-ui font-medium text-fg-secondary">
        {filtered
          ? tr('settings.usage.UsageSection.noRecordsMatchThese')
          : tr('settings.usage.UsageSection.noUsageRecordsYet')}
      </div>
      <p className="mt-1 max-w-sm text-meta text-fg-muted">
        {filtered
          ? tr('settings.usage.UsageSection.chooseAnotherTimeRange')
          : tr('settings.usage.UsageSection.afterStartingConversationEach')}
      </p>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Clock3, RefreshCw, UserRound } from 'lucide-react'
import type { EngineAccountUsage, EngineId } from '@pixelsky/protocol'
import { bridge, useEngineState } from '@/features/engine/store'
import { catalogSignature } from '@/features/engine/catalogSignature'
import { machineOf, useMachines } from '@/features/machines/store'
import { isDemo } from '@/data'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, getLocale } from '@/i18n/core'
import { cn } from '@/ui'
import { usagePercent, usageResetCountdown, usageResetTime, usageWindowLabel } from './accountUsageData'

export function AccountUsagePanel({ engine, sessionId }: { engine: EngineId; sessionId: string | null }) {
  const { currentId } = useMachines()
  const machine = sessionId ? machineOf(sessionId) : currentId
  const signature = useEngineState(state =>
    catalogSignature(
      state.engines.find(e => e.id === engine),
      state.config?.[engine],
      state.detectGen,
    ),
  )
  return (
    <AccountUsageContent
      key={`${machine}:${engine}:${sessionId}:${signature}`}
      engine={engine}
      sessionId={sessionId}
      machine={machine}
    />
  )
}

function demoUsage(): EngineAccountUsage {
  const now = Date.now()
  return {
    status: 'ready',
    observedAt: now,
    windows: [
      { id: 'five', kind: 'five_hour', usedPercent: 38, resetsAt: now + 138 * 60_000 },
      { id: 'week', kind: 'weekly', usedPercent: 72, resetsAt: now + 74 * 3600_000 },
    ],
  }
}

function AccountUsageContent({
  engine,
  sessionId,
  machine,
}: {
  engine: EngineId
  sessionId: string | null
  machine: string
}) {
  useI18n()
  const [usage, setUsage] = useState<EngineAccountUsage | null>(() => (isDemo ? demoUsage() : null))
  const [loading, setLoading] = useState(!isDemo)
  const [now, setNow] = useState(Date.now)
  const alive = useRef(false)
  const refreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {})
  useEffect(() => {
    alive.current = true
    let active = true,
      busy = false
    const refresh = async (force = false): Promise<void> => {
      if (!active || busy) return
      busy = true
      setLoading(true)
      try {
        const value = isDemo
          ? demoUsage()
          : await bridge!.accountUsage({ engine, ...(sessionId ? { sessionId } : {}) }, force)
        if (active) setUsage(previous => (previous && previous.observedAt > value.observedAt ? previous : value))
      } catch {
        if (active) setUsage({ status: 'error', windows: [], observedAt: Date.now() })
      } finally {
        busy = false
        if (active) setLoading(false)
      }
    }
    refreshRef.current = refresh
    if (!isDemo) void refresh()
    const unsubscribe = bridge?.onEvent(event => {
      if (event.kind === 'account_usage' && event.engine === engine && (event.machine ?? 'local') === machine)
        setUsage(previous => (previous && previous.observedAt > event.usage.observedAt ? previous : event.usage))
    })
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    // 只在弹窗可见时查询；后台窗口不主动轮询，事件仍可更新。
    const poll = setInterval(() => {
      if (!document.hidden) void refresh(true)
    }, 60_000)
    const focus = (): void => {
      if (!document.hidden) void refresh()
    }
    window.addEventListener('focus', focus)
    return () => {
      active = false
      alive.current = false
      unsubscribe?.()
      clearInterval(tick)
      clearInterval(poll)
      window.removeEventListener('focus', focus)
    }
  }, [engine, machine, sessionId])
  return (
    <AccountUsageView
      engine={engine}
      usage={usage}
      loading={loading}
      now={now}
      onRefresh={() => {
        if (alive.current) void refreshRef.current(true)
      }}
    />
  )
}

/** 纯展示层使用应用语义颜色，随暗色/亮色及配色同步。 */
export function AccountUsageView({
  engine,
  usage,
  loading,
  now,
  onRefresh,
}: {
  engine: EngineId
  usage: EngineAccountUsage | null
  loading: boolean
  now: number
  onRefresh: () => void
}) {
  useI18n()
  const ready = usage?.status === 'ready'
  const windows = ready ? usage.windows : []
  const highest = Math.max(0, ...windows.map(w => w.usedPercent ?? 0))
  const message = !usage
    ? null
    : usage.status === 'error'
      ? tr('accountUsage.error')
      : usage.status === 'unsupported'
        ? tr('accountUsage.unsupported')
        : usage.status === 'unavailable'
          ? tr(
              usage.reason === 'signed_out'
                ? 'accountUsage.signedOut'
                : usage.reason === 'api_key'
                  ? 'accountUsage.apiKey'
                  : usage.reason === 'missing'
                    ? 'accountUsage.missing'
                    : 'accountUsage.unavailable',
            )
          : !windows.length
            ? tr('accountUsage.empty')
            : null
  const timezone =
    new Intl.DateTimeFormat(getLocale(), { timeZoneName: 'short' })
      .formatToParts(now)
      .find(p => p.type === 'timeZoneName')?.value ?? ''
  return (
    <section
      data-account-usage
      aria-busy={loading}
      aria-label={tr('accountUsage.title')}
      className="mt-4 border-t border-line pt-4"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-ui font-medium">{tr('accountUsage.title')}</h3>
        <span className="rounded border border-accent/20 bg-accent/5 px-1.5 text-label text-accent-fg">
          {tr('accountUsage.native')}
        </span>
        <button
          type="button"
          data-account-usage-refresh
          onClick={onRefresh}
          disabled={loading}
          aria-label={tr('accountUsage.refresh')}
          title={tr('accountUsage.refresh')}
          className="ml-auto rounded-md p-1 text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-label text-fg-muted">
        <UserRound size={11} className="shrink-0" />
        <span className="truncate" title={usage?.account}>
          {engine === 'claude' ? 'Claude Code' : 'Codex'} · {usage?.account ?? tr('accountUsage.account')}
          {usage?.plan ? ` · ${usage.plan}` : ''}
        </span>
        {isDemo && <span className="shrink-0 text-fg-faint">· {tr('accountUsage.demo')}</span>}
      </div>
      {!usage && (
        <p className="mt-4 text-meta text-fg-muted" role="status">
          {tr('accountUsage.loading')}
        </p>
      )}
      {windows.map(window => {
        const value = window.usedPercent
        const tone = value !== null && value >= 100 ? 'danger' : value !== null && value >= 85 ? 'warn' : null
        return (
          <div key={window.id} data-account-usage-window={window.id} className="mt-4">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 text-meta text-fg-secondary">{usageWindowLabel(window)}</span>
              <span className="shrink-0 text-label text-fg-muted">
                {tr('accountUsage.used')}{' '}
                <strong
                  className={cn(
                    'ml-1 text-ui font-medium tabular-nums',
                    tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-fg',
                  )}
                >
                  {value === null ? '—' : `${usagePercent(value)}%`}
                </strong>
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={usageWindowLabel(window)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={value === null ? undefined : Math.min(100, value)}
              className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-subtle"
            >
              <span
                className={cn(
                  'h-full rounded-full',
                  tone === 'danger'
                    ? 'bg-danger'
                    : tone === 'warn'
                      ? 'bg-warn'
                      : window.kind === 'weekly'
                        ? 'bg-accent'
                        : 'bg-chart-cache',
                )}
                style={{ width: value === null ? '0%' : `${Math.min(100, Math.max(0, value))}%` }}
              />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-label text-fg-muted tabular-nums">
              <span className="inline-flex items-center gap-1">
                <Clock3 size={11} className="text-fg-faint" />
                {usageResetCountdown(window.resetsAt, now)}
              </span>
              <span
                className="text-fg-faint"
                title={window.resetsAt === null ? undefined : new Date(window.resetsAt).toLocaleString(getLocale())}
              >
                {usageResetTime(window.resetsAt)}
              </span>
            </div>
            {value !== null && (
              <p className="mt-1 text-label text-fg-faint">
                {tr('accountUsage.remaining', { percent: usagePercent(Math.max(0, 100 - value)) })}
              </p>
            )}
          </div>
        )
      })}
      {message && (
        <div className="mt-4 rounded-md bg-subtle p-3 text-meta text-fg-muted" role="status">
          <p>{message}</p>
          {usage?.status !== 'ready' && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="mt-2 text-accent-fg disabled:opacity-50"
            >
              {tr('accountUsage.retry')}
            </button>
          )}
        </div>
      )}
      {ready && usage.partial && <p className="mt-3 text-label text-fg-muted">{tr('accountUsage.partial')}</p>}
      {highest >= 85 && (
        <p className={cn('mt-3 text-label', highest >= 100 ? 'text-danger' : 'text-warn')}>
          {tr(highest >= 100 ? 'accountUsage.exhausted' : 'accountUsage.warning')}
        </p>
      )}
      {usage && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-label text-fg-faint">
          <span>
            {loading
              ? tr('accountUsage.loading')
              : tr('accountUsage.updated', {
                  time: new Date(usage.observedAt).toLocaleTimeString(getLocale(), {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }),
                })}
          </span>
          <span>{tr('accountUsage.timezone', { zone: timezone })}</span>
        </div>
      )}
    </section>
  )
}

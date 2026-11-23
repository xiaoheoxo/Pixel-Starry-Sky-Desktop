import { translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { formatBillingSource, formatDate, formatUpdatedAt, formatWindow } from '@/features/account'
import { QuotaBar } from '@/features/account/QuotaBar'
import { Button, cn } from '@/ui'
import { useSettings } from '../../settings/SettingsProvider'
import type { AccountInfo, Quota } from '../../../../../shared/types/account'
import type { AccountTab } from './AccountSection'

interface AccountOverviewProps {
  account: AccountInfo
  balanceText: string
  error: string | null
  refreshing: boolean
  onRefresh: () => void
  onNavigate: (tab: AccountTab) => void
}

/** 账号 → 概览：余额、当前套餐、限额、刷新（docs/ui/settings.md §9.3） */
export function AccountOverview({
  account,
  balanceText,
  error,
  refreshing,
  onRefresh,
  onNavigate,
}: AccountOverviewProps) {
  useI18n()
  const settings = useSettings()
  const { plan, rateLimits, currency, group } = account
  const expires = formatDate(plan?.expiresAt)
  const quotas: Array<[string, Quota | null]> = plan
    ? [
        [tr('account.AccountMenu.today'), plan.daily],
        [tr('account.AccountMenu.thisWeek'), plan.weekly],
        [tr('account.AccountMenu.thisMonth'), plan.monthly],
      ]
    : []
  const shownQuotas = quotas.filter((q): q is [string, Quota] => q[1] !== null)

  // 「更新于 …」每 30 秒重新计算一次
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="rounded-md bg-subtle px-3 py-2 text-meta text-danger">
          {translateMessage(error)}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Card title={tr('account.AccountMenu.balance')}>
          <div className="text-title leading-none font-semibold text-fg tabular-nums">{balanceText}</div>
          {account.balance === null && (
            <p className="mt-1.5 text-meta text-fg-muted">
              {tr('account.AccountMenu.balanceIsTemporarilyUnavailable')}
            </p>
          )}
          {group && (
            <p className="mt-2 truncate text-meta text-fg-muted">
              {tr('settings.account.AccountOverview.groups')} {group.name} · {formatBillingSource(group.billingSource)}
            </p>
          )}
          <button
            type="button"
            onClick={() => settings.openSettings('models')}
            className="mt-1 self-start text-meta text-accent-fg hover:underline"
          >
            {tr('settings.account.AccountOverview.manageRoutesInModels')}{' '}
          </button>
          <div className="mt-auto pt-4">
            <Button variant="primary" onClick={() => onNavigate('topup')}>
              {tr('settings.account.AccountOverview.addCredits')}{' '}
            </Button>
          </div>
        </Card>

        <Card title={tr('settings.account.AccountOverview.currentPlan')}>
          {plan ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-ui font-medium text-fg">{plan.name}</span>
                {expires && (
                  <span className="shrink-0 text-meta text-fg-muted">
                    {tr('account.AccountMenu.expires')} {expires}
                  </span>
                )}
              </div>
              <div className="mt-3 flex flex-col gap-2.5">
                {shownQuotas.map(([label, q]) => (
                  <QuotaBar key={label} label={label} quota={q} currency={currency} />
                ))}
              </div>
              <div className="mt-auto pt-4">
                <Button variant="outline" onClick={() => onNavigate('plans')}>
                  {tr('settings.account.AccountOverview.changePlan')}{' '}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-ui font-medium text-fg">{tr('settings.account.AccountOverview.noSubscription')}</div>
              <p className="mt-1 text-meta text-fg-muted">
                {tr('settings.account.AccountOverview.subscriptionsIncludeDailyAnd')}
              </p>
              <div className="mt-auto pt-4">
                <Button variant="outline" onClick={() => onNavigate('plans')}>
                  {tr('settings.account.AccountOverview.viewPlans')}{' '}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>

      {rateLimits.length > 0 && (
        <Card title={tr('account.AccountMenu.limit')}>
          <div className="flex flex-col gap-2.5">
            {rateLimits.map(r => (
              <QuotaBar
                key={r.window}
                label={tr('account.AccountMenu.every', { p0: formatWindow(r.window) })}
                quota={r}
                currency={currency}
              />
            ))}
          </div>
        </Card>
      )}

      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label={tr('settings.account.AccountOverview.refreshBalanceAndCredits')}
        className="press no-drag flex h-8 w-fit items-center gap-1.5 rounded-md px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg disabled:opacity-70"
      >
        <RefreshCw size={14} strokeWidth={1.5} className={cn('shrink-0', refreshing && 'animate-spin')} />
        {tr('account.AccountMenu.refresh')}{' '}
        <span className="text-fg-muted">
          {refreshing
            ? tr('settings.account.AccountOverview.updating')
            : tr('account.AccountMenu.updated', { p0: formatUpdatedAt(account.updatedAt, now) })}
        </span>
      </button>
    </div>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  useI18n()
  return (
    <div className="flex min-w-0 flex-col rounded-xl bg-surface p-5 shadow-sm">
      <h4 className="mb-2 text-meta font-medium text-fg-muted">{title}</h4>
      {children}
    </div>
  )
}

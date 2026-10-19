import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useState } from 'react'
import { Check, ExternalLink } from 'lucide-react'
import { formatAmount, formatPrice } from '@/features/account'
import { isCurrentPlan, validityLabel } from '../storeLogic'
import { Button, cn } from '@/ui'
import type { StoreCatalog, StorePlan, StoreQuotas } from '../../../../../shared/types/account'
import { checkoutAvailable, checkoutMethods, loadMethod, pickMethod, planIntent } from '../checkout/checkoutLogic'
import type { CheckoutHost } from '../checkout/useCheckout'
import { AccountCheckLine, OpenPanelButton, PendingOrderBar, type OpenStore } from './StoreParts'

const quotaRows = (): Array<[keyof StoreQuotas, string]> => [
  ['fiveHour', tr('settings.account.PlanStore.fiveHour')],
  ['daily', tr('settings.account.PlanStore.daily')],
  ['weekly', tr('settings.account.PlanStore.weekly')],
  ['monthly', tr('settings.account.PlanStore.monthly')],
]

/** 账号 → 订阅套餐：Sub2api 在售的套餐卡片；购买在浏览器里的面板完成（docs/ui/settings.md §9.4） */
export function PlanStore({
  catalog,
  currentPlan,
  onOpen,
  checkout,
  email = '',
}: {
  catalog: StoreCatalog
  currentPlan: string | null
  onOpen: OpenStore
  /** 软件内付款；不传或云端没开（catalog.checkout）时和以前一模一样 */
  checkout?: CheckoutHost
  /** 登录账号的邮箱：软件内付款开着时，「去浏览器购买」旁的核对提示用 */
  email?: string
}) {
  useI18n()
  const { plans } = catalog
  const [savedMethod] = useState(loadMethod)

  if (!catalog.enabled || plans.length === 0) {
    // 软件内付款开着时顶部的账号核对提示被隐藏了，这里只有浏览器入口，补上核对提示
    const checkLine = !!checkout && checkoutAvailable(catalog) && !!email
    return (
      <div className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center">
        <div className="text-ui font-medium text-fg">{tr('settings.account.PlanStore.noPlansOnPanel')}</div>
        <p className="mt-1 text-meta text-fg-muted">{tr('settings.account.PlanStore.plansWillAppearHere')}</p>
        <OpenPanelButton onOpen={onOpen} />
        {checkLine && (
          <div className="mt-2">
            <AccountCheckLine email={email} />
          </div>
        )}
      </div>
    )
  }

  // 软件内付款：按钮打开弹窗的「准备」步骤（选支付方式、扫码），卡片下方留一个去浏览器购买的小入口（§6.2）
  const payInApp = !!checkout && checkoutAvailable(catalog)
  const method = payInApp ? pickMethod(checkoutMethods(catalog), null, savedMethod) : null
  const scan =
    checkout && method ? (plan: StorePlan): void => checkout.start(planIntent(plan, method), true) : undefined

  const grid = (
    <div className="grid grid-cols-3 gap-2.5">
      {plans.map(plan => (
        <PlanCard key={plan.id} plan={plan} current={isCurrentPlan(plan, currentPlan)} onOpen={onOpen} onScan={scan} />
      ))}
    </div>
  )
  if (!payInApp || !checkout) return grid
  return (
    <div className="flex flex-col gap-3">
      <PendingOrderBar orders={checkout.pending} onResume={checkout.resume} />
      {grid}
      {email && <AccountCheckLine email={email} />}
    </div>
  )
}

function PlanCard({
  plan,
  current,
  onOpen,
  onScan,
}: {
  plan: StorePlan
  current: boolean
  onOpen: OpenStore
  /** 软件内付款开着时给：主按钮扫码付款，浏览器购买退成小字入口 */
  onScan?: (plan: StorePlan) => void
}) {
  useI18n()
  const browserParams = { tab: 'subscription', ...(plan.groupId ? { group: plan.groupId } : {}) } as const
  const action = current ? tr('settings.account.PlanStore.renew') : tr('settings.account.PlanStore.purchase')
  const rows = quotaRows().filter(([key]) => plan.quotas[key] !== null)
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col rounded-lg border bg-surface p-3.5',
        current ? 'border-accent-line' : 'border-line',
      )}
    >
      <div className="flex min-h-5 items-center gap-1.5">
        <span className="min-w-0 truncate text-ui font-medium text-fg" title={plan.name}>
          {plan.name}
        </span>
        {current && <Tag>{tr('settings.account.PlanStore.current')}</Tag>}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-title leading-none font-semibold text-fg tabular-nums">
          {formatPrice(plan.price, plan.currency)}
        </span>
        {plan.originalPrice !== null && plan.originalPrice > plan.price && (
          <span className="text-meta text-fg-faint tabular-nums line-through">
            {formatPrice(plan.originalPrice, plan.currency)}
          </span>
        )}
        {plan.validityDays > 0 && <span className="text-meta text-fg-muted">/ {validityLabel(plan.validityDays)}</span>}
      </div>

      {plan.description && <p className="mt-2 text-meta text-fg-muted">{plan.description}</p>}

      {rows.length > 0 && (
        <dl className="mt-3 flex flex-col gap-1 border-t border-line-subtle pt-3 text-meta">
          {rows.map(([key, label]) => (
            <div key={key} className="flex justify-between gap-2">
              <dt className="text-fg-muted">
                {label}
                {tr('settings.account.PlanStore.credits')}
              </dt>
              <dd className="text-fg tabular-nums">{formatAmount(plan.quotas[key] as number, 'USD')}</dd>
            </div>
          ))}
        </dl>
      )}

      {plan.features.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 text-meta text-fg-secondary">
          {plan.features.map(f => (
            <li key={f} className="flex items-start gap-1.5">
              <Check size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-accent-fg" />
              <span className="min-w-0">{f}</span>
            </li>
          ))}
        </ul>
      )}

      {plan.groupName && (
        <p className="mt-3 truncate text-label text-fg-faint" title={plan.groupName}>
          {tr('settings.account.PlanStore.group')} {plan.groupName}
        </p>
      )}

      <div className="mt-auto pt-4">
        <Button
          variant={current ? 'primary' : 'outline'}
          className="w-full justify-center"
          onClick={() => (onScan ? onScan(plan) : onOpen('purchase', browserParams))}
        >
          {action}
        </Button>
        {onScan && (
          <p className="mt-2 text-center text-label text-fg-faint">
            {tr('settings.account.PlanStore.alsoInBrowser')}{' '}
            <button
              type="button"
              className="press no-drag inline-flex items-center gap-0.5 underline-offset-2 hover:text-fg hover:underline"
              onClick={() => onOpen('purchase', browserParams)}
            >
              {tr('settings.account.PlanStore.buyInBrowser')}
              <ExternalLink size={11} aria-hidden />
            </button>
          </p>
        )}
      </div>
    </div>
  )
}

function Tag({ children }: { children: string }) {
  useI18n()
  return (
    <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-px text-label font-medium text-accent-fg">
      {children}
    </span>
  )
}

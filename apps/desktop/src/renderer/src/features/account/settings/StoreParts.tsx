import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useRef } from 'react'
import { Circle, CircleDot, ExternalLink, TriangleAlert } from 'lucide-react'
import { formatBalance, formatDate, formatPrice } from '@/features/account'
import { Button, cn } from '@/ui'
import type { AccountInfo, StoreLinkKind, StoreLinkParams, StoreMethod } from '../../../../../shared/types/account'
import type { AccountChange } from '../storeLogic'
import { nextRadioIndex, remainingMs } from '../checkout/checkoutLogic'
import type { TrackedOrder } from '../checkout/useCheckout'

/** 打开面板页：成功后页面上出现「在浏览器里完成付款后回到这里」 */
export type OpenStore = (kind: StoreLinkKind, params?: StoreLinkParams) => void

/** 「打开网页面板」按钮：空状态用 */
export function OpenPanelButton({ onOpen }: { onOpen: OpenStore }) {
  useI18n()
  return (
    <Button variant="outline" icon={ExternalLink} className="mt-4" onClick={() => onOpen('purchase')}>
      {tr('settings.account.Store.openPanel')}
    </Button>
  )
}

/** 商店页顶部：当前余额、套餐和到期时间（用账号里已有的数据，和概览页一致） */
export function StoreHeader({ account }: { account: Pick<AccountInfo, 'balance' | 'currency' | 'plan'> }) {
  useI18n()
  const { plan } = account
  const expires = formatDate(plan?.expiresAt)
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-ui">
      <span className="text-fg tabular-nums">
        {tr('settings.account.Store.balanceNow', { p0: formatBalance(account.balance, account.currency) })}
      </span>
      <span className="text-fg-secondary">
        {plan ? tr('settings.account.Store.planNow', { p0: plan.name }) : tr('settings.account.Store.planNone')}
        {plan && expires && (
          <span className="ml-1.5 text-meta text-fg-muted">
            {tr('settings.account.Store.planExpires', { p0: expires })}
          </span>
        )}
      </span>
    </div>
  )
}

/** 付款前的账号核对：浏览器里的面板可能登录着别的账号，钱会进到那个号上 */
export function AccountCheckNotice({ email }: { email: string }) {
  useI18n()
  return (
    <div role="note" className="mb-4 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5">
      <TriangleAlert size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0">
        <div className="selectable text-ui font-medium text-fg">
          {tr('settings.account.Store.accountCheck', { p0: email })}
        </div>
        <p className="mt-0.5 text-meta text-fg-muted">{tr('settings.account.Store.accountCheckHint')}</p>
      </div>
    </div>
  )
}

/** 付款前的账号核对（软件内付款开着时）：只和「去浏览器付款」有关，挪到那个入口旁边，缩成一行小字 */
export function AccountCheckLine({ email }: { email: string }) {
  useI18n()
  return (
    <p role="note" className="selectable text-label text-fg-faint">
      {tr('settings.account.Store.accountCheck', { p0: email })}
    </p>
  )
}

/** 支付方式单选（软件内付款开着时）：radiogroup，方向键切换，记住上次选的由调用方负责 */
export function MethodPicker({
  options,
  value,
  onChange,
  label,
}: {
  options: StoreMethod[]
  value: string
  onChange: (type: string) => void
  label: string
}) {
  useI18n()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const hasValue = options.some(m => m.type === value)
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((m, i) => {
        const selected = m.type === value
        const Icon = selected ? CircleDot : Circle
        return (
          <button
            key={m.type}
            ref={el => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (!hasValue && i === 0) ? 0 : -1}
            onClick={() => onChange(m.type)}
            onKeyDown={event => {
              const next = nextRadioIndex(event.key, i, options.length)
              if (next === null) return
              event.preventDefault()
              onChange(options[next].type)
              refs.current[next]?.focus()
            }}
            className={cn(
              'press no-drag inline-flex h-8 items-center gap-2 rounded-md border px-3 text-ui',
              selected
                ? 'border-accent-line bg-accent-soft font-medium text-fg'
                : 'border-line-strong bg-surface text-fg-secondary hover:border-fg-faint',
            )}
          >
            <Icon size={14} strokeWidth={2} aria-hidden className={selected ? 'text-accent-fg' : 'text-fg-faint'} />
            {m.label}
          </button>
        )
      })}
    </div>
  )
}

/** 软件里下的、还没付的单：充值页 / 套餐页上的「继续付款」条（关了弹窗订单也还在，docs/ui/in-app-payment.md §6.3） */
export function PendingOrderBar({
  orders,
  onResume,
  now = Date.now(),
}: {
  orders: TrackedOrder[]
  onResume: (orderId: number) => void
  now?: number
}) {
  useI18n()
  const live = orders.filter(t => t.order.status === 'pending' && remainingMs(t.order, t.at, now) > 0)
  if (live.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {live.map(({ order, at }) => (
        <div
          key={order.orderId}
          className="flex items-center gap-3 rounded-lg border border-accent-line bg-accent-soft px-4 py-2.5"
        >
          <p className="min-w-0 flex-1 text-meta text-fg-secondary tabular-nums">
            {tr('settings.account.TopUp.pendingOrder', {
              p0: order.methodLabel,
              p1: formatPrice(order.payAmount, order.payCurrency),
              p2: Math.max(1, Math.ceil(remainingMs(order, at, now) / 60_000)),
            })}
          </p>
          <Button variant="outline" onClick={() => onResume(order.orderId)}>
            {tr('settings.account.TopUp.continuePay')}
          </Button>
        </div>
      ))}
    </div>
  )
}

/** 到账前后的差异：每项一行文字 */
export function changeLines(change: AccountChange, currency: string): string[] {
  const none = tr('settings.account.Store.noValue')
  const lines: string[] = []
  if (change.balance) {
    lines.push(
      tr('settings.account.Store.balanceChange', {
        p0: formatBalance(change.balance.from, currency),
        p1: formatBalance(change.balance.to, currency),
      }),
    )
  }
  if (change.plan) {
    lines.push(tr('settings.account.Store.planChange', { p0: change.plan.from ?? none, p1: change.plan.to ?? none }))
  }
  if (change.expires) {
    lines.push(
      tr('settings.account.Store.expiresChange', {
        p0: formatDate(change.expires.from) ?? none,
        p1: formatDate(change.expires.to) ?? none,
      }),
    )
  }
  return lines
}

/** 刷新结果：到账（前后对比）/ 暂未到账 */
export function PaymentOutcome({
  outcome,
  currency,
}: {
  outcome: { kind: 'arrived'; change: AccountChange } | { kind: 'pending' }
  currency: string
}) {
  useI18n()
  if (outcome.kind === 'pending') {
    return (
      <p role="status" className="text-meta text-fg-secondary">
        {tr('settings.account.Store.notArrived')}
      </p>
    )
  }
  return (
    <div role="status" className="text-meta text-accent-fg">
      <div className="font-medium">{tr('settings.account.Store.arrived')}</div>
      <ul className="mt-0.5 tabular-nums">
        {changeLines(outcome.change, currency).map(line => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}

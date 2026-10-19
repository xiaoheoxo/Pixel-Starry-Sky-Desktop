import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { useState } from 'react'
import { Check, Copy, ExternalLink, QrCode as QrCodeIcon, Ticket } from 'lucide-react'
import { formatAmount, formatPrice } from '@/features/account'
import { checkAmount, payAmountTrusted, quoteRecharge } from '../storeLogic'
import { Button, cn } from '@/ui'
import type { StoreCatalog, StoreRecharge } from '../../../../../shared/types/account'
import {
  balanceIntent,
  checkoutAvailable,
  checkoutMethods,
  loadMethod,
  pickMethod,
  saveMethod,
} from '../checkout/checkoutLogic'
import type { CheckoutHost } from '../checkout/useCheckout'
import { AccountCheckLine, MethodPicker, OpenPanelButton, PendingOrderBar, type OpenStore } from './StoreParts'

/** 账号 → 充值：金额、赠送规则、到账与应付、支付方式；付款在浏览器里的面板完成（docs/ui/settings.md §9.5） */
export function TopUp({
  catalog,
  currency,
  onOpen,
  checkout,
  email = '',
  initialAmount = '',
}: {
  catalog: StoreCatalog
  /** 账号币种：到账额度的单位 */
  currency: string
  onOpen: OpenStore
  /** 软件内付款；不传或云端没开（catalog.checkout）时和以前一模一样 */
  checkout?: CheckoutHost
  /** 登录账号的邮箱：软件内付款开着时，「去浏览器付款」旁的核对提示用 */
  email?: string
  /** 金额输入框的初始内容（测试用） */
  initialAmount?: string
}) {
  useI18n()
  const { recharge, methods, helpText } = catalog
  const [text, setText] = useState(initialAmount)
  const [copied, setCopied] = useState(false)
  const [methodChoice, setMethodChoice] = useState<string | null>(null)
  const [savedMethod] = useState(loadMethod)

  const redeem = (
    <Button variant="ghost" icon={Ticket} className="h-7 px-2 text-meta" onClick={() => onOpen('redeem')}>
      {tr('settings.account.TopUp.redeemCode')}
    </Button>
  )

  if (!catalog.enabled || !recharge.enabled) {
    // 软件内付款开着时顶部的账号核对提示被隐藏了，这里只有浏览器入口，补上核对提示
    const checkLine = !!checkout && checkoutAvailable(catalog) && !!email
    return (
      <div>
        <div className="rounded-lg border border-dashed border-line-strong px-4 py-10 text-center">
          <div className="text-ui font-medium text-fg">{tr('settings.account.TopUp.rechargeClosed')}</div>
          <p className="mt-1 text-meta text-fg-muted">{tr('settings.account.TopUp.rechargeClosedHint')}</p>
          <OpenPanelButton onOpen={onOpen} />
          {checkLine && (
            <div className="mt-2">
              <AccountCheckLine email={email} />
            </div>
          )}
        </div>
        <div className="mt-3 flex justify-center">{redeem}</div>
      </div>
    )
  }

  const payCurrency = catalog.currency
  const check = checkAmount(text, recharge)
  const quote = check.ok ? quoteRecharge(recharge, check.value) : null
  // 支付币种和套餐币种对不上（或云端没给）时，应付金额的单位拿不准，不显示
  const dueTrusted = payAmountTrusted(catalog)
  const copyAmount = (): void => {
    if (!check.ok) return
    void navigator.clipboard.writeText(String(check.value)).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => undefined,
    )
  }
  // 软件内付款：支付方式可选，主按钮「扫码付款」，「去浏览器付款」退成次要入口（docs/ui/in-app-payment.md §6.1）
  const payInApp = !!checkout && checkoutAvailable(catalog)
  const methodOptions = payInApp ? checkoutMethods(catalog) : []
  const method = pickMethod(methodOptions, methodChoice, savedMethod)
  const scan = (): void => {
    if (!checkout || !check.ok || !quote || !method) return
    saveMethod(method)
    checkout.start(balanceIntent({ amount: check.value, method, quote, dueTrusted, payCurrency }), false)
  }
  const error =
    !check.ok && check.reason !== 'empty'
      ? check.reason === 'format'
        ? tr('settings.account.TopUp.enterAmountWithUp')
        : check.reason === 'min'
          ? tr('settings.account.TopUp.minAmount', { p0: formatPrice(recharge.min, payCurrency) })
          : tr('settings.account.TopUp.maxAmount', { p0: formatPrice(recharge.max, payCurrency) })
      : null

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h4 className="mb-2 text-ui font-medium text-fg">{tr('settings.account.TopUp.payAmount')}</h4>
        <div
          className={cn(
            'flex h-9 w-56 items-center gap-1 rounded-md border bg-surface px-3',
            error ? 'border-danger' : 'border-line-strong focus-within:border-accent-line',
          )}
        >
          <span className="text-ui text-fg-muted">{payCurrency.toUpperCase() === 'CNY' ? '¥' : payCurrency}</span>
          <input
            aria-label={tr('settings.account.TopUp.payAmount')}
            inputMode="decimal"
            value={text}
            placeholder={rangeText(recharge, payCurrency)}
            onChange={e => setText(e.target.value.replace(/[^\d.]/g, ''))}
            className="min-w-0 flex-1 bg-transparent text-ui text-fg tabular-nums outline-none placeholder:text-fg-faint"
          />
        </div>
        <p className={cn('mt-1.5 text-meta', error ? 'text-danger' : 'text-fg-faint')}>
          {error ?? rangeLine(recharge, payCurrency)}
        </p>
        {recharge.multiplier !== 1 && (
          <p className="mt-1 text-meta text-fg-faint">
            {tr('settings.account.TopUp.multiplier', {
              p0: formatPrice(1, payCurrency),
              p1: formatAmount(recharge.multiplier, currency),
            })}
          </p>
        )}
      </div>

      {recharge.bonusTiers.length > 0 && (
        <div>
          <h4 className="mb-2 text-ui font-medium text-fg">
            {recharge.bonusMode === 'discount'
              ? tr('settings.account.TopUp.discountRules')
              : tr('settings.account.TopUp.bonusRules')}
          </h4>
          <ul className="flex flex-col gap-1 text-meta text-fg-secondary">
            {recharge.bonusTiers.map(t => (
              <li key={t.minAmount}>
                {tr(
                  recharge.bonusMode === 'discount'
                    ? 'settings.account.TopUp.discountTier'
                    : 'settings.account.TopUp.bonusTier',
                  { p0: formatPrice(t.minAmount, payCurrency), p1: t.bonusPercent },
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h4 className="mb-2 text-ui font-medium text-fg">{tr('settings.account.TopUp.paymentMethod')}</h4>
        {payInApp && method ? (
          <MethodPicker
            options={methodOptions}
            value={method}
            label={tr('settings.account.TopUp.paymentMethod')}
            onChange={setMethodChoice}
          />
        ) : (
          <>
            <ul className="flex flex-wrap gap-2" aria-label={tr('settings.account.TopUp.paymentMethod')}>
              {methods.map(m => (
                <li
                  key={m.type}
                  className="rounded-md border border-line bg-subtle px-2.5 py-1 text-meta text-fg-secondary"
                >
                  {m.label}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-meta text-fg-faint">{tr('settings.account.TopUp.chooseInBrowser')}</p>
          </>
        )}
      </div>

      <div className="rounded-lg border border-line bg-surface p-4">
        <dl className="flex flex-col gap-1.5 text-ui">
          <div className="flex justify-between gap-4">
            <dt className="text-fg-muted">{tr('settings.account.TopUp.creditsReceived')}</dt>
            <dd className="text-fg tabular-nums">
              {quote ? formatAmount(quote.credited, currency) : '—'}
              {quote && quote.bonus > 0 && (
                <span className="ml-1 text-meta text-accent-fg">
                  {tr('settings.account.TopUp.includingBonusAmount', { p0: formatAmount(quote.bonus, currency) })}
                </span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-fg-muted">{tr('settings.account.TopUp.amountDue')}</dt>
            <dd className="text-section font-semibold text-fg tabular-nums">
              {quote && dueTrusted && Number.isFinite(quote.pay) ? formatPrice(quote.pay, payCurrency) : '—'}
              {quote && dueTrusted && quote.fee > 0 && (
                <span className="ml-1 text-meta font-normal text-fg-muted">
                  {tr('settings.account.TopUp.includingFee', { p0: formatPrice(quote.fee, payCurrency) })}
                </span>
              )}
            </dd>
          </div>
        </dl>
        {quote && !dueTrusted && (
          <p className="mt-1.5 text-meta text-fg-faint">{tr('settings.account.TopUp.currencyUnsure')}</p>
        )}
        {payInApp ? (
          <>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              {redeem}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  icon={ExternalLink}
                  disabled={!check.ok}
                  className="h-7 px-2 text-meta"
                  onClick={() => onOpen('purchase')}
                >
                  {tr('settings.account.TopUp.payInBrowser')}
                </Button>
                <Button
                  variant="primary"
                  icon={QrCodeIcon}
                  disabled={!check.ok || !method}
                  className={cn(
                    'px-5',
                    (!check.ok || !method) &&
                      'cursor-not-allowed bg-disabled! text-disabled-fg! shadow-none! hover:opacity-100',
                  )}
                  onClick={scan}
                >
                  {tr('settings.account.TopUp.scanToPay')}
                </Button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
              {email && <AccountCheckLine email={email} />}
              <span className="text-label text-fg-faint">{tr('settings.account.TopUp.reenterAmount')}</span>
              <Button
                variant="ghost"
                icon={copied ? Check : Copy}
                disabled={!check.ok}
                className="h-7 px-2 text-meta"
                onClick={copyAmount}
              >
                {copied ? tr('settings.account.TopUp.amountCopied') : tr('settings.account.TopUp.copyAmount')}
              </Button>
            </div>
          </>
        ) : (
          <div className="mt-4 flex items-center justify-between gap-3">
            {redeem}
            <div className="flex items-center gap-2">
              <span className="text-meta text-fg-muted">{tr('settings.account.TopUp.reenterAmount')}</span>
              <Button
                variant="ghost"
                icon={copied ? Check : Copy}
                disabled={!check.ok}
                className="h-7 px-2 text-meta"
                onClick={copyAmount}
              >
                {copied ? tr('settings.account.TopUp.amountCopied') : tr('settings.account.TopUp.copyAmount')}
              </Button>
              <Button
                variant="primary"
                disabled={!!error}
                className={cn(
                  'px-5',
                  error && 'cursor-not-allowed bg-disabled! text-disabled-fg! shadow-none! hover:opacity-100',
                )}
                onClick={() => onOpen('purchase')}
              >
                {tr('settings.account.TopUp.pay')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {payInApp && checkout && <PendingOrderBar orders={checkout.pending} onResume={checkout.resume} />}

      {helpText && <p className="selectable -mt-2 text-meta text-fg-faint">{helpText}</p>}
    </div>
  )
}

function rangeText(r: StoreRecharge, currency: string): string {
  const min = formatPrice(r.min, currency)
  return r.max > 0 ? `${min} – ${formatPrice(r.max, currency)}` : min
}

function rangeLine(r: StoreRecharge, currency: string): string {
  if (r.max > 0)
    return tr('settings.account.TopUp.range', { p0: formatPrice(r.min, currency), p1: formatPrice(r.max, currency) })
  return r.min > 0
    ? tr('settings.account.TopUp.minAmount', { p0: formatPrice(r.min, currency) })
    : tr('settings.account.TopUp.anyAmount')
}

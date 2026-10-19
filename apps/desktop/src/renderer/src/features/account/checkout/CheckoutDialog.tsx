import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '../../../i18n/core'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Circle, CircleDot, ExternalLink, X } from 'lucide-react'
import { formatAmount, formatPrice } from '@/features/account'
import { Button, IconButton, Spinner, cn } from '@/ui'
import { QrCode } from '@/ui/QrCode'
import { useTheme } from '@/features/appearance/ThemeProvider'
import type { CheckoutOrder, StoreMethod } from '../../../../../shared/types/account'
import { changeLines, MethodPicker } from '../settings/StoreParts'
import { validityLabel } from '../storeLogic'
import type { CheckoutFlow, FlowState } from './checkoutFlow'
import {
  STEPS,
  amountDiffers,
  canVerifyExpired,
  checkoutErrorText,
  countdownAnnounce,
  focusTrapTarget,
  formatCountdown,
  inExpiredWatchWindow,
  orderPhase,
  remainingMs,
  saveMethod,
  SLOW_CREDIT_MS,
  stepIndex,
  type CheckoutIntent,
  type DialogPhase,
} from './checkoutLogic'

const key = (suffix: string): TranslationKey => `settings.account.Checkout.${suffix}` as TranslationKey

/** 每秒刷新一次「现在」（倒计时用）；fixed 是测试用的固定时间 */
function useNow(active: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now())
  useEffect(() => {
    if (!active || fixed !== undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, fixed])
  return fixed ?? now
}

export interface CheckoutPanelProps {
  flow: CheckoutFlow
  state: FlowState
  /** 「准备」步骤里可选的支付方式 */
  methods: StoreMethod[]
  /** 账号币种：到账额度的单位 */
  currency: string
  /** 登录账号的邮箱：「确认账号」里提示浏览器里应该登录的是谁 */
  email: string
  /** 另外还有未付款的订单：提示旧码仍然可以付款（docs/ui/in-app-payment.md §10.2） */
  otherPending: boolean
  /** 关闭弹窗（不取消订单） */
  onClose: () => void
  /** 改用浏览器付款：关弹窗（订单留着），照原来的流程打开面板 */
  onBrowser: () => void
  /** 固定「现在」的时刻（测试用） */
  now?: number
  /** 一开始就处在「取消订单」的二次确认里（测试用） */
  initialConfirmingCancel?: boolean
}

/**
 * 软件内付款弹窗（docs/ui/in-app-payment.md §6.3、§6.12）：portal + 遮罩，叠在设置窗口上面。
 * 点遮罩、按 Esc 都只是关闭，不取消订单；取消订单要在弹窗里二次确认
 */
export function CheckoutDialog(props: CheckoutPanelProps) {
  useI18n()
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-scrim p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <CheckoutPanel {...props} />
    </div>,
    document.body,
  )
}

/** 弹窗本体（可单独渲染测试）：role=dialog、焦点循环、Esc 关闭、关闭后焦点回到触发按钮 */
export function CheckoutPanel({
  flow,
  state,
  methods,
  currency,
  email,
  otherPending,
  onClose,
  onBrowser,
  now: fixedNow,
  initialConfirmingCancel = false,
}: CheckoutPanelProps) {
  useI18n()
  const { order, intent } = state
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [confirmingCancel, setConfirmingCancel] = useState(initialConfirmingCancel)
  const [minuteNote, setMinuteNote] = useState<string | null>(null)

  const now = useNow(state.phase === 'order', fixedNow)
  const remaining = order ? remainingMs(order, state.receivedAt, now) : 0
  const phase: DialogPhase =
    state.phase !== 'order' ? state.phase : order ? orderPhase(order.status, remaining) : 'creating'
  // 订单阶段面板凭证中途失效：还在等 / 查的订单要先去浏览器确认账号才查得下去，这时主按钮是「去浏览器确认账号」
  const panelBad = order?.panelValid === false && (phase === 'waiting' || phase === 'paid' || phase === 'expired')
  // pay_url 订单（只给收银台网页）：不显示二维码，在付款窗口里付。窗口被用户关了 / 没加载出来时「重新打开付款窗口」当主按钮
  const payWindowMode = order?.qrSource === 'pay_url'
  const reopenPrimary = payWindowMode && (state.payWindow === 'closed' || state.payWindow === 'failed')

  // 键盘与焦点：Esc 关闭（二次确认时只退回上一步）、Tab 在弹窗里循环、关闭后焦点回到触发按钮
  const handlers = useRef({ onClose, confirmingCancel })
  handlers.current = { onClose, confirmingCancel }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (handlers.current.confirmingCancel) setConfirmingCancel(false)
        else handlers.current.onClose()
      } else if (event.key === 'Tab') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]') ?? [])]
        const active = items.indexOf(document.activeElement as HTMLElement)
        const target = focusTrapTarget(event.shiftKey, active, items.length)
        if (target) {
          event.preventDefault()
          ;(target === 'first' ? items[0] : items.at(-1))?.focus()
        } else if (items.length === 0) {
          event.preventDefault()
          ref.current?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    setConfirmingCancel(false)
    setMinuteNote(null)
  }, [phase])

  // 内容状态变了（生成好二维码、收到付款、进入二次确认……）：焦点放到这一步的主要按钮上；没有主要按钮就留在原处
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const main = root.querySelector<HTMLElement>('[data-autofocus]')
    if (main) main.focus({ preventScroll: true })
    else if (!root.contains(document.activeElement))
      root.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
  }, [phase, confirmingCancel, panelBad, state.payWindow])

  // 本地倒计时到 0 就算过期：服务端状态可能还没跟上，先把付款窗口关掉（别的终态由 flow 随订单状态关）
  useEffect(() => {
    if (phase === 'expired') flow.closePayWindow()
  }, [phase, flow])

  // 倒计时不播报，只在剩 5 分钟和 1 分钟时各播报一次
  const lastRemaining = useRef(remaining)
  useEffect(() => {
    const minutes = phase === 'waiting' ? countdownAnnounce(lastRemaining.current, remaining) : null
    lastRemaining.current = remaining
    if (minutes) setMinuteNote(tr(key(minutes === 5 ? 'announce.minutes5' : 'announce.minute1')))
  }, [remaining, phase])

  const errorText = (e: FlowState['error']): string => (e ? checkoutErrorText(e, intent?.payCurrency) : '')
  const title =
    phase === 'completed' ? tr(key('title.done')) : phase === 'reauth' ? tr(key('title.reauth')) : tr(key('title.pay'))
  const lines = phase === 'completed' && state.outcome?.change ? changeLines(state.outcome.change, currency) : []

  // 状态播报（sr-only 的 role=status）：只在状态变化时读，内容是这一步的结论
  let announce = ''
  if (phase === 'creating') announce = tr(key('creating'))
  else if (phase === 'reauth') announce = tr(key('reauth.intro'))
  // phase=error 的原因本身是 role=alert（会被读出来），这里不重复
  else if (phase === 'waiting') announce = tr(key('step.waiting'))
  else if (phase === 'paid') announce = tr(key('paid.title'))
  else if (phase === 'completed')
    announce = lines.length ? tr(key('announce.arrived'), { p0: lines.join(' / ') }) : tr(key('done'))
  else if (phase === 'expired') announce = tr(key('expired'))
  else if (phase === 'ended' && order) announce = endedText(order)

  const verifyBusy = state.busy === 'verify' || state.verifyLocked
  const reauthWaiting = state.reauth === 'opening' || state.reauth === 'waiting'
  const panelConfirmButton = (
    <Button variant="primary" data-autofocus="" disabled={reauthWaiting} onClick={() => void flow.startReauth()}>
      {state.reauth === 'timeout' ? tr(key('reauth.again')) : tr(key('panelInvalid.go'))}
    </Button>
  )
  // pay_url 订单里「在浏览器打开支付页」（WaitingBody）打开的是这笔订单的收银台；这个按钮是关弹窗、去网页面板重新走购买流程。
  // 两个都叫「浏览器」会让人以为是同一件事，所以 pay_url 订单里这个写成「去网页面板付款」
  const browserButton = (
    <Button variant="ghost" icon={ExternalLink} onClick={onBrowser}>
      {tr(key(payWindowMode ? 'payInBrowser.panel' : 'payInBrowser'))}
    </Button>
  )
  const verifyButton = (primary: boolean) => (
    <Button
      variant={primary && !panelBad ? 'primary' : 'outline'}
      data-autofocus={primary && !panelBad ? '' : undefined}
      disabled={verifyBusy || state.busy === 'cancel'}
      onClick={() => void flow.verify()}
    >
      {tr(key('verify'))}
    </Button>
  )
  // 凭证失效时不让「重新下单」当主按钮 / 抢焦点：旧单可能其实已经付了，再下一单会让用户付第二次
  const reorderButton = intent ? (
    <Button
      variant={panelBad ? 'outline' : 'primary'}
      data-autofocus={panelBad ? undefined : ''}
      onClick={() => flow.reorder()}
    >
      {tr(key('reorder'))}
    </Button>
  ) : null

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="pop-in w-full max-w-lg rounded-xl border border-line-card bg-popover p-5 text-fg shadow-popover outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 id={titleId} className="min-w-0 break-words text-section font-semibold">
          {title}
        </h3>
        <IconButton icon={X} label={tr(key('close'))} onClick={onClose} />
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {minuteNote ?? announce}
      </div>

      <div className="mt-3 flex flex-col gap-4 text-ui">
        {phase === 'prepare' && intent && (
          <>
            <IntentSummary intent={intent} currency={currency} />
            <div>
              <h4 className="mb-2 text-ui font-medium text-fg">{tr('settings.account.TopUp.paymentMethod')}</h4>
              <MethodPicker
                options={methods}
                value={intent.method}
                label={tr('settings.account.TopUp.paymentMethod')}
                onChange={method => {
                  saveMethod(method)
                  flow.setMethod(method)
                }}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                {tr(key('cancel'))}
              </Button>
              <Button variant="primary" data-autofocus="" onClick={() => void flow.submit()}>
                {tr('settings.account.TopUp.scanToPay')}
              </Button>
            </div>
          </>
        )}

        {phase === 'creating' && (
          <p className="flex items-center gap-2 py-6 text-fg-muted">
            <Spinner />
            {tr(key('creating'))}
          </p>
        )}

        {phase === 'reauth' && (
          <>
            <div>
              <p className="text-fg-secondary">{tr(key('reauth.intro'))}</p>
              <p className="selectable mt-1 text-fg-secondary">{tr(key('reauth.account'), { p0: email })}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                data-autofocus=""
                disabled={reauthWaiting}
                onClick={() => void flow.startReauth()}
              >
                {state.reauth === 'timeout' ? tr(key('reauth.again')) : tr(key('reauth.go'))}
              </Button>
              {browserButton}
              <Button variant="outline" className="ml-auto" onClick={onClose}>
                {tr(key('cancel'))}
              </Button>
            </div>
            {state.reauth === 'waiting' && (
              <p className="flex items-center gap-2 text-meta text-fg-muted">
                <Spinner />
                {tr(key('reauth.waiting'))}
              </p>
            )}
            {state.reauth === 'timeout' && (
              <p role="alert" className="text-meta text-danger">
                {tr(key('reauth.timeout'))}
              </p>
            )}
            {state.reauthError && (
              <p role="alert" className="selectable text-meta text-danger">
                {errorText(state.reauthError)}
              </p>
            )}
          </>
        )}

        {phase === 'error' && (
          <>
            <p role="alert" className="selectable text-fg-secondary">
              {errorText(state.error)}
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {browserButton}
              <Button variant="outline" onClick={onClose}>
                {tr(key('close'))}
              </Button>
              <Button variant="primary" data-autofocus="" onClick={() => flow.retry()}>
                {tr(key('retry'))}
              </Button>
            </div>
          </>
        )}

        {order && phase === 'waiting' && (
          <WaitingBody
            order={order}
            intent={intent}
            currency={currency}
            remaining={remaining}
            otherPending={otherPending}
            flow={flow}
            payWindow={state.payWindow}
            reopenPrimary={reopenPrimary}
          />
        )}
        {order && phase === 'paid' && (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 font-medium text-accent-fg">
              <Spinner />
              {tr(key('paid.title'))}
            </p>
            <p className="text-meta text-fg-muted">{tr(key('paid.hint'))}</p>
            {state.paidAt !== null && now - state.paidAt > SLOW_CREDIT_MS && (
              <p className="text-meta text-fg-secondary">{tr(key('paid.slow'), { p0: order.orderId })}</p>
            )}
          </div>
        )}
        {order && phase === 'completed' && (
          <div className="flex flex-col items-center gap-1 py-2 text-center">
            <span className="flex items-center gap-1.5 text-section font-semibold text-accent-fg">
              <Check size={18} strokeWidth={2} aria-hidden />
              {tr(key('done'))}
            </span>
            {state.outcome?.settling && (
              <p className="flex items-center gap-2 text-meta text-fg-muted">
                <Spinner />
                {tr(key('done.reading'))}
              </p>
            )}
            {lines.length > 0 && (
              <ul className="selectable text-fg-secondary tabular-nums">
                {lines.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {order && phase === 'expired' && (
          <div className="flex flex-col gap-1">
            <p className="font-medium text-fg">{tr(key('expired'))}</p>
            {canVerifyExpired(remaining) && <p className="text-meta text-fg-muted">{tr(key('expired.hint'))}</p>}
          </div>
        )}
        {order && phase === 'ended' && <p className="font-medium text-fg">{endedText(order)}</p>}

        {(phase === 'waiting' || phase === 'paid' || phase === 'completed') && <Steps index={stepIndex(phase)} />}

        {order && phase === 'waiting' && (
          <>
            {confirmingCancel ? (
              <div role="alertdialog" aria-label={tr(key('cancelOrder'))} className="flex flex-col gap-2">
                <p className="text-fg-secondary">{tr(key('cancelConfirm'))}</p>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" data-autofocus="" onClick={() => setConfirmingCancel(false)}>
                    {tr(key('back'))}
                  </Button>
                  <Button
                    variant="primary"
                    className="bg-danger!"
                    disabled={state.busy === 'cancel'}
                    onClick={() => {
                      setConfirmingCancel(false)
                      void flow.cancel()
                    }}
                  >
                    {tr(key('cancelConfirmOk'))}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {verifyButton(!reopenPrimary)}
                <Button variant="outline" disabled={state.busy === 'cancel'} onClick={() => setConfirmingCancel(true)}>
                  {tr(key('cancelOrder'))}
                </Button>
                <span className="ml-auto">{browserButton}</span>
              </div>
            )}
            {order.payUrl && !payWindowMode && !confirmingCancel && (
              <button
                type="button"
                className="press self-start text-meta text-fg-muted underline-offset-2 hover:text-fg hover:underline"
                onClick={() => void flow.openPayUrl()}
              >
                {tr(key('openPayPage'))} <ExternalLink size={11} className="inline" aria-hidden />
              </button>
            )}
          </>
        )}
        {order && phase === 'paid' && (
          <div className="flex justify-end">
            <Button variant="outline" data-autofocus={panelBad ? undefined : ''} onClick={onClose}>
              {tr(key('close'))}
            </Button>
          </div>
        )}
        {order && phase === 'completed' && (
          <div className="flex justify-end">
            <Button variant="primary" data-autofocus="" onClick={onClose}>
              {tr(key('done.finish'))}
            </Button>
          </div>
        )}
        {order && phase === 'expired' && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {tr(key('close'))}
            </Button>
            {canVerifyExpired(remaining) && verifyButton(!intent)}
            {reorderButton}
          </div>
        )}
        {order && phase === 'ended' && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" data-autofocus={intent ? undefined : ''} onClick={onClose}>
              {tr(key('close'))}
            </Button>
            {/* failed 是已经付了钱、到账出了问题：不给「重新下单」，免得再付一次 */}
            {order.status !== 'failed' && reorderButton}
          </div>
        )}

        {order && (phase === 'waiting' || phase === 'expired') && state.notYet && (
          <p className="text-meta text-fg-muted">
            {/* 过期后还在自动再查的窗口内说会再查；窗口外已经不查了，让用户手动再点或联系客服 */}
            {phase === 'expired' && !inExpiredWatchWindow(remaining)
              ? tr(key('notYet.stopped'), { p0: order.orderId })
              : tr(key('notYet'))}
          </p>
        )}
        {order && panelBad && (
          <div className="flex flex-col gap-2">
            <p role="note" className="text-meta text-warn">
              {tr(key('panelInvalid'))}
            </p>
            <div className="flex flex-wrap items-center gap-2">{panelConfirmButton}</div>
            {state.reauth === 'waiting' && (
              <p className="flex items-center gap-2 text-meta text-fg-muted">
                <Spinner />
                {tr(key('panelInvalid.waiting'))}
              </p>
            )}
            {state.reauth === 'timeout' && (
              <p role="alert" className="text-meta text-danger">
                {tr(key('reauth.timeout'))}
              </p>
            )}
            {state.reauthError && (
              <p role="alert" className="selectable text-meta text-danger">
                {errorText(state.reauthError)}
              </p>
            )}
          </div>
        )}
        {state.unstable && !state.watchError && phase === 'waiting' && (
          <p className="text-meta text-fg-faint">{tr(key('networkUnstable'))}</p>
        )}
        {state.watchError && (
          <div role="alert" className="flex items-center gap-2 text-meta text-danger">
            <span className="min-w-0 flex-1">{tr(key('watchFailed'))}</span>
            <Button variant="outline" onClick={() => flow.retryWatch()}>
              {tr(key('retry'))}
            </Button>
          </div>
        )}
        {state.actionError && (
          <p role="alert" className="selectable text-meta text-danger">
            {errorText(state.actionError)}
          </p>
        )}
      </div>
    </div>
  )
}

/** 订单没有二维码以外的终态：取消 / 失败 / 退款 */
function endedText(order: CheckoutOrder): string {
  switch (order.status) {
    case 'cancelled':
      return tr(key('ended.cancelled'))
    case 'failed':
      return tr(key('ended.failed'))
    case 'refunding':
      return tr(key('ended.refunding'))
    case 'refunded':
      return tr(key('ended.refunded'))
    default:
      return tr(key('ended.unknown'))
  }
}

/** 准备 / 下单时的摘要：余额充值显示到账和应付估算，套餐显示名称、价格和有效期 */
function IntentSummary({ intent, currency }: { intent: CheckoutIntent; currency: string }) {
  useI18n()
  if (intent.kind === 'plan' && intent.plan) {
    const { name, price, validityDays, currency: planCurrency } = intent.plan
    return (
      <div className="rounded-lg border border-line bg-surface px-4 py-3">
        <div className="text-ui font-medium text-fg">{name}</div>
        <div className="mt-1 text-fg-secondary tabular-nums">
          {formatPrice(price, planCurrency)}
          {validityDays > 0 && <span className="text-meta text-fg-muted"> / {validityLabel(validityDays)}</span>}
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 tabular-nums">
      <div className="text-fg-secondary">
        {balanceSummary(intent.estimateCredited ?? null, intent.estimateBonus ?? 0, currency)}
      </div>
      {intent.estimatePay !== null && (
        <div className="mt-1 text-fg">{formatPrice(intent.estimatePay, intent.payCurrency)}</div>
      )}
    </div>
  )
}

/** 「余额充值 · 到账 $126（含赠送 $6）」 */
function balanceSummary(credited: number | null, bonus: number, currency: string): string {
  const head = tr(key('summary.balance'))
  if (credited === null) return head
  const got = tr(key('summary.credited'), { p0: formatAmount(credited, currency) })
  const extra =
    bonus > 0 ? tr('settings.account.TopUp.includingBonusAmount', { p0: formatAmount(bonus, currency) }) : ''
  return `${head} · ${got}${extra}`
}

/** 等待付款：二维码（pay_url 订单是付款窗口的说明和按钮）、应付金额、方式、倒计时 */
function WaitingBody({
  order,
  intent,
  currency,
  remaining,
  otherPending,
  flow,
  payWindow,
  reopenPrimary,
}: {
  order: CheckoutOrder
  intent: CheckoutIntent | null
  currency: string
  remaining: number
  otherPending: boolean
  flow: CheckoutFlow
  payWindow: FlowState['payWindow']
  reopenPrimary: boolean
}) {
  useI18n()
  const { resolved } = useTheme()
  const demoMode = typeof window !== 'undefined' && window.pixelsky?.demo === true
  const due = formatPrice(order.payAmount, order.payCurrency)
  const summary =
    order.kind === 'plan' && order.plan
      ? order.plan.validityDays > 0
        ? `${order.plan.name} / ${validityLabel(order.plan.validityDays)}`
        : order.plan.name
      : balanceSummary(order.credited, order.bonus ?? 0, currency)
  const inWindow = order.qrSource === 'pay_url'
  // 「付款窗口已关闭」不是 live region：焦点跳到「重新打开」按钮时靠 aria-describedby 把这句读出来
  const closedNoteId = useId()
  return (
    <div className="flex flex-col gap-3">
      <p className="selectable text-fg-secondary">{summary}</p>
      <div className="flex items-start gap-5">
        {inWindow ? (
          <div className="flex w-[220px] shrink-0 flex-col gap-2">
            <p className="selectable text-fg">{tr(key('payWindow.hint'), { p0: order.methodLabel })}</p>
            {demoMode && <p className="text-label text-warn">{tr(key('payWindow.demo'))}</p>}
            {payWindow === 'opening' && (
              <p className="flex items-center gap-2 text-meta text-fg-muted">
                <Spinner />
                {tr(key('payWindow.opening'))}
              </p>
            )}
            {payWindow === 'closed' && (
              <p id={closedNoteId} className="text-meta text-fg-muted">
                {tr(key('payWindow.closed'))}
              </p>
            )}
            {payWindow === 'failed' && (
              <p role="alert" className="text-meta text-danger">
                {tr(key('payWindow.failed'))}
              </p>
            )}
            <Button
              variant={reopenPrimary ? 'primary' : 'outline'}
              data-autofocus={reopenPrimary ? '' : undefined}
              aria-describedby={payWindow === 'closed' ? closedNoteId : undefined}
              onClick={() => void flow.openPayWindow()}
            >
              {tr(key('payWindow.reopen'))}
            </Button>
            <Button variant="ghost" icon={ExternalLink} onClick={() => void flow.openPayUrl()}>
              {tr(key('payWindow.browser'))}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            {order.qrContent ? (
              <QrCode
                text={order.qrContent}
                ecc="M"
                fit={{ min: 180, max: 220 }}
                dark={resolved === 'dark'}
                label={tr(key('qrLabel'), { p0: order.methodLabel, p1: due })}
              />
            ) : (
              <p className="w-44 text-meta text-fg-muted">{tr(key('noQr'))}</p>
            )}
            {demoMode && <p className="max-w-[220px] text-center text-label text-warn">{tr(key('demoQr'))}</p>}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-meta text-fg-muted">{tr(key('amountDue'))}</div>
          <div className="text-title leading-tight font-semibold text-fg tabular-nums">{due}</div>
          {order.feeRate > 0 && (
            <div className="text-meta text-fg-muted">{tr(key('feeIncluded'), { p0: order.feeRate })}</div>
          )}
          {amountDiffers(order, intent) && <p className="mt-1 text-meta text-warn">{tr(key('amountDiffers'))}</p>}
          <div className="mt-3 text-fg">{order.methodLabel}</div>
          {!inWindow && <div className="text-meta text-fg-muted">{tr(key('scanWith'), { p0: order.methodLabel })}</div>}
          <div className={cn('mt-1 tabular-nums', remaining < 5 * 60_000 ? 'text-warn' : 'text-fg-secondary')}>
            {tr(key('remaining'), { p0: formatCountdown(remaining) })}
          </div>
          {order.reused && <p className="mt-2 text-meta text-fg-secondary">{tr(key('reused'))}</p>}
          {!order.reused && otherPending && (
            <p className="mt-2 text-meta text-fg-muted">{tr(key('oldQrStillValid'))}</p>
          )}
        </div>
      </div>
    </div>
  )
}

/** 状态条：● 等待付款 ─ ○ 已付款 ─ ○ 已到账。每一步都有文字和图标，不只靠颜色 */
function Steps({ index }: { index: number }) {
  useI18n()
  return (
    <ol aria-label={tr(key('steps'))} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
      {STEPS.map((step, i) => {
        const done = index === 2 || i < index
        const current = i === index
        const Icon = done ? Check : current ? CircleDot : Circle
        return (
          <li
            key={step}
            aria-current={current ? 'step' : undefined}
            className={cn('flex items-center gap-1', done || current ? 'text-fg' : 'text-fg-faint')}
          >
            {i > 0 && (
              <span aria-hidden className="mr-1 text-fg-faint">
                ─
              </span>
            )}
            <Icon size={13} strokeWidth={2} aria-hidden className={done || current ? 'text-accent-fg' : undefined} />
            {tr(key(`step.${step}`))}
          </li>
        )
      })}
    </ol>
  )
}

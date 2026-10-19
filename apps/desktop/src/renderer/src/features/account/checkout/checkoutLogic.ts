// 软件内付款的纯计算（docs/ui/in-app-payment.md §6.3、§6.9、§6.12）：订单状态映射、倒计时、应付与估算的差异、
// 错误码到文案、支付方式的记忆和键盘导航。不依赖 React，方便测试。
import { parseCodedError } from '@pixelsky/protocol'
import { tr, translateMessage, type TranslationKey } from '../../../i18n/core'
import { formatPrice } from '../format'
import { round2, type RechargeQuote } from '../storeLogic'
import { cleanIpcError } from '../useStore'
import type {
  CheckoutKind,
  CheckoutOrder,
  CheckoutStatus,
  StoreCatalog,
  StoreMethod,
  StorePlan,
} from '../../../../../shared/types/account'

// ---------------------------------------------------------------------------
// 下单意图
// ---------------------------------------------------------------------------

/**
 * 一次「下单意图」：点「扫码付款」时由充值 / 套餐页给出。重试、确认账号后续下单都用同一份参数（和同一个 requestId）。
 * estimate* 只用来和 Sub2api 返回的金额对比，真正的应付以订单为准
 */
export interface CheckoutIntent {
  kind: CheckoutKind
  /** kind=balance：支付金额 */
  amount?: number
  /** kind=plan：在售套餐 id */
  planId?: number
  method: string
  /** 估算应付（支付币种）；拿不准币种时为 null */
  estimatePay: number | null
  payCurrency: string
  /** 估算到账额度和赠送（余额充值；订单还没回来时先用它显示） */
  estimateCredited?: number | null
  estimateBonus?: number
  /** 套餐摘要（kind=plan）：准备步骤显示套餐名、价格、有效期 */
  plan?: { name: string; validityDays: number; price: number; currency: string }
}

/** 充值页的下单意图：应付只有币种拿得准（dueTrusted）时才当估算 */
export function balanceIntent(input: {
  amount: number
  method: string
  quote: Pick<RechargeQuote, 'pay' | 'credited' | 'bonus'>
  dueTrusted: boolean
  payCurrency: string
}): CheckoutIntent {
  const { quote } = input
  return {
    kind: 'balance',
    amount: input.amount,
    method: input.method,
    estimatePay: input.dueTrusted && Number.isFinite(quote.pay) ? quote.pay : null,
    payCurrency: input.payCurrency,
    estimateCredited: quote.credited,
    estimateBonus: quote.bonus,
  }
}

/** 套餐页的下单意图：估算应付就是标价（套餐自己的币种） */
export function planIntent(plan: StorePlan, method: string): CheckoutIntent {
  return {
    kind: 'plan',
    planId: plan.id,
    method,
    estimatePay: plan.price,
    payCurrency: plan.currency,
    plan: { name: plan.name, validityDays: plan.validityDays, price: plan.price, currency: plan.currency },
  }
}

/** 支付方式：商品数据里的方式和软件内付款能用的（checkout.methods）取交集，保持商品数据的顺序 */
export function checkoutMethods(catalog: Pick<StoreCatalog, 'methods' | 'checkout'>): StoreMethod[] {
  const allowed = catalog.checkout?.methods ?? []
  return catalog.methods.filter(m => allowed.includes(m.type))
}

/** 软件内付款可用：云端开着、总开关开着、至少有一种能扫码的方式。否则页面和以前一模一样 */
export function checkoutAvailable(catalog: Pick<StoreCatalog, 'enabled' | 'methods' | 'checkout'>): boolean {
  return catalog.enabled && catalog.checkout?.enabled === true && checkoutMethods(catalog).length > 0
}

const METHOD_KEY = 'pixelsky.checkout.method'

/** 上次选的支付方式（localStorage）；读不到或不可用返回 null */
export function loadMethod(): string | null {
  try {
    return localStorage.getItem(METHOD_KEY)
  } catch {
    return null
  }
}
export function saveMethod(method: string): void {
  try {
    localStorage.setItem(METHOD_KEY, method)
  } catch {
    /* localStorage 不可用就不记 */
  }
}

/** 选中的支付方式：当前选的还在列表里就用它，否则用记住的，再否则第一个；没有可选方式返回 null */
export function pickMethod(options: StoreMethod[], current: string | null, saved: string | null): string | null {
  for (const want of [current, saved]) if (want && options.some(m => m.type === want)) return want
  return options[0]?.type ?? null
}

// ---------------------------------------------------------------------------
// 状态映射、倒计时
// ---------------------------------------------------------------------------

/** 弹窗的内容状态：订单还没有的（准备 / 下单 / 确认账号 / 出错）和订单自己的状态 */
export type DialogPhase =
  | 'prepare'
  | 'creating'
  | 'reauth'
  | 'error'
  | 'waiting'
  | 'paid'
  | 'completed'
  | 'expired'
  | 'ended'

/**
 * 订单状态 → 弹窗状态。待付单到了 expires_at 就算过期（云端核实之前先这样显示）；
 * 已取消 / 失败 / 退款 / 不认识的状态都是终态，弹窗显示原因
 */
export function orderPhase(status: CheckoutStatus, remaining: number): DialogPhase {
  switch (status) {
    case 'pending':
      return remaining <= 0 ? 'expired' : 'waiting'
    case 'paid':
      return 'paid'
    case 'completed':
      return 'completed'
    case 'expired':
      return 'expired'
    default:
      return 'ended'
  }
}

/** 订单进入这个状态后不用再轮询（终态）；expired 时「我已付款」仍可手动核实 */
export function isFinalStatus(status: CheckoutStatus): boolean {
  return status !== 'pending' && status !== 'paid'
}

/** 状态条的三步：等待付款 → 已付款 → 已到账 */
export const STEPS = ['waiting', 'paid', 'completed'] as const
export type Step = (typeof STEPS)[number]

/** 当前走到第几步（0 起）；已过期 / 终态返回 -1（不画进度） */
export function stepIndex(phase: DialogPhase): number {
  return phase === 'waiting' ? 0 : phase === 'paid' ? 1 : phase === 'completed' ? 2 : -1
}

/**
 * 离到期还有多久（毫秒，可能为负）：剩余 = expires_at − server_time − (本机现在 − 收到响应的时刻)。
 * 只用时间差，本机时钟快 / 慢多少都不影响
 */
export function remainingMs(
  order: Pick<CheckoutOrder, 'expiresAt' | 'serverTime'>,
  receivedAt: number,
  now: number,
): number {
  const expires = Date.parse(order.expiresAt)
  const server = Date.parse(order.serverTime)
  if (!Number.isFinite(expires) || !Number.isFinite(server)) return 0
  return expires - server - (now - receivedAt)
}

/** 倒计时文字 mm:ss（不翻译）；负数当 0，超过 1 小时显示 h:mm:ss */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 倒计时的无障碍播报：只在剩 5 分钟和 1 分钟时各播一次。prev → now 之间越过哪个门槛就返回哪个（都越过了取更小的） */
export function countdownAnnounce(prevMs: number, nowMs: number): 5 | 1 | null {
  const crossed = (limit: number): boolean => prevMs > limit * 60_000 && nowMs <= limit * 60_000
  if (crossed(1)) return 1
  if (crossed(5)) return 5
  return null
}

/**
 * 过期以后「我已付款」还保留多久：云端对 expired 的单在到期后 1 天内仍会刷新，过期后才付的钱也能核实入账
 */
export const EXPIRED_VERIFY_MS = 24 * 60 * 60_000
/** 过期以后自动再查（慢节奏）多久：覆盖「二维码过期后才付的钱」，超过就停，之后只能手动「我已付款」 */
export const EXPIRED_WATCH_MS = 10 * 60_000
/** 已付款超过这么久还没到账就提示「到账有点慢」 */
export const SLOW_CREDIT_MS = 2 * 60_000

export function canVerifyExpired(remaining: number): boolean {
  return remaining > -EXPIRED_VERIFY_MS
}

/** 过期后还在自动再查的窗口内（到期后 10 分钟） */
export function inExpiredWatchWindow(remaining: number): boolean {
  return remaining > -EXPIRED_WATCH_MS
}

/**
 * 「改用浏览器付款」该打开哪一页：订单（从「继续付款」恢复的没有下单意图）或下单意图是套餐就打开订阅页，
 * 能找到套餐就带上它的分组；否则是充值页
 */
export function browserTarget(
  intent: Pick<CheckoutIntent, 'kind' | 'planId'> | null,
  order: Pick<CheckoutOrder, 'kind' | 'plan'> | null,
  plans: Array<Pick<StorePlan, 'id' | 'groupId'>>,
): { tab: 'subscription'; group?: number } | null {
  const kind = order?.kind ?? intent?.kind
  if (kind !== 'plan') return null
  const planId = order?.plan?.id ?? intent?.planId
  const plan = planId !== undefined ? plans.find(p => p.id === planId) : undefined
  return { tab: 'subscription', ...(plan?.groupId ? { group: plan.groupId } : {}) }
}

/** 应付金额和估算差 1 分以上（同一币种才比）：弹窗里加「以此金额为准」 */
export function amountDiffers(
  order: Pick<CheckoutOrder, 'payAmount' | 'payCurrency'>,
  intent: CheckoutIntent | null,
): boolean {
  if (!intent || intent.estimatePay === null) return false
  if (intent.payCurrency.toUpperCase() !== order.payCurrency.toUpperCase()) return false
  return Math.abs(round2(order.payAmount) - round2(intent.estimatePay)) >= 0.01 - 1e-9
}

/** 待付单列表里消失的订单号（可能已付款到账、过期或在别处取消了），用来在弹窗关着时发现到账 */
export function vanishedOrders(prev: CheckoutOrder[], next: CheckoutOrder[]): number[] {
  const still = new Set(next.map(o => o.orderId))
  return prev.filter(o => !still.has(o.orderId)).map(o => o.orderId)
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

/** 单选组按方向键切换：返回新的下标；不是导航键返回 null */
export function nextRadioIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/**
 * Tab 在弹窗里循环：activeIndex 是焦点在可聚焦元素里的位置（-1 表示焦点在弹窗外）。
 * 返回要把焦点移到哪（'first' / 'last'），null 表示让浏览器照常处理
 */
export function focusTrapTarget(shift: boolean, activeIndex: number, count: number): 'first' | 'last' | null {
  if (count <= 0) return null
  if (shift && (activeIndex <= 0 || activeIndex >= count)) return 'last'
  if (!shift && (activeIndex === count - 1 || activeIndex < 0)) return 'first'
  return null
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 渲染层认识的云端错误码（§4.5），对应 settings.account.Checkout.error.<CODE> */
const ERROR_CODES: ReadonlySet<string> = new Set([
  'PANEL_REAUTH_REQUIRED',
  'PAYMENT_DISABLED',
  'METHOD_UNAVAILABLE',
  'AMOUNT_OUT_OF_RANGE',
  'PLAN_UNAVAILABLE',
  'TOO_MANY_PENDING',
  'DAILY_LIMIT_EXCEEDED',
  'CANCEL_RATE_LIMITED',
  'ACCOUNT_DISABLED',
  'RATE_LIMITED',
  'REQUEST_REUSED',
  'ORDER_NOT_FOUND',
  'ORDER_NOT_CANCELLABLE',
  'UNSUPPORTED_RESULT',
  'UPSTREAM_UNAVAILABLE',
  'INVALID_REQUEST',
  'INTERNAL_ERROR',
])

export interface CheckoutErrorInfo {
  /** checkout.<CODE> 里的 CODE；没有码的错误为 null */
  code: string | null
  params: Record<string, string | number>
  /** 去掉 IPC 前缀后的原话（没有码时就是主进程给的可读中文） */
  message: string
}

/** 主进程的错误：IPC 前缀去掉，带 PIXELSKY_ERR: 的取出 checkout.<CODE> 和参数 */
export function parseCheckoutError(e: unknown): CheckoutErrorInfo {
  const message = cleanIpcError(e, '')
  const coded = parseCodedError(message)
  if (coded && coded.code.startsWith('checkout.'))
    return { code: coded.code.slice('checkout.'.length), params: coded.params, message }
  return { code: null, params: {}, message }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 错误文案：有码的按码显示本地化文案（金额参数用 formatPrice），没码的是可读中文，用 translateMessage */
export function checkoutErrorText(info: CheckoutErrorInfo, currency = 'CNY'): string {
  const key = (suffix: string): TranslationKey => `settings.account.Checkout.error.${suffix}` as TranslationKey
  const { code, params } = info
  if (code && ERROR_CODES.has(code)) {
    const price = (v: number): string => formatPrice(v, currency)
    if (code === 'AMOUNT_OUT_OF_RANGE') {
      const min = num(params.min)
      const max = num(params.max)
      if (min !== null && max !== null && max > 0) return tr(key(code), { p0: price(min), p1: price(max) })
      if (min !== null) return tr(key('AMOUNT_OUT_OF_RANGE_MIN'), { p0: price(min) })
      return tr(key('AMOUNT_OUT_OF_RANGE_ANY'))
    }
    if (code === 'TOO_MANY_PENDING') {
      const max = num(params.max)
      return max !== null ? tr(key(code), { p0: max }) : tr(key('TOO_MANY_PENDING_ANY'))
    }
    if (code === 'DAILY_LIMIT_EXCEEDED') {
      const left = num(params.remaining)
      // 额度已用完（remaining<=0）不说「只剩 ¥0」
      return left !== null && left > 0 ? tr(key(code), { p0: price(left) }) : tr(key('DAILY_LIMIT_EXCEEDED_ANY'))
    }
    return tr(key(code))
  }
  return info.message ? translateMessage(info.message) : tr(key('UNKNOWN'))
}

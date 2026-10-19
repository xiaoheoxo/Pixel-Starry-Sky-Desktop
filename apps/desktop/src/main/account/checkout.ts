// 软件内付款（主进程）：下单、查单、核实、取消，以及「去浏览器确认账号」。规格见 docs/ui/in-app-payment.md §4.4、§6.6。
// 所有请求只经 platformFetch（令牌不出主进程）；二维码内容和 pay_url 只放内存，不落盘、不写日志。
import { app, shell } from 'electron'
import { codedError, type ErrorParams } from '@pixelsky/protocol'
import { accountEpoch, baseUrl, platformFetch, signedInEmail } from './account'
import { lastStore } from './store'
import type { CheckoutKind, CheckoutOrder, CheckoutStatus, PanelStatus, StoreCatalog } from '../../shared/types/account'

const ORDERS_PATH = '/v1/platform/orders'
const PANEL_PATH = '/v1/platform/panel'
const PANEL_VERIFY_PATH = '/cli/panel-verify'
const FETCH_TIMEOUT_MS = 20_000
/** 下单要等 Sub2api 去支付商那边建单，给久一点 */
const CREATE_TIMEOUT_MS = 40_000
const MAX_AMOUNT = 1_000_000

// 主进程抛出的中文错误；字面量要和 shared/i18n/systemMessages.ts 里 system.checkout* 的 zh 一致，界面靠它反查英文
const MSG_INVALID_REQUEST = '请求参数不正确'
const MSG_BUSY = '已有一笔订单正在创建，请稍候'
const MSG_INVALID_DATA = '服务返回的付款数据异常'
const MSG_ORDER_NOT_FOUND = '找不到这笔订单，请重新下单'
const MSG_PANEL_URL_UNTRUSTED = '确认地址不在可信域名内，已拒绝打开'
const MSG_NO_PAY_PAGE = '这笔订单没有可以打开的支付页'
const MSG_REFRESH_FIRST = '请先刷新套餐信息' // 同 store.ts 的 openStore
const MSG_NETWORK = '连不上付款服务，请检查网络后重试'
const MSG_TIMEOUT = '付款服务响应超时，请稍后重试'
const MSG_CREATE_TIMEOUT = '下单超时：请稍后在「继续付款」里查看，不会重复下单'
const MSG_ACCOUNT_CHANGED = '登录状态已变化，请重试'

/** 云端会给的错误码（§4.5）。认识的才用 codedError 抛给界面，不认识的退回云端给的中文 */
const KNOWN_CODES: ReadonlySet<string> = new Set([
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'paid',
  'completed',
  'expired',
  'cancelled',
  'failed',
  'refunding',
  'refunded',
])

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
/** 有限数字，否则 null（只收 JSON 数字，不把字符串当数字） */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}
function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
/** 非空字符串，否则 null */
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}
/** 能解析成时间的字符串，否则 null */
function time(v: unknown): string | null {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null
}

/** 支付页链接只留 https 且不带用户名密码的；否则 null */
function httpsUrl(v: unknown): string | null {
  const raw = str(v)
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password ? raw : null
  } catch {
    return null
  }
}

/**
 * 解析云端的订单 JSON（§4.4）：蛇形 → 驼峰；必填字段缺失或类型不对就报错，多出来的字段忽略。
 * qr_content 只在 pending 时保留；pay_url 只留 https 且不带用户名密码的
 */
export function parseOrder(body: unknown): CheckoutOrder {
  const bad = (): Error => new Error(MSG_INVALID_DATA)
  if (!isObject(body)) throw bad()
  const orderId = positiveInt(body.order_id)
  const kind = body.kind
  const payAmount = num(body.pay_amount)
  const method = str(body.method)
  const createdAt = time(body.created_at)
  const expiresAt = time(body.expires_at)
  const serverTime = time(body.server_time)
  if (orderId === null || (kind !== 'balance' && kind !== 'plan') || typeof body.status !== 'string') throw bad()
  if (payAmount === null || payAmount < 0 || !method || !createdAt || !expiresAt || !serverTime) throw bad()
  const status: CheckoutStatus = STATUSES.has(body.status) ? (body.status as CheckoutStatus) : 'unknown'
  const pending = status === 'pending'
  const qr = pending ? str(body.qr_content) : null
  const plan = isObject(body.plan) ? body.plan : null
  const planId = plan ? positiveInt(plan.id) : null
  return {
    orderId,
    kind,
    status,
    method,
    methodLabel: text(body.method_label) || method,
    payAmount,
    payCurrency: text(body.pay_currency) || 'CNY',
    feeRate: Math.max(0, num(body.fee_rate) ?? 0),
    credited: num(body.credited),
    bonus: num(body.bonus),
    plan:
      plan && planId !== null
        ? { id: planId, name: text(plan.name), validityDays: Math.max(0, num(plan.validity_days) ?? 0) }
        : null,
    qrContent: qr,
    qrSource: qr ? (body.qr_source === 'pay_url' ? 'pay_url' : 'provider') : null,
    payUrl: pending ? httpsUrl(body.pay_url) : null,
    createdAt,
    expiresAt,
    paidAt: time(body.paid_at),
    completedAt: time(body.completed_at),
    serverTime,
    reused: body.reused === true,
    ...(typeof body.panel_valid === 'boolean' && { panelValid: body.panel_valid }),
  }
}

function parsePanel(body: unknown): PanelStatus {
  if (!isObject(body) || typeof body.valid !== 'boolean' || typeof body.usable_for_checkout !== 'boolean')
    throw new Error(MSG_INVALID_DATA)
  return { valid: body.valid, expiresAt: time(body.expires_at), usableForCheckout: body.usable_for_checkout }
}

// ---------------------------------------------------------------------------
// 这次登录期间下过 / 列出来过的订单：订单号和对应的 pay_url 只放内存，跟着登录会话代数清空
// ---------------------------------------------------------------------------

interface Remembered {
  payUrl: string | null
  /** 支付方式名（付款窗口的标题用） */
  label: string
  /** 支付方式代码（alipay / wxpay）：英文界面的窗口标题按它选通用写法 */
  method: string
}
let session: { epoch: number; orders: Map<number, Remembered> } | null = null
function orders(): Map<number, Remembered> {
  const epoch = accountEpoch()
  if (!session || session.epoch !== epoch) session = { epoch, orders: new Map() }
  return session.orders
}
/** 记下订单；keepUrl 为真（列表项不带支付链接）时，云端没给就保留之前记下的 */
function remember(order: CheckoutOrder, keepUrl = false): void {
  const map = orders()
  const payUrl =
    order.status === 'pending' ? (order.payUrl ?? (keepUrl ? (map.get(order.orderId)?.payUrl ?? null) : null)) : null
  map.set(order.orderId, { payUrl, label: order.methodLabel, method: order.method })
}
/** 订单号：正的安全整数，并且是这次登录期间主进程下过 / 列出来过的 */
function knownOrder(orderId: unknown): { id: number; payUrl: string | null; label: string; method: string } {
  const id = positiveInt(orderId)
  if (id === null) throw new Error(MSG_INVALID_REQUEST)
  const entry = orders().get(id)
  if (!entry) throw new Error(MSG_ORDER_NOT_FOUND)
  return { id, payUrl: entry.payUrl, label: entry.label, method: entry.method }
}

/** 同一时间只能有一个下单在途；记的是下单时的登录会话代数，换了账号就当没有在途 */
let creating: number | null = null

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** codedError 的参数只收字符串和数字，detail 里其它类型的值丢掉 */
function detailParams(detail: unknown): ErrorParams | undefined {
  if (!isObject(detail)) return undefined
  const params: ErrorParams = {}
  for (const [key, v] of Object.entries(detail))
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) params[key] = v
  return Object.keys(params).length ? params : undefined
}

/** 界面按 code 显示本地化文案（errors.checkout.<CODE>），参数来自云端的 detail 或主进程自己的校验 */
function checkoutError(code: string, params?: ErrorParams): Error {
  return codedError(`checkout.${code}`, params)
}

/** OAuth 风格的机器码（server_error、invalid_token……）：不给用户看 */
const MACHINE_CODE = /^[a-z][a-z0-9_.:-]*$/i

/**
 * 云端的错误体是 {error, code, detail}：有认识的 code 抛带代码的错误，否则抛云端给的中文提示。
 * 503 / 存储出错时是 OAuth 风格的 {error: "server_error", error_description: "…"}（没有 code）：优先用 error_description，
 * error 是机器码就不显示
 */
function apiError(status: number, body: unknown): Error {
  if (isObject(body)) {
    const code = text(body.code)
    if (KNOWN_CODES.has(code)) return checkoutError(code, detailParams(body.detail))
    const description = text(body.error_description)
    const reason = text(body.error)
    if (!code && description) return new Error(description)
    if (reason && !MACHINE_CODE.test(reason)) return new Error(reason)
    if (description) return new Error(description)
  }
  return new Error(`付款服务暂时不可用（HTTP ${status}）`)
}

/** 断网 / 超时的原始异常（fetch failed、The operation was aborted due to timeout）换成中文提示；其它错误（登录过期等）原样抛 */
function transportError(e: unknown, timeoutMs: number): Error | null {
  if (!(e instanceof Error) || (e as { code?: unknown }).code === 'AUTH_EXPIRED') return null
  if (e.name === 'TimeoutError' || e.name === 'AbortError')
    return new Error(timeoutMs === CREATE_TIMEOUT_MS ? MSG_CREATE_TIMEOUT : MSG_TIMEOUT)
  if (e instanceof TypeError) return new Error(MSG_NETWORK)
  return null
}

/**
 * 请求云端并取出 JSON。面板凭证的问题云端一律回 403 加 code（不是 401），platformFetch 只把 401 当作登录过期，
 * 所以 PANEL_REAUTH_REQUIRED 不会触发续期或退出登录
 */
async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const epoch = accountEpoch()
  let res: Response
  let json: unknown = null
  try {
    res = await platformFetch(path, {
      method,
      ...(body !== undefined && { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    try {
      json = await res.json()
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e // 读响应体时超时 / 断了；响应体不是 JSON 就当没有
    }
  } catch (e) {
    if (accountEpoch() !== epoch) throw new Error(MSG_ACCOUNT_CHANGED)
    throw transportError(e, timeoutMs) ?? e
  }
  // 换账号 / 退出登录后回来的结果不属于现在的账号：丢弃，调用方不会记订单
  if (accountEpoch() !== epoch) throw new Error(MSG_ACCOUNT_CHANGED)
  if (!res.ok) throw apiError(res.status, json)
  return json
}

// ---------------------------------------------------------------------------
// 下单参数校验
// ---------------------------------------------------------------------------

interface ValidInput {
  requestId: string
  kind: CheckoutKind
  amount?: number
  planId?: number
  method: string
}

/** 金额：有限、大于 0、最多两位小数、不超过上限 */
function validAmount(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_AMOUNT) return false
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-6
}

function validateCreate(input: unknown, catalog: StoreCatalog): ValidInput {
  if (!isObject(input)) throw new Error(MSG_INVALID_REQUEST)
  const { requestId, kind, amount, planId, method } = input
  if (typeof requestId !== 'string' || !UUID.test(requestId)) throw new Error(MSG_INVALID_REQUEST)
  if (kind !== 'balance' && kind !== 'plan') throw new Error(MSG_INVALID_REQUEST)
  if (typeof method !== 'string' || !method) throw new Error(MSG_INVALID_REQUEST)
  // kind=balance 只带 amount，kind=plan 只带 planId（和云端的规则一致）
  if (
    kind === 'balance'
      ? planId !== undefined || !validAmount(amount)
      : amount !== undefined || positiveInt(planId) === null
  )
    throw new Error(MSG_INVALID_REQUEST)
  const checkout = catalog.checkout
  if (!catalog.enabled || !checkout?.enabled || (kind === 'balance' && !catalog.recharge.enabled))
    throw checkoutError('PAYMENT_DISABLED')
  if (!checkout.methods.includes(method)) throw checkoutError('METHOD_UNAVAILABLE')
  if (kind === 'balance') {
    const { min, max } = catalog.recharge
    if ((min > 0 && (amount as number) < min) || (max > 0 && (amount as number) > max))
      throw checkoutError('AMOUNT_OUT_OF_RANGE', { min, max })
    // 最多两位小数：0.1 + 0.2 这类的浮点尾巴（0.30000000000000004）云端会拒收，发出去前取整到分
    return { requestId, kind, amount: Math.round((amount as number) * 100) / 100, method }
  }
  if (!catalog.plans.some(p => p.id === planId)) throw checkoutError('PLAN_UNAVAILABLE')
  return { requestId, kind, planId: planId as number, method }
}

// ---------------------------------------------------------------------------
// 8 个 IPC 操作
// ---------------------------------------------------------------------------

/** account:checkoutCreate：下单（或复用同参数的待付单；同一个 requestId 重试云端原样返回） */
export async function checkoutCreate(input: unknown): Promise<CheckoutOrder> {
  // 商品数据要是这次登录的：金额范围、套餐、支付方式都对照最近一次的结果（同 openStore）
  const store = lastStore()
  if (!store || store.email !== signedInEmail()) throw new Error(MSG_REFRESH_FIRST)
  const checked = validateCreate(input, store.catalog)
  const epoch = accountEpoch()
  if (creating === epoch) throw new Error(MSG_BUSY)
  creating = epoch
  try {
    const body = {
      request_id: checked.requestId,
      kind: checked.kind,
      ...(checked.kind === 'balance' ? { amount: checked.amount } : { plan_id: checked.planId }),
      method: checked.method,
    }
    const order = parseOrder(await call('POST', ORDERS_PATH, body, CREATE_TIMEOUT_MS))
    remember(order)
    return order
  } finally {
    if (creating === epoch) creating = null
  }
}

async function orderCall(method: 'GET' | 'POST', orderId: unknown, action = ''): Promise<CheckoutOrder> {
  const { id } = knownOrder(orderId)
  const order = parseOrder(await call(method, `${ORDERS_PATH}/${id}${action}`))
  if (order.orderId !== id) throw new Error(MSG_INVALID_DATA)
  remember(order)
  return order
}

/** account:checkoutGet：查单（云端待付时按节流顺带核实） */
export function checkoutGet(orderId: unknown): Promise<CheckoutOrder> {
  return orderCall('GET', orderId)
}

/** account:checkoutVerify：「我已付款」，马上核实 */
export function checkoutVerify(orderId: unknown): Promise<CheckoutOrder> {
  return orderCall('POST', orderId, '/verify')
}

/** account:checkoutCancel：取消待付单（取消后的状态可能其实是已付） */
export function checkoutCancel(orderId: unknown): Promise<CheckoutOrder> {
  return orderCall('POST', orderId, '/cancel')
}

/** account:checkoutPending：软件里下的、还没到期的待付单（重开软件后「继续付款」）；不含二维码，要付款时再查单笔 */
export async function checkoutPending(): Promise<CheckoutOrder[]> {
  const body = await call('GET', `${ORDERS_PATH}?status=pending`)
  if (!isObject(body) || !Array.isArray(body.data)) throw new Error(MSG_INVALID_DATA)
  const list: CheckoutOrder[] = []
  for (const item of body.data) {
    let order: CheckoutOrder
    try {
      order = parseOrder(item)
    } catch {
      continue // 一笔坏数据不拖垮整个列表
    }
    remember(order, true)
    list.push({ ...order, qrContent: null, qrSource: null })
  }
  return list
}

/** account:checkoutOpenPayUrl：只打开主进程记下的这笔订单的 pay_url，渲染层传不了地址 */
export async function checkoutOpenPayUrl(orderId: unknown): Promise<void> {
  const { payUrl } = knownOrder(orderId)
  const url = httpsUrl(payUrl)
  if (!url) throw new Error(MSG_NO_PAY_PAGE)
  await shell.openExternal(url)
}

/**
 * 付款窗口（main/account/pay-window.ts）要加载的页面：和 checkoutOpenPayUrl 一样，只认这次登录期间记下的订单、
 * 只用主进程记下的 pay_url（https、无用户名密码）；订单不再待付（pay_url 已清掉）时拒绝
 */
export function payPageOf(orderId: unknown): { orderId: number; url: string; label: string; method: string } {
  const { id, payUrl, label, method } = knownOrder(orderId)
  const url = httpsUrl(payUrl)
  if (!url) throw new Error(MSG_NO_PAY_PAGE)
  return { orderId: id, url, label, method }
}

/** account:panelStatus：面板凭证状态 */
export async function panelStatus(): Promise<PanelStatus> {
  return parsePanel(await call('GET', PANEL_PATH))
}

/** 小写、去掉主机名结尾的点（"Panel.Example.com.:8443" → "panel.example.com:8443"）；host 带端口也行 */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.(?=:\d+$|$)/, '')
}

/**
 * 确认页地址：必须和云端地址（baseUrl()）同主机、是 https（回环地址和未打包的开发环境可以用 http）、
 * 不带用户名密码、路径是 /cli/panel-verify。不通过就抛错，返回规范化后的地址
 */
export function panelVerifyLink(raw: unknown): string {
  const untrusted = (): Error => new Error(MSG_PANEL_URL_UNTRUSTED)
  if (typeof raw !== 'string') throw untrusted()
  let url: URL
  let cloud: URL
  try {
    url = new URL(raw)
    cloud = new URL(baseUrl())
  } catch {
    throw untrusted()
  }
  const host = normalizeHost(url.hostname)
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (!app.isPackaged || loopback))) throw untrusted()
  if (url.username || url.password) throw untrusted()
  // 主机和端口都要一致（url.host 带端口，默认端口会被省掉）
  if (normalizeHost(url.host) !== normalizeHost(cloud.host)) throw untrusted()
  if (url.pathname !== PANEL_VERIFY_PATH) throw untrusted()
  return url.toString()
}

/** account:panelVerify：向云端要一张一次性票据，在系统浏览器里打开确认页（账号确认后面板凭证才够用于下单） */
export async function panelVerify(): Promise<void> {
  const body = await call('POST', `${PANEL_PATH}/verify`)
  const url = panelVerifyLink(isObject(body) ? body.url : null)
  await shell.openExternal(url)
}

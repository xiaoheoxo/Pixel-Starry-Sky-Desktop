// 软件内付款弹窗的流程控制（docs/ui/in-app-payment.md §2.3、§5.5、§6.3–6.5）：下单 → 等待付款 → 已付款 → 已到账，
// 面板凭证过期时「去浏览器确认账号」并用同一个 requestId 自动接着下单。
// 控制器与 React 外壳（useCheckout.ts）分开，不依赖 React 和 DOM：桥方法、定时器、时钟都可以替换，方便测试。
import type {
  AccountInfo,
  AccountRefreshResult,
  CheckoutCreateInput,
  CheckoutOrder,
  PayWindowEvent,
} from '../../../../../shared/types/account'
import type { AccountBridge } from '../../../../../preload/account'
import { baselineBeforeOpen } from '../paymentWatch'
import { diffAccount, snapOf, type AccountChange } from '../storeLogic'
import { parseCheckoutError, type CheckoutErrorInfo, type CheckoutIntent } from './checkoutLogic'
import { OrderWatch } from './orderWatch'

/** 「我已付款」按钮点一次后这么久内不能再点 */
export const VERIFY_COOLDOWN_MS = 3_000
/** 等浏览器里确认账号：每 2 秒看一次面板凭证，最多等 10 分钟 */
export const PANEL_POLL_MS = 2_000
export const PANEL_WAIT_MS = 10 * 60_000
/** 到账后账号接口的缓存可能还没跟上：对比为空就每 2 秒再刷一次，最多 3 次 */
export const SETTLE_RETRY_MS = 2_000
export const SETTLE_RETRIES = 3

export type FlowBridge = Pick<
  AccountBridge,
  | 'checkoutCreate'
  | 'checkoutGet'
  | 'checkoutVerify'
  | 'checkoutCancel'
  | 'checkoutOpenPayUrl'
  | 'checkoutOpenPayWindow'
  | 'checkoutClosePayWindow'
  | 'panelStatus'
  | 'panelVerify'
>

/**
 * 付款窗口（pay_url 订单：支付FM 这类只给收银台网页的支付方式，在软件里开一个小窗口显示收银台）：
 * idle 没有 / opening 正在打开 / open 已打开 / closed 用户自己关了 / failed 没能打开或页面加载失败（窗口已被主进程关掉）
 */
export type PayWindowState = 'idle' | 'opening' | 'open' | 'closed' | 'failed'

/** 弹窗内容：订单还没有的（准备 / 下单 / 确认账号 / 出错）；有了订单就是 order，细分状态由订单状态和倒计时决定 */
export type FlowPhase = 'prepare' | 'creating' | 'reauth' | 'error' | 'order'

export interface FlowState {
  open: boolean
  phase: FlowPhase
  /** 从「继续付款」恢复的订单没有下单意图（无法「重新下单」） */
  intent: CheckoutIntent | null
  order: CheckoutOrder | null
  /** 收到 order 时的本机时刻，倒计时用 */
  receivedAt: number
  /** 第一次看到「已付款」的本机时刻：超过 2 分钟没到账就提示「到账有点慢」 */
  paidAt: number | null
  /** phase=error 的原因 */
  error: CheckoutErrorInfo | null
  /** 「我已付款」「取消订单」「打开支付页」失败的原因 */
  actionError: CheckoutErrorInfo | null
  busy: 'verify' | 'cancel' | null
  /** 「我已付款」刚点过，3 秒内不能再点 */
  verifyLocked: boolean
  /** 「我已付款」核实后订单状态没变（还没收到付款） */
  notYet: boolean
  /** 轮询失败 1–4 次：提示「网络不稳定，正在重试」 */
  unstable: boolean
  /** 连续失败 5 次：错误和「重试」 */
  watchError: CheckoutErrorInfo | null
  /** 确认账号：idle 还没点 / opening 正在打开浏览器 / waiting 等浏览器里确认 / timeout 等了 10 分钟没等到 */
  reauth: 'idle' | 'opening' | 'waiting' | 'timeout'
  reauthError: CheckoutErrorInfo | null
  /** 到账后的前后对比；settling 表示还在读新账号 */
  outcome: { settling: boolean; change: AccountChange | null } | null
  /** 付款窗口的状态；provider 订单（显示二维码）一直是 idle */
  payWindow: PayWindowState
}

const CLOSED: FlowState = {
  open: false,
  phase: 'creating',
  intent: null,
  order: null,
  receivedAt: 0,
  paidAt: null,
  error: null,
  actionError: null,
  busy: null,
  verifyLocked: false,
  notYet: false,
  unstable: false,
  watchError: null,
  reauth: 'idle',
  reauthError: null,
  outcome: null,
  payWindow: 'idle',
}

export interface FlowDeps {
  bridge: FlowBridge
  /** 强制发新请求刷新账号（到账后读前后对比 + 下单前定基准） */
  refreshAccount: () => Promise<AccountRefreshResult>
  /** 当前缓存的账号（刷新失败时当基准） */
  getAccount: () => Pick<AccountInfo, 'balance' | 'plan'>
  newRequestId: () => string
  /** 到账（含前后对比）：设置窗口里弹提示用 */
  onCompleted?: (order: CheckoutOrder, change: AccountChange | null) => void
  /** 弹窗关掉之后才回来的下单结果（订单已经建好）：让待付单列表刷新 */
  onLateOrder?: () => void
  foreground?: () => boolean
  now?: () => number
}

type Baseline = Pick<AccountInfo, 'balance' | 'plan'>

export class CheckoutFlow {
  private snapshot: FlowState = CLOSED
  private readonly listeners = new Set<() => void>()
  private readonly watch: OrderWatch
  private readonly now: () => number
  /** begin / resume / close 会让在途的下单、读单结果作废 */
  private gen = 0
  private requestId = ''
  private resumeId: number | null = null
  private baseline: Promise<Baseline> | null = null
  private panelTimer: ReturnType<typeof setTimeout> | null = null
  private verifyTimer: ReturnType<typeof setTimeout> | null = null
  /** begin / resume 会让还在读账号的到账结算作废（close 不会：关了弹窗账号照样要刷新） */
  private settleGen = 0
  private settledFor: number | null = null
  /** 最近一次下单请求（不管结果有没有被丢弃）：主进程同一时间只收一个下单，新的要等它回来 */
  private creating: Promise<unknown> | null = null
  /** 付款窗口现在属于哪笔订单（主进程同时最多一个）；null 表示没有 */
  private payWindowOrder: number | null = null
  /** 已经自动打开过付款窗口的订单：用户关掉或订单本地到期关掉之后，轮询到的 pending 不会再自动打开 */
  private autoOpened: number | null = null

  constructor(private readonly deps: FlowDeps) {
    this.now = deps.now ?? Date.now
    this.watch = new OrderWatch({
      fetch: id => deps.bridge.checkoutGet(id),
      foreground: deps.foreground,
      now: deps.now,
    })
    this.watch.subscribe(() => this.syncWatch())
  }

  getState = (): FlowState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private patch(p: Partial<FlowState>): void {
    this.snapshot = { ...this.snapshot, ...p }
    for (const l of this.listeners) l()
  }

  // -------------------------------------------------------------------------
  // 打开 / 关闭
  // -------------------------------------------------------------------------

  /**
   * 点「扫码付款」：prepare 为真先显示「准备」步骤（套餐页选支付方式），否则直接下单。
   * 一次下单意图一个 requestId，重试和确认账号后的自动下单都用它
   */
  begin(intent: CheckoutIntent, prepare: boolean): void {
    this.reset()
    this.requestId = this.deps.newRequestId()
    this.patch({ open: true, phase: prepare ? 'prepare' : 'creating', intent })
    if (!prepare) void this.submit()
  }

  /** 「继续付款」：读出这笔待付单（要先在这次登录期间 create 或 pending 列出过）并拿回二维码 */
  resume(orderId: number): void {
    this.reset()
    this.resumeId = orderId
    this.patch({ open: true, phase: 'creating' })
    void this.load()
  }

  /** 关闭弹窗（不取消订单）：停止轮询和等待确认，不再自动下单。返回关闭时手里的订单 */
  close(): CheckoutOrder | null {
    const order = this.snapshot.order
    this.gen++
    this.watch.stop()
    this.clearPanelTimer()
    this.clearVerifyTimer()
    this.releasePayWindow()
    this.autoOpened = null
    this.snapshot = CLOSED
    this.baseline = null
    this.resumeId = null
    for (const l of this.listeners) l()
    return order
  }

  /** 关掉弹窗、清掉所有定时器（组件卸载） */
  dispose(): void {
    this.settleGen++
    this.close()
  }

  private reset(): void {
    this.gen++
    this.settleGen++
    this.settledFor = null
    this.watch.stop()
    this.clearPanelTimer()
    this.clearVerifyTimer()
    this.releasePayWindow()
    this.autoOpened = null
    this.resumeId = null
    // 下单前先强制刷新一次账号定基准（和支付页打开前一样）；与下单并行，二维码出来之前不可能已经付款
    this.baseline = null
    this.snapshot = { ...CLOSED }
  }

  private takeBaseline(): Promise<Baseline> {
    this.baseline ??= baselineBeforeOpen(() => this.deps.refreshAccount(), this.deps.getAccount())
    return this.baseline
  }

  // -------------------------------------------------------------------------
  // 下单
  // -------------------------------------------------------------------------

  /** 准备步骤里换支付方式 */
  setMethod(method: string): void {
    const intent = this.snapshot.intent
    if (intent && this.snapshot.phase === 'prepare') this.patch({ intent: { ...intent, method } })
  }

  /** 下单；出错或确认完账号后用同一个 requestId 再来 */
  async submit(): Promise<void> {
    const { intent, phase } = this.snapshot
    if (!intent || phase === 'order') return
    const gen = ++this.gen
    this.patch({ phase: 'creating', error: null, actionError: null, reauth: 'idle', reauthError: null })
    void this.takeBaseline()
    if (this.creating) {
      await this.creating
      if (gen !== this.gen) return
    }
    const input: CheckoutCreateInput = {
      requestId: this.requestId,
      kind: intent.kind,
      method: intent.method,
      ...(intent.kind === 'balance' ? { amount: intent.amount } : { planId: intent.planId }),
    }
    let order: CheckoutOrder
    const request = this.deps.bridge.checkoutCreate(input)
    const done = request.then(
      () => undefined,
      () => undefined,
    )
    this.creating = done
    void done.then(() => {
      if (this.creating === done) this.creating = null
    })
    try {
      order = await request
    } catch (e) {
      if (gen !== this.gen) return
      const info = parseCheckoutError(e)
      if (info.code === 'PANEL_REAUTH_REQUIRED') this.patch({ phase: 'reauth', reauth: 'idle' })
      else this.patch({ phase: 'error', error: info })
      return
    }
    if (gen !== this.gen) {
      // 弹窗已经关了（或重新开始了）：订单在云端建好了，让「继续付款」的列表看到它
      this.deps.onLateOrder?.()
      return
    }
    this.watch.start(order)
    this.patch({ phase: 'order' })
  }

  private async load(): Promise<void> {
    const id = this.resumeId
    if (id === null) return
    const gen = ++this.gen
    this.patch({ phase: 'creating', error: null })
    void this.takeBaseline()
    try {
      const order = await this.deps.bridge.checkoutGet(id)
      if (gen !== this.gen) return
      this.watch.start(order)
      this.patch({ phase: 'order' })
    } catch (e) {
      if (gen !== this.gen) return
      this.patch({ phase: 'error', error: parseCheckoutError(e) })
    }
  }

  /** 出错后的「重试」：同一个 requestId（请求编号被占用时换新的） */
  retry(): void {
    const { error } = this.snapshot
    if (this.resumeId !== null) {
      void this.load()
      return
    }
    if (error?.code === 'REQUEST_REUSED') this.requestId = this.deps.newRequestId()
    void this.submit()
  }

  /** 过期 / 已取消 / 失败后的「重新下单」：换新的 requestId，参数不变 */
  reorder(): void {
    const { intent } = this.snapshot
    if (!intent) return
    this.gen++
    this.settleGen++
    this.settledFor = null
    this.watch.stop()
    this.baseline = null
    this.requestId = this.deps.newRequestId()
    this.releasePayWindow()
    this.patch({
      phase: 'creating',
      payWindow: 'idle',
      order: null,
      paidAt: null,
      actionError: null,
      watchError: null,
      unstable: false,
      outcome: null,
      busy: null,
    })
    void this.submit()
  }

  // -------------------------------------------------------------------------
  // 确认账号
  // -------------------------------------------------------------------------

  /**
   * 「去浏览器确认」：打开确认页，然后每 2 秒看一次面板凭证，够用了就自动接着下单。
   * 订单阶段凭证中途失效（order.panelValid === false）时也走这里：确认完回到这笔订单继续查，不下新单、不改 requestId
   */
  async startReauth(): Promise<void> {
    const s = this.snapshot
    const onOrder = s.phase === 'order' && s.order?.panelValid === false
    if ((s.phase !== 'reauth' && !onOrder) || s.reauth === 'opening' || s.reauth === 'waiting') return
    const gen = this.gen
    this.patch({ reauth: 'opening', reauthError: null })
    try {
      await this.deps.bridge.panelVerify()
    } catch (e) {
      if (gen !== this.gen) return
      this.patch({ reauth: 'idle', reauthError: parseCheckoutError(e) })
      return
    }
    if (gen !== this.gen) return
    this.patch({ reauth: 'waiting' })
    const deadline = this.now() + PANEL_WAIT_MS
    const poll = (): void => {
      this.panelTimer = setTimeout(() => {
        void (async () => {
          if (gen !== this.gen) return
          let usable = false
          try {
            usable = (await this.deps.bridge.panelStatus()).usableForCheckout
          } catch {
            /* 查不到就接着等 */
          }
          if (gen !== this.gen) return
          if (usable) {
            this.panelTimer = null
            if (onOrder) void this.resumeOrder(gen)
            else void this.submit()
          } else if (this.now() >= deadline) {
            this.panelTimer = null
            this.patch({ reauth: 'timeout' })
          } else poll()
        })()
      }, PANEL_POLL_MS)
    }
    poll()
  }

  /** 订单阶段确认完账号：马上查一次这笔订单并接着轮询（同一个订单、同一个 requestId） */
  private async resumeOrder(gen: number): Promise<void> {
    const order = this.snapshot.order
    if (!order) return
    this.patch({ reauth: 'idle', reauthError: null })
    try {
      const next = await this.deps.bridge.checkoutGet(order.orderId)
      if (gen !== this.gen) return
      this.watch.adopt(next)
    } catch {
      if (gen !== this.gen) return
      this.watch.retry() // 这一次没查到：照常的轮询接着查（连续失败会按原来的规则报错）
    }
  }

  // -------------------------------------------------------------------------
  // 订单上的操作
  // -------------------------------------------------------------------------

  /** 「我已付款」：马上核实（过期的单也行，过期后才付的钱也能入账）；3 秒内只能点一次 */
  async verify(): Promise<void> {
    const { order, busy, verifyLocked } = this.snapshot
    if (!order || busy || verifyLocked) return
    const gen = this.gen
    this.patch({ busy: 'verify', verifyLocked: true, actionError: null, notYet: false })
    this.clearVerifyTimer()
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = null
      this.patch({ verifyLocked: false })
    }, VERIFY_COOLDOWN_MS)
    try {
      const next = await this.deps.bridge.checkoutVerify(order.orderId)
      if (gen !== this.gen) return
      this.watch.adopt(next)
      this.patch({ busy: null, notYet: next.status === 'pending' || next.status === 'expired' })
    } catch (e) {
      if (gen !== this.gen) return
      this.patch({ busy: null, actionError: parseCheckoutError(e) })
    }
  }

  /** 「取消订单」（界面已二次确认）；返回的状态可能其实是已付款 */
  async cancel(): Promise<void> {
    const { order, busy } = this.snapshot
    if (!order || busy) return
    const gen = this.gen
    this.patch({ busy: 'cancel', actionError: null })
    try {
      const next = await this.deps.bridge.checkoutCancel(order.orderId)
      if (gen !== this.gen) return
      this.watch.adopt(next)
      this.patch({ busy: null })
    } catch (e) {
      if (gen !== this.gen) return
      this.patch({ busy: null, actionError: parseCheckoutError(e) })
    }
  }

  /** 「在浏览器打开这笔订单的支付页」：地址是主进程记下的，这里只传订单号 */
  async openPayUrl(): Promise<void> {
    const { order } = this.snapshot
    if (!order) return
    try {
      await this.deps.bridge.checkoutOpenPayUrl(order.orderId)
    } catch (e) {
      this.patch({ actionError: parseCheckoutError(e) })
    }
  }

  // -------------------------------------------------------------------------
  // 付款窗口（pay_url 订单）
  // -------------------------------------------------------------------------

  /** 打开（或聚焦）这笔订单的付款窗口：自动打开和「重新打开付款窗口」都走这里；地址是主进程记下的，这里只传订单号 */
  async openPayWindow(): Promise<void> {
    const order = this.snapshot.order
    if (!this.snapshot.open || !order || order.qrSource !== 'pay_url') return
    const id = order.orderId
    this.payWindowOrder = id
    this.autoOpened = id
    this.patch({ payWindow: 'opening' })
    try {
      await this.deps.bridge.checkoutOpenPayWindow(id)
    } catch {
      if (this.payWindowOrder === id && this.snapshot.open) this.patch({ payWindow: 'failed' })
      return
    }
    // 关了弹窗 / 换了订单 / 页面已经加载失败（事件比返回先到）就不再改状态
    if (this.payWindowOrder === id && this.snapshot.open && this.snapshot.payWindow === 'opening')
      this.patch({ payWindow: 'open' })
  }

  /** 关掉付款窗口（订单已付 / 到账 / 取消 / 过期，或弹窗关闭）；没有就什么都不做 */
  closePayWindow(): void {
    if (this.payWindowOrder === null) return
    this.releasePayWindow()
    if (this.snapshot.open) this.patch({ payWindow: 'idle' })
  }

  /** 主进程推来的付款窗口事件：用户自己关了窗口，或页面没加载出来（窗口已被主进程关掉）；不是当前这笔的忽略 */
  payWindowEvent(event: PayWindowEvent): void {
    if (event.orderId !== this.payWindowOrder || !this.snapshot.open) return
    this.patch({ payWindow: event.state })
  }

  /** 通知主进程关窗并忘掉这笔（不改状态）；失败不用管，窗口本来就可能已经没了 */
  private releasePayWindow(): void {
    const id = this.payWindowOrder
    if (id === null) return
    this.payWindowOrder = null
    void Promise.resolve(this.deps.bridge.checkoutClosePayWindow(id)).catch(() => undefined)
  }

  /** 订单更新时：待付的 pay_url 订单自动开窗（每笔一次）；不再待付就关窗 */
  private syncPayWindow(order: CheckoutOrder): void {
    if (order.status !== 'pending') this.closePayWindow()
    else if (order.qrSource === 'pay_url' && this.autoOpened !== order.orderId) void this.openPayWindow()
  }

  /** 连续失败后的「重试」 */
  retryWatch(): void {
    this.watch.retry()
  }

  /** 窗口前后台变了（visibilitychange / focus / blur） */
  foregroundChanged(): void {
    this.watch.foregroundChanged()
  }

  // -------------------------------------------------------------------------
  // 轮询结果 → 状态；到账后读前后对比
  // -------------------------------------------------------------------------

  private syncWatch(): void {
    const w = this.watch.getState()
    if (!w || !this.snapshot.open) return
    this.patch({
      order: w.order,
      notYet: this.snapshot.notYet && this.snapshot.order?.status === w.order.status,
      receivedAt: w.receivedAt,
      paidAt: w.order.status === 'paid' && this.snapshot.paidAt === null ? w.receivedAt : this.snapshot.paidAt,
      unstable: w.failures > 0 && !w.error,
      watchError: w.error ? parseCheckoutError(w.error) : null,
    })
    if (w.order.status === 'completed' && this.settledFor !== w.order.orderId) {
      this.settledFor = w.order.orderId
      void this.settle(w.order)
    }
    this.syncPayWindow(w.order)
  }

  /** 到账：强制刷新账号，和下单前的快照对比；对比为空（账号缓存还没跟上）就每 2 秒再刷，最多 3 次 */
  private async settle(order: CheckoutOrder): Promise<void> {
    const token = this.settleGen
    this.patch({ outcome: { settling: true, change: null } })
    const before = snapOf(await this.takeBaseline())
    let change: AccountChange | null = null
    for (let attempt = 0; attempt <= SETTLE_RETRIES; attempt++) {
      if (attempt > 0) await new Promise<void>(resolve => setTimeout(resolve, SETTLE_RETRY_MS))
      if (token !== this.settleGen) return
      const res = await this.deps.refreshAccount().catch(() => null)
      if (token !== this.settleGen) return
      if (res?.account) {
        change = diffAccount(before, snapOf(res.account))
        if (change) break
      }
    }
    if (this.snapshot.open) this.patch({ outcome: { settling: false, change } })
    this.deps.onCompleted?.(order, change)
  }

  private clearPanelTimer(): void {
    if (this.panelTimer !== null) clearTimeout(this.panelTimer)
    this.panelTimer = null
  }

  private clearVerifyTimer(): void {
    if (this.verifyTimer !== null) clearTimeout(this.verifyTimer)
    this.verifyTimer = null
  }
}

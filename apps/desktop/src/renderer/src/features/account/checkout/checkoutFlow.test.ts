import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codedError } from '@pixelsky/protocol'
import type {
  AccountInfo,
  AccountRefreshResult,
  CheckoutCreateInput,
  CheckoutOrder,
  CheckoutStatus,
  PanelStatus,
} from '../../../../../shared/types/account'
import {
  CheckoutFlow,
  PANEL_POLL_MS,
  PANEL_WAIT_MS,
  SETTLE_RETRIES,
  SETTLE_RETRY_MS,
  VERIFY_COOLDOWN_MS,
} from './checkoutFlow'
import type { CheckoutIntent } from './checkoutLogic'
import { FAST_INTERVAL_MS } from './orderWatch'
import { takeNotice, trackClosed } from './useCheckout'

// 弹窗的流程：下单 → 等待付款 → 到账；面板凭证过期时去浏览器确认账号，确认后用同一个 requestId 自动接着下单；
// 关掉弹窗不取消订单（docs/ui/in-app-payment.md §2.2、§5.5、§6.3、§6.5）。

const T0 = Date.parse('2026-10-18T03:00:00Z')
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => vi.useRealTimers())

const order = (status: CheckoutStatus = 'pending', over: Partial<CheckoutOrder> = {}): CheckoutOrder => ({
  orderId: 1234,
  kind: 'balance',
  status,
  method: 'alipay',
  methodLabel: '支付宝',
  payAmount: 122.4,
  payCurrency: 'CNY',
  feeRate: 2,
  credited: 126,
  bonus: 6,
  plan: null,
  qrContent: status === 'pending' ? 'https://qr.example.com/x' : null,
  qrSource: status === 'pending' ? 'provider' : null,
  payUrl: null,
  createdAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 30 * 60_000).toISOString(),
  paidAt: null,
  completedAt: null,
  serverTime: new Date(Date.now()).toISOString(),
  reused: false,
  ...over,
})

const intent: CheckoutIntent = {
  kind: 'balance',
  amount: 120,
  method: 'alipay',
  estimatePay: 122.4,
  payCurrency: 'CNY',
}
const planIntent: CheckoutIntent = { kind: 'plan', planId: 7, method: 'wxpay', estimatePay: 99, payCurrency: 'CNY' }

const acct = (balance: number, planName: string | null = null): AccountInfo => ({
  email: 'a@b.c',
  name: 'a',
  balance,
  currency: 'USD',
  group: null,
  plan: planName ? { name: planName, expiresAt: null, daily: null, weekly: null, monthly: null } : null,
  rateLimits: [],
  updatedAt: 1,
})

function make(opts: { balances?: number[] } = {}) {
  const create = vi.fn(async (_input: CheckoutCreateInput) => order())
  const get = vi.fn(async (_id: number) => order())
  const verify = vi.fn(async (_id: number) => order())
  const cancel = vi.fn(async (_id: number) => order('cancelled'))
  const openPayUrl = vi.fn(async (_id: number) => undefined)
  const openPayWindow = vi.fn(async (_id: number) => undefined)
  const closePayWindow = vi.fn(async (_id: number) => undefined)
  const panelStatus = vi.fn(
    async (): Promise<PanelStatus> => ({ valid: true, expiresAt: null, usableForCheckout: true }),
  )
  const panelVerify = vi.fn(async () => undefined)
  // 账号刷新：第一次是下单前的基准（余额 10），之后依次返回 balances
  const balances = [...(opts.balances ?? [10, 136])]
  const refresh = vi.fn(async (): Promise<AccountRefreshResult> => {
    const b = balances.length > 1 ? balances.shift()! : balances[0]
    return { error: null, account: acct(b) }
  })
  const onCompleted = vi.fn()
  const onLateOrder = vi.fn()
  let n = 0
  const flow = new CheckoutFlow({
    bridge: {
      checkoutCreate: create,
      checkoutGet: get,
      checkoutVerify: verify,
      checkoutCancel: cancel,
      checkoutOpenPayUrl: openPayUrl,
      checkoutOpenPayWindow: openPayWindow,
      checkoutClosePayWindow: closePayWindow,
      panelStatus,
      panelVerify,
    },
    refreshAccount: refresh,
    getAccount: () => acct(10),
    newRequestId: () => `req-${++n}`,
    onCompleted,
    onLateOrder,
  })
  return {
    flow,
    create,
    get,
    verify,
    cancel,
    openPayUrl,
    openPayWindow,
    closePayWindow,
    panelStatus,
    panelVerify,
    refresh,
    onCompleted,
    onLateOrder,
  }
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const reauthError = () => codedError('checkout.PANEL_REAUTH_REQUIRED')

describe('下单', () => {
  it('充值：用 requestId 和金额、方式下单，出码后进入订单状态并开始轮询', async () => {
    const t = make()
    t.flow.begin(intent, false)
    expect(t.flow.getState()).toMatchObject({ open: true, phase: 'creating' })
    await tick(0)
    expect(t.create).toHaveBeenCalledWith({ requestId: 'req-1', kind: 'balance', amount: 120, method: 'alipay' })
    expect(t.flow.getState()).toMatchObject({ phase: 'order', order: { orderId: 1234, status: 'pending' } })
    await tick(FAST_INTERVAL_MS)
    expect(t.get).toHaveBeenCalledWith(1234)
  })

  it('套餐：先停在「准备」步骤，换支付方式后点扫码才下单，只传 planId', async () => {
    const t = make()
    t.flow.begin(planIntent, true)
    expect(t.flow.getState().phase).toBe('prepare')
    expect(t.create).not.toHaveBeenCalled()
    t.flow.setMethod('alipay')
    void t.flow.submit()
    await tick(0)
    expect(t.create).toHaveBeenCalledWith({ requestId: 'req-1', kind: 'plan', planId: 7, method: 'alipay' })
  })

  it('下单出错：显示错误，「重试」用同一个 requestId', async () => {
    const t = make()
    t.create.mockRejectedValueOnce(codedError('checkout.UPSTREAM_UNAVAILABLE'))
    t.flow.begin(intent, false)
    await tick(0)
    expect(t.flow.getState()).toMatchObject({ phase: 'error', error: { code: 'UPSTREAM_UNAVAILABLE' } })
    t.flow.retry()
    await tick(0)
    expect(t.create).toHaveBeenCalledTimes(2)
    expect(t.create.mock.calls[1][0].requestId).toBe('req-1')
    expect(t.flow.getState().phase).toBe('order')
  })

  it('请求编号被占用（REQUEST_REUSED）：重试时换新的 requestId', async () => {
    const t = make()
    t.create.mockRejectedValueOnce(codedError('checkout.REQUEST_REUSED'))
    t.flow.begin(intent, false)
    await tick(0)
    t.flow.retry()
    await tick(0)
    expect(t.create.mock.calls[1][0].requestId).toBe('req-2')
  })

  it('过期后「重新下单」：新的 requestId，参数不变', async () => {
    const t = make()
    t.create.mockResolvedValueOnce(order('expired'))
    t.flow.begin(intent, false)
    await tick(0)
    expect(t.flow.getState().order?.status).toBe('expired')
    t.flow.reorder()
    await tick(0)
    expect(t.create).toHaveBeenCalledTimes(2)
    expect(t.create.mock.calls[1][0]).toEqual({ requestId: 'req-2', kind: 'balance', amount: 120, method: 'alipay' })
  })

  it('从「继续付款」恢复：读单拿回二维码；没有下单意图所以不能重新下单', async () => {
    const t = make()
    t.flow.resume(1234)
    await tick(0)
    expect(t.get).toHaveBeenCalledWith(1234)
    expect(t.create).not.toHaveBeenCalled()
    expect(t.flow.getState()).toMatchObject({
      phase: 'order',
      intent: null,
      order: { qrContent: 'https://qr.example.com/x' },
    })
    t.flow.reorder()
    await tick(0)
    expect(t.create).not.toHaveBeenCalled()
  })

  it('恢复失败：显示错误，重试再读单', async () => {
    const t = make()
    t.get.mockRejectedValueOnce(codedError('checkout.ORDER_NOT_FOUND'))
    t.flow.resume(1234)
    await tick(0)
    expect(t.flow.getState()).toMatchObject({ phase: 'error', error: { code: 'ORDER_NOT_FOUND' } })
    t.flow.retry()
    await tick(0)
    expect(t.flow.getState().phase).toBe('order')
  })
})

describe('需要确认账号 → 自动接着下单', () => {
  it('PANEL_REAUTH_REQUIRED 切到确认账号；点「去浏览器确认」打开浏览器，凭证够用后用同一个 requestId 同样的参数再下单', async () => {
    const t = make()
    t.create.mockRejectedValueOnce(reauthError())
    t.panelStatus
      .mockResolvedValueOnce({ valid: false, expiresAt: null, usableForCheckout: false })
      .mockResolvedValueOnce({ valid: true, expiresAt: null, usableForCheckout: true })
    t.flow.begin(intent, false)
    await tick(0)
    expect(t.flow.getState()).toMatchObject({ phase: 'reauth', reauth: 'idle' })

    await t.flow.startReauth()
    expect(t.panelVerify).toHaveBeenCalledTimes(1)
    expect(t.flow.getState().reauth).toBe('waiting')
    await tick(PANEL_POLL_MS)
    expect(t.create).toHaveBeenCalledTimes(1) // 第一次还没确认
    await tick(PANEL_POLL_MS)
    expect(t.panelStatus).toHaveBeenCalledTimes(2)
    expect(t.create).toHaveBeenCalledTimes(2)
    expect(t.create.mock.calls[1][0]).toEqual(t.create.mock.calls[0][0]) // 同一个 requestId，同样的参数
    expect(t.flow.getState()).toMatchObject({ phase: 'order', reauth: 'idle' })
  })

  it('等待期间查状态失败就接着等', async () => {
    const t = make()
    t.create.mockRejectedValueOnce(reauthError())
    t.panelStatus.mockRejectedValueOnce(new Error('offline'))
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.startReauth()
    await tick(PANEL_POLL_MS * 2)
    expect(t.create).toHaveBeenCalledTimes(2)
  })

  it('用户在等待期间关掉弹窗：不再自动下单', async () => {
    const t = make()
    t.create.mockRejectedValueOnce(reauthError())
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.startReauth()
    t.flow.close()
    await tick(PANEL_WAIT_MS)
    expect(t.panelStatus).not.toHaveBeenCalled()
    expect(t.create).toHaveBeenCalledTimes(1)
  })

  it('等了 10 分钟没等到：超时，可以再试一次', async () => {
    const t = make()
    t.create.mockRejectedValueOnce(reauthError())
    t.panelStatus.mockResolvedValue({ valid: false, expiresAt: null, usableForCheckout: false })
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.startReauth()
    await tick(PANEL_WAIT_MS + PANEL_POLL_MS)
    expect(t.flow.getState().reauth).toBe('timeout')
    const polls = t.panelStatus.mock.calls.length
    await tick(PANEL_WAIT_MS)
    expect(t.panelStatus.mock.calls.length).toBe(polls) // 超时后不再查
    await t.flow.startReauth()
    expect(t.panelVerify).toHaveBeenCalledTimes(2)
    expect(t.flow.getState().reauth).toBe('waiting')
  })

  it('打开浏览器失败：留在原处，显示原因', async () => {
    const t = make()
    t.create.mockRejectedValueOnce(reauthError())
    t.panelVerify.mockRejectedValueOnce(new Error('确认地址不在可信域名内，已拒绝打开'))
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.startReauth()
    expect(t.flow.getState()).toMatchObject({
      reauth: 'idle',
      reauthError: { message: '确认地址不在可信域名内，已拒绝打开' },
    })
    expect(t.panelStatus).not.toHaveBeenCalled()
  })
})

describe('订单上的操作', () => {
  it('「我已付款」3 秒内只能点一次；结果交给轮询采用', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    t.verify.mockResolvedValue(order('paid'))
    await t.flow.verify()
    await t.flow.verify() // 冷却中
    expect(t.verify).toHaveBeenCalledTimes(1)
    expect(t.flow.getState()).toMatchObject({ verifyLocked: true, order: { status: 'paid' }, notYet: false })
    await tick(VERIFY_COOLDOWN_MS)
    expect(t.flow.getState().verifyLocked).toBe(false)
    await t.flow.verify()
    expect(t.verify).toHaveBeenCalledTimes(2)
  })

  it('核实后仍是待付：提示「暂时没有查到付款」；状态一变就收起', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.verify()
    expect(t.flow.getState().notYet).toBe(true)
    t.get.mockResolvedValue(order('paid'))
    await tick(FAST_INTERVAL_MS)
    expect(t.flow.getState()).toMatchObject({ notYet: false, order: { status: 'paid' } })
  })

  it('核实失败：显示原因，订单不变', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    t.verify.mockRejectedValueOnce(codedError('checkout.RATE_LIMITED'))
    await t.flow.verify()
    expect(t.flow.getState()).toMatchObject({
      busy: null,
      actionError: { code: 'RATE_LIMITED' },
      order: { status: 'pending' },
    })
  })

  it('取消订单：调用取消，结果就是新的状态（可能其实是已付款）', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.cancel()
    expect(t.cancel).toHaveBeenCalledWith(1234)
    expect(t.flow.getState().order?.status).toBe('cancelled')

    const u = make()
    u.flow.begin(intent, false)
    await tick(0)
    u.cancel.mockResolvedValueOnce(order('paid'))
    await u.flow.cancel()
    expect(u.flow.getState().order?.status).toBe('paid')
  })

  it('打开支付页只传订单号；失败显示原因', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.openPayUrl()
    expect(t.openPayUrl).toHaveBeenCalledWith(1234)
    t.openPayUrl.mockRejectedValueOnce(new Error('这笔订单没有可以打开的支付页'))
    await t.flow.openPayUrl()
    expect(t.flow.getState().actionError?.message).toBe('这笔订单没有可以打开的支付页')
  })
})

describe('订单阶段面板凭证失效 → 确认账号后继续查这笔订单', () => {
  async function onOrderWithBadPanel() {
    const t = make()
    t.create.mockResolvedValueOnce(order('pending', { panelValid: false }))
    t.flow.begin(intent, false)
    await tick(0)
    expect(t.flow.getState()).toMatchObject({ phase: 'order', order: { panelValid: false } })
    return t
  }

  it('点「去浏览器确认账号」打开浏览器，等凭证够用后马上查这笔订单；不下新单、requestId 不变', async () => {
    const t = await onOrderWithBadPanel()
    t.panelStatus
      .mockResolvedValueOnce({ valid: false, expiresAt: null, usableForCheckout: false })
      .mockResolvedValueOnce({ valid: true, expiresAt: null, usableForCheckout: true })
    t.get.mockResolvedValue(order('pending', { panelValid: true }))
    await t.flow.startReauth()
    expect(t.panelVerify).toHaveBeenCalledTimes(1)
    expect(t.flow.getState()).toMatchObject({ phase: 'order', reauth: 'waiting' })
    await tick(PANEL_POLL_MS)
    expect(t.get).not.toHaveBeenCalled() // 第一次还没确认（订单自己的轮询是 3 秒一拍，没到）
    await tick(PANEL_POLL_MS)
    expect(t.panelStatus).toHaveBeenCalledTimes(2)
    expect(t.get).toHaveBeenCalledWith(1234)
    expect(t.create).toHaveBeenCalledTimes(1) // 没有下新单
    expect(t.flow.getState()).toMatchObject({
      phase: 'order',
      reauth: 'idle',
      order: { orderId: 1234, panelValid: true },
    })
    // 轮询接着跑
    const calls = t.get.mock.calls.length
    await tick(FAST_INTERVAL_MS)
    expect(t.get.mock.calls.length).toBe(calls + 1)
  })

  it('确认完马上查到订单已付款：接着按已付款的节奏走', async () => {
    const t = await onOrderWithBadPanel()
    t.get.mockResolvedValue(order('paid', { panelValid: true }))
    await t.flow.startReauth()
    await tick(PANEL_POLL_MS)
    expect(t.flow.getState().order).toMatchObject({ status: 'paid', panelValid: true })
  })

  it('确认完这一次没查到：照常轮询接着查', async () => {
    const t = await onOrderWithBadPanel()
    t.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(order('pending', { panelValid: true }))
    await t.flow.startReauth()
    await tick(PANEL_POLL_MS)
    expect(t.get).toHaveBeenCalled()
    expect(t.flow.getState().reauth).toBe('idle')
    await tick(FAST_INTERVAL_MS * 2)
    expect(t.flow.getState().order).toMatchObject({ panelValid: true })
  })

  it('订单的凭证是好的时候点不起作用；打开浏览器失败显示原因，可以再试', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.startReauth()
    expect(t.panelVerify).not.toHaveBeenCalled()

    const u = await onOrderWithBadPanel()
    u.panelVerify.mockRejectedValueOnce(new Error('打不开浏览器'))
    await u.flow.startReauth()
    expect(u.flow.getState()).toMatchObject({ reauth: 'idle', reauthError: { message: '打不开浏览器' } })
    await u.flow.startReauth()
    expect(u.flow.getState().reauth).toBe('waiting')
    expect(u.flow.getState().reauthError).toBeNull()
  })

  it('等了 10 分钟没等到：超时可以再试；等待期间关掉弹窗就不再查', async () => {
    const t = await onOrderWithBadPanel()
    t.get.mockImplementation(async () =>
      order('pending', { panelValid: false, expiresAt: new Date(T0 + 60 * 60_000).toISOString() }),
    )
    t.panelStatus.mockResolvedValue({ valid: false, expiresAt: null, usableForCheckout: false })
    await t.flow.startReauth()
    await tick(PANEL_WAIT_MS + PANEL_POLL_MS)
    expect(t.flow.getState().reauth).toBe('timeout')
    await t.flow.startReauth()
    expect(t.flow.getState().reauth).toBe('waiting')
    t.flow.close()
    const polls = t.panelStatus.mock.calls.length
    await tick(PANEL_WAIT_MS)
    expect(t.panelStatus.mock.calls.length).toBe(polls)
  })
})

describe('关闭弹窗', () => {
  it('不取消订单，停止轮询；返回手里的订单，待付的进「继续付款」列表', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    const closed = t.flow.close()
    expect(closed?.orderId).toBe(1234)
    expect(t.cancel).not.toHaveBeenCalled()
    expect(t.flow.getState().open).toBe(false)
    await tick(FAST_INTERVAL_MS * 10)
    expect(t.get).not.toHaveBeenCalled()

    const list = trackClosed([], closed!, 5)
    expect(list).toHaveLength(1)
    expect(list[0].order.qrContent).toBeNull() // 列表里不留二维码
    expect(trackClosed(list, order('pending', { payAmount: 1 }), 6)).toHaveLength(1) // 同一笔单只留最新的
    expect(trackClosed([], order('paid'), 5)).toHaveLength(1) // 已付款正在到账的也跟着
    expect(trackClosed([], order('completed'), 5)).toEqual([]) // 已到账 / 终态不进列表
    expect(trackClosed([], order('expired'), 5)).toEqual([])
  })

  it('已到账 / 已取消的单关弹窗时从列表里移走（不留旧状态的横条，也不会因它消失再提示一次到账）', () => {
    const other = order('pending', { orderId: 9 })
    const list = trackClosed(trackClosed([], other, 1), order('pending'), 2)
    expect(list.map(t => t.order.orderId)).toEqual([1234, 9])
    for (const status of ['completed', 'cancelled', 'failed', 'expired', 'refunded'] as const) {
      const next = trackClosed(list, order(status), 3)
      expect(
        next.map(t => t.order.orderId),
        status,
      ).toEqual([9]) // 只移走这一笔，别的单不动
    }
    // 已付款正在到账的留着
    expect(trackClosed(list, order('paid'), 3).map(t => t.order.status)).toEqual(['paid', 'pending'])
  })

  it('到账提示按订单号去重：同一笔只提示一次', () => {
    const seen = new Set<number>()
    expect(takeNotice(seen, 1234)).toBe(true)
    expect(takeNotice(seen, 1234)).toBe(false)
    expect(takeNotice(seen, 9)).toBe(true)
  })

  it('下单还在途中就关掉：订单在云端建好了，通知列表刷新，不会冒出弹窗', async () => {
    const t = make()
    let resolve!: (o: CheckoutOrder) => void
    t.create.mockImplementationOnce(() => new Promise<CheckoutOrder>(r => (resolve = r)))
    t.flow.begin(intent, false)
    await tick(0)
    expect(t.flow.close()).toBeNull()
    resolve(order())
    await tick(0)
    expect(t.onLateOrder).toHaveBeenCalledTimes(1)
    expect(t.flow.getState().open).toBe(false)
  })

  it('刚关掉又重新开始：新的下单要等上一个下单回来（主进程同一时间只收一个）', async () => {
    const t = make()
    let resolve!: (o: CheckoutOrder) => void
    t.create.mockImplementationOnce(() => new Promise<CheckoutOrder>(r => (resolve = r)))
    t.flow.begin(intent, false)
    await tick(0)
    t.flow.close()
    t.flow.begin(intent, false)
    await tick(0)
    expect(t.create).toHaveBeenCalledTimes(1)
    resolve(order())
    await tick(0)
    expect(t.create).toHaveBeenCalledTimes(2)
    expect(t.flow.getState().phase).toBe('order')
  })
})

describe('到账', () => {
  it('轮询看到 completed：强制刷新账号，对比下单前的余额，提示一次', async () => {
    const t = make({ balances: [10, 136] })
    t.flow.begin(intent, false)
    await tick(0)
    t.get.mockResolvedValue(order('completed'))
    await tick(FAST_INTERVAL_MS)
    expect(t.flow.getState().order?.status).toBe('completed')
    await tick(0)
    expect(t.flow.getState().outcome).toMatchObject({ settling: false, change: { balance: { from: 10, to: 136 } } })
    expect(t.onCompleted).toHaveBeenCalledTimes(1)
    expect(t.onCompleted.mock.calls[0][1]).toMatchObject({ balance: { from: 10, to: 136 } })
    await tick(FAST_INTERVAL_MS * 5)
    expect(t.refresh).toHaveBeenCalledTimes(2) // 基准一次，到账一次；不会重复结算
  })

  it('账号缓存还没跟上（对比为空）：每 2 秒再刷，最多 3 次；还是空就只说已到账', async () => {
    const t = make({ balances: [10, 10, 10, 10, 10] })
    t.create.mockResolvedValueOnce(order('completed')) // 复用 / 幂等返回的就是已到账的单
    t.flow.begin(intent, false)
    await tick(0)
    await tick(SETTLE_RETRY_MS * SETTLE_RETRIES)
    expect(t.flow.getState().outcome).toEqual({ settling: false, change: null })
    expect(t.refresh).toHaveBeenCalledTimes(1 + 1 + SETTLE_RETRIES)
    expect(t.onCompleted.mock.calls[0][1]).toBeNull()
  })

  it('对比一出来就不再重试', async () => {
    const t = make({ balances: [10, 10, 136] })
    t.create.mockResolvedValueOnce(order('completed'))
    t.flow.begin(intent, false)
    await tick(0)
    await tick(SETTLE_RETRY_MS * 5)
    expect(t.flow.getState().outcome?.change).toMatchObject({ balance: { from: 10, to: 136 } })
    expect(t.refresh).toHaveBeenCalledTimes(3)
  })

  it('已付款：记下第一次看到的时刻（超过 2 分钟没到账会提示到账有点慢）', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    t.get.mockResolvedValue(order('paid'))
    await tick(FAST_INTERVAL_MS)
    expect(t.flow.getState()).toMatchObject({ order: { status: 'paid' }, paidAt: T0 + FAST_INTERVAL_MS })
  })

  it('轮询连续失败：先提示网络不稳定，5 次后报错，「重试」恢复', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    t.get.mockRejectedValue(new Error('offline'))
    await tick(FAST_INTERVAL_MS)
    expect(t.flow.getState()).toMatchObject({ unstable: true, watchError: null })
    await tick(FAST_INTERVAL_MS * 4)
    expect(t.flow.getState()).toMatchObject({ unstable: false, watchError: { message: 'offline' } })
    t.get.mockResolvedValue(order('pending'))
    t.flow.retryWatch()
    await tick(0)
    expect(t.flow.getState()).toMatchObject({ unstable: false, watchError: null })
  })
})

// pay_url 订单（支付FM 这类只给收银台网页）：不显示二维码，下单 / 恢复订单时自动开付款窗口，订单不再待付或弹窗关闭时关掉
describe('付款窗口（pay_url 订单）', () => {
  const cashier = (status: CheckoutStatus = 'pending', over: Partial<CheckoutOrder> = {}): CheckoutOrder =>
    order(status, {
      qrContent: status === 'pending' ? 'https://pay.example.com/cashier/1' : null,
      qrSource: status === 'pending' ? 'pay_url' : null,
      payUrl: status === 'pending' ? 'https://pay.example.com/cashier/1' : null,
      ...over,
    })
  const makeCashier = () => {
    const t = make()
    t.create.mockResolvedValue(cashier())
    t.get.mockResolvedValue(cashier())
    return t
  }

  it('下单成功自动打开付款窗口，只传订单号', async () => {
    const t = makeCashier()
    t.flow.begin(intent, false)
    await tick(0)
    expect(t.openPayWindow).toHaveBeenCalledTimes(1)
    expect(t.openPayWindow).toHaveBeenCalledWith(1234)
    expect(t.flow.getState().payWindow).toBe('open')
    // 之后轮询到的还是待付，不会再自动开
    await tick(FAST_INTERVAL_MS * 3)
    expect(t.openPayWindow).toHaveBeenCalledTimes(1)
  })

  it('「继续付款」恢复订单时也自动打开', async () => {
    const t = makeCashier()
    t.flow.resume(1234)
    await tick(0)
    expect(t.get).toHaveBeenCalledWith(1234)
    expect(t.openPayWindow).toHaveBeenCalledWith(1234)
    expect(t.flow.getState().payWindow).toBe('open')
  })

  it('provider 订单（显示二维码）不开付款窗口，关闭时也不调关窗', async () => {
    const t = make()
    t.flow.begin(intent, false)
    await tick(0)
    expect(t.openPayWindow).not.toHaveBeenCalled()
    expect(t.flow.getState().payWindow).toBe('idle')
    t.flow.close()
    expect(t.closePayWindow).not.toHaveBeenCalled()
  })

  it('订单变成已付款 / 已到账 / 已取消：关掉付款窗口，只关一次', async () => {
    for (const status of ['paid', 'completed', 'cancelled', 'expired', 'failed'] as const) {
      const t = makeCashier()
      t.flow.begin(intent, false)
      await tick(0)
      t.get.mockResolvedValue(cashier(status))
      await tick(FAST_INTERVAL_MS)
      expect(t.closePayWindow, status).toHaveBeenCalledTimes(1)
      expect(t.closePayWindow).toHaveBeenCalledWith(1234)
      expect(t.flow.getState().payWindow, status).toBe('idle')
      t.flow.dispose()
    }
  })

  it('「我已付款」核实到已付款：关窗', async () => {
    const t = makeCashier()
    t.flow.begin(intent, false)
    await tick(0)
    t.verify.mockResolvedValue(cashier('paid'))
    await t.flow.verify()
    expect(t.closePayWindow).toHaveBeenCalledWith(1234)
  })

  it('取消订单：关窗', async () => {
    const t = makeCashier()
    t.cancel.mockResolvedValue(cashier('cancelled'))
    t.flow.begin(intent, false)
    await tick(0)
    await t.flow.cancel()
    expect(t.closePayWindow).toHaveBeenCalledWith(1234)
  })

  it('关闭弹窗：关窗（订单留着）', async () => {
    const t = makeCashier()
    t.flow.begin(intent, false)
    await tick(0)
    t.flow.close()
    expect(t.closePayWindow).toHaveBeenCalledWith(1234)
    expect(t.cancel).not.toHaveBeenCalled()
  })

  it('用户自己关了窗口：状态变 closed，轮询不会自动再开；「重新打开付款窗口」才再开', async () => {
    const t = makeCashier()
    t.flow.begin(intent, false)
    await tick(0)
    t.flow.payWindowEvent({ orderId: 1234, state: 'closed' })
    expect(t.flow.getState().payWindow).toBe('closed')
    await tick(FAST_INTERVAL_MS * 3)
    expect(t.openPayWindow).toHaveBeenCalledTimes(1)
    await t.flow.openPayWindow()
    expect(t.openPayWindow).toHaveBeenCalledTimes(2)
    expect(t.flow.getState().payWindow).toBe('open')
  })

  it('页面加载失败（事件）：状态变 failed；打开本身失败（调用报错）也是 failed', async () => {
    const t = makeCashier()
    t.flow.begin(intent, false)
    await tick(0)
    t.flow.payWindowEvent({ orderId: 1234, state: 'failed' })
    expect(t.flow.getState().payWindow).toBe('failed')
    t.openPayWindow.mockRejectedValueOnce(new Error('这笔订单没有可以打开的支付页'))
    await t.flow.openPayWindow()
    expect(t.flow.getState().payWindow).toBe('failed')
    await t.flow.openPayWindow() // 重新打开成功
    expect(t.flow.getState().payWindow).toBe('open')
  })

  it('别的订单的事件、关了弹窗之后的事件忽略', async () => {
    const t = makeCashier()
    t.flow.begin(intent, false)
    await tick(0)
    t.flow.payWindowEvent({ orderId: 9999, state: 'closed' })
    expect(t.flow.getState().payWindow).toBe('open')
    t.flow.close()
    t.flow.payWindowEvent({ orderId: 1234, state: 'closed' })
    expect(t.flow.getState().payWindow).toBe('idle')
  })

  it('本地倒计时到期：closePayWindow 关窗，之后轮询到的 pending 不会再自动开', async () => {
    const t = makeCashier()
    t.flow.begin(intent, false)
    await tick(0)
    t.flow.closePayWindow()
    expect(t.closePayWindow).toHaveBeenCalledWith(1234)
    t.flow.closePayWindow() // 没有窗口了，不重复调
    expect(t.closePayWindow).toHaveBeenCalledTimes(1)
    await tick(FAST_INTERVAL_MS * 3)
    expect(t.openPayWindow).toHaveBeenCalledTimes(1)
  })

  it('重新下单（换订单）：旧窗口关掉，新订单自动开窗', async () => {
    const t = makeCashier()
    t.flow.begin(intent, false)
    await tick(0)
    t.get.mockResolvedValue(cashier('expired'))
    await tick(FAST_INTERVAL_MS)
    t.create.mockResolvedValue(cashier('pending', { orderId: 5678 }))
    t.get.mockResolvedValue(cashier('pending', { orderId: 5678 }))
    t.flow.reorder()
    await tick(0)
    expect(t.openPayWindow).toHaveBeenLastCalledWith(5678)
    expect(t.flow.getState().payWindow).toBe('open')
  })
})

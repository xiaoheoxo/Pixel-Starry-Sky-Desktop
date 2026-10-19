import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCodedError } from '@pixelsky/protocol'
import type { CheckoutCreateInput } from '../../../shared/types/account'
import {
  DEMO_COMPLETE_MS,
  DEMO_PAID_MS,
  DEMO_CASHIER,
  DEMO_QR,
  DEMO_REAUTH_AMOUNT,
  DEMO_REAUTH_MS,
  createDemoCheckout,
} from './checkout'
import { demoAccount } from './account'
import { demoStore } from './store'

const balance = (requestId: string, amount: number, method = 'alipay'): CheckoutCreateInput => ({
  requestId,
  kind: 'balance',
  amount,
  method,
})

describe('演示模式的软件内付款', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('下单后 8 秒变已付款、再 2 秒到账，余额增加；二维码只在待付时给', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const order = await demo.bridge.checkoutCreate(balance('r1', 100, 'wxpay'))
    expect(order.status).toBe('pending')
    expect(order.qrContent).toBe(DEMO_QR)
    expect(order.credited).toBe(105)
    const before = demo.account().balance ?? 0
    let notified = 0
    demo.subscribe(() => notified++)

    await vi.advanceTimersByTimeAsync(DEMO_PAID_MS)
    const paid = await demo.bridge.checkoutGet(order.orderId)
    expect(paid.status).toBe('paid')
    expect(paid.qrContent).toBeNull()
    expect(demo.account().balance).toBe(before)

    await vi.advanceTimersByTimeAsync(DEMO_COMPLETE_MS)
    expect((await demo.bridge.checkoutGet(order.orderId)).status).toBe('completed')
    expect(demo.account().balance).toBeCloseTo(before + 105, 2)
    expect(notified).toBe(1)
  })

  it('支付宝是 pay_url 订单（收银台链接），微信是 provider 订单（二维码）；两种都带支付链接', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const ali = await demo.bridge.checkoutCreate(balance('a1', 50, 'alipay'))
    expect(ali).toMatchObject({ qrSource: 'pay_url', qrContent: DEMO_CASHIER, payUrl: DEMO_CASHIER })
    expect(DEMO_CASHIER).toBe('https://example.invalid/pixelsky-demo-cashier')
    const wx = await demo.bridge.checkoutCreate(balance('w1', 50, 'wxpay'))
    expect(wx).toMatchObject({ qrSource: 'provider', qrContent: DEMO_QR, payUrl: DEMO_QR })
    // 查单、同 requestId 重复下单拿到的还是同一种；待付列表不带二维码
    expect(await demo.bridge.checkoutGet(ali.orderId)).toMatchObject({ qrSource: 'pay_url', qrContent: DEMO_CASHIER })
    expect((await demo.bridge.checkoutCreate(balance('a1', 50, 'alipay'))).qrSource).toBe('pay_url')
    const listed = await demo.bridge.checkoutPending()
    expect(listed.every(o => o.qrContent === null && o.qrSource === null)).toBe(true)
  })

  it('演示桥的付款窗口：不开真窗口，认识的订单直接成功，不认识的订单报错；关窗什么都不做', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const ali = await demo.bridge.checkoutCreate(balance('a2', 50, 'alipay'))
    await expect(demo.bridge.checkoutOpenPayWindow(ali.orderId)).resolves.toBeUndefined()
    await expect(demo.bridge.checkoutClosePayWindow(ali.orderId)).resolves.toBeUndefined()
    await expect(demo.bridge.checkoutOpenPayWindow(424242)).rejects.toThrow('找不到这笔订单')
    // 付款后支付宝订单照样到账
    await demo.bridge.checkoutVerify(ali.orderId)
    await vi.advanceTimersByTimeAsync(DEMO_COMPLETE_MS)
    expect((await demo.bridge.checkoutGet(ali.orderId)).status).toBe('completed')
  })

  it('同一个 requestId 返回同一笔订单', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const a = await demo.bridge.checkoutCreate(balance('same', 50))
    const b = await demo.bridge.checkoutCreate(balance('same', 50))
    expect(b.orderId).toBe(a.orderId)
  })

  it('点「我已付款」立刻变已付款，2 秒后到账', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const order = await demo.bridge.checkoutCreate(balance('r2', 20))
    expect((await demo.bridge.checkoutVerify(order.orderId)).status).toBe('paid')
    await vi.advanceTimersByTimeAsync(DEMO_COMPLETE_MS)
    expect((await demo.bridge.checkoutGet(order.orderId)).status).toBe('completed')
    // 原来的 8 秒定时器已经作废，不会重复到账
    const balanceAfter = demo.account().balance
    await vi.advanceTimersByTimeAsync(DEMO_PAID_MS)
    expect(demo.account().balance).toBe(balanceAfter)
  })

  it('套餐单到账后账号换成这个套餐', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const order = await demo.bridge.checkoutCreate({ requestId: 'p1', kind: 'plan', planId: 3, method: 'wxpay' })
    expect(order.plan?.name).toBe('Max 季卡')
    expect(order.payAmount).toBe(799)
    await demo.bridge.checkoutVerify(order.orderId)
    await vi.advanceTimersByTimeAsync(DEMO_COMPLETE_MS)
    expect(demo.account().plan?.name).toBe('Max 季卡')
  })

  it('金额 66.6 先要求确认账号，3 秒后可用，之后同一个 requestId 能下单', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const err = await demo.bridge.checkoutCreate(balance('r3', DEMO_REAUTH_AMOUNT)).catch((e: unknown) => e)
    expect(parseCodedError((err as Error).message)?.code).toBe('checkout.PANEL_REAUTH_REQUIRED')
    expect((await demo.bridge.panelStatus()).usableForCheckout).toBe(false)

    await demo.bridge.panelVerify()
    await vi.advanceTimersByTimeAsync(DEMO_REAUTH_MS - 1)
    expect((await demo.bridge.panelStatus()).usableForCheckout).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await demo.bridge.panelStatus()).usableForCheckout).toBe(true)

    const order = await demo.bridge.checkoutCreate(balance('r3', DEMO_REAUTH_AMOUNT))
    expect(order.status).toBe('pending')
    // 下一次填 66.6 又要重新确认，方便反复演示
    const again = await demo.bridge.checkoutCreate(balance('r4', DEMO_REAUTH_AMOUNT)).catch((e: unknown) => e)
    expect(again).toBeInstanceOf(Error)
  })

  it('取消待付单：不再变已付款，也不会到账；已付款的不能取消', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const before = demo.account().balance
    const order = await demo.bridge.checkoutCreate(balance('r5', 30))
    expect((await demo.bridge.checkoutCancel(order.orderId)).status).toBe('cancelled')
    await vi.advanceTimersByTimeAsync(DEMO_PAID_MS + DEMO_COMPLETE_MS)
    expect((await demo.bridge.checkoutGet(order.orderId)).status).toBe('cancelled')
    expect(demo.account().balance).toBe(before)

    const paid = await demo.bridge.checkoutCreate(balance('r6', 30))
    await demo.bridge.checkoutVerify(paid.orderId)
    expect((await demo.bridge.checkoutCancel(paid.orderId)).status).toBe('paid')
  })

  it('待付列表：含待付和已付款、不带二维码，到账 / 取消后消失', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const a = await demo.bridge.checkoutCreate(balance('l1', 10))
    const b = await demo.bridge.checkoutCreate(balance('l2', 20))
    const list = await demo.bridge.checkoutPending()
    expect(list.map(o => o.orderId)).toEqual([b.orderId, a.orderId])
    expect(list.every(o => o.qrContent === null)).toBe(true)

    await demo.bridge.checkoutCancel(a.orderId)
    expect((await demo.bridge.checkoutPending()).map(o => o.orderId)).toEqual([b.orderId])
    await vi.advanceTimersByTimeAsync(DEMO_PAID_MS + DEMO_COMPLETE_MS)
    expect(await demo.bridge.checkoutPending()).toEqual([])
  })

  it('30 分钟没付款变已过期，倒计时用 serverTime 和 expiresAt', async () => {
    const demo = createDemoCheckout(demoAccount, demoStore)
    const order = await demo.bridge.checkoutCreate(balance('e1', 10))
    expect(Date.parse(order.expiresAt) - Date.parse(order.serverTime)).toBe(30 * 60_000)
    // 取消定时器后快进，模拟没人点也没有 8 秒自动付款
    await demo.bridge.checkoutCancel(order.orderId)
    const slow = await demo.bridge.checkoutCreate(balance('e2', 10))
    vi.setSystemTime(Date.now() + 30 * 60_000)
    // 8 秒定时器会先触发（fake timers 只在 advance 时走），所以直接读单
    expect((await demo.bridge.checkoutGet(slow.orderId)).status).toBe('expired')
  })
})

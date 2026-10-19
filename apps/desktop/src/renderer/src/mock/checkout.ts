// 演示模式下的软件内付款（--demo，docs/ui/in-app-payment.md §6.10）：假的下单 / 查单 / 取消 / 待付列表，不连任何网络。
// 订单 8 秒后（或点「我已付款」后）变 paid，再过 2 秒变 completed，演示账号的余额 / 套餐随之增加；
// 支付宝演示成「只给收银台链接」的 pay_url 订单（弹窗里走付款窗口，演示桥不开真窗口），微信是 provider 订单（显示二维码），两条路径都能点到；
// 金额填 66.6 时先要求确认账号（PANEL_REAUTH_REQUIRED），点「去浏览器确认」不开浏览器，3 秒后算确认成功。
import { codedError } from '@pixelsky/protocol'
import type {
  AccountInfo,
  CheckoutCreateInput,
  CheckoutOrder,
  PanelStatus,
  StoreCatalog,
} from '../../../shared/types/account'
import type { DemoCheckout } from '@/data/demo'
import { tr } from '../i18n/core'
import { quoteRecharge } from '../features/account/storeLogic'

export const DEMO_QR = 'https://example.invalid/pixelsky-demo-pay'
/** 演示的收银台链接（支付宝订单的 qrContent / payUrl，qrSource=pay_url） */
export const DEMO_CASHIER = 'https://example.invalid/pixelsky-demo-cashier'
/** 填这个金额会模拟「需要先在浏览器里确认账号」 */
export const DEMO_REAUTH_AMOUNT = 66.6
export const DEMO_PAID_MS = 8_000
export const DEMO_COMPLETE_MS = 2_000
export const DEMO_REAUTH_MS = 3_000
const ORDER_TIMEOUT_MS = 30 * 60_000
const DAY_MS = 86_400_000

interface Entry {
  order: CheckoutOrder
  paidTimer: ReturnType<typeof setTimeout> | null
  doneTimer: ReturnType<typeof setTimeout> | null
}

export function createDemoCheckout(
  initial: AccountInfo,
  catalog: StoreCatalog,
  now: () => number = Date.now,
): DemoCheckout {
  let account = initial
  const listeners = new Set<() => void>()
  const orders = new Map<number, Entry>()
  const byRequest = new Map<string, number>()
  let nextId = 1001
  let panelOk = false
  let panelTimer: ReturnType<typeof setTimeout> | null = null

  const methodLabel = (method: string): string => catalog.methods.find(m => m.type === method)?.label ?? method

  /** 到期的待付单变 expired（按 30 分钟算，不用真等） */
  const settleExpiry = (e: Entry): void => {
    if (e.order.status === 'pending' && now() >= Date.parse(e.order.expiresAt))
      e.order = { ...e.order, status: 'expired' }
  }

  const view = (e: Entry, withQr = true): CheckoutOrder => {
    settleExpiry(e)
    const pending = e.order.status === 'pending'
    return {
      ...e.order,
      serverTime: new Date(now()).toISOString(),
      qrContent: pending && withQr ? e.order.qrContent : null,
      qrSource: pending && withQr ? e.order.qrSource : null,
      payUrl: pending && withQr ? e.order.payUrl : null,
    }
  }

  const find = (orderId: number): Entry => {
    const e = orders.get(orderId)
    if (!e) throw new Error('找不到这笔订单，请重新下单')
    return e
  }

  /** 到账：演示账号的余额 / 套餐加上订单的额度 */
  const credit = (order: CheckoutOrder): void => {
    const t = now()
    if (order.kind === 'plan' && order.plan) {
      const base = account.plan?.name === order.plan.name ? Date.parse(account.plan.expiresAt ?? '') : NaN
      const from = Number.isFinite(base) && base > t ? base : t
      const expiresAt = new Date(from + order.plan.validityDays * DAY_MS).toISOString()
      const prev = account.plan
      const plan = catalog.plans.find(p => p.id === order.plan?.id)
      account = {
        ...account,
        plan: {
          name: order.plan.name,
          expiresAt,
          daily: prev?.daily ?? (plan?.quotas.daily ? { used: 0, limit: plan.quotas.daily } : null),
          weekly: prev?.weekly ?? (plan?.quotas.weekly ? { used: 0, limit: plan.quotas.weekly } : null),
          monthly: prev?.monthly ?? (plan?.quotas.monthly ? { used: 0, limit: plan.quotas.monthly } : null),
        },
        updatedAt: t,
      }
    } else {
      account = {
        ...account,
        balance: Math.round(((account.balance ?? 0) + (order.credited ?? 0)) * 100) / 100,
        updatedAt: t,
      }
    }
    for (const l of listeners) l()
  }

  const clearTimers = (e: Entry): void => {
    if (e.paidTimer) clearTimeout(e.paidTimer)
    if (e.doneTimer) clearTimeout(e.doneTimer)
    e.paidTimer = null
    e.doneTimer = null
  }

  const complete = (e: Entry): void => {
    e.doneTimer = null
    if (e.order.status !== 'paid') return
    e.order = { ...e.order, status: 'completed', completedAt: new Date(now()).toISOString() }
    credit(e.order)
  }

  const markPaid = (e: Entry): void => {
    clearTimers(e)
    if (e.order.status !== 'pending' && e.order.status !== 'expired') return
    e.order = { ...e.order, status: 'paid', paidAt: new Date(now()).toISOString() }
    e.doneTimer = setTimeout(() => complete(e), DEMO_COMPLETE_MS)
  }

  const bridge: DemoCheckout['bridge'] = {
    async checkoutCreate(input: CheckoutCreateInput): Promise<CheckoutOrder> {
      const known = byRequest.get(input.requestId)
      if (known !== undefined) return view(find(known))
      const t = now()
      let order: Omit<CheckoutOrder, 'orderId'>
      const cashier = input.method === 'alipay'
      const base = {
        status: 'pending' as const,
        method: input.method,
        methodLabel: methodLabel(input.method),
        payCurrency: catalog.currency,
        qrContent: cashier ? DEMO_CASHIER : DEMO_QR,
        qrSource: cashier ? ('pay_url' as const) : ('provider' as const),
        payUrl: cashier ? DEMO_CASHIER : DEMO_QR,
        createdAt: new Date(t).toISOString(),
        expiresAt: new Date(t + ORDER_TIMEOUT_MS).toISOString(),
        paidAt: null,
        completedAt: null,
        serverTime: new Date(t).toISOString(),
        reused: false,
      }
      if (input.kind === 'plan') {
        const plan = catalog.plans.find(p => p.id === input.planId)
        if (!plan) throw codedError('checkout.PLAN_NOT_FOUND')
        order = {
          ...base,
          kind: 'plan',
          payAmount: plan.price,
          feeRate: 0,
          credited: null,
          bonus: null,
          plan: { id: plan.id, name: plan.name, validityDays: plan.validityDays },
        }
      } else {
        const r = catalog.recharge
        const amount = input.amount ?? 0
        if (amount < r.min || (r.max > 0 && amount > r.max))
          throw codedError('checkout.AMOUNT_OUT_OF_RANGE', { min: r.min, max: r.max })
        if (amount === DEMO_REAUTH_AMOUNT && !panelOk) throw codedError('checkout.PANEL_REAUTH_REQUIRED')
        const quote = quoteRecharge(r, amount)
        order = {
          ...base,
          kind: 'balance',
          payAmount: quote.pay,
          feeRate: r.feeRate,
          credited: quote.credited,
          bonus: quote.bonus,
          plan: null,
        }
      }
      // 确认账号只管这一单：下次填 66.6 又会要求确认，方便反复演示
      if (input.kind === 'balance' && input.amount === DEMO_REAUTH_AMOUNT) panelOk = false
      const entry: Entry = { order: { ...order, orderId: nextId++ }, paidTimer: null, doneTimer: null }
      entry.paidTimer = setTimeout(() => markPaid(entry), DEMO_PAID_MS)
      orders.set(entry.order.orderId, entry)
      byRequest.set(input.requestId, entry.order.orderId)
      return view(entry)
    },
    async checkoutGet(orderId) {
      return view(find(orderId))
    },
    async checkoutVerify(orderId) {
      const e = find(orderId)
      settleExpiry(e)
      markPaid(e)
      return view(e)
    },
    async checkoutCancel(orderId) {
      const e = find(orderId)
      settleExpiry(e)
      if (e.order.status === 'pending') {
        clearTimers(e)
        e.order = { ...e.order, status: 'cancelled' }
      }
      return view(e)
    },
    async checkoutPending() {
      return [...orders.values()]
        .map(e => view(e, false))
        .filter(o => o.status === 'pending' || o.status === 'paid')
        .sort((a, b) => b.orderId - a.orderId)
    },
    async checkoutOpenPayUrl() {
      throw new Error(tr('settings.account.Store.demoNoOpen'))
    },
    // 演示不开真窗口，只当成功（弹窗里会写明这是演示）；订单要存在，和主进程一样认不得的订单报错
    async checkoutOpenPayWindow(orderId) {
      find(orderId)
    },
    async checkoutClosePayWindow() {},
    async panelStatus(): Promise<PanelStatus> {
      return {
        valid: panelOk,
        expiresAt: panelOk ? new Date(now() + 7 * DAY_MS).toISOString() : null,
        usableForCheckout: panelOk,
      }
    },
    async panelVerify() {
      if (panelTimer) clearTimeout(panelTimer)
      panelTimer = setTimeout(() => {
        panelTimer = null
        panelOk = true
      }, DEMO_REAUTH_MS)
    },
  }

  return {
    bridge,
    account: () => account,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

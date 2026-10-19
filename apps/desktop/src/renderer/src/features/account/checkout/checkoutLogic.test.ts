import { afterEach, describe, expect, it, vi } from 'vitest'
import { codedError } from '@pixelsky/protocol'
import { allMessages, setCurrentLocale } from '../../../i18n/core'
import type { CheckoutOrder, StoreCatalog, StorePlan } from '../../../../../shared/types/account'
import {
  EXPIRED_VERIFY_MS,
  EXPIRED_WATCH_MS,
  amountDiffers,
  balanceIntent,
  browserTarget,
  canVerifyExpired,
  checkoutAvailable,
  checkoutErrorText,
  checkoutMethods,
  countdownAnnounce,
  focusTrapTarget,
  formatCountdown,
  inExpiredWatchWindow,
  isFinalStatus,
  loadMethod,
  nextRadioIndex,
  orderPhase,
  parseCheckoutError,
  pickMethod,
  planIntent,
  remainingMs,
  saveMethod,
  stepIndex,
  vanishedOrders,
  type CheckoutIntent,
} from './checkoutLogic'

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
})

const MIN = 60_000
const order = (over: Partial<CheckoutOrder> = {}): CheckoutOrder => ({
  orderId: 1234,
  kind: 'balance',
  status: 'pending',
  method: 'alipay',
  methodLabel: '支付宝',
  payAmount: 122.4,
  payCurrency: 'CNY',
  feeRate: 2,
  credited: 126,
  bonus: 6,
  plan: null,
  qrContent: 'https://qr.example.com/x',
  qrSource: 'provider',
  payUrl: null,
  createdAt: '2026-10-18T03:00:00Z',
  expiresAt: '2026-10-18T03:30:00Z',
  paidAt: null,
  completedAt: null,
  serverTime: '2026-10-18T03:00:01Z',
  reused: false,
  ...over,
})

describe('状态映射', () => {
  it('订单状态 → 弹窗状态；待付单到了 expires_at 就算过期', () => {
    expect(orderPhase('pending', 5 * MIN)).toBe('waiting')
    expect(orderPhase('pending', 0)).toBe('expired')
    expect(orderPhase('pending', -1)).toBe('expired')
    expect(orderPhase('paid', -MIN)).toBe('paid') // 已付款不受倒计时影响
    expect(orderPhase('completed', 0)).toBe('completed')
    expect(orderPhase('expired', 9 * MIN)).toBe('expired')
    for (const s of ['cancelled', 'failed', 'refunding', 'refunded', 'unknown'] as const)
      expect(orderPhase(s, MIN)).toBe('ended')
  })
  it('终态：不再轮询；待付和已付款还在路上', () => {
    expect(isFinalStatus('pending')).toBe(false)
    expect(isFinalStatus('paid')).toBe(false)
    for (const s of ['completed', 'expired', 'cancelled', 'failed', 'refunding', 'refunded', 'unknown'] as const)
      expect(isFinalStatus(s)).toBe(true)
  })
  it('状态条走到第几步', () => {
    expect(stepIndex('waiting')).toBe(0)
    expect(stepIndex('paid')).toBe(1)
    expect(stepIndex('completed')).toBe(2)
    expect(stepIndex('expired')).toBe(-1)
    expect(stepIndex('ended')).toBe(-1)
  })
})

describe('倒计时', () => {
  const o = order({ expiresAt: '2026-10-18T03:30:00Z', serverTime: '2026-10-18T03:00:00Z' })
  it('剩余 = expires_at − server_time − (本机现在 − 收到响应的时刻)', () => {
    const received = 1_000_000
    expect(remainingMs(o, received, received)).toBe(30 * MIN)
    expect(remainingMs(o, received, received + 19_000)).toBe(30 * MIN - 19_000)
  })
  it('本机时钟快 5 分钟或慢 5 分钟，倒计时都一样（只用时间差）', () => {
    const real = Date.parse('2026-10-18T03:00:00Z')
    for (const skew of [-5 * MIN, 0, 5 * MIN]) {
      const received = real + skew
      expect(remainingMs(o, received, received + 60_000)).toBe(29 * MIN)
    }
  })
  it('时间格式不对当作已到期', () => {
    expect(remainingMs(order({ expiresAt: 'x' }), 0, 0)).toBe(0)
  })
  it('mm:ss；负数当 0；超过 1 小时带小时', () => {
    expect(formatCountdown(29 * MIN + 41_000)).toBe('29:41')
    expect(formatCountdown(59)).toBe('00:01') // 不足一秒向上取整，不会提前显示 00:00
    expect(formatCountdown(0)).toBe('00:00')
    expect(formatCountdown(-5000)).toBe('00:00')
    expect(formatCountdown(3_725_000)).toBe('1:02:05')
  })
  it('只在剩 5 分钟和 1 分钟时各播报一次', () => {
    expect(countdownAnnounce(5 * MIN + 1000, 5 * MIN)).toBe(5)
    expect(countdownAnnounce(5 * MIN, 5 * MIN - 1000)).toBeNull() // 已经播过
    expect(countdownAnnounce(MIN + 1000, MIN)).toBe(1)
    expect(countdownAnnounce(4 * MIN, 3 * MIN)).toBeNull()
    expect(countdownAnnounce(10 * MIN, 30_000)).toBe(1) // 一下越过两个门槛（窗口在后台）：取更近的
  })
  it('过期后「我已付款」保留 1 天（云端到期后 1 天内还会刷新）', () => {
    expect(EXPIRED_VERIFY_MS).toBe(24 * 60 * MIN)
    expect(canVerifyExpired(-EXPIRED_VERIFY_MS + 1)).toBe(true)
    expect(canVerifyExpired(-EXPIRED_VERIFY_MS)).toBe(false)
    expect(canVerifyExpired(-30 * MIN)).toBe(true) // 自动再查停了以后手动还能点
  })
  it('过期后自动再查 10 分钟', () => {
    expect(EXPIRED_WATCH_MS).toBe(10 * MIN)
    expect(inExpiredWatchWindow(0)).toBe(true)
    expect(inExpiredWatchWindow(-EXPIRED_WATCH_MS + 1)).toBe(true)
    expect(inExpiredWatchWindow(-EXPIRED_WATCH_MS)).toBe(false)
  })
})

describe('改用浏览器付款打开哪一页', () => {
  const plans = [
    { id: 7, groupId: 3 },
    { id: 8, groupId: null },
  ]
  const balanceOrder: Pick<CheckoutOrder, 'kind' | 'plan'> = { kind: 'balance', plan: null }
  const planOrder = (id: number): Pick<CheckoutOrder, 'kind' | 'plan'> => ({
    kind: 'plan',
    plan: { id, name: 'Pro', validityDays: 30 },
  })
  it('充值单（下单意图或订单）打开充值页', () => {
    expect(browserTarget({ kind: 'balance' }, null, plans)).toBeNull()
    expect(browserTarget({ kind: 'balance' }, balanceOrder, plans)).toBeNull()
    expect(browserTarget(null, balanceOrder, plans)).toBeNull()
    expect(browserTarget(null, null, plans)).toBeNull()
  })
  it('套餐单打开订阅页，带上套餐的分组', () => {
    expect(browserTarget({ kind: 'plan', planId: 7 }, null, plans)).toEqual({ tab: 'subscription', group: 3 })
    expect(browserTarget({ kind: 'plan', planId: 7 }, planOrder(7), plans)).toEqual({
      tab: 'subscription',
      group: 3,
    })
  })
  it('从「继续付款」恢复的套餐单（没有下单意图）也打开订阅页，订单上的套餐为准', () => {
    expect(browserTarget(null, planOrder(7), plans)).toEqual({ tab: 'subscription', group: 3 })
    expect(browserTarget({ kind: 'plan', planId: 8 }, planOrder(7), plans)).toEqual({
      tab: 'subscription',
      group: 3,
    })
  })
  it('拿不到分组（套餐下架了、没有分组）就只打开订阅页', () => {
    expect(browserTarget(null, planOrder(99), plans)).toEqual({ tab: 'subscription' })
    expect(browserTarget(null, planOrder(8), plans)).toEqual({ tab: 'subscription' })
    expect(browserTarget(null, { kind: 'plan', plan: null }, plans)).toEqual({ tab: 'subscription' })
  })
})

describe('应付与估算的差异', () => {
  const intent = (over: Partial<CheckoutIntent> = {}): CheckoutIntent => ({
    kind: 'balance',
    amount: 120,
    method: 'alipay',
    estimatePay: 122.4,
    payCurrency: 'CNY',
    ...over,
  })
  it('差 1 分以上才提示，一模一样或差不到 1 分不提示', () => {
    expect(amountDiffers(order({ payAmount: 122.4 }), intent())).toBe(false)
    expect(amountDiffers(order({ payAmount: 122.41 }), intent())).toBe(true)
    expect(amountDiffers(order({ payAmount: 122.39 }), intent())).toBe(true)
    expect(amountDiffers(order({ payAmount: 122.4000001 }), intent())).toBe(false)
    expect(amountDiffers(order({ payAmount: 130 }), intent())).toBe(true)
  })
  it('没有估算（币种拿不准、从「继续付款」恢复）或币种不同：不提示', () => {
    expect(amountDiffers(order({ payAmount: 999 }), intent({ estimatePay: null }))).toBe(false)
    expect(amountDiffers(order({ payAmount: 999 }), null)).toBe(false)
    expect(amountDiffers(order({ payAmount: 999 }), intent({ payCurrency: 'USD' }))).toBe(false)
    expect(amountDiffers(order({ payAmount: 999, payCurrency: 'cny' }), intent())).toBe(true) // 币种不分大小写
  })
  it('充值页的下单意图：币种拿不准时不给估算', () => {
    const quote = { pay: 122.4, credited: 126, bonus: 6 }
    const base = { amount: 120, method: 'alipay', quote, payCurrency: 'CNY' }
    expect(balanceIntent({ ...base, dueTrusted: true })).toMatchObject({
      kind: 'balance',
      amount: 120,
      method: 'alipay',
      estimatePay: 122.4,
      estimateCredited: 126,
      estimateBonus: 6,
    })
    expect(balanceIntent({ ...base, dueTrusted: false }).estimatePay).toBeNull()
  })
  it('套餐页的下单意图：只传套餐 id，估算是标价', () => {
    const plan = { id: 7, name: 'Pro 月卡', price: 99, currency: 'CNY', validityDays: 30 } as StorePlan
    const i = planIntent(plan, 'wxpay')
    expect(i).toMatchObject({ kind: 'plan', planId: 7, method: 'wxpay', estimatePay: 99, payCurrency: 'CNY' })
    expect(i.amount).toBeUndefined()
  })
})

describe('待付单列表', () => {
  it('消失的订单号（可能已到账）', () => {
    expect(vanishedOrders([order({ orderId: 1 }), order({ orderId: 2 })], [order({ orderId: 2 })])).toEqual([1])
    expect(vanishedOrders([], [order()])).toEqual([])
  })
})

describe('支付方式', () => {
  const catalog: Pick<StoreCatalog, 'enabled' | 'methods' | 'checkout'> = {
    enabled: true,
    methods: [
      { type: 'alipay', label: '支付宝' },
      { type: 'stripe', label: 'Stripe' },
      { type: 'wxpay', label: '微信支付' },
    ],
    checkout: { enabled: true, methods: ['wxpay', 'alipay'], orderTimeoutMinutes: 30 },
  }
  it('商品数据的方式和 checkout.methods 取交集，顺序跟商品数据', () => {
    expect(checkoutMethods(catalog).map(m => m.type)).toEqual(['alipay', 'wxpay'])
  })
  it('可用条件：支付总开关、checkout.enabled、至少一种方式；缺 checkout 字段（旧云端）就是不可用', () => {
    expect(checkoutAvailable(catalog)).toBe(true)
    expect(checkoutAvailable({ ...catalog, checkout: undefined })).toBe(false)
    expect(checkoutAvailable({ ...catalog, checkout: { ...catalog.checkout!, enabled: false } })).toBe(false)
    expect(checkoutAvailable({ ...catalog, enabled: false })).toBe(false)
    expect(checkoutAvailable({ ...catalog, checkout: { ...catalog.checkout!, methods: ['stripe-x'] } })).toBe(false)
  })
  it('默认选第一个；记住上次选的；当前选的优先；记的方式不在列表里就忽略', () => {
    const options = checkoutMethods(catalog)
    expect(pickMethod(options, null, null)).toBe('alipay')
    expect(pickMethod(options, null, 'wxpay')).toBe('wxpay')
    expect(pickMethod(options, 'alipay', 'wxpay')).toBe('alipay')
    expect(pickMethod(options, null, 'paypal')).toBe('alipay')
    expect(pickMethod([], null, 'wxpay')).toBeNull()
  })
  it('记在 localStorage；不可用时不报错', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    })
    expect(loadMethod()).toBeNull()
    saveMethod('wxpay')
    expect(loadMethod()).toBe('wxpay')
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    })
    expect(loadMethod()).toBeNull()
    expect(() => saveMethod('alipay')).not.toThrow()
  })
})

describe('键盘', () => {
  it('单选组：方向键循环切换，Home / End 跳到两端', () => {
    expect(nextRadioIndex('ArrowRight', 0, 2)).toBe(1)
    expect(nextRadioIndex('ArrowRight', 1, 2)).toBe(0)
    expect(nextRadioIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextRadioIndex('ArrowLeft', 0, 2)).toBe(1)
    expect(nextRadioIndex('ArrowUp', 1, 3)).toBe(0)
    expect(nextRadioIndex('Home', 2, 3)).toBe(0)
    expect(nextRadioIndex('End', 0, 3)).toBe(2)
    expect(nextRadioIndex('a', 0, 3)).toBeNull()
    expect(nextRadioIndex('ArrowRight', 0, 0)).toBeNull()
  })
  it('Tab 在弹窗里循环：最后一个再往后回到第一个，第一个再往前回到最后一个', () => {
    expect(focusTrapTarget(false, 2, 3)).toBe('first')
    expect(focusTrapTarget(false, 0, 3)).toBeNull()
    expect(focusTrapTarget(true, 0, 3)).toBe('last')
    expect(focusTrapTarget(true, 1, 3)).toBeNull()
    // 焦点跑到弹窗外（-1）：拉回来
    expect(focusTrapTarget(false, -1, 3)).toBe('first')
    expect(focusTrapTarget(true, -1, 3)).toBe('last')
    expect(focusTrapTarget(false, 0, 0)).toBeNull()
  })
})

describe('错误文案', () => {
  /** 主进程抛的错经 IPC 到渲染层会带这个前缀 */
  const ipc = (e: Error): Error =>
    new Error(`Error invoking remote method 'account:checkoutCreate': Error: ${e.message}`)
  const coded = (code: string, params?: Record<string, string | number>) => ipc(codedError(`checkout.${code}`, params))

  it('从 IPC 错误里取出 checkout.<CODE> 和参数', () => {
    expect(parseCheckoutError(coded('AMOUNT_OUT_OF_RANGE', { min: 5, max: 1000 }))).toMatchObject({
      code: 'AMOUNT_OUT_OF_RANGE',
      params: { min: 5, max: 1000 },
    })
    expect(parseCheckoutError(coded('PANEL_REAUTH_REQUIRED'))).toMatchObject({
      code: 'PANEL_REAUTH_REQUIRED',
      params: {},
    })
  })
  it('没有码的错误是可读的中文，原样保留；别的模块的码不算', () => {
    expect(parseCheckoutError(new Error('请先刷新套餐信息'))).toMatchObject({ code: null, message: '请先刷新套餐信息' })
    expect(parseCheckoutError(ipc(codedError('files.exists')))).toMatchObject({ code: null })
    expect(parseCheckoutError(undefined)).toMatchObject({ code: null, message: '' })
  })

  const CODES = [
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
  ]
  it.each(CODES)('%s：中英文案都有，带不带参数都不会留下没替换的 {…}', code => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      setCurrentLocale(locale)
      for (const params of [undefined, { min: 5, max: 1000, remaining: 12.5 }]) {
        const text = checkoutErrorText(parseCheckoutError(coded(code, params)))
        expect(text).toBeTruthy()
        expect(text).not.toMatch(/\{\w+\}/)
        if (locale === 'en-US') expect(text).not.toMatch(/[一-鿿]/)
      }
    }
  })
  it('文案与方案 §4.5 一致（金额用 formatPrice）', () => {
    expect(checkoutErrorText(parseCheckoutError(coded('AMOUNT_OUT_OF_RANGE', { min: 5, max: 1000 })))).toBe(
      '金额要在 ¥5 – ¥1,000 之间',
    )
    expect(checkoutErrorText(parseCheckoutError(coded('TOO_MANY_PENDING', { max: 3 })))).toBe(
      '你有 3 笔未付款的订单，请先付款或取消其中一笔',
    )
    expect(checkoutErrorText(parseCheckoutError(coded('DAILY_LIMIT_EXCEEDED', { remaining: 12.5 })))).toBe(
      '今天的付款额度只剩 ¥12.50',
    )
    setCurrentLocale('en-US')
    expect(checkoutErrorText(parseCheckoutError(coded('INTERNAL_ERROR')))).toBe(
      'The payment service ran into a problem. Try again later',
    )
    expect(checkoutErrorText(parseCheckoutError(coded('AMOUNT_OUT_OF_RANGE', { min: 5, max: 1000 })))).toBe(
      'Amount must be between ¥5 and ¥1,000',
    )
    expect(checkoutErrorText(parseCheckoutError(coded('PANEL_REAUTH_REQUIRED')))).toBe(
      'Confirm your account in the browser once to pay in the app',
    )
  })
  it('每日额度用完（remaining ≤ 0）不说「只剩 ¥0」，说已用完', () => {
    for (const remaining of [0, -3]) {
      expect(checkoutErrorText(parseCheckoutError(coded('DAILY_LIMIT_EXCEEDED', { remaining })))).toBe(
        '今天的付款额度已用完',
      )
    }
    expect(checkoutErrorText(parseCheckoutError(coded('DAILY_LIMIT_EXCEEDED')))).toBe('今天的付款额度已用完')
    expect(checkoutErrorText(parseCheckoutError(coded('DAILY_LIMIT_EXCEEDED', { remaining: 0.01 })))).toBe(
      '今天的付款额度只剩 ¥0.01',
    )
    setCurrentLocale('en-US')
    expect(checkoutErrorText(parseCheckoutError(coded('DAILY_LIMIT_EXCEEDED', { remaining: 0 })))).toBe(
      "Today's payment limit is used up",
    )
  })
  it('金额范围 max 为 0（不限）：只说下限', () => {
    expect(checkoutErrorText(parseCheckoutError(coded('AMOUNT_OUT_OF_RANGE', { min: 5, max: 0 })))).toBe(
      '金额不能低于 ¥5',
    )
    expect(checkoutErrorText(parseCheckoutError(coded('AMOUNT_OUT_OF_RANGE')))).toBe('金额不在允许的范围内')
  })
  it('没有码的错误走 translateMessage（英文界面有译文）；空消息有兜底', () => {
    expect(checkoutErrorText(parseCheckoutError(new Error('找不到这笔订单，请重新下单')))).toBe(
      '找不到这笔订单，请重新下单',
    )
    setCurrentLocale('en-US')
    expect(checkoutErrorText(parseCheckoutError(new Error('找不到这笔订单，请重新下单')))).toBe(
      'Order not found. Please place a new order',
    )
    expect(checkoutErrorText(parseCheckoutError(new Error('确认地址不在可信域名内，已拒绝打开')))).toBe(
      'The confirmation URL is not trusted and was not opened',
    )
    expect(checkoutErrorText(parseCheckoutError(new Error('这笔订单没有可以打开的支付页')))).toBe(
      'This order has no payment page to open',
    )
    for (const zh of [
      '连不上付款服务，请检查网络后重试',
      '付款服务响应超时，请稍后重试',
      '下单超时：请稍后在「继续付款」里查看，不会重复下单',
      '登录状态已变化，请重试',
    ])
      expect(checkoutErrorText(parseCheckoutError(new Error(zh))), zh).not.toMatch(/[一-鿿]/)
    expect(checkoutErrorText(parseCheckoutError(null))).toBe(allMessages['settings.account.Checkout.error.UNKNOWN'].en)
  })
})

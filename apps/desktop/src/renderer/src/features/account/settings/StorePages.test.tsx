import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import type { AccountInfo, CheckoutOrder, StoreCatalog, StorePlan } from '../../../../../shared/types/account'
import { balanceIntent, planIntent } from '../checkout/checkoutLogic'
import type { CheckoutHost } from '../checkout/useCheckout'
import type { StoreState } from '../useStore'
import { PlanStore } from './PlanStore'
import { StorePages } from './StorePages'
import { AccountCheckNotice, PaymentOutcome, StoreHeader, changeLines } from './StoreParts'
import { TopUp } from './TopUp'

// 订阅套餐 / 充值页：账号核对提示、余额与套餐头部、到账反馈、预计应付（用静态渲染，不依赖 DOM）。
// 软件内付款（checkout）关着时页面和以前一模一样；开着时的支付方式单选、扫码付款、待付单条（docs/ui/in-app-payment.md §6.1、§6.2、§8.3）。

// StorePages 里的商品数据：默认是读取中（上面的老用例看的就是这个），软件内付款的用例按需换成已读到的目录
const mocked = vi.hoisted(() => ({ state: { status: 'loading' } as StoreState }))
vi.mock('../useStore', async importOriginal => {
  const real = await importOriginal<typeof import('../useStore')>()
  return {
    ...real,
    useStore: () => ({ state: mocked.state, reload: async () => undefined, open: async () => 'demo' as const }),
  }
})

const account: AccountInfo = {
  email: 'alice@example.com',
  name: 'Alice',
  balance: 12.5,
  currency: 'USD',
  group: null,
  plan: { name: 'Pro 月卡', expiresAt: '2026-11-01T12:00:00Z', daily: null, weekly: null, monthly: null },
  rateLimits: [],
  updatedAt: 1,
}

const catalog = (over: Partial<StoreCatalog> = {}): StoreCatalog => ({
  enabled: true,
  currency: 'CNY',
  currencyKnown: true,
  plans: [],
  recharge: {
    enabled: true,
    min: 5,
    max: 1000,
    multiplier: 1,
    feeRate: 2,
    bonusMode: 'bonus',
    bonusTiers: [{ minAmount: 100, bonusPercent: 10 }],
    usdToCnyRate: 7,
  },
  methods: [{ type: 'alipay', label: '支付宝' }],
  helpText: '',
  purchaseUrl: 'https://pixelstarrysky.xyz/purchase',
  redeemUrl: 'https://pixelstarrysky.xyz/redeem',
  ...over,
})

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
  mocked.state = { status: 'loading' }
})

function render(node: React.ReactElement, locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  vi.stubGlobal('localStorage', { getItem: () => locale, setItem: () => undefined })
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>)
}

describe('StorePages 顶部', () => {
  const refresh = async () => ({ error: null, account })
  it('打开支付页之前就显示「请确认浏览器里面板登录的是 邮箱」，并显示余额、套餐和到期时间', () => {
    const html = render(<StorePages tab="topup" account={account} onRefreshAccount={refresh} />)
    expect(html).toContain('请确认浏览器里面板登录的是 alice@example.com')
    expect(html).toContain('当前余额 $12.50')
    expect(html).toContain('套餐 Pro 月卡')
    expect(html).toMatch(/到期 2026-1[01]-\d\d/)
    expect(html).not.toContain('我已付款')
  })
  it('英文界面：账号核对提示和头部都是英文', () => {
    const html = render(
      <StorePages tab="plans" account={{ ...account, plan: null }} onRefreshAccount={refresh} />,
      'en-US',
    )
    expect(html).toContain('Make sure the panel in your browser is signed in as alice@example.com')
    expect(html).toContain('Balance $12.50')
    expect(html).toContain('No plan')
    expect(html).not.toMatch(/[一-鿿]/)
  })
  it('AccountCheckNotice 是 note 角色', () => {
    expect(render(<AccountCheckNotice email="a@b.c" />)).toContain('role="note"')
  })
  it('StoreHeader：没有套餐时写「暂无套餐」', () => {
    expect(render(<StoreHeader account={{ ...account, plan: null, balance: null }} />)).toContain('暂无套餐')
  })
})

describe('到账反馈', () => {
  it('到账：余额和套餐的前后对比', () => {
    const lines = changeLines({ balance: { from: 10, to: 35 }, plan: { from: null, to: 'Pro' }, expires: null }, 'USD')
    expect(lines).toEqual(['余额 $10.00 → $35.00', '套餐 无 → Pro'])
    const html = render(
      <PaymentOutcome
        outcome={{ kind: 'arrived', change: { balance: { from: 10, to: 35 }, plan: null, expires: null } }}
        currency="USD"
      />,
    )
    expect(html).toContain('已到账')
    expect(html).toContain('余额 $10.00 → $35.00')
  })
  it('续费：到期时间对比', () => {
    const lines = changeLines({ balance: null, plan: null, expires: { from: '2026-11-01T12:00:00Z', to: null } }, 'USD')
    expect(lines[0]).toMatch(/^到期时间 2026-1[01]-\d\d → 无$/)
  })
  it('暂未到账的提示（中英文）', () => {
    const zh = render(<PaymentOutcome outcome={{ kind: 'pending' }} currency="USD" />)
    expect(zh).toContain('暂未到账：可能有几秒延迟；如果一直没到，请到面板确认登录的账号和订单')
    const en = render(<PaymentOutcome outcome={{ kind: 'pending' }} currency="USD" />, 'en-US')
    expect(en).toContain('Not received yet')
  })
})

describe('TopUp 预计应付', () => {
  const onOpen = vi.fn()
  it('可信币种：标签是「预计应付」，含手续费，旁边写明要在面板重新输入金额并可复制', () => {
    const html = render(<TopUp catalog={catalog()} currency="USD" onOpen={onOpen} initialAmount="100" />)
    expect(html).toContain('预计应付')
    expect(html).not.toMatch(/>应付</)
    expect(html).toContain('¥102') // 100 + 2% 手续费
    expect(html).toContain('含手续费 ¥2')
    expect(html).toContain('需在面板里重新输入金额')
    expect(html).toContain('复制金额')
  })
  it('赠送额度的括号放进文案：中文全角、英文半角', () => {
    const zh = render(<TopUp catalog={catalog()} currency="USD" onOpen={onOpen} initialAmount="100" />)
    expect(zh).toContain('（含赠送 $10）')
    const en = render(<TopUp catalog={catalog()} currency="USD" onOpen={onOpen} initialAmount="100" />, 'en-US')
    expect(en).toContain('(incl. $10 bonus)')
    expect(en).not.toContain('）')
    expect(en).toContain('Estimated amount due')
  })
  it('套餐币种和支付币种对不上：不显示应付金额，提示以面板为准', () => {
    const mixed = catalog({
      plans: [{ id: 1, name: 'A', currency: 'USD' } as never],
    })
    const html = render(<TopUp catalog={mixed} currency="USD" onOpen={onOpen} initialAmount="100" />)
    expect(html).not.toContain('¥102')
    expect(html).toContain('支付币种无法确认，请以面板显示的金额为准')
    // 到账额度不受影响
    expect(html).toContain('$110')
  })
  it('云端没给币种（默认值是猜的）：同样不显示', () => {
    const html = render(
      <TopUp catalog={catalog({ currencyKnown: false })} currency="USD" onOpen={onOpen} initialAmount="100" />,
    )
    expect(html).not.toContain('¥102')
    expect(html).toContain('支付币种无法确认')
  })
  it('没输入金额：应付显示「—」，没有币种提示，复制按钮不可点', () => {
    const html = render(<TopUp catalog={catalog()} currency="USD" onOpen={onOpen} />)
    expect(html).not.toContain('支付币种无法确认')
    expect(html).toMatch(/disabled=""[^>]*>[^<]*(<svg[^>]*>.*?<\/svg>)?[^<]*复制金额/s)
  })
})

describe('PlanStore', () => {
  it('没有在售套餐时仍给出打开面板的入口', () => {
    expect(render(<PlanStore catalog={catalog()} currentPlan={null} onOpen={vi.fn()} />)).toContain('打开网页面板')
  })
})

// ---------------------------------------------------------------------------
// 软件内付款
// ---------------------------------------------------------------------------

const methods2 = [
  { type: 'alipay', label: '支付宝' },
  { type: 'wxpay', label: '微信支付' },
]
const checkoutOn = { enabled: true, methods: ['alipay', 'wxpay'], orderTimeoutMinutes: 30 }
const plan = (id: number, over: Partial<StorePlan> = {}): StorePlan => ({
  id,
  name: `套餐${id}`,
  description: '',
  price: 99,
  originalPrice: null,
  currency: 'CNY',
  validityDays: 30,
  features: [],
  groupName: `分组${id}`,
  groupId: id,
  quotas: { fiveHour: null, daily: null, weekly: null, monthly: null },
  sort: id,
  ...over,
})
const pendingOrder = (over: Partial<CheckoutOrder> = {}): CheckoutOrder => ({
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
  qrContent: null,
  qrSource: null,
  payUrl: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 18 * 60_000).toISOString(),
  paidAt: null,
  completedAt: null,
  serverTime: new Date().toISOString(),
  reused: false,
  ...over,
})
const host = (over: Partial<CheckoutHost> = {}): CheckoutHost => ({
  start: vi.fn(),
  resume: vi.fn(),
  pending: [],
  ...over,
})
const tracked = (...orders: CheckoutOrder[]) => orders.map(order => ({ order, at: Date.now() }))

/** 带某个文字的按钮是否可点；没有这个按钮返回 null */
function buttonState(html: string, label: string): 'disabled' | 'enabled' | null {
  const m = new RegExp(`<button([^>]*)>((?:(?!</button>).)*?)${label}`, 's').exec(html)
  if (!m) return null
  return /disabled=""/.test(m[1]) ? 'disabled' : 'enabled'
}

const emailNote = /<p role="note"[^>]*>请确认浏览器里面板登录的是 alice@example.com<\/p>/
const refreshOk = async () => ({ error: null, account })

describe('checkout 关着：页面和以前一模一样', () => {
  const off = [
    ['云端没给 checkout 字段（旧版本）', catalog()],
    ['checkout.enabled 为假', catalog({ checkout: { ...checkoutOn, enabled: false } })],
    ['没有能扫码的方式', catalog({ checkout: { ...checkoutOn, methods: ['stripe'] } })],
    ['支付总开关关着', catalog({ enabled: false, checkout: checkoutOn })],
  ] as const
  const topup = (c: StoreCatalog, h?: CheckoutHost) => (
    <TopUp catalog={c} currency="USD" onOpen={vi.fn()} checkout={h} email="alice@example.com" initialAmount="100" />
  )

  it.each(off)('充值页（%s）：和不带软件内付款时的页面逐字相同', (_name, c) => {
    const baseline = render(topup(catalog({ enabled: c.enabled })))
    expect(render(topup(c, host({ pending: tracked(pendingOrder()) })))).toBe(baseline)
    expect(baseline).not.toContain('role="radiogroup"')
    expect(baseline).not.toContain('扫码付款')
    expect(baseline).not.toContain('去浏览器付款')
    expect(baseline).not.toContain('继续付款')
  })

  it('充值页：原来的内容都在（只读的支付方式、去支付、重新输入金额、复制金额）', () => {
    const html = render(topup(catalog()))
    expect(html).toContain('去支付')
    expect(html).toContain('支付方式和金额在浏览器里的面板中确认')
    expect(html).toContain('需在面板里重新输入金额')
    expect(buttonState(html, '复制金额')).toBe('enabled')
    expect(buttonState(html, '去支付')).toBe('enabled')
  })

  it('充值页：云端开着但页面没接软件内付款（不传 checkout）也一样', () => {
    expect(render(topup(catalog({ checkout: checkoutOn })))).toBe(render(topup(catalog())))
  })

  it('套餐页：卡片只有购买 / 续费，没有「也可以去浏览器购买」和待付单条', () => {
    const base = catalog({ plans: [plan(1), plan(2)] })
    const baseline = render(<PlanStore catalog={base} currentPlan="分组2" onOpen={vi.fn()} />)
    const disabled = { ...base, checkout: { ...checkoutOn, enabled: false } }
    expect(
      render(
        <PlanStore
          catalog={disabled}
          currentPlan="分组2"
          onOpen={vi.fn()}
          checkout={host({ pending: tracked(pendingOrder()) })}
          email="a@b.c"
        />,
      ),
    ).toBe(baseline)
    expect(baseline).toContain('购买')
    expect(baseline).toContain('续费')
    expect(baseline).not.toContain('去浏览器购买')
    expect(baseline).not.toContain('继续付款')
  })

  it('整页：账号核对提示仍在页面顶部，没有软件内付款的入口', () => {
    mocked.state = { status: 'ready', catalog: catalog({ checkout: { ...checkoutOn, enabled: false } }), stale: false }
    const html = render(<StorePages tab="topup" account={account} onRefreshAccount={refreshOk} />)
    expect(html).toContain('请确认浏览器里面板登录的是 alice@example.com')
    expect(html).toContain('付款到账的是面板里登录的账号')
    expect(html).toContain('去支付')
    expect(html).not.toContain('扫码付款')
    expect(html).not.toContain('role="dialog"')
  })
})

describe('checkout 开着：充值页', () => {
  const on = (over: Partial<StoreCatalog> = {}) => catalog({ methods: methods2, checkout: checkoutOn, ...over })
  const topup = (h: CheckoutHost, amount = '100', c = on()) =>
    render(
      <TopUp
        catalog={c}
        currency="USD"
        onOpen={vi.fn()}
        checkout={h}
        email="alice@example.com"
        initialAmount={amount}
      />,
    )

  it('支付方式是单选（radiogroup），默认选第一个；不再写「在浏览器里选」', () => {
    const html = topup(host())
    expect(html).toContain('role="radiogroup"')
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*tabindex="0"[^>]*>.*?支付宝/s)
    expect(html).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*tabindex="-1"[^>]*>.*?微信支付/s)
    expect(html).not.toContain('支付方式和金额在浏览器里的面板中确认')
  })
  it('只列商品数据和 checkout.methods 的交集', () => {
    const html = topup(host(), '100', on({ checkout: { ...checkoutOn, methods: ['wxpay'] } }))
    expect(html).toContain('微信支付')
    expect(html).not.toContain('支付宝')
  })
  it('主按钮「扫码付款」，次要「去浏览器付款」；原来的「去支付」没了', () => {
    const html = topup(host())
    expect(buttonState(html, '扫码付款')).toBe('enabled')
    expect(buttonState(html, '去浏览器付款')).toBe('enabled')
    expect(html).not.toContain('去支付')
  })
  it('浏览器付款才需要的提示跟着挪过来：重新输入金额、复制金额、核对账号（缩成一行小字）', () => {
    const html = topup(host())
    expect(html).toContain('需在面板里重新输入金额')
    expect(buttonState(html, '复制金额')).toBe('enabled')
    expect(html).toMatch(emailNote)
    expect(html).not.toContain('付款到账的是面板里登录的账号')
  })
  it('金额不合法（没填、格式不对、低于下限、高于上限）：两个按钮都不可点', () => {
    for (const amount of ['', '1', '5000', '12.345']) {
      const html = topup(host(), amount)
      expect(buttonState(html, '扫码付款'), amount).toBe('disabled')
      expect(buttonState(html, '去浏览器付款'), amount).toBe('disabled')
    }
    expect(buttonState(topup(host(), '5'), '扫码付款')).toBe('enabled')
  })
  it('币种拿不准（payAmountTrusted 为假）：照样能扫码付款', () => {
    const html = topup(host(), '100', on({ currencyKnown: false }))
    expect(html).toContain('支付币种无法确认')
    expect(buttonState(html, '扫码付款')).toBe('enabled')
  })
  it('有在软件里下的待付单：出现「继续付款」条（方式、金额、还剩几分钟）', () => {
    const html = topup(host({ pending: tracked(pendingOrder()) }))
    expect(html).toContain('你有一笔未付款的订单：支付宝 ¥122.40，还剩 18 分钟')
    expect(buttonState(html, '继续付款')).toBe('enabled')
  })
  it('待付单已到期、或已付款正在到账的：不显示在未付款条里', () => {
    const expired = pendingOrder({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    const paid = pendingOrder({ orderId: 5, status: 'paid' })
    expect(topup(host({ pending: tracked(expired, paid) }))).not.toContain('继续付款')
  })
  it('英文界面全是英文', () => {
    const en = on({
      methods: [
        { type: 'alipay', label: 'Alipay' },
        { type: 'wxpay', label: 'WeChat Pay' },
      ],
    })
    const html = render(
      <TopUp
        catalog={en}
        currency="USD"
        onOpen={vi.fn()}
        checkout={host({ pending: tracked(pendingOrder({ methodLabel: 'Alipay' })) })}
        email="alice@example.com"
        initialAmount="100"
      />,
      'en-US',
    )
    expect(html).toContain('Pay by QR code')
    expect(html).toContain('Pay in browser')
    expect(html).toContain('Continue paying')
    expect(html).toContain('You have an unpaid order: Alipay ¥122.40, 18 min left')
    expect(html).not.toMatch(/[一-鿿]/)
  })
})

describe('checkout 开着：套餐页', () => {
  const on = catalog({ methods: methods2, checkout: checkoutOn, plans: [plan(1), plan(2)] })
  it('购买 / 续费按钮保留；卡片下方加「也可以 去浏览器购买」；页面有待付单条和核对提示', () => {
    const html = render(
      <PlanStore
        catalog={on}
        currentPlan="分组2"
        onOpen={vi.fn()}
        checkout={host({ pending: tracked(pendingOrder()) })}
        email="alice@example.com"
      />,
    )
    expect(buttonState(html, '购买')).toBe('enabled')
    expect(buttonState(html, '续费')).toBe('enabled')
    expect((html.match(/也可以/g) ?? []).length).toBe(2)
    expect((html.match(/去浏览器购买/g) ?? []).length).toBe(2)
    expect(html).toContain('继续付款')
    expect(html).toMatch(emailNote)
  })
  it('整页开着时顶部不再有醒目的账号核对提示（挪到浏览器入口旁）；关着时原样', () => {
    mocked.state = { status: 'ready', catalog: on, stale: false }
    const html = render(<StorePages tab="plans" account={account} onRefreshAccount={refreshOk} />)
    expect(html).not.toContain('付款到账的是面板里登录的账号')
    expect(html).toContain('也可以')
    expect(html).toMatch(emailNote)
    mocked.state = { status: 'ready', catalog: { ...on, checkout: undefined }, stale: false }
    const off = render(<StorePages tab="plans" account={account} onRefreshAccount={refreshOk} />)
    expect(off).toContain('付款到账的是面板里登录的账号')
    expect(off).not.toContain('也可以')
  })
})

describe('checkout 开着：充值关闭 / 没有套餐的空状态仍有账号核对提示', () => {
  const rechargeOff = (checkout = checkoutOn) =>
    catalog({
      methods: methods2,
      checkout,
      recharge: { ...catalog().recharge, enabled: false },
    })
  it('充值关闭：只有打开面板的入口，补一行账号核对提示（顶部的醒目提示在软件内付款开着时被隐藏）', () => {
    const html = render(
      <TopUp catalog={rechargeOff()} currency="USD" onOpen={vi.fn()} checkout={host()} email="alice@example.com" />,
    )
    expect(html).toContain('打开网页面板')
    expect(html).toMatch(emailNote)
  })
  it('充值关闭、软件内付款关着（或页面没接）：不加这一行，和以前一样', () => {
    const off = rechargeOff({ ...checkoutOn, enabled: false })
    const plain = render(
      <TopUp catalog={off} currency="USD" onOpen={vi.fn()} checkout={host()} email="alice@example.com" />,
    )
    expect(plain).not.toContain('请确认浏览器里面板登录的是')
    const noHost = render(<TopUp catalog={rechargeOff()} currency="USD" onOpen={vi.fn()} email="alice@example.com" />)
    expect(noHost).not.toContain('请确认浏览器里面板登录的是')
  })
  it('没有在售套餐：同样补一行；没传邮箱就不显示', () => {
    const empty = catalog({ methods: methods2, checkout: checkoutOn, plans: [] })
    const html = render(
      <PlanStore catalog={empty} currentPlan={null} onOpen={vi.fn()} checkout={host()} email="alice@example.com" />,
    )
    expect(html).toContain('打开网页面板')
    expect(html).toMatch(emailNote)
    expect(render(<PlanStore catalog={empty} currentPlan={null} onOpen={vi.fn()} checkout={host()} />)).not.toContain(
      '请确认浏览器里面板登录的是',
    )
    const off = render(
      <PlanStore
        catalog={{ ...empty, checkout: undefined }}
        currentPlan={null}
        onOpen={vi.fn()}
        checkout={host()}
        email="alice@example.com"
      />,
    )
    expect(off).not.toContain('请确认浏览器里面板登录的是')
  })
  it('整页：只有一处账号核对（顶部醒目提示隐藏，空状态里那一行顶上）', () => {
    mocked.state = { status: 'ready', catalog: rechargeOff(), stale: false }
    const html = render(<StorePages tab="topup" account={account} onRefreshAccount={refreshOk} />)
    expect(html).not.toContain('付款到账的是面板里登录的账号')
    expect((html.match(/请确认浏览器里面板登录的是 alice@example\.com/g) ?? []).length).toBe(1)
    mocked.state = { status: 'ready', catalog: rechargeOff({ ...checkoutOn, enabled: false }), stale: false }
    const off = render(<StorePages tab="topup" account={account} onRefreshAccount={refreshOk} />)
    expect(off).toContain('付款到账的是面板里登录的账号')
  })
})

describe('下单意图由页面给出，参数在主进程再校验', () => {
  it('充值：金额、方式、估算；套餐：只带套餐 id', () => {
    const quote = { pay: 102, credited: 110, bonus: 10 }
    expect(balanceIntent({ amount: 100, method: 'wxpay', quote, dueTrusted: true, payCurrency: 'CNY' })).toMatchObject({
      kind: 'balance',
      amount: 100,
      method: 'wxpay',
      estimatePay: 102,
    })
    const p = planIntent(plan(3), 'alipay')
    expect(p).toMatchObject({ kind: 'plan', planId: 3, method: 'alipay', estimatePay: 99 })
    expect(p.amount).toBeUndefined()
  })
})

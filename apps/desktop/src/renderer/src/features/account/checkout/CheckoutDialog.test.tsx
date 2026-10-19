import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { codedError } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import type { CheckoutOrder, CheckoutStatus, StoreMethod } from '../../../../../shared/types/account'
import { CheckoutFlow, type FlowState } from './checkoutFlow'
import { CheckoutPanel, type CheckoutPanelProps } from './CheckoutDialog'
import { parseCheckoutError, type CheckoutIntent } from './checkoutLogic'

// 二维码跟主题走；静态渲染里没有 ThemeProvider
vi.mock('@/features/appearance/ThemeProvider', () => ({ useTheme: () => ({ resolved: 'light' }) }))

// 弹窗各状态的内容与无障碍标记（静态渲染，不依赖 DOM）。流程本身（下单、确认账号、取消、关闭）见 checkoutFlow.test.ts，
// 键盘与焦点循环的纯逻辑见 checkoutLogic.test.ts（Esc 关闭、焦点回到触发按钮靠 ConfirmDialog 同款的 effect，没有 DOM 环境测）。

const T0 = Date.parse('2026-10-18T03:00:00Z')
const MIN = 60_000

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
})

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
  qrContent: status === 'pending' ? 'https://qr.example.com/pay/abc' : null,
  qrSource: status === 'pending' ? 'provider' : null,
  payUrl: null,
  createdAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 30 * MIN).toISOString(),
  paidAt: null,
  completedAt: null,
  serverTime: new Date(T0).toISOString(),
  reused: false,
  ...over,
})

const intent: CheckoutIntent = {
  kind: 'balance',
  amount: 120,
  method: 'alipay',
  estimatePay: 122.4,
  payCurrency: 'CNY',
  estimateCredited: 126,
  estimateBonus: 6,
}

const state = (over: Partial<FlowState> = {}): FlowState => ({
  open: true,
  phase: 'order',
  intent,
  order: order(),
  receivedAt: T0,
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
  ...over,
})

const methods: StoreMethod[] = [
  { type: 'alipay', label: '支付宝' },
  { type: 'wxpay', label: '微信支付' },
]

const flow = new CheckoutFlow({
  bridge: {
    checkoutCreate: vi.fn(),
    checkoutGet: vi.fn(),
    checkoutVerify: vi.fn(),
    checkoutCancel: vi.fn(),
    checkoutOpenPayUrl: vi.fn(),
    checkoutOpenPayWindow: vi.fn(),
    checkoutClosePayWindow: vi.fn(),
    panelStatus: vi.fn(),
    panelVerify: vi.fn(),
  },
  refreshAccount: vi.fn(),
  getAccount: () => ({ balance: 10, plan: null }),
  newRequestId: () => 'req',
})

function render(s: FlowState, over: Partial<CheckoutPanelProps> = {}, locale: 'zh-CN' | 'en-US' = 'zh-CN'): string {
  vi.stubGlobal('localStorage', { getItem: () => locale, setItem: () => undefined })
  return renderToStaticMarkup(
    <I18nProvider>
      <CheckoutPanel
        flow={flow}
        state={s}
        methods={methods}
        currency="USD"
        email="alice@example.com"
        otherPending={false}
        onClose={() => undefined}
        onBrowser={() => undefined}
        now={T0 + 19_000}
        {...over}
      />
    </I18nProvider>,
  )
}

const hasButton = (html: string, label: string): boolean =>
  new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`, 's').test(html)

describe('弹窗外壳与无障碍', () => {
  it('role=dialog、aria-modal，aria-labelledby 指向标题', () => {
    const html = render(state())
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
    expect(id).toBeTruthy()
    expect(html).toMatch(new RegExp(`<h3 id="${id}"[^>]*>扫码付款</h3>`))
  })
  it('右上角有关闭按钮（带名称），不取消订单', () => {
    expect(render(state())).toMatch(/<button[^>]*aria-label="关闭"/)
  })
  it('状态播报区 role=status、aria-live=polite，只放当前这一步的结论', () => {
    const html = render(state())
    expect(html).toMatch(/<div role="status" aria-live="polite" class="sr-only">等待付款<\/div>/)
  })
})

describe('等待付款', () => {
  it('二维码 role=img，aria-label 写明方式和应付；显示尺寸固定在 180–220 像素', () => {
    const html = render(state())
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="支付宝付款二维码，应付 ¥122.40"/)
    const width = Number(/<svg[^>]*role="img"[^>]*width="(\d+)"/.exec(html)?.[1])
    expect(width).toBeGreaterThanOrEqual(180)
    expect(width).toBeLessThanOrEqual(220)
  })
  it('应付金额（Sub2api 给的）、手续费率、方式、倒计时', () => {
    const html = render(state())
    expect(html).toContain('¥122.40')
    expect(html).toContain('（含 2% 手续费）')
    expect(html).toContain('请用支付宝扫码')
    expect(html).toContain('剩余 29:41') // 30:00 − 19 秒
    expect(html).toContain('余额充值 · 到账 $126（含赠送 $6）')
  })
  it('倒计时只用 server_time 校正：本机时钟快 / 慢不影响', () => {
    // receivedAt / now 都是本机时钟，同样偏 5 分钟，差值不变
    for (const skew of [-5 * MIN, 5 * MIN]) {
      const html = render(state({ receivedAt: T0 + skew }), { now: T0 + skew + 19_000 })
      expect(html).toContain('剩余 29:41')
    }
  })
  it('状态条：三步都有文字，当前一步 aria-current=step，图标 aria-hidden', () => {
    const html = render(state())
    expect(html).toMatch(/<ol aria-label="付款进度"/)
    expect(html).toMatch(
      /<li aria-current="step"[^>]*>.*?等待付款<\/li><li[^>]*>.*?已付款<\/li><li[^>]*>.*?已到账<\/li>/s,
    )
    expect(html).toContain('aria-hidden="true"')
  })
  it('按钮：我已付款、取消订单、改用浏览器付款；没有 pay_url 就没有「在浏览器打开支付页」', () => {
    const html = render(state())
    expect(hasButton(html, '我已付款')).toBe(true)
    expect(hasButton(html, '取消订单')).toBe(true)
    expect(hasButton(html, '改用浏览器付款')).toBe(true)
    expect(html).not.toContain('在浏览器打开这笔订单的支付页')
    expect(render(state({ order: order('pending', { payUrl: 'https://pay.example.com/c/1' }) }))).toContain(
      '扫不出来？在浏览器打开这笔订单的支付页',
    )
  })
  it('核实中或刚点过「我已付款」：按钮不可点', () => {
    expect(render(state({ verifyLocked: true }))).toMatch(/<button[^>]*disabled=""[^>]*>.*?我已付款/s)
    expect(render(state())).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(<svg.*?<\/svg>)?我已付款/s)
  })
  it('取消订单要二次确认：确认界面写明「取消后这个二维码就不能付了」，主按钮换成返回 / 确认取消', () => {
    const html = render(state(), { initialConfirmingCancel: true })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('取消后这个二维码就不能付了')
    expect(hasButton(html, '确认取消')).toBe(true)
    expect(hasButton(html, '返回')).toBe(true)
    expect(hasButton(html, '我已付款')).toBe(false)
    // 平时的界面里没有确认按钮：取消订单要先点「取消订单」
    expect(hasButton(render(state()), '确认取消')).toBe(false)
  })
  it('reused：这是你刚才那笔未付款的订单；换了参数另有未付单：旧码仍可付款的提示', () => {
    expect(render(state({ order: order('pending', { reused: true }) }), { otherPending: true })).toContain(
      '这是你刚才那笔未付款的订单',
    )
    expect(render(state({ order: order('pending', { reused: true }) }), { otherPending: true })).not.toContain(
      '仍然可以付款',
    )
    expect(render(state(), { otherPending: true })).toContain('仍然可以付款')
    expect(render(state())).not.toContain('仍然可以付款')
  })
  it('应付和估算差 1 分以上：提示以此金额为准；一样就不提示', () => {
    expect(render(state({ order: order('pending', { payAmount: 125 }) }))).toContain('应付金额以这里为准')
    expect(render(state())).not.toContain('应付金额以这里为准')
  })
  it('provider 订单照旧：显示二维码，没有付款窗口的说明和按钮', () => {
    const html = render(state())
    expect(html).toContain('role="img"')
    expect(html).not.toContain('付款窗口')
    expect(hasButton(html, '重新打开付款窗口')).toBe(false)
  })
})

describe('等待付款：pay_url 订单（付款窗口）', () => {
  const payUrlOrder = (over: Partial<CheckoutOrder> = {}): CheckoutOrder =>
    order('pending', {
      qrSource: 'pay_url',
      qrContent: 'https://pay.example.com/cashier/abc',
      payUrl: 'https://pay.example.com/cashier/abc',
      ...over,
    })
  const payState = (over: Partial<FlowState> = {}): FlowState => state({ order: payUrlOrder(), ...over })

  it('不再显示我们生成的二维码，改成说明（带支付方式名）和两个按钮', () => {
    const html = render(payState({ payWindow: 'open' }))
    expect(html).not.toContain('role="img"')
    expect(html).not.toContain('<svg role="img"')
    expect(html).toContain('请在弹出的付款窗口里，用手机支付宝扫码付款')
    expect(hasButton(html, '重新打开付款窗口')).toBe(true)
    expect(hasButton(html, '在浏览器打开支付页')).toBe(true)
    // 旧的小字链接不再重复出现；倒计时、状态条、我已付款、取消订单照旧
    expect(html).not.toContain('扫不出来')
    expect(html).not.toContain('请用支付宝扫码')
    expect(html).toContain('剩余 29:41')
    expect(html).toContain('¥122.40')
    expect(hasButton(html, '我已付款')).toBe(true)
    expect(hasButton(html, '取消订单')).toBe(true)
    expect(html).toMatch(/<ol aria-label="付款进度"/)
  })
  it('英文界面', () => {
    const html = render(payState({ payWindow: 'open' }), {}, 'en-US')
    expect(html).toContain('In the payment window that opened, scan the code with 支付宝 on your phone')
    expect(hasButton(html, 'Reopen payment window')).toBe(true)
    expect(hasButton(html, 'Open payment page in browser')).toBe(true)
  })
  it('状态播报不重复：正在打开 / 已关闭只是普通小字，只有加载失败是 role=alert', () => {
    const opening = render(payState({ payWindow: 'opening' }))
    expect(opening).toContain('正在打开付款窗口')
    expect(opening).toMatch(/<div role="status" aria-live="polite" class="sr-only">等待付款<\/div>/)
    expect(opening).not.toContain('role="alert"')
    const closed = render(payState({ payWindow: 'closed' }))
    expect(closed).toContain('付款窗口已关闭')
    expect(closed).not.toContain('role="alert"')
    const failed = render(payState({ payWindow: 'failed' }))
    expect(failed).toMatch(/<p role="alert"[^>]*>付款窗口没能打开或加载失败/)
    expect(render(payState({ payWindow: 'open' }))).not.toContain('role="alert"')
  })
  it('窗口被关掉 / 加载失败时「重新打开付款窗口」当主按钮并抢焦点，「我已付款」退成次要', () => {
    for (const payWindow of ['closed', 'failed'] as const) {
      const html = render(payState({ payWindow }))
      expect(html).toMatch(/<button[^>]*data-autofocus=""[^>]*>(?:(?!<\/button>).)*重新打开付款窗口/s)
      expect(html).not.toMatch(/<button[^>]*data-autofocus=""[^>]*>(?:(?!<\/button>).)*我已付款/s)
    }
    const open = render(payState({ payWindow: 'open' }))
    expect(open).toMatch(/<button[^>]*data-autofocus=""[^>]*>(?:(?!<\/button>).)*我已付款/s)
    expect(open).not.toMatch(/<button[^>]*data-autofocus=""[^>]*>(?:(?!<\/button>).)*重新打开付款窗口/s)
  })
  it('底部的去网页面板按钮和窗口里的「在浏览器打开支付页」文案分开；二维码订单不变', () => {
    const html = render(payState({ payWindow: 'open' }))
    expect(hasButton(html, '去网页面板付款')).toBe(true)
    expect(hasButton(html, '改用浏览器付款')).toBe(false)
    expect(hasButton(html, '在浏览器打开支付页')).toBe(true)
    const en = render(payState({ payWindow: 'open' }), {}, 'en-US')
    expect(hasButton(en, 'Pay on the web panel')).toBe(true)
    expect(hasButton(en, 'Pay in browser instead')).toBe(false)
    const qr = render(state())
    expect(hasButton(qr, '改用浏览器付款')).toBe(true)
    expect(hasButton(qr, '去网页面板付款')).toBe(false)
  })
  it('「付款窗口已关闭」提示不是 live region：「重新打开」按钮用 aria-describedby 指向它；其它状态没有', () => {
    const closed = render(payState({ payWindow: 'closed' }))
    const id = /<p id="([^"]+)"[^>]*>付款窗口已关闭/.exec(closed)?.[1]
    expect(id).toBeTruthy()
    expect(closed).toMatch(
      new RegExp(`<button[^>]*aria-describedby="${id}"[^>]*>(?:(?!</button>).)*重新打开付款窗口`, 's'),
    )
    for (const payWindow of ['open', 'opening', 'failed'] as const)
      expect(render(payState({ payWindow }))).not.toContain('aria-describedby')
  })
  it('演示模式写明不会真的打开付款窗口；平时没有这句', () => {
    vi.stubGlobal('window', { pixelsky: { demo: true } })
    expect(render(payState({ payWindow: 'open' }))).toContain('演示模式：不会真的打开付款窗口')
    vi.unstubAllGlobals()
    expect(render(payState({ payWindow: 'open' }))).not.toContain('演示模式')
  })
})

describe('等待付款：其它提示', () => {
  it('网络不稳定：小字提示；连续失败 5 次：错误和重试；凭证失效：提示确认账号', () => {
    expect(render(state({ unstable: true }))).toContain('网络不稳定，正在重试')
    const failed = render(state({ watchError: parseCheckoutError(new Error('x')) }))
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('付完的钱不会丢，恢复后会自动到账')
    expect(hasButton(failed, '重试')).toBe(true)
    expect(render(state({ order: order('pending', { panelValid: false }) }))).toContain(
      '需要确认账号才能继续查询；付完的钱仍会自动到账',
    )
    expect(render(state({ notYet: true }))).toContain('暂时没有查到付款')
  })
  it('操作失败（核实 / 取消 / 打开支付页）显示本地化原因', () => {
    const html = render(
      state({
        actionError: parseCheckoutError(
          new Error(`Error invoking remote method 'x': Error: ${codedError('checkout.ORDER_NOT_CANCELLABLE').message}`),
        ),
      }),
    )
    expect(html).toContain('这笔订单已经不能取消')
  })
})

describe('订单阶段面板凭证失效', () => {
  const bad = (status: CheckoutStatus = 'pending', over: Partial<CheckoutOrder> = {}) =>
    order(status, { panelValid: false, ...over })
  const autofocusCount = (html: string): number => (html.match(/data-autofocus/g) ?? []).length
  /** 带 data-autofocus 的按钮文字 */
  const autofocusLabel = (html: string): string | undefined =>
    /<button[^>]*data-autofocus=""[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/s.exec(html)?.[1]

  it('等待付款：有主按钮「去浏览器确认账号」并拿焦点，「我已付款」退成次要', () => {
    const html = render(state({ order: bad() }))
    expect(html).toContain('需要确认账号才能继续查询')
    expect(hasButton(html, '去浏览器确认账号')).toBe(true)
    expect(autofocusCount(html)).toBe(1)
    expect(autofocusLabel(html)).toBe('去浏览器确认账号')
    expect(html).toMatch(/<button[^>]*bg-primary[^>]*data-autofocus=""[^>]*>去浏览器确认账号/)
    expect(html).not.toMatch(/<button[^>]*bg-primary[^>]*>我已付款/)
  })
  it('凭证正常的订单没有这个按钮，主按钮还是「我已付款」', () => {
    const html = render(state())
    expect(hasButton(html, '去浏览器确认账号')).toBe(false)
    expect(autofocusLabel(html)).toBe('我已付款')
  })
  it('已过期：焦点 / 主按钮不在「重新下单」上（旧单可能已付，再下一单会付第二次）', () => {
    const html = render(state({ order: bad('expired') }), { now: T0 + 31 * MIN })
    expect(hasButton(html, '重新下单')).toBe(true)
    expect(autofocusCount(html)).toBe(1)
    expect(autofocusLabel(html)).toBe('去浏览器确认账号')
    expect(html).not.toMatch(/<button[^>]*bg-primary[^>]*>重新下单/)
    // 没有下单意图（继续付款恢复的）也一样
    expect(autofocusLabel(render(state({ order: bad('expired'), intent: null }), { now: T0 + 31 * MIN }))).toBe(
      '去浏览器确认账号',
    )
  })
  it('凭证正常的过期单：重新下单仍是主按钮', () => {
    const html = render(state({ order: order('expired') }), { now: T0 + 31 * MIN })
    expect(autofocusLabel(html)).toBe('重新下单')
  })
  it('已付款还没到账：同样给确认账号的入口，关闭不抢焦点', () => {
    const html = render(state({ order: bad('paid'), paidAt: T0 }))
    expect(autofocusCount(html)).toBe(1)
    expect(autofocusLabel(html)).toBe('去浏览器确认账号')
  })
  it('已取消 / 已到账的订单不需要：没有按钮，也不再提示', () => {
    for (const status of ['cancelled', 'completed'] as const) {
      const html = render(state({ order: bad(status) }))
      expect(hasButton(html, '去浏览器确认账号')).toBe(false)
      expect(html).not.toContain('需要确认账号才能继续查询')
    }
  })
  it('点了之后显示等待（按钮不可点）；等超时显示原因和「再试一次」；打开失败显示原因', () => {
    const waiting = render(state({ order: bad(), reauth: 'waiting' }))
    expect(waiting).toContain('确认后会继续查询这笔订单')
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*>.*?去浏览器确认账号/s)
    const timeout = render(state({ order: bad(), reauth: 'timeout' }))
    expect(timeout).toContain('没有等到浏览器里的确认')
    expect(hasButton(timeout, '再试一次')).toBe(true)
    const failed = render(state({ order: bad(), reauthError: parseCheckoutError(new Error('打不开浏览器')) }))
    expect(failed).toContain('打不开浏览器')
  })
  it('英文界面没有残留中文', () => {
    const html = render(state({ order: bad(), reauth: 'waiting' }), {}, 'en-US').replace(/支付宝/g, 'Alipay')
    expect(html).toContain('Confirm account in browser')
    expect(html).not.toMatch(/[一-鿿]/)
  })
})

describe('已付款、已到账', () => {
  it('已付款：已收到付款，正在到账；订单继续在后台到账，只有关闭', () => {
    const html = render(state({ order: order('paid'), paidAt: T0 }))
    expect(html).toContain('已收到付款，正在到账…')
    expect(html).toContain('关掉这个窗口也没关系')
    expect(html).toMatch(/<li aria-current="step"[^>]*>.*?已付款<\/li>/s)
    expect(hasButton(html, '关闭')).toBe(true)
    expect(hasButton(html, '我已付款')).toBe(false)
    expect(html).not.toContain('到账有点慢')
  })
  it('已付款超过 2 分钟还没到账：加「到账有点慢」和订单号', () => {
    const paid = state({ order: order('paid'), paidAt: T0 })
    expect(render(paid, { now: T0 + 119_000 })).not.toContain('到账有点慢')
    const slow = render(paid, { now: T0 + 121_000 })
    expect(slow).toContain('到账有点慢；10 分钟还没到请联系客服，订单号 1234')
  })
  it('已到账：标题「付款完成」，前后对比，完成按钮；读账号期间显示正在读取', () => {
    const done = state({
      order: order('completed'),
      outcome: { settling: false, change: { balance: { from: 10, to: 136 }, plan: null, expires: null } },
    })
    const html = render(done)
    expect(html).toMatch(/<h3[^>]*>付款完成<\/h3>/)
    expect(html).toContain('余额 $10.00 → $136.00')
    expect(hasButton(html, '完成')).toBe(true)
    expect(html).toMatch(/<div role="status"[^>]*class="sr-only">已到账，余额 \$10.00 → \$136.00<\/div>/)
    expect(render(state({ order: order('completed'), outcome: { settling: true, change: null } }))).toContain(
      '正在读取最新余额',
    )
  })
  it('对比为空：只说已到账，不列对比', () => {
    const html = render(state({ order: order('completed'), outcome: { settling: false, change: null } }))
    expect(html).toContain('已到账')
    expect(html).not.toContain('→')
  })
  it('套餐单：摘要是套餐名和有效期', () => {
    const plan = order('pending', {
      kind: 'plan',
      credited: null,
      bonus: null,
      plan: { id: 7, name: 'Pro 月卡', validityDays: 30 },
    })
    expect(render(state({ order: plan }))).toContain('Pro 月卡 / 月')
  })
})

describe('已过期、终态', () => {
  it('到了 expires_at：订单已过期，10 分钟内保留「我已付款」和重新下单', () => {
    const html = render(state(), { now: T0 + 30 * MIN + 5000 })
    expect(html).toContain('订单已过期')
    expect(html).toContain('如果你已经付了款')
    expect(hasButton(html, '我已付款')).toBe(true)
    expect(hasButton(html, '重新下单')).toBe(true)
  })
  it('过期超过 10 分钟（自动再查已停）：「我已付款」仍在，云端到期后 1 天内还会刷新；超过 1 天才收起', () => {
    const html = render(state(), { now: T0 + 41 * MIN })
    expect(html).toContain('订单已过期')
    expect(html).toContain('如果你已经付了款')
    expect(hasButton(html, '我已付款')).toBe(true)
    const old = render(state(), { now: T0 + 30 * MIN + 25 * 60 * MIN })
    expect(old).not.toContain('如果你已经付了款')
    expect(hasButton(old, '我已付款')).toBe(false)
  })
  it('「我已付款」后还没查到：10 分钟慢查窗口内说会再查，窗口外说已经不查了，请再点或联系客服', () => {
    const waiting = state({ order: order('expired'), notYet: true })
    const inside = render(waiting, { now: T0 + 30 * MIN + 5 * MIN })
    expect(inside).toContain('暂时没有查到付款，稍后会自动再查')
    expect(inside).not.toContain('联系客服并提供订单号')
    const outside = render(waiting, { now: T0 + 30 * MIN + 11 * MIN })
    expect(outside).not.toContain('稍后会自动再查')
    expect(outside).toContain('如果你已经付款，请点「我已付款」再查一次，或联系客服并提供订单号 1234')
    // 待付单到了 expires_at 还没被云端标成过期：同样按窗口算
    const lapsed = render(state({ notYet: true }), { now: T0 + 30 * MIN + 11 * MIN })
    expect(lapsed).toContain('联系客服并提供订单号')
  })
  it('英文：窗口外的提示也是英文', () => {
    const html = render(state({ order: order('expired'), notYet: true }), { now: T0 + 45 * MIN }, 'en-US')
    expect(html).toContain('contact support with order 1234')
    expect(html).not.toMatch(/[一-鿿]/)
  })
  it('从「继续付款」恢复的订单没有下单意图：不能重新下单', () => {
    expect(hasButton(render(state({ intent: null }), { now: T0 + 31 * MIN }), '重新下单')).toBe(false)
  })
  it.each([
    ['cancelled', '订单已取消'],
    ['refunding', '订单正在退款'],
    ['refunded', '订单已退款'],
    ['unknown', '订单状态未知'],
  ] as const)('%s：显示原因，重新下单 / 关闭', (status, text) => {
    const html = render(state({ order: order(status) }))
    expect(html).toContain(text)
    expect(hasButton(html, '重新下单')).toBe(true)
    expect(hasButton(html, '关闭')).toBe(true)
  })
  it('failed（付了钱、加余额失败）：说明会自动补上，不给「重新下单」', () => {
    const html = render(state({ order: order('failed') }))
    expect(html).toContain('已收到付款，但到账出了问题')
    expect(hasButton(html, '重新下单')).toBe(false)
    expect(hasButton(html, '关闭')).toBe(true)
  })
})

describe('下单前后的其它状态', () => {
  it('正在下单：转圈「正在生成付款码…」', () => {
    expect(render(state({ phase: 'creating', order: null }))).toContain('正在生成付款码…')
  })
  it('准备（套餐页）：套餐名、价格、有效期，支付方式单选（radiogroup），扫码付款 / 取消', () => {
    const plan: CheckoutIntent = {
      kind: 'plan',
      planId: 7,
      method: 'wxpay',
      estimatePay: 99,
      payCurrency: 'CNY',
      plan: { name: 'Pro 月卡', validityDays: 30, price: 99, currency: 'CNY' },
    }
    const html = render(state({ phase: 'prepare', order: null, intent: plan }))
    expect(html).toContain('Pro 月卡')
    expect(html).toContain('¥99')
    expect(html).toContain('role="radiogroup"')
    expect(html).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*>.*?支付宝/s)
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?微信支付/s)
    expect(hasButton(html, '扫码付款')).toBe(true)
    expect(hasButton(html, '取消')).toBe(true)
  })
  it('出错：本地化文案（带参数），重试 / 改用浏览器付款 / 关闭', () => {
    const e = parseCheckoutError(
      new Error(
        `Error invoking remote method 'x': Error: ${codedError('checkout.TOO_MANY_PENDING', { max: 3 }).message}`,
      ),
    )
    const html = render(state({ phase: 'error', order: null, error: e }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('你有 3 笔未付款的订单，请先付款或取消其中一笔')
    // 同一句只放一个 live region：role=alert 读了，role=status 就留空，不再读第二遍
    expect(html.split('你有 3 笔未付款的订单，请先付款或取消其中一笔')).toHaveLength(2)
    expect(html).toContain('<div role="status" aria-live="polite" class="sr-only"></div>')
    expect((html.match(/role="alert"/g) ?? []).length).toBe(1)
    for (const label of ['重试', '改用浏览器付款', '关闭']) expect(hasButton(html, label)).toBe(true)
  })
  it('需要确认账号：标题、说明、邮箱、去浏览器确认 / 改用浏览器付款 / 取消', () => {
    const html = render(state({ phase: 'reauth', order: null }))
    expect(html).toMatch(/<h3[^>]*>确认账号<\/h3>/)
    expect(html).toContain('需要在浏览器里确认一次你的账号（最长 7 天确认一次）')
    expect(html).toContain('请确认浏览器里登录的是 alice@example.com')
    for (const label of ['去浏览器确认', '改用浏览器付款', '取消']) expect(hasButton(html, label)).toBe(true)
    expect(html).not.toContain('正在等待浏览器里的确认')
  })
  it('确认账号：点了之后显示等待（按钮不可点）；等超时显示原因和「再试一次」', () => {
    const waiting = render(state({ phase: 'reauth', order: null, reauth: 'waiting' }))
    expect(waiting).toContain('正在等待浏览器里的确认…（确认后会自动生成二维码）')
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*>.*?去浏览器确认/s)
    const timeout = render(state({ phase: 'reauth', order: null, reauth: 'timeout' }))
    expect(timeout).toContain('没有等到浏览器里的确认')
    expect(hasButton(timeout, '再试一次')).toBe(true)
  })
})

describe('英文界面', () => {
  it('等待付款、已到账、确认账号都是英文，没有残留中文（订单里的方式名是云端给的除外）', () => {
    const en = (s: FlowState, over: Partial<CheckoutPanelProps> = {}) =>
      render(s, { ...over, methods: [{ type: 'alipay', label: 'Alipay' }] }, 'en-US').replace(/支付宝/g, 'Alipay')
    const waiting = en(state())
    expect(waiting).toContain('Pay by QR code')
    expect(waiting).toContain('29:41 left')
    expect(waiting).toContain('I have paid')
    expect(waiting).toContain('Pay in browser instead')
    expect(waiting).toContain('(incl. 2% fee)')
    expect(waiting).toContain('Alipay payment QR code, amount due ¥122.40')
    expect(waiting).not.toMatch(/[一-鿿]/)
    const done = en(
      state({
        order: order('completed'),
        outcome: { settling: false, change: { balance: { from: 10, to: 136 }, plan: null, expires: null } },
      }),
    )
    expect(done).toContain('Payment complete')
    expect(done).toContain('Balance $10.00 → $136.00')
    expect(done).not.toMatch(/[一-鿿]/)
    const reauth = en(state({ phase: 'reauth', order: null }))
    expect(reauth).toContain('Confirm your account in the browser once before paying in the app')
    expect(reauth).not.toMatch(/[一-鿿]/)
  })
})

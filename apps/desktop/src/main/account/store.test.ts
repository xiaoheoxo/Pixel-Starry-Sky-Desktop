import { beforeEach, describe, expect, it, vi } from 'vitest'

// 订阅套餐与充值：解析云端响应、校验打开浏览器的地址（docs/cloud-service.md §4.16）。

const mocks = vi.hoisted(() => ({
  opened: [] as string[],
  email: 'alice@example.com' as string | null,
  packaged: false,
  base: 'https://panel.example.com',
  response: { status: 200, body: {} as unknown },
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.packaged
    },
  },
  shell: {
    openExternal: async (url: string) => {
      mocks.opened.push(url)
    },
  },
}))
vi.mock('./account', () => ({
  signedInEmail: () => mocks.email,
  baseUrl: () => mocks.base,
  platformFetch: async () =>
    new Response(JSON.stringify(mocks.response.body), {
      status: mocks.response.status,
      headers: { 'Content-Type': 'application/json' },
    }),
}))

const { fetchStore, isTrustedPanelHost, lastStore, openStore, parseStore, storeLink } = await import('./store')

const open = {
  enabled: true,
  currency: 'CNY',
  plans: [
    {
      id: 2,
      name: 'B',
      price: 60,
      sort: 20,
      validity_days: 30,
      quotas: { five_hour: 1, daily: null, weekly: 2, monthly: null },
      extra_field: 'ignored',
    },
    { id: 1, name: 'A', price: 30, sort: 20, original_price: 40, currency: 'USD', features: ['x', 3, ''] },
  ],
  recharge: { enabled: true, min: 5, max: 0, multiplier: 2, fee_rate: 1.5, bonus_mode: 'discount', bonus_tiers: [] },
  methods: [{ type: 'alipay', label: '支付宝' }, { type: 'stripe' }, { label: 'no type' }],
  help_text: 'hi',
  purchase_url: 'https://panel.example.com/purchase',
  redeem_url: 'https://panel.example.com/redeem',
  unknown_top_level: true,
}

beforeEach(() => {
  mocks.opened.length = 0
  mocks.email = 'alice@example.com'
  mocks.packaged = false
  mocks.base = 'https://panel.example.com'
  mocks.response = { status: 200, body: open }
})

describe('parseStore', () => {
  it('蛇形转驼峰，多余字段忽略，同 sort 按 id 排', () => {
    const s = parseStore(open)
    expect(s.plans.map(p => p.id)).toEqual([1, 2])
    expect(s.plans[0]).toMatchObject({
      originalPrice: 40,
      currency: 'USD',
      validityDays: 0,
      features: ['x'],
      groupName: '',
      groupId: null,
      description: '',
    })
    expect(s.plans[1].quotas).toEqual({ fiveHour: 1, daily: null, weekly: 2, monthly: null })
    expect(s.plans[1].originalPrice).toBeNull()
    expect(s.plans[1].currency).toBe('CNY')
    expect(s.recharge).toMatchObject({ max: 0, multiplier: 2, feeRate: 1.5, bonusMode: 'discount', usdToCnyRate: 0 })
    // 没有 type 的支付方式丢掉，没有 label 用 type
    expect(s.methods).toEqual([
      { type: 'alipay', label: '支付宝' },
      { type: 'stripe', label: 'stripe' },
    ])
  })

  it('坏的套餐条目丢掉，不让整页失败', () => {
    const s = parseStore({
      ...open,
      plans: [
        null,
        'x',
        { id: '1', name: 'a', price: 1 },
        { id: 1, name: '', price: 1 },
        { id: 1, name: 'a', price: -1 },
        { id: 9, name: 'ok', price: '30' },
        { id: 5, name: 'ok', price: 5 },
      ],
    })
    expect(s.plans.map(p => p.id)).toEqual([5])
  })

  it('赠送档位：非法的丢掉，按金额升序；倍率非正数当 1；未知模式当 bonus', () => {
    const s = parseStore({
      ...open,
      recharge: {
        enabled: true,
        multiplier: 0,
        bonus_mode: 'weird',
        bonus_tiers: [
          { min_amount: 500, bonus_percent: 10 },
          { min_amount: 100, bonus_percent: 5 },
          { min_amount: 'x', bonus_percent: 5 },
          { min_amount: 1, bonus_percent: 0 },
          null,
        ],
      },
    })
    expect(s.recharge.bonusTiers).toEqual([
      { minAmount: 100, bonusPercent: 5 },
      { minAmount: 500, bonusPercent: 10 },
    ])
    expect(s.recharge.multiplier).toBe(1)
    expect(s.recharge.bonusMode).toBe('bonus')
  })

  it('缺 recharge 当作充值关闭', () => {
    const { recharge: _drop, ...rest } = open
    void _drop
    expect(parseStore(rest).recharge).toMatchObject({ enabled: false, min: 0, max: 0, multiplier: 1, feeRate: 0 })
  })

  it.each([null, 'x', [], {}, { enabled: 'yes', plans: [] }, { enabled: true }, { enabled: true, plans: {} }])(
    '整体不对就报错：%j',
    body => {
      expect(() => parseStore(body)).toThrow('服务返回的套餐数据异常')
    },
  )
})

describe('fetchStore', () => {
  it('502 带云端的提示，响应不是 JSON 也有兜底', async () => {
    mocks.response = { status: 502, body: { error: '暂时读不到' } }
    await expect(fetchStore()).rejects.toThrow('暂时读不到')
    mocks.response = { status: 500, body: null }
    await expect(fetchStore()).rejects.toThrow('HTTP 500')
  })
})

describe('storeLink / openStore', () => {
  it('只打开最近一次取到的目录里的 http(s) 地址', async () => {
    await expect(openStore('purchase')).rejects.toThrow('请先刷新')
    await fetchStore()
    await openStore('purchase')
    await openStore('redeem')
    expect(mocks.opened).toEqual(['https://panel.example.com/purchase', 'https://panel.example.com/redeem'])
  })

  it('购买页只允许带 tab=subscription 和正整数 group，其他参数一律不带', async () => {
    await fetchStore()
    await openStore('purchase', { tab: 'subscription', group: 7, amount: 100, url: 'https://evil.example' })
    await openStore('purchase', { tab: 'subscription', group: '7&x=1' })
    await openStore('purchase', { tab: 'subscription', group: -3 })
    await openStore('purchase', { tab: 'other', group: 7 })
    await openStore('redeem', { tab: 'subscription', group: 7 })
    expect(mocks.opened).toEqual([
      'https://panel.example.com/purchase?tab=subscription&group=7',
      'https://panel.example.com/purchase?tab=subscription',
      'https://panel.example.com/purchase?tab=subscription',
      'https://panel.example.com/purchase',
      'https://panel.example.com/redeem',
    ])
  })

  it('种类不对、登录的账号换了都拒绝', async () => {
    await fetchStore()
    await expect(openStore('https://evil.example')).rejects.toThrow('无效的面板页')
    mocks.email = 'bob@example.com'
    await expect(openStore('purchase')).rejects.toThrow('请先刷新')
    expect(mocks.opened).toEqual([])
  })

  it('不是 http(s) 绝对地址就不打开', () => {
    const catalog = parseStore(open)
    for (const bad of ['/purchase', '', 'javascript:alert(1)', 'file:///c:/x', 'ftp://x.example/purchase']) {
      expect(() => storeLink('purchase', { ...catalog, purchaseUrl: bad })).toThrow('没有可用的面板地址')
    }
    mocks.base = 'http://127.0.0.1:9080' // 本地联调：云端和面板都在回环地址
    expect(storeLink('purchase', { ...catalog, purchaseUrl: 'http://127.0.0.1:9080/purchase' })).toBe(
      'http://127.0.0.1:9080/purchase',
    )
  })
})

describe('面板地址校验', () => {
  const link = (purchaseUrl: string) => storeLink('purchase', { ...parseStore(open), purchaseUrl })

  it('正式站、测试站的真实地址都能通过（内置域名 + 云端地址同主机）', () => {
    // 正式站：认证服务 pixelstarrysky.xyz，面板地址 PANEL_PUBLIC_URL 同域
    mocks.base = 'https://pixelstarrysky.xyz'
    expect(link('https://pixelstarrysky.xyz/purchase')).toBe('https://pixelstarrysky.xyz/purchase')
    // 测试站：auth. 子域；面板地址默认 WEB_URL 就是它
    mocks.base = 'https://auth.pixelstarrysky.xyz'
    expect(link('https://auth.pixelstarrysky.xyz/purchase')).toBe('https://auth.pixelstarrysky.xyz/purchase')
    // 云端地址是别的域时，只认完全相同的主机；内置域名始终可信
    mocks.base = 'https://panel.example.com'
    expect(link('https://panel.example.com/purchase')).toBe('https://panel.example.com/purchase')
    expect(link('https://pixelstarrysky.xyz/redeem')).toBe('https://pixelstarrysky.xyz/redeem')
  })

  it('云端地址在托管平台上（x.github.io）：同注册域的别人站点不放行', () => {
    mocks.base = 'https://alice.github.io'
    expect(link('https://alice.github.io/purchase')).toBe('https://alice.github.io/purchase')
    for (const bad of [
      'https://evil.github.io/purchase',
      'https://github.io/purchase',
      'https://x.alice.github.io/purchase',
    ])
      expect(() => link(bad), bad).toThrow('可信域名')
  })

  it('不同注册域、仿冒域名、IP 一律拒绝', () => {
    for (const bad of [
      'https://evil.example/purchase',
      'https://pixelstarrysky.xyz.evil.example/purchase',
      'https://evilpixelstarrysky.xyz/purchase',
      'https://pixelstarrysky.xyz@evil.example/purchase',
      'https://1.2.3.4/purchase',
    ]) {
      expect(() => link(bad), bad).toThrow(/可信域名|用户名或密码/)
    }
  })

  it('带用户名或密码的地址拒绝', () => {
    expect(() => link('https://user:pw@panel.example.com/purchase')).toThrow('用户名或密码')
    expect(() => link('https://user@panel.example.com/purchase')).toThrow('用户名或密码')
  })

  it('打包后只允许 https（回环地址除外）；开发环境 http 也行', () => {
    mocks.packaged = true
    expect(() => link('http://panel.example.com/purchase')).toThrow('不是 https')
    expect(link('https://panel.example.com/purchase')).toBe('https://panel.example.com/purchase')
    mocks.base = 'http://127.0.0.1:9080'
    expect(link('http://127.0.0.1:9080/purchase')).toBe('http://127.0.0.1:9080/purchase')
    mocks.base = 'http://localhost:9080'
    expect(link('http://localhost:9080/purchase')).toBe('http://localhost:9080/purchase')
    // 回环地址只在云端地址也是它时才可信：目录里夹带的 127.0.0.1 不会被打开
    expect(() => link('http://127.0.0.1:9080/purchase')).toThrow('可信域名')
  })

  it('开发环境：http 的同主机地址可用', () => {
    mocks.base = 'http://panel.example.com'
    expect(link('http://panel.example.com/purchase')).toBe('http://panel.example.com/purchase')
  })

  it('openStore 遇到不可信地址时不调用浏览器', async () => {
    mocks.response = { status: 200, body: { ...open, purchase_url: 'https://evil.example/purchase' } }
    await fetchStore()
    await expect(openStore('purchase')).rejects.toThrow('可信域名')
    expect(mocks.opened).toEqual([])
  })

  it('isTrustedPanelHost：云端地址是 IP 时只认同一个 IP', () => {
    expect(isTrustedPanelHost('10.0.0.5', '10.0.0.5')).toBe(true)
    expect(isTrustedPanelHost('10.0.0.6', '10.0.0.5')).toBe(false)
    expect(isTrustedPanelHost('auth.pixelstarrysky.xyz', '10.0.0.5')).toBe(true)
  })
})

describe('parseStore 币种', () => {
  it('云端给了币种 currencyKnown 为 true；没给时默认 CNY 但 currencyKnown 为 false', () => {
    expect(parseStore({ ...open, currency: 'USD' })).toMatchObject({ currency: 'USD', currencyKnown: true })
    expect(parseStore({ ...open, currency: undefined })).toMatchObject({ currency: 'CNY', currencyKnown: false })
  })
})

describe('parseStore 软件内付款能力标记', () => {
  it('云端没给 checkout（旧版本）：不带这个字段，等于不开', () => {
    expect('checkout' in parseStore(open)).toBe(false)
    expect(parseStore(open).checkout).toBeUndefined()
  })

  it('蛇形转驼峰；支付方式只收非空字符串', () => {
    const checkout = { enabled: true, methods: ['alipay', 'wxpay', '', 3, null], order_timeout_minutes: 15 }
    expect(parseStore({ ...open, checkout }).checkout).toEqual({
      enabled: true,
      methods: ['alipay', 'wxpay'],
      orderTimeoutMinutes: 15,
    })
  })

  it('格式不对按不开处理，不让整页失败', () => {
    for (const checkout of [null, 'yes', 1, [], true])
      expect(parseStore({ ...open, checkout }).checkout).toBeUndefined()
    // enabled 不是 true、或没有可用的支付方式，都算没开；有效期不对用 30 分钟
    expect(parseStore({ ...open, checkout: { enabled: 'true', methods: ['alipay'] } }).checkout).toMatchObject({
      enabled: false,
    })
    expect(parseStore({ ...open, checkout: { enabled: true, methods: [] } }).checkout).toMatchObject({
      enabled: false,
      methods: [],
    })
    for (const order_timeout_minutes of [undefined, 0, -5, '30', NaN])
      expect(
        parseStore({ ...open, checkout: { enabled: true, methods: ['alipay'], order_timeout_minutes } }).checkout,
      ).toMatchObject({ enabled: true, orderTimeoutMinutes: 30 })
  })

  it('fetchStore 之后 lastStore 带着商品数据和当时的邮箱', async () => {
    mocks.response = { status: 200, body: { ...open, checkout: { enabled: true, methods: ['alipay'] } } }
    await fetchStore()
    expect(lastStore()).toMatchObject({ email: 'alice@example.com', catalog: { checkout: { enabled: true } } })
  })
})

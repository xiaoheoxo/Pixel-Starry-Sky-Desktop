import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCodedError } from '@pixelsky/protocol'

// 软件内付款：订单解析、参数校验、订单号白名单、错误码、浏览器地址校验（docs/ui/in-app-payment.md §4.4、§6.6）。

interface Call {
  path: string
  method: string
  body: Record<string, unknown> | null
}
type Reply = { status: number; body: unknown } | (() => Promise<{ status: number; body: unknown }>)

const mocks = vi.hoisted(() => ({
  opened: [] as string[],
  email: 'alice@example.com' as string | null,
  epoch: 1,
  packaged: false,
  base: 'https://panel.example.com',
  calls: [] as Array<{ path: string; method: string; body: Record<string, unknown> | null }>,
  /** 按路径取回复；没写的路径回 404 */
  replies: new Map<string, unknown>(),
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
  accountEpoch: () => mocks.epoch,
  baseUrl: () => mocks.base,
  platformFetch: async (path: string, init: RequestInit = {}) => {
    mocks.calls.push({
      path,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    })
    const reply = (await mocks.replies.get(`${init.method ?? 'GET'} ${path}`)) as Reply | undefined
    const { status, body } = typeof reply === 'function' ? await reply() : (reply ?? { status: 404, body: {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  },
}))

const {
  checkoutCancel,
  checkoutCreate,
  checkoutGet,
  checkoutOpenPayUrl,
  checkoutPending,
  checkoutVerify,
  panelStatus,
  panelVerify,
  panelVerifyLink,
  parseOrder,
  payPageOf,
} = await import('./checkout')
const { fetchStore } = await import('./store')

const ID = '3f6c1e0a-6a4b-4f0e-9d8f-2a1c7b5e9d10'
const storeJson = {
  enabled: true,
  currency: 'CNY',
  plans: [{ id: 2, name: 'Pro 月卡', price: 99, validity_days: 30 }],
  recharge: { enabled: true, min: 5, max: 1000, multiplier: 1, fee_rate: 2 },
  methods: [{ type: 'alipay' }, { type: 'wxpay' }],
  purchase_url: 'https://panel.example.com/purchase',
  redeem_url: 'https://panel.example.com/redeem',
  checkout: { enabled: true, methods: ['alipay', 'wxpay'], order_timeout_minutes: 30 },
}
const orderJson = {
  order_id: 1234,
  kind: 'balance',
  status: 'pending',
  method: 'alipay',
  method_label: '支付宝',
  pay_amount: 122.4,
  pay_currency: 'CNY',
  fee_rate: 2,
  credited: 126,
  bonus: 6,
  plan: null,
  qr_content: 'https://qr.alipay.com/bax0abc',
  qr_source: 'provider',
  pay_url: 'https://pay.example.com/cashier/abc',
  created_at: '2026-10-18T03:00:00Z',
  expires_at: '2026-10-18T03:30:00Z',
  paid_at: null,
  completed_at: null,
  server_time: '2026-10-18T03:00:01Z',
  reused: false,
}
const balance = { requestId: ID, kind: 'balance', amount: 120, method: 'alipay' }

function reply(method: string, path: string, status: number, body: unknown): void {
  mocks.replies.set(`${method} ${path}`, { status, body })
}
function codeOf(e: unknown): { code: string; params: Record<string, string | number> } | null {
  return parseCodedError((e as Error)?.message)
}
async function failure(p: Promise<unknown>): Promise<Error> {
  return (await p.then(
    () => {
      throw new Error('应该失败')
    },
    (e: unknown) => e,
  )) as Error
}
const networkCalls = (): Call[] => mocks.calls.filter(c => c.path.startsWith('/v1/platform/orders'))

beforeEach(async () => {
  mocks.opened.length = 0
  mocks.calls.length = 0
  mocks.replies.clear()
  mocks.email = 'alice@example.com'
  mocks.epoch += 1 // 每个用例一个新的登录会话：上一个用例记下的订单不带过来
  mocks.packaged = false
  mocks.base = 'https://panel.example.com'
  reply('GET', '/v1/platform/store', 200, storeJson)
  await fetchStore()
  mocks.calls.length = 0
})

describe('parseOrder', () => {
  it('蛇形转驼峰', () => {
    expect(parseOrder(orderJson)).toEqual({
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
      qrContent: 'https://qr.alipay.com/bax0abc',
      qrSource: 'provider',
      payUrl: 'https://pay.example.com/cashier/abc',
      createdAt: '2026-10-18T03:00:00Z',
      expiresAt: '2026-10-18T03:30:00Z',
      paidAt: null,
      completedAt: null,
      serverTime: '2026-10-18T03:00:01Z',
      reused: false,
    })
  })

  it('套餐单带套餐；panel_valid 为 false 时带出来', () => {
    const o = parseOrder({
      ...orderJson,
      kind: 'plan',
      credited: null,
      bonus: null,
      plan: { id: 2, name: 'Pro 月卡', validity_days: 30 },
      panel_valid: false,
    })
    expect(o).toMatchObject({ kind: 'plan', credited: null, plan: { id: 2, name: 'Pro 月卡', validityDays: 30 } })
    expect(o.panelValid).toBe(false)
    expect('panelValid' in parseOrder(orderJson)).toBe(false)
  })

  it('必填字段缺失或类型不对就报错', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      { ...orderJson, order_id: 0 },
      { ...orderJson, order_id: '1234' },
      { ...orderJson, order_id: 1.5 },
      { ...orderJson, kind: 'other' },
      { ...orderJson, status: 3 },
      { ...orderJson, status: undefined },
      { ...orderJson, method: '' },
      { ...orderJson, method: undefined },
      { ...orderJson, pay_amount: '122.4' },
      { ...orderJson, pay_amount: -1 },
      { ...orderJson, pay_amount: null },
      { ...orderJson, created_at: 'not a time' },
      { ...orderJson, expires_at: undefined },
      { ...orderJson, server_time: 12345 },
    ]
    for (const b of bad) expect(() => parseOrder(b), JSON.stringify(b)).toThrow('服务返回的付款数据异常')
  })

  it('状态：认识的照用，不认识的是 unknown', () => {
    for (const s of ['pending', 'paid', 'completed', 'expired', 'cancelled', 'failed', 'refunding', 'refunded'])
      expect(parseOrder({ ...orderJson, status: s }).status).toBe(s)
    expect(parseOrder({ ...orderJson, status: 'weird' }).status).toBe('unknown')
  })

  it('qr_content 只在 pending 时保留', () => {
    for (const s of ['paid', 'completed', 'expired', 'cancelled', 'failed', 'refunding', 'refunded', 'weird']) {
      const o = parseOrder({ ...orderJson, status: s })
      expect(o.qrContent, s).toBeNull()
      expect(o.qrSource, s).toBeNull()
      expect(o.payUrl, s).toBeNull()
    }
    expect(parseOrder(orderJson).qrContent).toBe('https://qr.alipay.com/bax0abc')
    // pending 但没给二维码
    expect(parseOrder({ ...orderJson, qr_content: null })).toMatchObject({ qrContent: null, qrSource: null })
    expect(parseOrder({ ...orderJson, qr_content: '' }).qrContent).toBeNull()
  })

  it('qr_source：pay_url 照留，其它值当 provider', () => {
    expect(parseOrder({ ...orderJson, qr_source: 'pay_url' }).qrSource).toBe('pay_url')
    expect(parseOrder({ ...orderJson, qr_source: 'whatever' }).qrSource).toBe('provider')
  })

  it('pay_url 只留 https 且不带用户名密码的', () => {
    for (const bad of [
      'http://pay.example.com/x',
      'javascript:alert(1)',
      'file:///C:/x',
      'weixin://wxpay/bizpayurl?pr=abc',
      'https://user:pw@pay.example.com/x',
      'https://user@pay.example.com/x',
      '/relative/path',
      'not a url',
      '',
      42,
      null,
    ])
      expect(parseOrder({ ...orderJson, pay_url: bad }).payUrl, String(bad)).toBeNull()
    expect(parseOrder({ ...orderJson, pay_url: 'https://pay.example.com/cashier/x?a=1' }).payUrl).toBe(
      'https://pay.example.com/cashier/x?a=1',
    )
  })
})

describe('checkout 能力标记缺省', () => {
  it('云端没给 checkout（旧版本）时下单被拒：支付总开关视为关闭', async () => {
    reply('GET', '/v1/platform/store', 200, { ...storeJson, checkout: undefined })
    await fetchStore()
    expect(codeOf(await failure(checkoutCreate(balance)))?.code).toBe('checkout.PAYMENT_DISABLED')
    expect(networkCalls()).toEqual([])
  })
})

describe('checkoutCreate 参数校验（每条规则一个用例，都不发请求）', () => {
  const rejects = async (input: unknown, expected: string | RegExp = '请求参数不正确'): Promise<void> => {
    const e = await failure(checkoutCreate(input))
    if (typeof expected === 'string') expect(e.message, JSON.stringify(input)).toBe(expected)
    else expect(e.message, JSON.stringify(input)).toMatch(expected)
    expect(networkCalls(), JSON.stringify(input)).toEqual([])
  }
  const codedReject = async (input: unknown, code: string): Promise<Record<string, string | number>> => {
    const e = await failure(checkoutCreate(input))
    expect(codeOf(e)?.code, e.message).toBe(`checkout.${code}`)
    expect(networkCalls()).toEqual([])
    return codeOf(e)?.params ?? {}
  }

  it('不是对象', async () => {
    for (const v of [null, undefined, 'x', 5, []]) await rejects(v)
  })

  it('requestId 必须是 UUID 格式', async () => {
    for (const requestId of [
      undefined,
      '',
      'abc',
      123,
      `${ID}x`,
      ID.replace(/-/g, ''),
      'zzzzzzzz-6a4b-4f0e-9d8f-2a1c7b5e9d10',
    ])
      await rejects({ ...balance, requestId })
  })

  it('kind 只能是 balance 或 plan', async () => {
    for (const kind of [undefined, '', 'topup', 'BALANCE', 1]) await rejects({ ...balance, kind })
  })

  it('amount：有限、大于 0、最多两位小数', async () => {
    for (const amount of [undefined, NaN, Infinity, -Infinity, 0, -5, 12.345, 0.001, '120', null, 1_000_000.01])
      await rejects({ ...balance, amount })
    for (const amount of [5, 12.5, 0.07 + 100, 999.99]) {
      mocks.replies.clear()
      reply('POST', '/v1/platform/orders', 200, orderJson)
      reply('GET', '/v1/platform/store', 200, { ...storeJson, recharge: { ...storeJson.recharge, min: 0, max: 0 } })
      await fetchStore()
      await expect(checkoutCreate({ ...balance, amount, requestId: ID }), String(amount)).resolves.toBeTruthy()
    }
  })

  it('amount 要在最近一次商品数据的 recharge 范围内（0 表示不限）', async () => {
    expect(await codedReject({ ...balance, amount: 4.99 }, 'AMOUNT_OUT_OF_RANGE')).toEqual({ min: 5, max: 1000 })
    expect(await codedReject({ ...balance, amount: 1000.01 }, 'AMOUNT_OUT_OF_RANGE')).toEqual({ min: 5, max: 1000 })
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await expect(checkoutCreate({ ...balance, amount: 5 })).resolves.toBeTruthy()
    await expect(checkoutCreate({ ...balance, amount: 1000 })).resolves.toBeTruthy()
  })

  it('kind=balance 不能带 planId，kind=plan 不能带 amount', async () => {
    await rejects({ ...balance, planId: 2 })
    await rejects({ requestId: ID, kind: 'plan', planId: 2, amount: 10, method: 'alipay' })
  })

  it('planId：正的安全整数，并且在最近一次的套餐里', async () => {
    const plan = { requestId: ID, kind: 'plan', method: 'alipay' }
    for (const planId of [undefined, 0, -2, 1.5, '2', NaN, Number.MAX_SAFE_INTEGER + 2])
      await rejects({ ...plan, planId })
    await codedReject({ ...plan, planId: 3 }, 'PLAN_UNAVAILABLE')
    reply('POST', '/v1/platform/orders', 200, { ...orderJson, kind: 'plan' })
    await expect(checkoutCreate({ ...plan, planId: 2 })).resolves.toMatchObject({ kind: 'plan' })
    expect(networkCalls()[0].body).toEqual({ request_id: ID, kind: 'plan', plan_id: 2, method: 'alipay' })
  })

  it('method 必须在 checkout.methods 里', async () => {
    for (const method of ['stripe', 'ALIPAY', 'alipay ', '']) {
      if (method === '') await rejects({ ...balance, method })
      else await codedReject({ ...balance, method }, 'METHOD_UNAVAILABLE')
    }
    for (const method of [undefined, 5, null]) await rejects({ ...balance, method })
  })

  it('checkout 没开 / 支付总开关关 / 余额充值关：PAYMENT_DISABLED', async () => {
    for (const patch of [
      { checkout: { enabled: false, methods: ['alipay'], order_timeout_minutes: 30 } },
      { checkout: { enabled: true, methods: [] } },
      { enabled: false },
      { recharge: { ...storeJson.recharge, enabled: false } },
    ]) {
      reply('GET', '/v1/platform/store', 200, { ...storeJson, ...patch })
      await fetchStore()
      await codedReject(balance, 'PAYMENT_DISABLED')
    }
  })

  it('商品数据是别的账号的（或没取过）：请先刷新套餐信息', async () => {
    mocks.email = 'bob@example.com'
    await rejects(balance, '请先刷新套餐信息')
    mocks.email = null
    await rejects(balance, '请先刷新套餐信息')
  })

  it('金额发出前取整到分：0.1 + 0.2 发的是 0.3，不是 0.30000000000000004', async () => {
    reply('GET', '/v1/platform/store', 200, { ...storeJson, recharge: { ...storeJson.recharge, min: 0, max: 0 } })
    await fetchStore()
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate({ ...balance, amount: 0.1 + 0.2 })
    expect(networkCalls().at(-1)?.body).toMatchObject({ amount: 0.3 })
    await checkoutCreate({ ...balance, amount: 19.99 })
    expect(networkCalls().at(-1)?.body).toMatchObject({ amount: 19.99 })
    await checkoutCreate({ ...balance, amount: 100.07 })
    expect(networkCalls().at(-1)?.body).toMatchObject({ amount: 100.07 })
  })

  it('请求体：蛇形字段，balance 只带 amount', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate({ ...balance, extra: 'ignored' })
    expect(networkCalls()).toEqual([
      {
        path: '/v1/platform/orders',
        method: 'POST',
        body: { request_id: ID, kind: 'balance', amount: 120, method: 'alipay' },
      },
    ])
  })
})

describe('同时只能一个下单在途', () => {
  it('在途时第二个下单被拒、不发请求；结束后（成功或失败）可以再下', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    mocks.replies.set('POST /v1/platform/orders', (async () => {
      await gate
      return { status: 200, body: orderJson }
    }) as unknown as Reply)
    const first = checkoutCreate(balance)
    // 同步校验通过后立即占位：第二个马上被拒
    const second = await failure(checkoutCreate({ ...balance, requestId: '11111111-6a4b-4f0e-9d8f-2a1c7b5e9d10' }))
    expect(second.message).toBe('已有一笔订单正在创建，请稍候')
    release()
    await expect(first).resolves.toMatchObject({ orderId: 1234 })
    expect(networkCalls()).toHaveLength(1)

    // 失败后也释放
    reply('POST', '/v1/platform/orders', 502, { error: '暂时连不上', code: 'UPSTREAM_UNAVAILABLE' })
    expect(codeOf(await failure(checkoutCreate(balance)))?.code).toBe('checkout.UPSTREAM_UNAVAILABLE')
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await expect(checkoutCreate(balance)).resolves.toBeTruthy()
  })

  it('换了登录会话以后，上一个会话里还在途的下单不再占位，它的结果也不记', async () => {
    const other = '11111111-6a4b-4f0e-9d8f-2a1c7b5e9d10'
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    mocks.replies.set('POST /v1/platform/orders', (async () => {
      await gate
      return { status: 200, body: orderJson }
    }) as unknown as Reply)
    const stale = checkoutCreate(balance)
    mocks.epoch += 1 // 换账号：新会话里要重新取商品数据
    await fetchStore()
    mocks.replies.set('POST /v1/platform/orders', { status: 200, body: { ...orderJson, order_id: 99 } })
    await expect(checkoutCreate({ ...balance, requestId: other })).resolves.toMatchObject({ orderId: 99 })
    release()
    expect((await failure(stale)).message).toBe('登录状态已变化，请重试')
    // 旧会话的订单没有被记到新会话里
    expect((await failure(checkoutGet(1234))).message).toBe('找不到这笔订单，请重新下单')
    // 旧下单结束不会清掉新会话的占位：新会话里在途的下单仍然挡住第二个
    mocks.replies.set('POST /v1/platform/orders', (async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      return { status: 200, body: orderJson }
    }) as unknown as Reply)
    const first = checkoutCreate(balance)
    const second = await failure(checkoutCreate({ ...balance, requestId: '22222222-6a4b-4f0e-9d8f-2a1c7b5e9d10' }))
    expect(second.message).toBe('已有一笔订单正在创建，请稍候')
    await first
  })

  it('参数校验失败的下单不占位', async () => {
    await failure(checkoutCreate({ ...balance, amount: 0 }))
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await expect(checkoutCreate(balance)).resolves.toBeTruthy()
  })
})

describe('订单号白名单', () => {
  it('不认识的订单号一律拒绝，不发请求', async () => {
    for (const id of [1234, 1, 999]) {
      for (const op of [checkoutGet, checkoutVerify, checkoutCancel, checkoutOpenPayUrl]) {
        const e = await failure(op(id))
        expect(e.message).toBe('找不到这笔订单，请重新下单')
      }
    }
    expect(mocks.calls).toEqual([])
  })

  it('订单号必须是正的安全整数', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate(balance)
    mocks.calls.length = 0
    for (const id of [0, -1, 1.5, '1234', NaN, null, undefined, {}, Number.MAX_SAFE_INTEGER + 2]) {
      for (const op of [checkoutGet, checkoutVerify, checkoutCancel, checkoutOpenPayUrl])
        expect((await failure(op(id))).message, String(id)).toBe('请求参数不正确')
    }
    expect(mocks.calls).toEqual([])
  })

  it('下单后认识这个订单号：get / verify / cancel 走各自的路径', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    reply('GET', '/v1/platform/orders/1234', 200, { ...orderJson, status: 'paid' })
    reply('POST', '/v1/platform/orders/1234/verify', 200, { ...orderJson, status: 'completed' })
    reply('POST', '/v1/platform/orders/1234/cancel', 200, { ...orderJson, status: 'cancelled' })
    await checkoutCreate(balance)
    mocks.calls.length = 0
    expect((await checkoutGet(1234)).status).toBe('paid')
    expect((await checkoutVerify(1234)).status).toBe('completed')
    expect((await checkoutCancel(1234)).status).toBe('cancelled')
    expect(mocks.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/platform/orders/1234',
      'POST /v1/platform/orders/1234/verify',
      'POST /v1/platform/orders/1234/cancel',
    ])
  })

  it('换了登录账号（登录会话代数变了）以后，之前的订单号都不认', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    reply('GET', '/v1/platform/orders/1234', 200, orderJson)
    await checkoutCreate(balance)
    await expect(checkoutGet(1234)).resolves.toBeTruthy()
    mocks.epoch += 1
    mocks.calls.length = 0
    for (const op of [checkoutGet, checkoutVerify, checkoutCancel, checkoutOpenPayUrl])
      expect((await failure(op(1234))).message).toBe('找不到这笔订单，请重新下单')
    expect(mocks.calls).toEqual([])
  })

  it('pending 列表里列出来的订单也认', async () => {
    reply('GET', '/v1/platform/orders?status=pending', 200, {
      data: [{ ...orderJson, order_id: 77, qr_content: null }],
    })
    reply('GET', '/v1/platform/orders/77', 200, { ...orderJson, order_id: 77 })
    await checkoutPending()
    await expect(checkoutGet(77)).resolves.toMatchObject({ orderId: 77 })
  })

  it('云端回来的订单号和请求的对不上：报错，不记', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    reply('GET', '/v1/platform/orders/1234', 200, { ...orderJson, order_id: 9999 })
    await checkoutCreate(balance)
    expect((await failure(checkoutGet(1234))).message).toBe('服务返回的付款数据异常')
    expect((await failure(checkoutGet(9999))).message).toBe('找不到这笔订单，请重新下单')
  })
})

describe('checkoutPending', () => {
  it('不含二维码；坏条目丢掉，不拖垮整个列表', async () => {
    reply('GET', '/v1/platform/orders?status=pending', 200, {
      data: [orderJson, { order_id: 'x' }, null, { ...orderJson, order_id: 5 }],
    })
    const list = await checkoutPending()
    expect(list.map(o => o.orderId)).toEqual([1234, 5])
    for (const o of list) expect(o).toMatchObject({ qrContent: null, qrSource: null })
  })

  it('响应不是 {data:[…]} 就报错', async () => {
    for (const body of [{}, { data: {} }, [], 'x']) {
      reply('GET', '/v1/platform/orders?status=pending', 200, body)
      expect((await failure(checkoutPending())).message).toBe('服务返回的付款数据异常')
    }
  })

  it('列表项不带支付链接时，保留之前记下的', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    reply('GET', '/v1/platform/orders?status=pending', 200, { data: [{ ...orderJson, pay_url: null }] })
    await checkoutCreate(balance)
    await checkoutPending()
    await checkoutOpenPayUrl(1234)
    expect(mocks.opened).toEqual(['https://pay.example.com/cashier/abc'])
  })
})

describe('错误：codedError 的 code 和参数', () => {
  const create = (status: number, body: unknown): Promise<Error> => {
    reply('POST', '/v1/platform/orders', status, body)
    return failure(checkoutCreate(balance))
  }

  it('有认识的 code：抛 checkout.<CODE>，detail 里的字符串和数字做参数', async () => {
    const e = await create(429, { error: '待付单太多', code: 'TOO_MANY_PENDING', detail: { max: 5 } })
    expect(codeOf(e)).toEqual({ code: 'checkout.TOO_MANY_PENDING', params: { max: 5 } })
    const f = await create(400, {
      error: 'x',
      code: 'AMOUNT_OUT_OF_RANGE',
      detail: { min: 5, max: 1000, note: 'hi', nested: { a: 1 }, flag: true, list: [1], nan: null },
    })
    expect(codeOf(f)).toEqual({ code: 'checkout.AMOUNT_OUT_OF_RANGE', params: { min: 5, max: 1000, note: 'hi' } })
  })

  it('没有 detail 时没有参数', async () => {
    expect(codeOf(await create(409, { error: 'x', code: 'METHOD_UNAVAILABLE' }))).toEqual({
      code: 'checkout.METHOD_UNAVAILABLE',
      params: {},
    })
  })

  it('403 PANEL_REAUTH_REQUIRED 是带代码的错误（不是登录过期）', async () => {
    const e = await create(403, { error: '需要在浏览器里确认一次账号', code: 'PANEL_REAUTH_REQUIRED', detail: {} })
    expect(codeOf(e)?.code).toBe('checkout.PANEL_REAUTH_REQUIRED')
    expect((e as Error & { code?: string }).code).toBeUndefined() // 不带 AUTH_EXPIRED
  })

  it('云端 §4.5 的每个 code 都认识', async () => {
    for (const code of [
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
      expect(codeOf(await create(400, { error: '中文', code }))?.code, code).toBe(`checkout.${code}`)
  })

  it('不认识的 code 或没有 code：抛云端给的中文提示', async () => {
    expect((await create(400, { error: '请求不对', code: 'SOMETHING_NEW' })).message).toBe('请求不对')
    expect((await create(500, { error: '云端存储出错' })).message).toBe('云端存储出错')
  })

  it('没有可读提示 / 响应体不是 JSON：带状态码的中文', async () => {
    expect((await create(502, {})).message).toBe('付款服务暂时不可用（HTTP 502）')
    expect((await create(504, '<html>bad gateway</html>')).message).toBe('付款服务暂时不可用（HTTP 504）')
  })

  it('503 / 存储出错的 OAuth 风格错误体（没有 code）：用 error_description，机器码不显示', async () => {
    const desc = '云端服务暂时不可用，请稍后重试'
    expect((await create(503, { error: 'server_error', error_description: desc })).message).toBe(desc)
    expect((await create(503, { error: 'invalid_token', error_description: desc })).message).toBe(desc)
    // 只有机器码、没有描述：不把 server_error 抛给界面，退回带状态码的中文
    expect((await create(503, { error: 'server_error' })).message).toBe('付款服务暂时不可用（HTTP 503）')
    expect((await create(401, { error: 'invalid_token' })).message).toBe('付款服务暂时不可用（HTTP 401）')
    // 有中文 error 时照旧用 error；没有 code 且有描述时描述优先
    expect((await create(500, { error: '云端存储出错' })).message).toBe('云端存储出错')
    expect((await create(500, { error: '云端存储出错', error_description: '稍后再试' })).message).toBe('稍后再试')
    // 有不认识的 code：用 error
    const unknown = await create(400, { error: '请求不对', code: 'SOMETHING_NEW', error_description: 'x' })
    expect(unknown.message).toBe('请求不对')
  })

  it('成功响应的订单数据坏了：报错，不记订单', async () => {
    expect((await create(200, { order_id: 1234 })).message).toBe('服务返回的付款数据异常')
    expect((await failure(checkoutGet(1234))).message).toBe('找不到这笔订单，请重新下单')
  })
})

describe('checkoutOpenPayUrl', () => {
  it('只打开主进程记下的 pay_url', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate(balance)
    await checkoutOpenPayUrl(1234)
    expect(mocks.opened).toEqual(['https://pay.example.com/cashier/abc'])
  })

  it('记下的订单没有 https 支付页：拒绝，不开浏览器', async () => {
    for (const pay_url of ['http://pay.example.com/x', 'https://u:p@pay.example.com/x', null]) {
      reply('POST', '/v1/platform/orders', 200, { ...orderJson, pay_url })
      await checkoutCreate({ ...balance, requestId: ID })
      expect((await failure(checkoutOpenPayUrl(1234))).message, String(pay_url)).toBe('这笔订单没有可以打开的支付页')
    }
    expect(mocks.opened).toEqual([])
  })

  it('订单不再是待付（已付、已过期…）后，记下的地址作废', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    reply('GET', '/v1/platform/orders/1234', 200, { ...orderJson, status: 'paid' })
    await checkoutCreate(balance)
    await checkoutGet(1234)
    expect((await failure(checkoutOpenPayUrl(1234))).message).toBe('这笔订单没有可以打开的支付页')
    expect(mocks.opened).toEqual([])
  })

  it('渲染层多传的参数（地址）不起作用', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate(balance)
    await (checkoutOpenPayUrl as (...args: unknown[]) => Promise<void>)(1234, 'https://evil.example/x')
    expect(mocks.opened).toEqual(['https://pay.example.com/cashier/abc'])
  })
})

describe('payPageOf（付款窗口要加载的页面）', () => {
  it('取主进程记下的 pay_url 和支付方式名，渲染层多传的参数不起作用', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate(balance)
    const page = {
      orderId: 1234,
      url: 'https://pay.example.com/cashier/abc',
      label: orderJson.method_label,
      method: orderJson.method,
    }
    expect(payPageOf(1234)).toEqual(page)
    expect((payPageOf as (...args: unknown[]) => unknown)(1234, 'https://evil.example/x')).toEqual(page)
  })

  it('没记过的订单、订单号格式不对：拒绝', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate(balance)
    expect(() => payPageOf(999)).toThrow('找不到这笔订单，请重新下单')
    for (const bad of ['1234', 0, -1, 1.5, null, undefined, {}]) expect(() => payPageOf(bad)).toThrow('请求参数不正确')
  })

  it('没有 https 支付页（http、带用户名密码、没有）或订单已不是待付：拒绝；换了登录会话后也认不得', async () => {
    for (const pay_url of ['http://pay.example.com/x', 'https://u:p@pay.example.com/x', null]) {
      reply('POST', '/v1/platform/orders', 200, { ...orderJson, pay_url })
      await checkoutCreate({ ...balance, requestId: ID })
      expect(() => payPageOf(1234), String(pay_url)).toThrow('这笔订单没有可以打开的支付页')
    }
    reply('POST', '/v1/platform/orders', 200, orderJson)
    reply('GET', '/v1/platform/orders/1234', 200, { ...orderJson, status: 'paid' })
    await checkoutCreate(balance)
    expect(payPageOf(1234).url).toBe('https://pay.example.com/cashier/abc')
    await checkoutGet(1234)
    expect(() => payPageOf(1234)).toThrow('这笔订单没有可以打开的支付页')
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate({ ...balance, requestId: ID })
    mocks.epoch++
    expect(() => payPageOf(1234)).toThrow('找不到这笔订单，请重新下单')
  })
})

describe('panelStatus', () => {
  it('蛇形转驼峰', async () => {
    reply('GET', '/v1/platform/panel', 200, {
      valid: true,
      expires_at: '2026-10-24T09:12:00Z',
      usable_for_checkout: true,
    })
    expect(await panelStatus()).toEqual({ valid: true, expiresAt: '2026-10-24T09:12:00Z', usableForCheckout: true })
    reply('GET', '/v1/platform/panel', 200, { valid: false, usable_for_checkout: false })
    expect(await panelStatus()).toEqual({ valid: false, expiresAt: null, usableForCheckout: false })
  })

  it('字段不对就报错', async () => {
    for (const body of [{}, { valid: 'yes', usable_for_checkout: true }, { valid: true }, null]) {
      reply('GET', '/v1/platform/panel', 200, body)
      expect((await failure(panelStatus())).message).toBe('服务返回的付款数据异常')
    }
  })
})

describe('panelVerify 的地址校验', () => {
  const good = 'https://panel.example.com/cli/panel-verify?t=abc'

  it('同主机、https、路径是 /cli/panel-verify：打开浏览器', async () => {
    reply('POST', '/v1/platform/panel/verify', 200, { url: good, expires_at: '2026-10-18T03:10:00Z' })
    await panelVerify()
    expect(mocks.opened).toEqual([good])
    expect(mocks.calls[0]).toMatchObject({ method: 'POST', path: '/v1/platform/panel/verify' })
  })

  it('不同主机、仿冒主机拒绝，不开浏览器', async () => {
    for (const url of [
      'https://evil.example/cli/panel-verify?t=abc',
      'https://panel.example.com.evil.example/cli/panel-verify?t=abc',
      'https://evilpanel.example.com/cli/panel-verify?t=abc',
      'https://sub.panel.example.com/cli/panel-verify?t=abc',
      'https://panel.example.com@evil.example/cli/panel-verify?t=abc',
      'https://1.2.3.4/cli/panel-verify?t=abc',
    ]) {
      reply('POST', '/v1/platform/panel/verify', 200, { url })
      expect((await failure(panelVerify())).message, url).toBe('确认地址不在可信域名内，已拒绝打开')
    }
    expect(mocks.opened).toEqual([])
  })

  it('非 https 拒绝（打包后；开发环境和回环地址例外）', () => {
    mocks.packaged = true
    expect(() => panelVerifyLink('http://panel.example.com/cli/panel-verify?t=abc')).toThrow('已拒绝打开')
    expect(() => panelVerifyLink('ftp://panel.example.com/cli/panel-verify')).toThrow('已拒绝打开')
    expect(() => panelVerifyLink('javascript:alert(1)')).toThrow('已拒绝打开')
    mocks.base = 'http://127.0.0.1:9080'
    expect(panelVerifyLink('http://127.0.0.1:9080/cli/panel-verify?t=abc')).toBe(
      'http://127.0.0.1:9080/cli/panel-verify?t=abc',
    )
    mocks.base = 'http://localhost:9080'
    expect(panelVerifyLink('http://localhost:9080/cli/panel-verify?t=abc')).toContain('localhost')
    // 回环地址只在云端地址也是它时才可信
    expect(() => panelVerifyLink('http://127.0.0.1:9080/cli/panel-verify?t=abc')).toThrow('已拒绝打开')
    mocks.packaged = false
    mocks.base = 'http://panel.example.com'
    expect(panelVerifyLink('http://panel.example.com/cli/panel-verify?t=abc')).toContain('panel.example.com')
  })

  it('带用户名密码、路径不对、不是字符串都拒绝', () => {
    for (const url of [
      'https://u:p@panel.example.com/cli/panel-verify?t=abc',
      'https://panel.example.com/purchase',
      'https://panel.example.com/cli/panel-verify/extra',
      'https://panel.example.com/cli/panel-verifyx',
      'https://panel.example.com/',
      '/cli/panel-verify?t=abc',
      'not a url',
      '',
      null,
      undefined,
      42,
    ])
      expect(() => panelVerifyLink(url), String(url)).toThrow('确认地址不在可信域名内，已拒绝打开')
  })

  it('响应里没有 url 也拒绝', async () => {
    reply('POST', '/v1/platform/panel/verify', 200, { expires_at: 'x' })
    expect((await failure(panelVerify())).message).toBe('确认地址不在可信域名内，已拒绝打开')
    expect(mocks.opened).toEqual([])
  })
})

describe('panelVerifyLink 连端口一起比', () => {
  it('云端地址带端口：确认地址端口必须一样', () => {
    mocks.base = 'https://panel.example.com:8443'
    expect(panelVerifyLink('https://panel.example.com:8443/cli/panel-verify?t=a')).toContain(':8443')
    expect(() => panelVerifyLink('https://panel.example.com/cli/panel-verify?t=a')).toThrow('已拒绝打开')
    expect(() => panelVerifyLink('https://panel.example.com:9443/cli/panel-verify?t=a')).toThrow('已拒绝打开')
  })

  it('云端地址是默认端口：确认地址带别的端口拒绝；默认端口 / 大小写 / 结尾的点照样认', () => {
    expect(() => panelVerifyLink('https://panel.example.com:8443/cli/panel-verify?t=a')).toThrow('已拒绝打开')
    expect(panelVerifyLink('https://panel.example.com:443/cli/panel-verify?t=a')).toContain('panel.example.com')
    expect(panelVerifyLink('https://PANEL.Example.com./cli/panel-verify?t=a')).toContain('/cli/panel-verify')
    mocks.base = 'https://Panel.Example.com.:8443'
    expect(panelVerifyLink('https://panel.example.com.:8443/cli/panel-verify?t=a')).toContain(':8443')
  })
})

describe('断网、超时和换账号（call 的包装）', () => {
  const timeout = (): Error =>
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  const throwing = (e: Error): Reply =>
    (async () => {
      throw e
    }) as unknown as Reply

  it('断网（fetch failed）：中文提示，不冒原始异常', async () => {
    mocks.replies.set('POST /v1/platform/orders', throwing(new TypeError('fetch failed')))
    expect((await failure(checkoutCreate(balance))).message).toBe('连不上付款服务，请检查网络后重试')
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate(balance)
    mocks.replies.set('GET /v1/platform/orders/1234', throwing(new TypeError('fetch failed')))
    expect((await failure(checkoutGet(1234))).message).toBe('连不上付款服务，请检查网络后重试')
    mocks.replies.set('GET /v1/platform/panel', throwing(new TypeError('fetch failed')))
    expect((await failure(panelStatus())).message).toBe('连不上付款服务，请检查网络后重试')
  })

  it('超时：下单说「不会重复下单」，其它请求说响应超时；和断网分开', async () => {
    mocks.replies.set('POST /v1/platform/orders', throwing(timeout()))
    expect((await failure(checkoutCreate(balance))).message).toBe('下单超时：请稍后在「继续付款」里查看，不会重复下单')
    mocks.replies.set('GET /v1/platform/panel', throwing(timeout()))
    expect((await failure(panelStatus())).message).toBe('付款服务响应超时，请稍后重试')
    mocks.replies.set('GET /v1/platform/panel', throwing(new DOMException('aborted', 'AbortError')))
    expect((await failure(panelStatus())).message).toBe('付款服务响应超时，请稍后重试')
  })

  it('登录过期之类带 code 的错误、别的错误原样抛，不当成断网', async () => {
    const expired = Object.assign(new TypeError('登录已失效，请重新登录'), { code: 'AUTH_EXPIRED' })
    mocks.replies.set('GET /v1/platform/panel', throwing(expired))
    expect(await failure(panelStatus())).toBe(expired)
    mocks.replies.set('GET /v1/platform/panel', throwing(new Error('请先登录像素星空账号')))
    expect((await failure(panelStatus())).message).toBe('请先登录像素星空账号')
  })

  it('请求途中换了账号：结果丢弃，不记订单，抛「登录状态已变化」', async () => {
    mocks.replies.set('POST /v1/platform/orders', (async () => {
      mocks.epoch += 1
      return { status: 200, body: orderJson }
    }) as unknown as Reply)
    expect((await failure(checkoutCreate(balance))).message).toBe('登录状态已变化，请重试')
    expect((await failure(checkoutGet(1234))).message).toBe('找不到这笔订单，请重新下单')
  })

  it('查单 / 失败的请求途中换了账号：同样说登录状态已变化，不记订单', async () => {
    reply('POST', '/v1/platform/orders', 200, orderJson)
    await checkoutCreate(balance)
    mocks.replies.set('GET /v1/platform/orders/1234', (async () => {
      mocks.epoch += 1
      return { status: 200, body: orderJson }
    }) as unknown as Reply)
    expect((await failure(checkoutGet(1234))).message).toBe('登录状态已变化，请重试')
    expect((await failure(checkoutGet(1234))).message).toBe('找不到这笔订单，请重新下单')
    mocks.replies.set('GET /v1/platform/panel', (async () => {
      mocks.epoch += 1
      throw new TypeError('fetch failed')
    }) as unknown as Reply)
    expect((await failure(panelStatus())).message).toBe('登录状态已变化，请重试')
  })
})

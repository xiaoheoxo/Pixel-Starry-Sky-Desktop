import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 云端服务的契约样例（services/cloud/testdata/contract，见 docs/cloud-service.md §4.2.10）：
// Go 那边检查实际响应和样例的字段、类型一致，这里用同一份样例喂桌面端的解析代码。
// 改接口就必须改样例，两边的测试会一起失败。

const contractDir = fileURLToPath(new URL('../../../../../services/cloud/testdata/contract/', import.meta.url))

interface Sample {
  endpoint: string
  status: number
  body: unknown
}
// services/ 不进主仓库（独立的 git 仓库）：CI 和没拉云端代码的机器上没有样例，整组跳过
const hasSamples = existsSync(contractDir)

const sample = (name: string): Sample => JSON.parse(readFileSync(contractDir + name, 'utf8')) as Sample

const mocks = vi.hoisted(() => ({
  responses: new Map<string, { status: number; body: unknown }>(),
  paths: [] as string[],
}))
vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: { openExternal: vi.fn() } }))
vi.mock('../account/account', () => ({
  signedInEmail: () => 'alice@example.com',
  accountEpoch: () => 1,
  baseUrl: () => 'https://cloud.example.test',
  // 按路径（不含查询串）回放样例
  platformFetch: async (path: string) => {
    mocks.paths.push(path)
    const hit = mocks.responses.get(path.split('?')[0])
    if (!hit) throw new Error('没有为 ' + path + ' 准备样例')
    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { 'Content-Type': 'application/json' },
    })
  },
}))

const { platformGroups } = await import('./platform')
const { accountCalls, platformCharges } = await import('./billing')
const { fetchStore } = await import('../account/store')
const { checkoutCreate, checkoutGet, checkoutPending, panelStatus, panelVerify, parseOrder } = await import(
  '../account/checkout'
)
const { shell } = await import('electron')
const { parseCodedError } = await import('@pixelsky/protocol')

function serve(path: string, s: Sample): void {
  mocks.responses.set(path, { status: s.status, body: s.body })
}

// 和 @pixelsky/protocol 的接口逐字段对上：字段名和 JS 类型
function expectFields(value: Record<string, unknown>, fields: Record<string, string | string[]>): void {
  for (const [key, type] of Object.entries(fields)) {
    const actual = value[key] === null ? 'null' : typeof value[key]
    expect([type].flat(), `${key} 的类型`).toContain(actual)
  }
}

beforeEach(() => {
  mocks.responses.clear()
  mocks.paths.length = 0
})

describe.skipIf(!hasSamples)('云端契约样例：平台分组', () => {
  it('公开分组的样例全部通过桌面端的筛选，字段原样保留', async () => {
    const s = sample('desktop/platform-groups.json')
    serve('/v1/platform/groups', s)
    const groups = await platformGroups()
    const data = (s.body as { data: unknown[] }).data
    expect(groups).toHaveLength(data.length)
    expect(groups).toEqual(data)
    for (const g of groups) expect(['claude', 'codex']).toEqual(expect.arrayContaining(g.supported_engines ?? []))
  })

  it('面板授权过期时显示云端给的提示', async () => {
    const s = sample('desktop/platform-groups-expired.json')
    serve('/v1/platform/groups', s)
    await expect(platformGroups()).rejects.toThrow((s.body as { error: string }).error)
  })
})

describe.skipIf(!hasSamples)('云端契约样例：调用明细', () => {
  it('调用明细一页能被 accountCalls 接受，每条记录的字段和类型符合 RemoteCall', async () => {
    serve('/v1/oauth/usage/calls', sample('desktop/usage-calls.json'))
    const page = await accountCalls({ range: '7d', now: Date.now(), offset: 0, limit: 50, model: null })
    expect(page.calls.length).toBeGreaterThan(0)
    expectFields(page as unknown as Record<string, unknown>, {
      total: 'number',
      offset: 'number',
      nextCursor: ['string', 'null'],
    })
    for (const call of page.calls)
      expectFields(call as unknown as Record<string, unknown>, {
        id: 'string',
        createdAt: 'number',
        model: 'string',
        client: 'string',
        device: ['string', 'null'],
        keyName: ['string', 'null'],
        stream: 'boolean',
        status: 'string',
        httpStatus: 'number',
        input: 'number',
        cacheRead: 'number',
        cacheWrite: 'number',
        output: 'number',
        costUsd: ['number', 'null'],
        firstTokenMs: ['number', 'null'],
        durationMs: 'number',
        turnId: ['string', 'null'],
        billing: 'string',
      })
    expect(mocks.paths[0]).toMatch(/^\/v1\/oauth\/usage\/calls\?offset=0&limit=50&/)
  })

  it('按请求 ID 查实扣金额能被 platformCharges 接受，字段和类型符合 PlatformCharge', async () => {
    const s = sample('desktop/usage-charges.json')
    serve('/v1/oauth/usage/calls', s)
    const requestId = (s.body as { charges: Array<{ requestId: string }> }).charges[0].requestId
    const charges = await platformCharges(
      {
        account: 'alice@example.com',
        requests: [{ id: requestId, model: 'm', groupId: '2' }],
        startedAt: Date.now(),
        complete: true,
      },
      AbortSignal.timeout(5000),
    )
    expect(charges).toHaveLength(1)
    expect(charges[0].requestId).toBe(requestId)
    expectFields(charges[0] as unknown as Record<string, unknown>, {
      requestId: 'string',
      model: 'string',
      groupId: 'string',
      costUsd: 'number',
      billing: 'string',
      rateMultiplier: 'number',
      input: 'number',
      output: 'number',
      cacheRead: 'number',
      cacheWrite: 'number',
    })
  })

  it('参数不对时云端回 400，桌面端报读取失败', async () => {
    serve('/v1/oauth/usage/calls', sample('desktop/usage-calls-invalid.json'))
    await expect(accountCalls({ range: '7d', now: Date.now(), offset: 0, limit: 50, model: null })).rejects.toThrow(
      '暂时无法读取账号调用记录',
    )
  })
})

describe.skipIf(!hasSamples)('云端契约样例：订阅套餐与充值（§4.16）', () => {
  it('支付开着：套餐、充值规则、支付方式逐项对上样例', async () => {
    const s = sample('desktop/store-open.json')
    serve('/v1/platform/store', s)
    const body = s.body as {
      plans: Array<Record<string, unknown>>
      recharge: Record<string, unknown>
      methods: Array<{ type: string; label: string }>
      help_text: string
      purchase_url: string
      redeem_url: string
    }
    const store = await fetchStore()
    expect(mocks.paths).toEqual(['/v1/platform/store'])
    expect(store.enabled).toBe(true)
    expect(store.currency).toBe('CNY')
    expect(store.plans).toHaveLength(body.plans.length)
    // 按 sort 排：GPT 周卡（sort 10，id 3）在 Claude 周卡（sort 20，id 1）前
    expect(store.plans.map(p => p.id)).toEqual([3, 1])
    const claude = store.plans.find(p => p.id === 1)!
    expect(claude).toMatchObject({
      name: 'Claude 周卡',
      price: 30,
      originalPrice: 40,
      validityDays: 7,
      groupName: 'Claude Sub',
      features: ['不限次数', '优先通道'],
      quotas: { fiveHour: 8, daily: 10, weekly: 50, monthly: null },
    })
    expect(store.plans.find(p => p.id === 3)!.originalPrice).toBeNull()
    expect(store.plans.find(p => p.id === 3)!.quotas).toEqual({
      fiveHour: null,
      daily: null,
      weekly: null,
      monthly: null,
    })
    expect(store.recharge).toEqual({
      enabled: true,
      min: 5,
      max: 500,
      multiplier: 1.5,
      feeRate: 2,
      bonusMode: 'bonus',
      bonusTiers: [
        { minAmount: 100, bonusPercent: 5 },
        { minAmount: 500, bonusPercent: 10 },
      ],
      usdToCnyRate: 7.2,
    })
    expect(store.methods).toEqual(body.methods)
    expect(store.helpText).toBe(body.help_text)
    expect(store.purchaseUrl).toBe(body.purchase_url)
    expect(store.redeemUrl).toBe(body.redeem_url)
  })

  it('支付关着：enabled=false，套餐、支付方式、档位全空', async () => {
    serve('/v1/platform/store', sample('desktop/store-closed.json'))
    const store = await fetchStore()
    expect(store.enabled).toBe(false)
    expect(store.plans).toEqual([])
    expect(store.methods).toEqual([])
    expect(store.recharge.enabled).toBe(false)
    expect(store.recharge.bonusTiers).toEqual([])
  })

  it('没有在售套餐：空套餐、充值关闭，但档位和帮助文字保留', async () => {
    serve('/v1/platform/store', sample('desktop/store-empty.json'))
    const store = await fetchStore()
    expect(store.enabled).toBe(true)
    expect(store.plans).toEqual([])
    expect(store.recharge.enabled).toBe(false)
    expect(store.recharge.bonusTiers).toHaveLength(2)
    expect(store.helpText).toBe('充值遇到问题请联系客服')
  })

  it('401 invalid_token 和 502 都报错，502 带云端给的提示', async () => {
    mocks.responses.set('/v1/platform/store', {
      status: 502,
      body: { error: '暂时读不到订阅套餐和充值信息，请稍后重试' },
    })
    await expect(fetchStore()).rejects.toThrow('暂时读不到订阅套餐和充值信息，请稍后重试')
    mocks.responses.set('/v1/platform/store', { status: 401, body: { error: 'invalid_token' } })
    await expect(fetchStore()).rejects.toThrow('invalid_token')
  })
})

describe.skipIf(!hasSamples)('云端契约样例：软件内付款（docs/ui/in-app-payment.md §4.3–4.5）', () => {
  const REQUEST_ID = '3f6c1e0a-6a4b-4f0e-9d8f-2a1c7b5e9d10'
  // 下单要对照最近一次的商品数据：先用 store-open（带 checkout 能力标记）读一次
  async function openStore(): Promise<void> {
    serve('/v1/platform/store', sample('desktop/store-open.json'))
    const store = await fetchStore()
    expect(store.checkout).toEqual({ enabled: true, methods: ['alipay', 'wxpay'], orderTimeoutMinutes: 30 })
  }
  async function codeOf(p: Promise<unknown>): Promise<{ code: string; params: unknown } | null> {
    const err = await p.then(
      () => null,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(Error)
    const info = parseCodedError(err!.message)
    return info && { code: info.code, params: info.params }
  }

  it('每份订单样例都能解析；二维码和支付链接只在 pending 时有', () => {
    for (const name of [
      'checkout-create',
      'checkout-create-plan',
      'checkout-create-reused',
      'checkout-get-paid',
      'checkout-get-completed',
      'checkout-get-expired',
      'checkout-cancel',
    ]) {
      const order = parseOrder(sample(`desktop/${name}.json`).body)
      expect(order.orderId, name).toBeGreaterThan(0)
      if (order.status === 'pending') expect(order.qrContent, name).toBeTruthy()
      else expect([order.qrContent, order.payUrl], name).toEqual([null, null])
    }
    const plan = parseOrder(sample('desktop/checkout-create-plan.json').body)
    expect(plan.kind).toBe('plan')
    expect(plan.plan).toMatchObject({ id: expect.any(Number), name: expect.any(String) })
    expect(parseOrder(sample('desktop/checkout-create-reused.json').body).reused).toBe(true)
  })

  it('下单、查单逐项对上样例；待付列表不带二维码', async () => {
    await openStore()
    const s = sample('desktop/checkout-create.json')
    serve('/v1/platform/orders', s)
    const order = await checkoutCreate({ requestId: REQUEST_ID, kind: 'balance', amount: 120, method: 'alipay' })
    expect(order).toMatchObject({
      orderId: 1001,
      kind: 'balance',
      status: 'pending',
      method: 'alipay',
      payAmount: 120,
      payCurrency: 'CNY',
      credited: 120,
      plan: null,
      qrSource: 'provider',
      reused: false,
    })
    expect(order.qrContent).toBe((s.body as { qr_content: string }).qr_content)
    serve('/v1/platform/orders/1001', sample('desktop/checkout-get-paid.json'))
    expect((await checkoutGet(1001)).status).toBe('paid')
    serve('/v1/platform/orders', sample('desktop/checkout-pending-list.json'))
    const list = await checkoutPending()
    expect(list.length).toBeGreaterThan(0)
    expect(list.every(o => o.qrContent === null)).toBe(true)
  })

  it('错误样例：按 code 抛 codedError，带上 detail 里的参数；需要确认账号是 403 不是 401', async () => {
    await openStore()
    const create = () => checkoutCreate({ requestId: REQUEST_ID, kind: 'balance', amount: 120, method: 'alipay' })
    const reauth = sample('desktop/checkout-reauth-required.json')
    expect(reauth.status).toBe(403)
    serve('/v1/platform/orders', reauth)
    expect(await codeOf(create())).toMatchObject({ code: 'checkout.PANEL_REAUTH_REQUIRED' })
    serve('/v1/platform/orders', sample('desktop/checkout-too-many-pending.json'))
    expect(await codeOf(create())).toEqual({ code: 'checkout.TOO_MANY_PENDING', params: { max: 3 } })
    serve('/v1/platform/orders', sample('desktop/checkout-amount-out-of-range.json'))
    expect(await codeOf(create())).toEqual({ code: 'checkout.AMOUNT_OUT_OF_RANGE', params: { min: 5, max: 500 } })
    serve('/v1/platform/orders', sample('desktop/checkout-unsupported.json'))
    expect(await codeOf(create())).toMatchObject({ code: 'checkout.UNSUPPORTED_RESULT' })
    serve('/v1/platform/orders', sample('desktop/checkout-account-disabled.json'))
    expect(await codeOf(create())).toMatchObject({ code: 'checkout.ACCOUNT_DISABLED' })
  })

  it('查单被限频：RATE_LIMITED 带 retry_after；核实时面板凭证失效：仍是订单，panelValid=false', async () => {
    await openStore()
    serve('/v1/platform/orders', sample('desktop/checkout-create.json'))
    await checkoutCreate({ requestId: REQUEST_ID, kind: 'balance', amount: 120, method: 'alipay' })
    serve('/v1/platform/orders/1001', sample('desktop/checkout-rate-limited.json'))
    expect(await codeOf(checkoutGet(1001))).toEqual({ code: 'checkout.RATE_LIMITED', params: { retry_after: 41 } })
    const verify = parseOrder(sample('desktop/checkout-verify-panel-invalid.json').body)
    expect(verify.panelValid).toBe(false)
  })

  it('面板凭证状态', async () => {
    serve('/v1/platform/panel', sample('desktop/panel-status.json'))
    expect(await panelStatus()).toEqual({ valid: true, expiresAt: '2026-10-19T10:34:50Z', usableForCheckout: true })
  })

  it('去浏览器确认账号：样例里的确认页地址和云端同主机、https、路径对，主进程照样打开', async () => {
    const s = sample('desktop/panel-verify.json')
    serve('/v1/platform/panel/verify', s)
    await panelVerify()
    expect(shell.openExternal).toHaveBeenCalledWith((s.body as { url: string }).url)
  })

  it('商品接口：支付关着时 checkout 不开', async () => {
    serve('/v1/platform/store', sample('desktop/store-closed.json'))
    expect((await fetchStore()).checkout?.enabled ?? false).toBe(false)
  })
})

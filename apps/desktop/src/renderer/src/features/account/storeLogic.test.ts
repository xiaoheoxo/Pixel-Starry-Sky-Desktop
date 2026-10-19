import { describe, expect, it } from 'vitest'
import type { StoreRecharge } from '../../../../shared/types/account'
import {
  checkAmount,
  diffAccount,
  isCurrentPlan,
  matchTier,
  payAmountTrusted,
  quoteRecharge,
  round2,
  roundUp2,
  snapOf,
  validityLabel,
} from './storeLogic'

const recharge = (over: Partial<StoreRecharge> = {}): StoreRecharge => ({
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
  ...over,
})

describe('validityLabel', () => {
  it('只有正好 30 / 90 / 365 天才显示月 / 季 / 年', () => {
    expect(validityLabel(30)).toBe('月')
    expect(validityLabel(90)).toBe('季')
    expect(validityLabel(365)).toBe('年')
  })
  it('其余按天', () => {
    expect(validityLabel(7)).toBe('7 天')
    expect(validityLabel(31)).toBe('31 天')
    expect(validityLabel(1)).toBe('1 天')
  })
})

describe('isCurrentPlan', () => {
  it('账号的 plan.name 是分组名：按分组名匹配，也认套餐名', () => {
    expect(isCurrentPlan({ name: 'Claude 周卡', groupName: 'Claude Sub' }, 'Claude Sub')).toBe(true)
    expect(isCurrentPlan({ name: 'Claude 周卡', groupName: 'Claude Sub' }, 'Claude 周卡')).toBe(true)
    expect(isCurrentPlan({ name: 'GPT 周卡', groupName: 'GPT Pro' }, 'Claude Sub')).toBe(false)
    expect(isCurrentPlan({ name: 'x', groupName: '' }, null)).toBe(false)
  })
})

describe('matchTier', () => {
  it('取不超过金额的最大档位', () => {
    const tiers = recharge().bonusTiers
    expect(matchTier(tiers, 99.99)).toBeNull()
    expect(matchTier(tiers, 100)?.bonusPercent).toBe(5)
    expect(matchTier(tiers, 499)?.bonusPercent).toBe(5)
    expect(matchTier(tiers, 500)?.bonusPercent).toBe(10)
  })
})

describe('quoteRecharge', () => {
  it('没命中档位：到账 = 金额 × 倍率，应付 = 金额 + 手续费', () => {
    expect(quoteRecharge(recharge(), 50)).toEqual({ credited: 75, bonus: 0, payBase: 50, fee: 1, pay: 51, percent: 0 })
  })
  it('赠金模式：在到账基数上多送百分比，实付不变', () => {
    // 100 × 1.5 = 150；送 5% = 7.5；到账 157.5；手续费 2
    expect(quoteRecharge(recharge(), 100)).toEqual({
      credited: 157.5,
      bonus: 7.5,
      payBase: 100,
      fee: 2,
      pay: 102,
      percent: 5,
    })
  })
  it('折扣模式：到账不变，实付基数打折，免费部分 = 到账 − 实付部分的到账', () => {
    const q = quoteRecharge(recharge({ bonusMode: 'discount' }), 100)
    // 实付基数 95；手续费 1.9；到账 150；免费 150 − round2(95 × 1.5 = 142.5) = 7.5
    expect(q).toEqual({ credited: 150, bonus: 7.5, payBase: 95, fee: 1.9, pay: 96.9, percent: 5 })
  })
  it('手续费向上取整到分', () => {
    // 3.33 × 2% = 0.0666 → 0.07
    expect(quoteRecharge(recharge({ multiplier: 1 }), 3.33).fee).toBe(0.07)
  })
  it('折扣百分比 >= 100 的非法档位按无优惠处理', () => {
    const q = quoteRecharge(recharge({ bonusMode: 'discount', bonusTiers: [{ minAmount: 1, bonusPercent: 100 }] }), 10)
    expect(q.percent).toBe(0)
    expect(q.payBase).toBe(10)
  })
  it('十进制舍入', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.675)).toBe(2.68)
  })
})

describe('checkAmount', () => {
  const r = { min: 5, max: 500 }
  it('空、格式、范围', () => {
    expect(checkAmount('', r)).toEqual({ ok: false, reason: 'empty' })
    expect(checkAmount('1.234', r)).toEqual({ ok: false, reason: 'format' })
    expect(checkAmount('abc', r)).toEqual({ ok: false, reason: 'format' })
    expect(checkAmount('4.99', r)).toEqual({ ok: false, reason: 'min' })
    expect(checkAmount('500.01', r)).toEqual({ ok: false, reason: 'max' })
    expect(checkAmount('5', r)).toEqual({ ok: true, value: 5 })
  })
  it('max 为 0 表示不限', () => {
    expect(checkAmount('99999', { min: 0, max: 0 })).toEqual({ ok: true, value: 99999 })
  })
})

describe('round2 / roundUp2 的数值算法', () => {
  it('极小值、极大值不再出 NaN', () => {
    expect(round2(1e-7)).toBe(0)
    expect(round2(-1e-7)).toBe(0)
    expect(Object.is(round2(-1e-7), 0)).toBe(true) // 不出 -0
    expect(round2(5e-324)).toBe(0)
    expect(round2(1e21)).toBe(1e21)
    expect(roundUp2(1e-7)).toBe(0.01)
    expect(roundUp2(0)).toBe(0)
    expect(roundUp2(-1e-7)).toBe(0)
  })
  it('NaN 和 Infinity 原样返回，不抛错', () => {
    expect(round2(NaN)).toBeNaN()
    expect(round2(Infinity)).toBe(Infinity)
    expect(roundUp2(NaN)).toBeNaN()
    expect(roundUp2(-Infinity)).toBe(-Infinity)
  })
  it('1.005 一类的浮点误差仍按十进制处理', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(-1.005)).toBe(-1.01)
    expect(round2(2.675)).toBe(2.68)
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(roundUp2(1.001)).toBe(1.01)
    expect(roundUp2(1.5)).toBe(1.5)
    expect(roundUp2(0.07)).toBe(0.07) // 0.07 × 100 = 7.000000000000001 不会被多进一分
  })
  it('极小金额的报价也是有限数', () => {
    const q = quoteRecharge(recharge({ multiplier: 1e-9, feeRate: 1e-9 }), 1e-7)
    for (const v of [q.credited, q.bonus, q.payBase, q.fee, q.pay]) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('payAmountTrusted：币种对不上或拿不准就不显示应付', () => {
  const plans = (...currencies: string[]) => currencies.map(currency => ({ currency })) as never
  it('云端明确给了币种，套餐币种一致（忽略大小写）：可信', () => {
    expect(payAmountTrusted({ currency: 'CNY', currencyKnown: true, plans: plans('CNY', 'cny') })).toBe(true)
    expect(payAmountTrusted({ currency: 'CNY', plans: [] })).toBe(true)
  })
  it('套餐币种和支付币种对不上：不可信', () => {
    expect(payAmountTrusted({ currency: 'CNY', currencyKnown: true, plans: plans('CNY', 'USD') })).toBe(false)
  })
  it('云端没给币种（默认值是猜的）或币种为空：不可信', () => {
    expect(payAmountTrusted({ currency: 'CNY', currencyKnown: false, plans: [] })).toBe(false)
    expect(payAmountTrusted({ currency: '', plans: [] })).toBe(false)
  })
})

describe('diffAccount：付款前后对比', () => {
  const acc = (balance: number | null, plan: { name: string; expiresAt: string | null } | null) =>
    snapOf({ balance, plan: plan && { ...plan, daily: null, weekly: null, monthly: null } })
  it('没变化返回 null（暂未到账）', () => {
    const a = acc(10, { name: 'Pro', expiresAt: '2026-11-01' })
    expect(diffAccount(a, acc(10, { name: 'Pro', expiresAt: '2026-11-01' }))).toBeNull()
    expect(diffAccount(acc(10 + 1e-12, null), acc(10, null))).toBeNull()
  })
  it('余额变了', () => {
    expect(diffAccount(acc(10, null), acc(35, null))).toEqual({
      balance: { from: 10, to: 35 },
      plan: null,
      expires: null,
    })
  })
  it('余额减少（会话在扣费）、套餐失效、到期时间变早都不算到账', () => {
    expect(diffAccount(acc(10, null), acc(9.98, null))).toBeNull()
    expect(diffAccount(acc(1, { name: 'A', expiresAt: null }), acc(1, null))).toBeNull()
    expect(
      diffAccount(acc(1, { name: 'A', expiresAt: '2026-12-01' }), acc(1, { name: 'A', expiresAt: '2026-11-01' })),
    ).toBeNull()
  })
  it('开通套餐、换套餐', () => {
    expect(diffAccount(acc(1, null), acc(1, { name: 'Pro', expiresAt: null }))?.plan).toEqual({ from: null, to: 'Pro' })
    expect(diffAccount(acc(1, { name: 'A', expiresAt: null }), acc(1, { name: 'B', expiresAt: null }))?.plan).toEqual({
      from: 'A',
      to: 'B',
    })
  })
  it('续费：同一个套餐到期时间变长', () => {
    const r = diffAccount(
      acc(1, { name: 'Pro', expiresAt: '2026-11-01' }),
      acc(1, { name: 'Pro', expiresAt: '2026-12-01' }),
    )
    expect(r).toEqual({ balance: null, plan: null, expires: { from: '2026-11-01', to: '2026-12-01' } })
  })
  it('余额读不到（null）时不算余额变化', () => {
    expect(diffAccount(acc(null, null), acc(5, null))).toBeNull()
    expect(diffAccount(acc(5, null), acc(null, null))).toBeNull()
  })
})

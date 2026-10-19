// 订阅套餐与充值的纯计算（docs/ui/settings.md §9.4–9.6）。公式照 Sub2api：
// service/payment_recharge_bonus.go（quoteRechargeBonus）、payment/fee.go（CalculatePayAmountForCurrency）。
import { tr } from '../../i18n/core'
import type {
  AccountInfo,
  StoreBonusTier,
  StoreCatalog,
  StorePlan,
  StoreRecharge,
} from '../../../../shared/types/account'

/** 先乘 100 再用 15 位有效数字消掉浮点误差（1.005 × 100 = 100.49999999999999 → 100.5） */
function cents(v: number): number {
  return Number((v * 100).toPrecision(15))
}

/** 按十进制四舍五入到分（半数远离零），避开 1.005 这类浮点误差；NaN / Infinity 和大到没有小数位的数原样返回 */
export function round2(v: number): number {
  if (!Number.isFinite(v) || Math.abs(v) >= 1e13) return v
  const r = Math.round(cents(Math.abs(v))) / 100
  return v < 0 && r !== 0 ? -r : r
}
/** 向上取整到分（容忍 1e-9 的浮点误差）；NaN / Infinity 原样返回 */
export function roundUp2(v: number): number {
  if (!Number.isFinite(v) || Math.abs(v) >= 1e13) return v
  const r = Math.ceil(cents(v) - 1e-9) / 100
  return r === 0 ? 0 : r
}

/** 有效期文字：正好 30 / 90 / 365 天显示 月 / 季 / 年，其余按天（「7 天」） */
export function validityLabel(days: number): string {
  if (days === 30) return tr('settings.account.PlanStore.month')
  if (days === 90) return tr('settings.account.PlanStore.quarter')
  if (days === 365) return tr('settings.account.PlanStore.year')
  if (days === 1) return tr('settings.account.PlanStore.oneDay')
  return tr('settings.account.PlanStore.days', { p0: days })
}

/** 账号当前套餐对应的卖品：账号的 plan.name 是订阅分组名（订阅计费时），也兼容与套餐名相同 */
export function isCurrentPlan(plan: Pick<StorePlan, 'name' | 'groupName'>, currentPlan: string | null): boolean {
  if (!currentPlan) return false
  return (!!plan.groupName && plan.groupName === currentPlan) || plan.name === currentPlan
}

/** 命中的赠送 / 折扣档位：不超过支付金额的最大 minAmount */
export function matchTier(tiers: StoreBonusTier[], amount: number): StoreBonusTier | null {
  let hit: StoreBonusTier | null = null
  for (const t of [...tiers].sort((a, b) => a.minAmount - b.minAmount)) {
    if (amount + 1e-9 < t.minAmount) break
    hit = t
  }
  return hit && hit.bonusPercent > 0 ? hit : null
}

export interface RechargeQuote {
  /** 到账总额（美元），含赠送 */
  credited: number
  /** 其中免费的部分 */
  bonus: number
  /** 手续费前的实付基数（折扣模式为折后金额） */
  payBase: number
  fee: number
  /** 应付（支付币种） */
  pay: number
  /** 命中档位的百分比，没命中为 0 */
  percent: number
}

/**
 * 充值报价。amount 是用户输入的支付金额：
 * - 基数 base = round2(amount × multiplier)（美元）
 * - bonus 模式：赠送 = round2(base × 百分比 / 100)，到账 = base + 赠送，实付基数 = amount
 * - discount 模式：实付基数 = round2(amount × (100 − 百分比) / 100)，到账 = base，
 *   免费部分 = base − round2(实付基数 × multiplier)
 * - 手续费 = 向上取整到分(实付基数 × feeRate / 100)，应付 = 实付基数 + 手续费
 */
export function quoteRecharge(r: StoreRecharge, amount: number): RechargeQuote {
  const base = round2(amount * r.multiplier)
  let credited = base
  let bonus = 0
  let payBase = amount
  const tier = matchTier(r.bonusTiers, amount)
  let percent = 0
  if (tier) {
    if (r.bonusMode === 'discount') {
      if (tier.bonusPercent < 100) {
        const discounted = round2((amount * (100 - tier.bonusPercent)) / 100)
        if (discounted > 0 && discounted < amount) {
          payBase = discounted
          bonus = Math.max(0, round2(base - round2(discounted * r.multiplier)))
          percent = tier.bonusPercent
        }
      }
    } else {
      const extra = round2((base * tier.bonusPercent) / 100)
      if (extra > 0) {
        bonus = extra
        credited = round2(base + extra)
        percent = tier.bonusPercent
      }
    }
  }
  const fee = r.feeRate > 0 ? roundUp2((payBase * r.feeRate) / 100) : 0
  return { credited, bonus, payBase, fee, pay: round2(payBase + fee), percent }
}

export type AmountCheck = { ok: true; value: number } | { ok: false; reason: 'empty' | 'format' | 'min' | 'max' }

/** 校验输入的金额：最多两位小数，落在 [min, max]（max 为 0 表示不限） */
export function checkAmount(input: string, r: Pick<StoreRecharge, 'min' | 'max'>): AmountCheck {
  const s = input.trim()
  if (s === '') return { ok: false, reason: 'empty' }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, reason: 'format' }
  const value = Number(s)
  if (!(value > 0)) return { ok: false, reason: 'format' }
  if (value < r.min) return { ok: false, reason: 'min' }
  if (r.max > 0 && value > r.max) return { ok: false, reason: 'max' }
  return { ok: true, value }
}

/**
 * 能否显示「预计应付」：支付币种必须是云端明确给出的，且在售套餐的币种都和它一致。
 * 对不上（或云端没给币种、只是默认值）时金额的单位拿不准，宁可不显示
 */
export function payAmountTrusted(catalog: Pick<StoreCatalog, 'currency' | 'currencyKnown' | 'plans'>): boolean {
  if (catalog.currencyKnown === false || !catalog.currency) return false
  const pay = catalog.currency.toUpperCase()
  return catalog.plans.every(p => p.currency.toUpperCase() === pay)
}

/** 判断到账用的账号快照：余额、套餐名、到期时间 */
export interface AccountSnap {
  balance: number | null
  planName: string | null
  expiresAt: string | null
}
export function snapOf(account: Pick<AccountInfo, 'balance' | 'plan'>): AccountSnap {
  return { balance: account.balance, planName: account.plan?.name ?? null, expiresAt: account.plan?.expiresAt ?? null }
}

export interface AccountChange {
  /** 余额变了（前后都读得到才算） */
  balance: { from: number; to: number } | null
  /** 套餐名变了（含新开通 / 到期失效） */
  plan: { from: string | null; to: string | null } | null
  /** 同一个套餐的到期时间变了（续费） */
  expires: { from: string | null; to: string | null } | null
}

/**
 * 刷新前后的「到账」差异；没有到账迹象时返回 null。只认增加的方向：
 * 余额变多；套餐从无到有 / 换成另一个非空套餐；同一个套餐到期时间变晚。
 * 余额被扣（会话在用）、套餐失效都不算到账
 */
export function diffAccount(before: AccountSnap, after: AccountSnap): AccountChange | null {
  const balance =
    before.balance !== null && after.balance !== null && after.balance > before.balance + 1e-9
      ? { from: before.balance, to: after.balance }
      : null
  const plan =
    after.planName !== null && before.planName !== after.planName ? { from: before.planName, to: after.planName } : null
  const from = before.expiresAt ? Date.parse(before.expiresAt) : NaN
  const to = after.expiresAt ? Date.parse(after.expiresAt) : NaN
  const expires =
    !plan && after.planName !== null && before.planName === after.planName && to > from
      ? { from: before.expiresAt, to: after.expiresAt }
      : null
  return balance || plan || expires ? { balance, plan, expires } : null
}

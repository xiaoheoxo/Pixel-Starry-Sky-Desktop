// Codex 的账号额度（docs/ui/account-quota.md §3.3）：account/rateLimits/read 的回包和 account/rateLimits/updated 的通知。
// 窗口按 windowDurationMins 认（quotaWindowId），不按 primary / secondary 的位置认；真实快照没实测过，字段缺了就不出那一项。
import {
  quotaWindowId,
  type AccountQuota,
  type QuotaCredits,
  type QuotaModelLimit,
  type QuotaResetCredits,
  type QuotaWindow,
} from '@pixelsky/protocol'
import { clampPercent, epochMs, quotaNoDataError, type AccountQuotaPatch, type QuotaReading } from '../quota'
import { object, string } from './process'

/** Codex 把主额度桶的 limitId 叫 codex（类型注释里的例子）；通知里别的桶的更新不能盖掉主桶的窗口 */
const MAIN_LIMIT_ID = 'codex'

const durationOf = (w: Record<string, unknown>): number | null => {
  const v = w.windowDurationMins
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** primary / secondary 各自按时长定 id；用量不是数字的窗口不出 */
function snapshotWindows(snapshot: Record<string, unknown>): QuotaWindow[] {
  const out: QuotaWindow[] = []
  ;[snapshot.primary, snapshot.secondary].forEach((raw, index) => {
    const w = object(raw)
    const usedPercent = clampPercent(w.usedPercent)
    if (usedPercent === null) return
    const durationMins = durationOf(w)
    out.push({ id: quotaWindowId(durationMins, index), durationMins, usedPercent, resetsAt: epochMs(w.resetsAt) })
  })
  return out
}

function modelLimits(snapshot: Record<string, unknown>, fallbackId: string): QuotaModelLimit[] {
  const name = string(snapshot.limitName) || string(snapshot.normalModelSlug) || string(snapshot.limitId) || fallbackId
  return snapshotWindows(snapshot).map(w => ({
    name,
    durationMins: w.durationMins,
    usedPercent: w.usedPercent,
    resetsAt: w.resetsAt,
  }))
}

function credits(raw: unknown): QuotaCredits | undefined {
  const c = object(raw)
  if (typeof c.hasCredits !== 'boolean' && typeof c.unlimited !== 'boolean' && c.balance === undefined) return undefined
  const balance = c.balance === null || c.balance === undefined || c.balance === '' ? NaN : Number(c.balance)
  return {
    hasCredits: c.hasCredits === true,
    unlimited: c.unlimited === true,
    balance: Number.isFinite(balance) ? balance : null,
  }
}

/**
 * 重置卡（rateLimitResetCredits，docs/ui/codex-reset-card.md）：availableCount 在 JSON 里是数字或数字字符串；
 * credits 为 null 表示只知道张数。只留 status available 的，按到期先后排（不过期的排最后）
 */
export function resetCredits(raw: unknown): QuotaResetCredits | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = object(raw)
  const count = Number(r.availableCount)
  if (!Number.isFinite(count) || count < 0) return undefined
  const list = Array.isArray(r.credits)
    ? r.credits
        .map(object)
        .filter(c => string(c.id) && (c.status === undefined || c.status === 'available'))
        .map(c => ({ id: string(c.id), expiresAt: epochMs(c.expiresAt), title: string(c.title) || null }))
        .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))
    : null
  return { available: Math.floor(count), credits: list }
}

const planOf = (v: unknown): string | null => {
  const plan = string(v)
  return plan && plan !== 'unknown' ? plan : null
}

const latestReset = (windows: readonly { resetsAt: number | null }[]): number | null =>
  windows.reduce<number | null>(
    (max, w) => (w.resetsAt !== null && (max === null || w.resetsAt > max) ? w.resetsAt : max),
    null,
  )

/** account/rateLimits/read 的回包（GetAccountRateLimitsResponse）→ 统一的读取结果；account 由调用方填 */
export function parseCodexRateLimits(res: unknown, observedAt: number): QuotaReading {
  const r = object(res)
  if (!r.rateLimits || typeof r.rateLimits !== 'object') throw quotaNoDataError()
  const snapshot = object(r.rateLimits)
  const windows = snapshotWindows(snapshot)
  const extras: AccountQuota['extras'] = {}

  const c = credits(snapshot.credits)
  if (c) extras.credits = c
  const resets = resetCredits(r.rateLimitResetCredits)
  if (resets) extras.resetCredits = resets

  // 其它额度桶（limitId 和主桶不同的）放进「其它」
  const mainId = string(snapshot.limitId) || MAIN_LIMIT_ID
  const models: QuotaModelLimit[] = []
  for (const [key, raw] of Object.entries(object(r.rateLimitsByLimitId))) {
    const bucket = object(raw)
    if ((string(bucket.limitId) || key) === mainId) continue
    models.push(...modelLimits(bucket, key))
  }
  if (models.length) extras.models = models

  // 账号整体被拒绝：rateLimitReachedType 有值，或明确 ordinaryUsageAllowed=false；null 不推断（不能从百分比推恢复）
  const reached = string(snapshot.rateLimitReachedType)
  let blocked: AccountQuota['blocked'] = null
  if (reached || r.ordinaryUsageAllowed === false)
    blocked = { kind: reached || 'usage_not_allowed', resetsAt: latestReset(windows) }
  const marked =
    reached === 'rate_limit_reached' ? windows.map(w => (w.usedPercent >= 100 ? { ...w, rejected: true } : w)) : windows

  return {
    kind: 'ok',
    plan: planOf(snapshot.planType),
    account: null,
    windows: marked,
    extras,
    blocked,
    observedAt,
  }
}

/**
 * account/rateLimits/updated 的 params.rateLimits（稀疏快照：null 字段不代表清空）→ 对快照的部分更新。
 * 只放非 null 的 primary / secondary / credits / planType；rateLimitReachedType 有值才放 blocked。
 * 和 mergeQuota 一起等价于「把稀疏更新并进最近一次读到的快照」
 */
export function codexQuotaPatch(snapshot: unknown, observedAt: number): AccountQuotaPatch {
  const s = object(snapshot)
  const patch: AccountQuotaPatch = { observedAt }
  const limitId = string(s.limitId)
  // 别的额度桶的更新：只进「其它」，不能盖掉主桶的 5 小时 / 每周
  if (limitId && limitId !== MAIN_LIMIT_ID) {
    const models = modelLimits(s, limitId)
    if (models.length) patch.models = models
    return patch
  }
  const windows = snapshotWindows(s)
  if (windows.length) patch.windows = windows
  const c = credits(s.credits)
  if (c) patch.credits = c
  const plan = planOf(s.planType)
  if (plan) patch.plan = plan
  const reached = string(s.rateLimitReachedType)
  if (reached) {
    patch.blocked = { kind: reached, resetsAt: latestReset(windows) }
    if (reached === 'rate_limit_reached' && patch.windows)
      patch.windows = patch.windows.map(w => (w.usedPercent >= 100 ? { ...w, rejected: true } : w))
  }
  return patch
}

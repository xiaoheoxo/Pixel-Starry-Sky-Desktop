// Codex 账号额度解析（docs/ui/account-quota.md §3.3、§7.1）：account/rateLimits/read 的回包和 updated 的稀疏更新
/* eslint-disable @typescript-eslint/no-explicit-any -- 读 JSON 样本，字段随意取 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AccountQuota } from '@pixelsky/protocol'
import { describe, expect, it } from 'vitest'
import { codexQuotaPatch, parseCodexRateLimits } from '../src/codex/quota'
import { mergeQuota } from '../src/quota'

const sample = (): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/codex-rate-limits.json', import.meta.url)), 'utf8'))
const NOW = 1_792_000_000_000

function ok(res: unknown) {
  const r = parseCodexRateLimits(res, NOW)
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`)
  return r
}
/** 只改主桶 */
function withSnapshot(patch: Record<string, unknown>): Record<string, any> {
  const base = sample()
  return { ...base, rateLimits: { ...base.rateLimits, ...patch } }
}

describe('parseCodexRateLimits', () => {
  it('primary 300 / secondary 10080 → five_hour / seven_day，秒 → 毫秒', () => {
    const r = ok(sample())
    expect(r.plan).toBe('plus')
    expect(r.account).toBeNull()
    expect(r.observedAt).toBe(NOW)
    expect(r.blocked).toBeNull()
    expect(r.windows).toEqual([
      { id: 'five_hour', durationMins: 300, usedPercent: 42, resetsAt: 1_792_400_400_000 },
      { id: 'seven_day', durationMins: 10_080, usedPercent: 18, resetsAt: 1_792_566_000_000 },
    ])
  })

  it('窗口按时长认：primary / secondary 位置对调，结果不变（顺序无意义）', () => {
    const base = sample()
    const swapped = withSnapshot({ primary: base.rateLimits.secondary, secondary: base.rateLimits.primary })
    const byId = (res: unknown) => Object.fromEntries(ok(res).windows.map(w => [w.id, w]))
    expect(byId(swapped)).toEqual(byId(base))
  })

  it('windowDurationMins 为 null → unknown:n；1440 → mins:1440', () => {
    const r = ok(
      withSnapshot({
        primary: { usedPercent: 10, windowDurationMins: null, resetsAt: null },
        secondary: { usedPercent: 20, windowDurationMins: null, resetsAt: 1_792_566_000 },
      }),
    )
    expect(r.windows).toEqual([
      { id: 'unknown:0', durationMins: null, usedPercent: 10, resetsAt: null },
      { id: 'unknown:1', durationMins: null, usedPercent: 20, resetsAt: 1_792_566_000_000 },
    ])
    const day = ok(
      withSnapshot({ primary: { usedPercent: 5, windowDurationMins: 1440, resetsAt: 1_792_566_000 }, secondary: null }),
    )
    expect(day.windows).toEqual([{ id: 'mins:1440', durationMins: 1440, usedPercent: 5, resetsAt: 1_792_566_000_000 }])
  })

  it('credits：字符串余额转数字，解析不了为 null', () => {
    expect(ok(sample()).extras.credits).toEqual({ hasCredits: true, unlimited: false, balance: 120 })
    expect(
      ok(withSnapshot({ credits: { hasCredits: true, unlimited: false, balance: '2,480' } })).extras.credits?.balance,
    ).toBeNull()
    expect(ok(withSnapshot({ credits: { hasCredits: false, unlimited: true, balance: null } })).extras.credits).toEqual(
      {
        hasCredits: false,
        unlimited: true,
        balance: null,
      },
    )
    expect(ok(withSnapshot({ credits: null })).extras.credits).toBeUndefined()
  })

  it("planType 'unknown' → null", () => {
    expect(ok(withSnapshot({ planType: 'unknown' })).plan).toBeNull()
    expect(ok(withSnapshot({ planType: null })).plan).toBeNull()
    expect(ok(withSnapshot({ planType: 'prolite' })).plan).toBe('prolite')
  })

  it('rateLimitReachedType 非空 → blocked（最晚的恢复时间），rate_limit_reached 时用完的窗口标 rejected', () => {
    const r = ok(
      withSnapshot({
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_792_400_400 },
        rateLimitReachedType: 'rate_limit_reached',
      }),
    )
    expect(r.blocked).toEqual({ kind: 'rate_limit_reached', resetsAt: 1_792_566_000_000 })
    expect(r.windows.find(w => w.id === 'five_hour')?.rejected).toBe(true)
    expect(r.windows.find(w => w.id === 'seven_day')?.rejected).toBeUndefined()
    const workspace = ok(withSnapshot({ rateLimitReachedType: 'workspace_member_credits_depleted' }))
    expect(workspace.blocked?.kind).toBe('workspace_member_credits_depleted')
    expect(workspace.windows.some(w => w.rejected)).toBe(false)
  })

  it('ordinaryUsageAllowed: false → blocked；null 不推断', () => {
    const blocked = ok({ ...sample(), ordinaryUsageAllowed: false })
    expect(blocked.blocked).toEqual({ kind: 'usage_not_allowed', resetsAt: 1_792_566_000_000 })
    expect(ok({ ...sample(), ordinaryUsageAllowed: null }).blocked).toBeNull()
    // 百分比到 100 也不推断
    const full = ok({
      ...withSnapshot({ primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1 } }),
      ordinaryUsageAllowed: null,
    })
    expect(full.blocked).toBeNull()
    expect(full.windows.some(w => w.rejected)).toBe(false)
  })

  it('rateLimitsByLimitId 里和主桶不同的桶 → models（名字 limitName ?? normalModelSlug ?? limitId）', () => {
    const r = ok(sample())
    expect(r.extras.models).toEqual([
      { name: 'GPT-5.3-Codex-Spark', durationMins: 300, usedPercent: 7, resetsAt: 1_792_400_400_000 },
      { name: 'GPT-5.3-Codex-Spark', durationMins: 10_080, usedPercent: 3, resetsAt: 1_792_566_000_000 },
    ])
    const base = sample()
    base.rateLimitsByLimitId.codex_spark.limitName = null
    expect(ok(base).extras.models?.[0].name).toBe('gpt-5.3-codex-spark')
    base.rateLimitsByLimitId.codex_spark.normalModelSlug = null
    expect(ok(base).extras.models?.[0].name).toBe('codex_spark')
    expect(ok({ ...sample(), rateLimitsByLimitId: null }).extras.models).toBeUndefined()
  })

  it('形状不对不崩：没有 rateLimits 抛错，字段缺失就不出', () => {
    expect(() => parseCodexRateLimits({}, NOW)).toThrow('没有拿到额度数据')
    const r = ok({ rateLimits: { primary: { usedPercent: 'many' }, secondary: 7 } })
    expect(r.windows).toEqual([])
    expect(r.extras).toEqual({})
  })
})

describe('codexQuotaPatch + mergeQuota（稀疏更新）', () => {
  const base = (): AccountQuota => {
    const r = ok(sample())
    return {
      provider: 'chatgpt',
      status: 'ok',
      plan: r.plan,
      account: 'user@example.com',
      windows: r.windows,
      extras: r.extras,
      blocked: null,
      observedAt: NOW - 1000,
      fetchedAt: NOW - 1000,
      source: 'usage',
      refreshable: true,
      error: null,
    }
  }
  const snapshot = (patch: Record<string, unknown>) => ({
    limitId: 'codex',
    primary: null,
    secondary: null,
    credits: null,
    planType: null,
    rateLimitReachedType: null,
    ...patch,
  })

  it('只带 secondary 的更新保留 primary', () => {
    const patch = codexQuotaPatch(
      snapshot({ secondary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: 1_792_566_000 } }),
      NOW,
    )
    expect(patch.windows).toEqual([
      { id: 'seven_day', durationMins: 10_080, usedPercent: 30, resetsAt: 1_792_566_000_000 },
    ])
    const merged = mergeQuota(base(), patch)
    expect(merged.windows.find(w => w.id === 'five_hour')?.usedPercent).toBe(42)
    expect(merged.windows.find(w => w.id === 'seven_day')?.usedPercent).toBe(30)
    expect(merged.source).toBe('event')
    expect(merged.observedAt).toBe(NOW)
    expect(merged.fetchedAt).toBe(NOW - 1000)
  })

  it('credits: null 保留旧点数，planType: null 保留旧套餐', () => {
    const merged = mergeQuota(base(), codexQuotaPatch(snapshot({}), NOW))
    expect(merged.extras.credits).toEqual({ hasCredits: true, unlimited: false, balance: 120 })
    expect(merged.plan).toBe('plus')
    const changed = mergeQuota(
      base(),
      codexQuotaPatch(
        snapshot({ credits: { hasCredits: true, unlimited: false, balance: '99' }, planType: 'pro' }),
        NOW,
      ),
    )
    expect(changed.extras.credits?.balance).toBe(99)
    expect(changed.plan).toBe('pro')
  })

  it('rateLimitReachedType 为 null 视为没带，不清已有的 blocked；有值才放 blocked', () => {
    const blocked = mergeQuota(
      base(),
      codexQuotaPatch(
        snapshot({
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_792_400_400 },
          rateLimitReachedType: 'rate_limit_reached',
        }),
        NOW,
      ),
    )
    expect(blocked.blocked).toEqual({ kind: 'rate_limit_reached', resetsAt: 1_792_400_400_000 })
    expect(blocked.windows.find(w => w.id === 'five_hour')?.rejected).toBe(true)
    const still = mergeQuota(blocked, codexQuotaPatch(snapshot({ credits: null }), NOW))
    expect(still.blocked).not.toBeNull()
  })

  it('别的额度桶的更新只进 models，不盖掉主桶的窗口', () => {
    const patch = codexQuotaPatch(
      {
        limitId: 'codex_other',
        limitName: 'Other',
        primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1_792_400_400 },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        planType: 'pro',
      },
      NOW,
    )
    expect(patch.windows).toBeUndefined()
    expect(patch.credits).toBeUndefined()
    expect(patch.plan).toBeUndefined()
    const merged = mergeQuota(base(), patch)
    expect(merged.windows.find(w => w.id === 'five_hour')?.usedPercent).toBe(42)
    expect(merged.extras.models?.some(m => m.name === 'Other' && m.usedPercent === 90)).toBe(true)
  })
})

describe('重置卡（docs/ui/codex-reset-card.md）', () => {
  const withResets = (resets: unknown) => ({ ...sample(), rateLimitResetCredits: resets })

  it('只留 available 的，按到期先后排，不过期的排最后；秒 → 毫秒', () => {
    const r = ok(
      withResets({
        availableCount: '3',
        credits: [
          { id: 'b', status: 'available', expiresAt: null, title: null },
          { id: 'a', status: 'available', expiresAt: 1_792_500_000, title: '活动赠送' },
          { id: 'x', status: 'redeemed', expiresAt: 1_792_100_000 },
          { id: 'c', status: 'available', expiresAt: 1_792_300_000 },
        ],
      }),
    )
    expect(r.extras.resetCredits).toEqual({
      available: 3,
      credits: [
        { id: 'c', expiresAt: 1_792_300_000_000, title: null },
        { id: 'a', expiresAt: 1_792_500_000_000, title: '活动赠送' },
        { id: 'b', expiresAt: null, title: null },
      ],
    })
  })

  it('只有张数时 credits 为 null；没有这一项、张数不是数字时不出', () => {
    expect(ok(withResets({ availableCount: 2, credits: null })).extras.resetCredits).toEqual({
      available: 2,
      credits: null,
    })
    expect(ok(sample()).extras.resetCredits).toBeUndefined()
    expect(ok(withResets({ availableCount: 'x', credits: [] })).extras.resetCredits).toBeUndefined()
  })
})

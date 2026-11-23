// 账号额度的公共纯函数（docs/ui/account-quota.md §3.1、§7.1）：mergeQuota、classifyQuotaError、clampPercent、epochMs
import type { AccountQuota } from '@pixelsky/protocol'
import { describe, expect, it } from 'vitest'
import { classifyQuotaError, clampPercent, epochMs, mergeQuota } from '../src/quota'

function quota(patch: Partial<AccountQuota> = {}): AccountQuota {
  return {
    provider: 'claude',
    status: 'empty',
    plan: null,
    account: 'user@example.com',
    windows: [],
    extras: {},
    blocked: null,
    observedAt: null,
    fetchedAt: null,
    source: 'usage',
    refreshable: true,
    error: null,
    ...patch,
  }
}
const five = (usedPercent: number, extra: object = {}) => ({
  id: 'five_hour',
  durationMins: 300,
  usedPercent,
  resetsAt: 1_000,
  ...extra,
})
const week = (usedPercent: number, extra: object = {}) => ({
  id: 'seven_day',
  durationMins: 10_080,
  usedPercent,
  resetsAt: 2_000,
  ...extra,
})

describe('clampPercent / epochMs', () => {
  it('clampPercent：只认数字，按尺度换成 0–100 并截断', () => {
    expect(clampPercent(42)).toBe(42)
    expect(clampPercent(120)).toBe(100)
    expect(clampPercent(-1)).toBe(0)
    expect(clampPercent(0.03, 1)).toBe(3)
    expect(clampPercent(0.67, 1)).toBe(67)
    expect(clampPercent(1.5, 1)).toBe(100)
    expect(clampPercent('42')).toBeNull()
    expect(clampPercent(null)).toBeNull()
    expect(clampPercent(Number.NaN)).toBeNull()
    expect(clampPercent(Infinity)).toBeNull()
  })

  it('epochMs：秒 / 毫秒数字、ISO 字符串；其它为 null', () => {
    expect(epochMs(1_792_400_400)).toBe(1_792_400_400_000)
    expect(epochMs(1_792_400_400_000)).toBe(1_792_400_400_000)
    expect(epochMs('2026-10-19T08:59:59Z')).toBe(Date.parse('2026-10-19T08:59:59Z'))
    expect(epochMs('2026-10-19T08:59:59.917005+00:00')).toBe(Date.parse('2026-10-19T08:59:59.917Z'))
    expect(epochMs('soon')).toBeNull()
    expect(epochMs('')).toBeNull()
    expect(epochMs(0)).toBeNull()
    expect(epochMs(null)).toBeNull()
    expect(epochMs(Number.NaN)).toBeNull()
  })
})

describe('mergeQuota', () => {
  it('windows 按 id 合并：新的覆盖同 id，旧的其它窗口保留', () => {
    const merged = mergeQuota(quota({ windows: [five(10), week(20)] }), { windows: [five(15)], observedAt: 5 })
    expect(merged.windows).toEqual([five(15), week(20)])
    expect(mergeQuota(quota({ windows: [five(10)] }), { windows: [week(20)], observedAt: 5 }).windows).toEqual([
      five(10),
      week(20),
    ])
  })

  it('models 按 name + durationMins 合并', () => {
    const m = (name: string, durationMins: number | null, usedPercent: number) => ({
      name,
      durationMins,
      usedPercent,
      resetsAt: null,
    })
    const merged = mergeQuota(quota({ extras: { models: [m('Opus', 10_080, 10), m('Opus', 300, 5)] } }), {
      models: [m('Opus', 10_080, 60), m('Sonnet', 10_080, 1)],
      observedAt: 5,
    })
    expect(merged.extras.models).toEqual([m('Opus', 10_080, 60), m('Opus', 300, 5), m('Sonnet', 10_080, 1)])
  })

  it('credits、plan 有就换；blocked 不是 undefined 就换（null 清掉）', () => {
    const base = quota({
      plan: 'plus',
      extras: { credits: { hasCredits: true, unlimited: false, balance: 1 } },
      blocked: { kind: 'x', resetsAt: null },
    })
    expect(mergeQuota(base, { observedAt: 5 })).toMatchObject({ plan: 'plus', blocked: { kind: 'x', resetsAt: null } })
    const next = mergeQuota(base, {
      plan: 'pro',
      credits: { hasCredits: false, unlimited: true, balance: null },
      blocked: null,
      observedAt: 5,
    })
    expect(next.plan).toBe('pro')
    expect(next.extras.credits).toEqual({ hasCredits: false, unlimited: true, balance: null })
    expect(next.blocked).toBeNull()
  })

  it('allowed 清掉所有 rejected（窗口和分模型），新带来的窗口自己说了算', () => {
    const base = quota({
      windows: [five(100, { rejected: true }), week(100, { rejected: true })],
      extras: { models: [{ name: 'Opus', durationMins: 10_080, usedPercent: 100, resetsAt: null, rejected: true }] },
    })
    const merged = mergeQuota(base, { allowed: true, windows: [five(2)], observedAt: 5 })
    expect(merged.windows).toEqual([five(2), week(100)])
    expect(merged.extras.models?.[0].rejected).toBeUndefined()
    // 不带 allowed 就保留
    expect(mergeQuota(base, { observedAt: 5 }).windows.every(w => w.rejected)).toBe(true)
  })

  it('overage 写到 extraUsage.inUse，没有时建一个', () => {
    const created = mergeQuota(quota(), { overage: true, observedAt: 5 })
    expect(created.extras.extraUsage).toEqual({
      enabled: true,
      used: null,
      limit: null,
      currency: null,
      usedPercent: null,
      inUse: true,
    })
    const kept = mergeQuota(
      quota({
        extras: { extraUsage: { enabled: true, used: 1, limit: 5, currency: 'USD', usedPercent: 20, inUse: true } },
      }),
      { overage: false, observedAt: 5 },
    )
    expect(kept.extras.extraUsage).toMatchObject({ used: 1, limit: 5, inUse: false })
  })

  it('overage 为 false 且没有 extraUsage：不新建（每条 rate_limit_event 都带 isUsingOverage:false）', () => {
    const merged = mergeQuota(quota(), { overage: false, windows: [five(3)], observedAt: 5 })
    expect(merged.extras.extraUsage).toBeUndefined()
    expect(merged.windows).toEqual([five(3)])
    // 只有 overage:false 的事件也不会凭空变成 ok
    expect(mergeQuota(quota(), { overage: false, observedAt: 5 }).status).toBe('empty')
  })

  it('unsupported 的账号不接收事件合并：状态不翻成 ok，数据不动', () => {
    const base = quota({ status: 'unsupported' })
    const merged = mergeQuota(base, { windows: [five(3)], allowed: true, overage: true, observedAt: 5 })
    expect(merged).toBe(base)
    expect(merged.windows).toEqual([])
  })

  it('observedAt 取新的，source 记 event，有数据 status 变 ok，fetchedAt / refreshable 不动', () => {
    const merged = mergeQuota(quota({ fetchedAt: 100, refreshable: false, observedAt: 100 }), {
      windows: [five(1)],
      observedAt: 500,
    })
    expect(merged).toMatchObject({ status: 'ok', source: 'event', observedAt: 500, fetchedAt: 100, refreshable: false })
  })

  it('没有数据的更新不会把 empty 变 ok；有数据时清掉旧的错误', () => {
    expect(mergeQuota(quota(), { allowed: true, observedAt: 5 }).status).toBe('empty')
    const errored = quota({
      status: 'error',
      windows: [five(1)],
      error: { code: 'failed', message: '读取额度失败：x' },
    })
    const merged = mergeQuota(errored, { windows: [five(2)], observedAt: 5 })
    expect(merged.status).toBe('ok')
    expect(merged.error).toBeNull()
  })

  it('不改传入的快照', () => {
    const base = quota({ windows: [five(10, { rejected: true })] })
    const copy = JSON.parse(JSON.stringify(base))
    mergeQuota(base, { allowed: true, windows: [five(1)], overage: true, observedAt: 5 })
    expect(base).toEqual(copy)
  })
})

describe('classifyQuotaError', () => {
  it('没有回应 / timeout → timeout', () => {
    expect(classifyQuotaError(new Error('Claude Code 没有回应 get_usage'), 'claude.ai')).toEqual({
      code: 'timeout',
      message: '读取额度超时',
    })
    expect(classifyQuotaError(new Error('Codex did not respond'), 'chatgpt.com').code).toBe('timeout')
    expect(classifyQuotaError(new Error('request timeout'), 'chatgpt.com').code).toBe('timeout')
  })

  it('网络类 → network，带上主机名', () => {
    for (const text of [
      'ECONNRESET',
      'getaddrinfo ENOTFOUND claude.ai',
      'ETIMEDOUT',
      'network error',
      'fetch failed',
      'socket hang up',
    ])
      expect(classifyQuotaError(new Error(text), 'claude.ai')).toEqual({ code: 'network', message: '连不上 claude.ai' })
    expect(classifyQuotaError(new Error('fetch failed'), 'chatgpt.com').message).toBe('连不上 chatgpt.com')
  })

  it('进程已退出 / 引擎不可用 → engine-unavailable，带上引擎名', () => {
    expect(classifyQuotaError(new Error('Claude Code 进程已退出'), 'claude.ai')).toEqual({
      code: 'engine-unavailable',
      message: 'Claude Code 现在不可用',
    })
    expect(classifyQuotaError(new Error('Codex process exited'), 'chatgpt.com')).toEqual({
      code: 'engine-unavailable',
      message: 'Codex 现在不可用',
    })
    expect(classifyQuotaError(new Error('引擎不可用'), 'chatgpt.com').code).toBe('engine-unavailable')
  })

  it('其它 → failed，原因截到 200 字；没拿到数据的原文不加前缀', () => {
    expect(classifyQuotaError(new Error('boom'), 'claude.ai')).toEqual({
      code: 'failed',
      message: '读取额度失败：boom',
    })
    expect(classifyQuotaError(new Error('x'.repeat(500)), 'claude.ai').message).toBe(`读取额度失败：${'x'.repeat(200)}`)
    expect(classifyQuotaError('plain string', 'claude.ai').message).toBe('读取额度失败：plain string')
    expect(classifyQuotaError(new Error('没有拿到额度数据'), 'claude.ai')).toEqual({
      code: 'failed',
      message: '没有拿到额度数据',
    })
  })
})

it('does not update the weekly sample time on five-hour or status-only events', () => {
  const initial = quota({ windows: [five(20), week(42)], source: 'usage', observedAt: 10 })
  const partial = mergeQuota(initial, { observedAt: 20, windows: [five(22)] })
  expect(partial.windowObservedAt).toEqual({ five_hour: 20, seven_day: 10 })
  const allowed = mergeQuota(partial, { observedAt: 30, allowed: true })
  expect(allowed.windowObservedAt).toEqual({ five_hour: 20, seven_day: 10 })
  const current = mergeQuota(allowed, { observedAt: 40, windows: [week(45)] })
  const late = mergeQuota(current, { observedAt: 35, windows: [week(21)] })
  expect(late.windowObservedAt).toEqual({ five_hour: 20, seven_day: 40 })
  expect(late.windows).toEqual([five(22), week(45)])
})

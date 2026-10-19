import { describe, it, expect, vi } from 'vitest'
import type { EngineAccountUsage } from '@pixelsky/protocol'
import { AccountUsageCache } from '../src/account-usage'
import { claudeAccountUsage, claudeUsageEvent } from '../src/claude/account-usage'
import { codexAccountUsage } from '../src/codex/account-usage'

describe('原生账号限额归一化', () => {
  it('Codex 按周期识别窗口，缺失 primary 时只显示周额，保留有效 0%', () => {
    const usage = codexAccountUsage({
      rateLimits: { primary: null, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1800000000 } },
    })
    expect(usage.status).toBe('ready')
    expect(usage.windows).toEqual([
      { id: 'default:secondary', kind: 'weekly', usedPercent: 0, resetsAt: 1800000000000, windowMinutes: 10080 },
    ])
  })
  it('不根据主窗口的位置猜测 5h；多额度桶按实际返回展示', () => {
    const usage = codexAccountUsage({
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          limitName: 'Codex',
          primary: { usedPercent: 32.5, windowDurationMins: 300, resetsAt: 1800000000 },
          secondary: null,
        },
        review: { limitName: 'Review', primary: { usedPercent: 125, windowDurationMins: 60, resetsAt: null } },
      },
    })
    expect(usage.windows.map(w => [w.kind, w.usedPercent])).toEqual([
      ['five_hour', 32.5],
      ['other', 125],
    ])
    expect(codexAccountUsage({ rateLimits: { primary: { usedPercent: 5 } } }).windows[0].kind).toBe('other')
  })
  it('单桶推送保留其他桶及账号信息，空窗口可以删除原来的 5h', () => {
    const previous = {
      ...codexAccountUsage({
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 10, windowDurationMins: 300 } },
          review: { secondary: { usedPercent: 20, windowDurationMins: 10080 } },
        },
      }),
      account: 'user@example.com',
    }
    const next = codexAccountUsage(
      { rateLimits: { limitId: 'codex', primary: null, secondary: { usedPercent: 30, windowDurationMins: 10080 } } },
      previous,
    )
    expect(next.windows.map(w => w.id)).toEqual(['review:secondary', 'codex:secondary'])
    expect(next.account).toBe('user@example.com')
  })
  it('Claude 使用百分比和 ISO 重置时间，无 5h 时不合成一行', () => {
    const usage = claudeAccountUsage({
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: {
        five_hour: null,
        seven_day: { utilization: 72, resets_at: '2026-10-22T10:12:00Z' },
        seven_day_opus: { utilization: null, resets_at: null },
      },
    })
    expect(usage.status).toBe('ready')
    expect(usage.plan).toBe('pro')
    expect(usage.windows.map(w => [w.kind, w.label, w.usedPercent])).toEqual([
      ['weekly', undefined, 72],
      ['weekly', 'Opus', null],
    ])
    expect(usage.windows[0].resetsAt).toBe(Date.parse('2026-10-22T10:12:00Z'))
  })
  it('区分无额度数据、空窗口、格式错误和未知数字', () => {
    expect(claudeAccountUsage({ rate_limits_available: false, rate_limits: null }).status).toBe('unavailable')
    expect(claudeAccountUsage({ rate_limits: {} })).toMatchObject({ status: 'ready', windows: [] })
    expect(claudeAccountUsage({}).status).toBe('error')
    expect(codexAccountUsage({}).status).toBe('error')
    expect(codexAccountUsage({ rateLimits: null }).status).toBe('unavailable')
    expect(
      claudeAccountUsage({ rate_limits: { five_hour: { utilization: '50', resets_at: 'bad' } } }).windows[0],
    ).toMatchObject({ usedPercent: null, resetsAt: null })
  })
  it('Claude 单窗口事件按比例转换，合并完整查询，首次事件标记为部分数据', () => {
    const event = { rateLimitType: 'five_hour', utilization: 0.91, resetsAt: 1800000000 }
    expect(claudeUsageEvent(event, null)).toMatchObject({
      partial: true,
      windows: [{ usedPercent: 91, resetsAt: 1800000000000 }],
    })
    const previous = claudeAccountUsage({ rate_limits: { seven_day: { utilization: 30, resets_at: null } } })
    const next = claudeUsageEvent(event, previous)!
    expect(next.partial).toBeUndefined()
    expect(next.windows.map(w => w.usedPercent)).toEqual([91, 30])
    expect(claudeUsageEvent({ ...event, utilization: 0.92 }, next)!.windows.map(w => w.usedPercent)).toEqual([92, 30])
    expect(claudeUsageEvent({ rateLimitType: 'overage' }, previous)).toBeNull()
  })
})

describe('账号额度缓存', () => {
  const value = (): EngineAccountUsage => ({ status: 'ready', windows: [], observedAt: Date.now() })
  it('并发查询合并，手动刷新绕过缓存，切换账号或配置不复用旧值', async () => {
    const cache = new AccountUsageCache(),
      fetch = vi.fn(async () => value())
    await Promise.all([cache.read('a', fetch), cache.read('a', fetch)])
    await cache.read('a', fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    await cache.read('a', fetch, true)
    await cache.read('b', fetch)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('旧账号晚到的查询不覆盖新账号，也不广播旧数据', async () => {
    const notify = vi.fn(),
      cache = new AccountUsageCache(notify)
    let resolve!: (v: EngineAccountUsage) => void
    const old = cache.read(
      'old',
      () =>
        new Promise(r => {
          resolve = r
        }),
    )
    const current = await cache.read('new', async () => ({ ...value(), plan: 'new' }))
    resolve({ ...value(), plan: 'old' })
    await old
    expect(cache.peek('new')).toBe(current)
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('先到的新事件不会被较早发出的查询覆盖；部分数据不阻止完整查询', async () => {
    const cache = new AccountUsageCache()
    let resolve!: (v: EngineAccountUsage) => void
    const pending = cache.read(
      'a',
      () =>
        new Promise(r => {
          resolve = r
        }),
    )
    cache.push('a', { ...value(), partial: true, plan: 'event' })
    resolve({ ...value(), plan: 'old' })
    expect((await pending).plan).toBe('event')
    const fetch = vi.fn(async () => ({ ...value(), plan: 'full' }))
    expect((await cache.read('a', fetch)).plan).toBe('full')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

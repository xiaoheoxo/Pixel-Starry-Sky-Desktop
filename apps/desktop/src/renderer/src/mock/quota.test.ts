import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountQuota } from '@pixelsky/protocol'
import { platformQuota } from '../features/session/quota/platformQuota'
import { quotaButtonView } from '../features/session/quota/quotaModel'
import { demoAccount } from './account'
import { demoQuota } from './quota'

// 演示模式的额度数据（docs/ui/account-quota.md §6.12）：数字照样稿，按钮和存储在演示里的表现。
const NOW = new Date(2026, 9, 19, 14, 32).getTime()

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('演示数据', () => {
  const claude = demoQuota(NOW).claude
  const chatgpt = demoQuota(NOW).chatgpt
  const text = (q: AccountQuota, provider: 'claude' | 'chatgpt' | 'platform' = q.provider) => {
    const v = quotaButtonView(q, { provider, loading: false, now: NOW })
    return [v.short, v.value].filter(Boolean).join(' ')
  }
  it('Claude：5 小时 42%、本周 18%、本周 Opus 61%、额外用量 $12.40 / $50；按钮「周 61%」', () => {
    expect(claude).toMatchObject({ plan: 'max_20x', account: 'linxia@example.com', source: 'demo' })
    expect(claude.windows.map(w => [w.durationMins, w.usedPercent])).toEqual([
      [300, 42],
      [10_080, 18],
    ])
    expect(claude.extras.models?.[0]).toMatchObject({ name: 'Opus', usedPercent: 61 })
    expect(claude.extras.extraUsage).toMatchObject({ used: 12.4, limit: 50 })
    expect(text(claude)).toBe('周 61%')
  })
  it('恢复时间按现在往后算（2 小时 13 分后）', () => {
    expect(claude.windows[0].resetsAt! - NOW).toBe((2 * 60 + 13) * 60_000)
  })
  it('ChatGPT：5 小时 27%、本周 54%、点数剩余 120；按钮「周 54%」', () => {
    expect(chatgpt).toMatchObject({ plan: 'plus', source: 'demo' })
    expect(chatgpt.extras.credits).toEqual({ hasCredits: true, unlimited: false, balance: 120 })
    expect(text(chatgpt)).toBe('周 54%')
  })
  it('平台：演示账号的 5h $0.50 / $2 → 「5h 25%」', () => {
    expect(text(platformQuota(demoAccount)!, 'platform')).toBe('5h 25%')
  })
})

describe('存储（演示模式）', () => {
  it('不碰桥，用演示数据；刷新等一会儿后把更新时间改成现在', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const refresh = vi.fn()
    vi.stubGlobal('window', { pixelsky: { demo: true, quota: { get: refresh, refresh, onChange: refresh } } })
    const { installDemo } = await import('@/data/demo')
    installDemo({ quota: demoQuota(NOW) } as never)
    const store = await import('../features/session/quota/quotaStore')
    expect(store.getQuota('claude')?.source).toBe('demo')
    expect(store.getQuota('chatgpt')?.plan).toBe('plus')
    vi.setSystemTime(NOW + 5 * 60_000)
    const done = store.refreshQuota('claude', { force: true })
    await vi.advanceTimersByTimeAsync(700)
    await expect(done).resolves.toBe(true)
    expect(store.getQuota('claude')?.observedAt).toBe(NOW + 5 * 60_000 + 600)
    await store.ensureQuota('claude')
    expect(refresh).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountRefreshResult } from '../../../../shared/types/account'
import {
  BASELINE_TIMEOUT_MS,
  PaymentWatch,
  WATCH_DURATION_MS,
  WATCH_INTERVAL_MS,
  baselineBeforeOpen,
} from './paymentWatch'

// 付款后的到账检测：打开支付页前定基准；之后前 2 分钟每 15 秒自动刷新，变化即停；手动刷新给出对比、暂未到账或错误。

const account = (balance: number | null, planName: string | null = null) => ({
  balance,
  plan: planName ? { name: planName, expiresAt: null, daily: null, weekly: null, monthly: null } : null,
})
const ok = (balance: number | null, planName: string | null = null): AccountRefreshResult => ({
  error: null,
  account: {
    email: 'a@b.c',
    name: 'a',
    currency: 'USD',
    group: null,
    rateLimits: [],
    updatedAt: 1,
    ...account(balance, planName),
  },
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** 依次返回 results（最后一个一直重复）；Error 表示刷新函数本身抛错 */
function make(results: Array<AccountRefreshResult | Error>) {
  const queue = [...results]
  const refresh = vi.fn(async (): Promise<AccountRefreshResult> => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if (next instanceof Error) throw next
    return next
  })
  return { refresh, watch: new PaymentWatch(refresh) }
}

describe('自动轮询', () => {
  it('每 15 秒刷新一次，2 分钟共 8 次后自己停', async () => {
    const { watch, refresh } = make([ok(10)])
    watch.begin(account(10))
    expect(watch.getState().watching).toBe(true)
    expect(refresh).not.toHaveBeenCalled() // 基准是打开前定的，begin 自己不刷新
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS - 1)
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(WATCH_DURATION_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(WATCH_DURATION_MS / WATCH_INTERVAL_MS)
    // 2 分钟没到账：留下「暂未到账」，不让提示消失
    expect(watch.getState()).toMatchObject({ watching: false, outcome: { kind: 'pending' }, error: null })
  })

  it('余额变了就报到账并停止轮询', async () => {
    const { watch, refresh } = make([ok(10), ok(10), ok(35)])
    watch.begin(account(10))
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS * 5)
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(watch.getState()).toMatchObject({
      watching: false,
      outcome: { kind: 'arrived', change: { balance: { from: 10, to: 35 } } },
    })
  })

  it('自动刷新失败不打扰界面，下一次照常', async () => {
    const { watch } = make([{ error: '网络错误：x', account: null }, ok(10, 'Pro')])
    watch.begin(account(10))
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(watch.getState().error).toBeNull()
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(watch.getState().outcome).toMatchObject({ kind: 'arrived', change: { plan: { from: null, to: 'Pro' } } })
  })

  it('stop（离开商店页）后不再刷新', async () => {
    const { watch, refresh } = make([ok(10)])
    watch.begin(account(10))
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS) // 第一次轮询
    watch.stop()
    await vi.advanceTimersByTimeAsync(WATCH_DURATION_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(watch.getState().watching).toBe(false)
  })

  it('stop 时在途的结果作废', async () => {
    let release!: (r: AccountRefreshResult) => void
    const refresh = vi.fn(() => new Promise<AccountRefreshResult>(resolve => (release = resolve)))
    const watch = new PaymentWatch(refresh)
    watch.begin(account(10))
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    watch.stop()
    release(ok(99))
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.getState().outcome).toBeNull()
  })

  it('再次打开支付页：重新以当前余额为基准、重新计时', async () => {
    const { watch, refresh } = make([ok(10)])
    watch.begin(account(10))
    await vi.advanceTimersByTimeAsync(WATCH_DURATION_MS)
    expect(watch.getState().watching).toBe(false)
    watch.begin(account(10))
    expect(watch.getState().watching).toBe(true)
    const before = refresh.mock.calls.length
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(refresh.mock.calls.length).toBe(before + 1)
  })
})

describe('打开前定基准（baselineBeforeOpen）', () => {
  it('打开支付页前就已入账（缓存 $10、服务端 $35）：$35 是基准，不报到账；之后涨到 $60 报 $35 → $60', async () => {
    const { watch, refresh } = make([ok(35), ok(35), ok(60)])
    const baseline = await baselineBeforeOpen(refresh, account(10))
    expect(baseline.balance).toBe(35)
    watch.begin(baseline)
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ watching: true, outcome: null })
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({
      watching: false,
      outcome: { kind: 'arrived', change: { balance: { from: 35, to: 60 } } },
    })
  })
  it('打开后很快就到账：第一次检查就报到账', async () => {
    const { watch, refresh } = make([ok(10), ok(35)])
    watch.begin(await baselineBeforeOpen(refresh, account(10)))
    await watch.manual()
    expect(watch.getState().outcome).toMatchObject({ kind: 'arrived', change: { balance: { from: 10, to: 35 } } })
  })
  it('缓存是旧的、实际已被会话扣到 $5：以 $5 为基准，之后继续扣费不算到账', async () => {
    const { watch, refresh } = make([ok(5), ok(4.98)])
    watch.begin(await baselineBeforeOpen(refresh, account(10)))
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ watching: true, outcome: null })
  })
  it('刷新失败：用缓存当基准，余额减少不算、增加才算', async () => {
    const { watch, refresh } = make([{ error: '网络错误：x', account: null }, ok(9.98), ok(30)])
    watch.begin(await baselineBeforeOpen(refresh, account(10)))
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(watch.getState().outcome).toBeNull()
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(watch.getState().outcome).toMatchObject({ kind: 'arrived', change: { balance: { from: 10, to: 30 } } })
  })
  it('刷新函数抛错：用缓存', async () => {
    const { refresh } = make([new Error('boom')])
    expect((await baselineBeforeOpen(refresh, account(10))).balance).toBe(10)
  })
  it('刷新一直不回：最多等 5 秒，超时用缓存', async () => {
    const refresh = vi.fn(() => new Promise<AccountRefreshResult>(() => undefined))
    const pending = baselineBeforeOpen(refresh, account(10))
    let settled: number | null | undefined
    void pending.then(b => (settled = b.balance))
    await vi.advanceTimersByTimeAsync(BASELINE_TIMEOUT_MS - 1)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(10)
  })
  it('套餐失效不算到账', async () => {
    const { watch, refresh } = make([ok(10, 'Pro'), ok(10, null)])
    watch.begin(await baselineBeforeOpen(refresh, account(10, 'Pro')))
    await vi.advanceTimersByTimeAsync(WATCH_INTERVAL_MS)
    expect(watch.getState().outcome).toBeNull()
  })
})

describe('手动刷新', () => {
  it('没变化：暂未到账', async () => {
    const { watch } = make([ok(10)])
    watch.begin(account(10))
    await watch.manual()
    expect(watch.getState()).toMatchObject({ refreshing: false, outcome: { kind: 'pending' }, error: null })
  })

  it('有变化：前后对比；之后再点不会把到账结果换成暂未到账', async () => {
    const { watch } = make([ok(35), ok(10)])
    watch.begin(account(10))
    await watch.manual()
    expect(watch.getState().outcome).toMatchObject({ kind: 'arrived', change: { balance: { from: 10, to: 35 } } })
    await watch.manual()
    expect(watch.getState().outcome?.kind).toBe('arrived')
  })

  it('刷新失败：显示错误，不报暂未到账；下次成功后错误清掉', async () => {
    const { watch } = make([{ error: '网络错误：offline', account: null }, ok(10)])
    watch.begin(account(10))
    await watch.manual()
    expect(watch.getState()).toMatchObject({ error: '网络错误：offline', outcome: null, refreshing: false })
    await watch.manual()
    expect(watch.getState()).toMatchObject({ error: null, outcome: { kind: 'pending' } })
  })

  it('刷新函数本身抛错也按失败显示', async () => {
    const { watch } = make([new Error('boom')])
    watch.begin(account(10))
    await watch.manual()
    expect(watch.getState().error).toBe('boom')
  })

  it('进行中不重复触发；订阅者收到通知', async () => {
    const { watch, refresh } = make([ok(10)])
    const seen = vi.fn()
    watch.subscribe(seen)
    watch.begin(account(10))
    const first = watch.manual()
    void watch.manual()
    await first
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalled()
  })
})

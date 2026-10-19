import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckoutOrder, CheckoutStatus } from '../../../../../shared/types/account'
import {
  EXPIRED_INTERVAL_MS,
  FAST_DURATION_MS,
  FAST_INTERVAL_MS,
  HIDDEN_INTERVAL_MS,
  MAX_FAILURES,
  OrderWatch,
  PAID_FAST_DURATION_MS,
  PAID_INTERVAL_MS,
  SLOW_INTERVAL_MS,
} from './orderWatch'

// 订单轮询的节奏（docs/ui/in-app-payment.md §6.4）：3 秒 → 10 秒；窗口不在前台 30 秒、回到前台马上查；
// 已付款 2 秒；到期时再查一次，到期后 10 分钟内每 30 秒再查（过期后才付的钱）；终态就停；连续 5 次失败才报错；
// 在途时跳过这一拍（不排 0 毫秒的定时器）；关闭后在途结果作废。

const T0 = Date.parse('2026-10-18T03:00:00Z')
const MIN = 60_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => vi.useRealTimers())

/** 一笔订单；server_time 取「现在」（假时钟），expires_at 默认 30 分钟后 */
function order(status: CheckoutStatus = 'pending', over: Partial<CheckoutOrder> = {}): CheckoutOrder {
  return {
    orderId: 1234,
    kind: 'balance',
    status,
    method: 'alipay',
    methodLabel: '支付宝',
    payAmount: 122.4,
    payCurrency: 'CNY',
    feeRate: 2,
    credited: 126,
    bonus: 6,
    plan: null,
    qrContent: status === 'pending' ? 'https://qr.example.com/x' : null,
    qrSource: status === 'pending' ? 'provider' : null,
    payUrl: null,
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 30 * MIN).toISOString(),
    paidAt: null,
    completedAt: null,
    serverTime: new Date(Date.now()).toISOString(),
    reused: false,
    ...over,
  }
}

/** 每次都返回「现在」的订单（server_time 跟着假时钟走）；statuses 依次用完后一直重复最后一个 */
function make(statuses: Array<CheckoutStatus | Error> = ['pending'], over: Partial<CheckoutOrder> = {}) {
  const queue = [...statuses]
  const fetch = vi.fn(async (): Promise<CheckoutOrder> => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if (next instanceof Error) throw next
    return order(next, over)
  })
  let foreground = true
  const watch = new OrderWatch({ fetch, foreground: () => foreground })
  return {
    watch,
    fetch,
    setForeground: (v: boolean) => {
      foreground = v
    },
  }
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('等待付款的节奏', () => {
  it('二维码出现后前 2 分钟每 3 秒查一次', async () => {
    const { watch, fetch } = make()
    watch.start(order())
    expect(fetch).not.toHaveBeenCalled() // start 自己不查：二维码刚出来
    await tick(FAST_INTERVAL_MS - 1)
    expect(fetch).not.toHaveBeenCalled()
    await tick(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await tick(FAST_DURATION_MS - FAST_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(FAST_DURATION_MS / FAST_INTERVAL_MS) // 3 秒 × 40
  })

  it('2 分钟之后改成每 10 秒', async () => {
    const { watch, fetch } = make()
    watch.start(order())
    await tick(FAST_DURATION_MS)
    const before = fetch.mock.calls.length
    await tick(SLOW_INTERVAL_MS * 3)
    expect(fetch.mock.calls.length - before).toBe(3)
    await tick(SLOW_INTERVAL_MS - 1)
    expect(fetch.mock.calls.length - before).toBe(3)
  })

  it('窗口不在前台：30 秒查一次；回到前台马上查一次', async () => {
    const { watch, fetch, setForeground } = make()
    watch.start(order())
    setForeground(false)
    watch.foregroundChanged() // 重新排节奏：现在是后台
    await tick(HIDDEN_INTERVAL_MS - 1)
    expect(fetch).not.toHaveBeenCalled()
    await tick(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await tick(HIDDEN_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)

    setForeground(true)
    watch.foregroundChanged()
    expect(fetch).toHaveBeenCalledTimes(3) // 马上
    await tick(FAST_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(4) // 之后回到 3 秒（还在前 2 分钟内）
  })

  it('进了后台，下一拍从 3 秒改成 30 秒', async () => {
    const { watch, fetch, setForeground } = make()
    watch.start(order())
    await tick(FAST_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(1)
    setForeground(false)
    watch.foregroundChanged()
    await tick(HIDDEN_INTERVAL_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await tick(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('已付款之后', () => {
  it('每 2 秒查一次，直到到账；到账后停', async () => {
    const { watch, fetch } = make(['paid', 'paid', 'paid', 'completed'])
    watch.start(order('paid'))
    await tick(PAID_INTERVAL_MS * 3)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(watch.getState()?.active).toBe(true)
    await tick(PAID_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ active: false, order: { status: 'completed' } })
    await tick(MIN)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('等待付款中途变成已付款，节奏从 3 秒换成 2 秒', async () => {
    const { watch, fetch } = make(['paid'])
    watch.start(order())
    await tick(FAST_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(watch.getState()?.order.status).toBe('paid')
    await tick(PAID_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(2)
    await tick(PAID_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('已付款超过 2 分钟还没到账，改成每 10 秒', async () => {
    const { watch, fetch } = make(['paid'])
    watch.start(order('paid'))
    await tick(PAID_FAST_DURATION_MS)
    const before = fetch.mock.calls.length
    expect(before).toBe(PAID_FAST_DURATION_MS / PAID_INTERVAL_MS)
    await tick(SLOW_INTERVAL_MS * 2)
    expect(fetch.mock.calls.length - before).toBe(2)
  })
})

describe('到期与终态', () => {
  it('到 expires_at 时再查一次，之后仍是待付：改成每 30 秒查，到期后 10 分钟停', async () => {
    const expiresAt = new Date(T0 + 20_000).toISOString()
    const { watch, fetch } = make(['pending'], { expiresAt })
    watch.start(order('pending', { expiresAt }))
    await tick(20_000)
    // 3、6、9、12、15、18 秒各一次，再加到期的 20 秒这一次
    expect(fetch).toHaveBeenCalledTimes(7)
    expect(watch.getState()?.active).toBe(true)
    await tick(EXPIRED_INTERVAL_MS - 1)
    expect(fetch).toHaveBeenCalledTimes(7)
    await tick(1)
    expect(fetch).toHaveBeenCalledTimes(8)
    await tick(10 * MIN)
    expect(watch.getState()?.active).toBe(false)
    const calls = fetch.mock.calls.length
    await tick(MIN)
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it('到期时云端把单标成过期：状态记下来，到期后 10 分钟内每 30 秒再查，之后停', async () => {
    const expiresAt = new Date(T0 + 5_000).toISOString()
    const { watch, fetch } = make(['pending', 'expired'], { expiresAt })
    watch.start(order('pending', { expiresAt }))
    await tick(5_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(watch.getState()).toMatchObject({ active: true, order: { status: 'expired' } })
    await tick(EXPIRED_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(3)
    await tick(10 * MIN)
    expect(watch.getState()).toMatchObject({ active: false, order: { status: 'expired' } })
    const calls = fetch.mock.calls.length
    expect(calls).toBeLessThanOrEqual(2 + (10 * MIN) / EXPIRED_INTERVAL_MS + 1)
    await tick(MIN)
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it('过期后才付的钱：窗口内查到 paid / completed 就接着走', async () => {
    const expiresAt = new Date(T0 + 5_000).toISOString()
    const { watch } = make(['pending', 'expired', 'expired', 'paid', 'completed'], { expiresAt })
    watch.start(order('pending', { expiresAt }))
    await tick(5_000 + 2 * EXPIRED_INTERVAL_MS) // 3 秒：pending；5 秒：expired；35 秒：expired；65 秒：paid
    expect(watch.getState()).toMatchObject({ active: true, order: { status: 'paid' } })
    await tick(PAID_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ active: false, order: { status: 'completed' } })
  })

  it('到期那一刻上一次查询还没回来：跳过，不排 0 毫秒的定时器', async () => {
    const expiresAt = new Date(T0 + 10_000).toISOString()
    const fetch = vi.fn(() => new Promise<CheckoutOrder>(() => undefined))
    const watch = new OrderWatch({ fetch })
    watch.start(order('pending', { expiresAt }))
    await tick(3_000) // 第一次查询发出，一直不回来
    await tick(10_000) // 经过到期那一刻
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1) // 只有下一拍，没有空转
    await tick(MIN)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('到期那一刻的查询会延迟返回：回来之前不重复请求，回来后按 30 秒慢查', async () => {
    const expiresAt = new Date(T0 + 10_000).toISOString()
    const pending: Array<(o: CheckoutOrder) => void> = []
    const fetch = vi.fn(() => new Promise<CheckoutOrder>(r => pending.push(r)))
    const watch = new OrderWatch({ fetch })
    watch.start(order('pending', { expiresAt }))
    for (let i = 0; i < 3; i++) {
      await tick(3_000)
      pending.shift()?.(order('pending', { expiresAt })) // 每次都回来
    }
    await tick(1_000) // 10 秒：到期这一拍
    expect(fetch).toHaveBeenCalledTimes(4)
    await tick(6_000) // 到期这次查询 6 秒后才回来
    expect(fetch).toHaveBeenCalledTimes(4)
    pending.shift()?.(order('expired', { expiresAt }))
    await tick(0)
    expect(watch.getState()).toMatchObject({ active: true, order: { status: 'expired' } })
    await tick(EXPIRED_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('取消的单：到期后 10 分钟内每 30 秒再查（迟到的付款会把它恢复成已付款），之后停', async () => {
    const expiresAt = new Date(T0 + 2 * MIN).toISOString()
    const { watch, fetch } = make(['cancelled'], { expiresAt })
    watch.start(order('pending', { expiresAt }))
    await tick(FAST_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ active: true, order: { status: 'cancelled' } })
    const calls = fetch.mock.calls.length
    await tick(EXPIRED_INTERVAL_MS - 1)
    expect(fetch.mock.calls.length).toBe(calls)
    await tick(1)
    expect(fetch.mock.calls.length).toBe(calls + 1)
    await tick(15 * MIN)
    expect(watch.getState()?.active).toBe(false)
  })

  it('取消的单后来恢复成已付款、已到账：接着走到底', async () => {
    const { watch } = make(['cancelled', 'paid', 'completed'])
    watch.start(order())
    await tick(FAST_INTERVAL_MS)
    expect(watch.getState()?.order.status).toBe('cancelled')
    await tick(EXPIRED_INTERVAL_MS)
    expect(watch.getState()?.order.status).toBe('paid')
    await tick(PAID_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ active: false, order: { status: 'completed' } })
  })

  it('failed（付了钱、加余额失败）：弹窗开着就每 30 秒查，补到账后停', async () => {
    const { watch, fetch } = make(['failed', 'failed', 'completed'], {
      expiresAt: new Date(T0 - 60 * MIN).toISOString(),
    })
    watch.start(order('paid'))
    await tick(PAID_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ active: true, order: { status: 'failed' } })
    await tick(EXPIRED_INTERVAL_MS * 2)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(watch.getState()).toMatchObject({ active: false, order: { status: 'completed' } })
  })

  it.each(['completed', 'refunding', 'refunded'] as const)('%s 是终态：查到就停', async status => {
    const { watch, fetch } = make(['pending', status])
    watch.start(order())
    await tick(FAST_INTERVAL_MS * 3)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(watch.getState()).toMatchObject({ active: false, order: { status } })
  })

  it('start 的订单本身就是终态：不轮询', async () => {
    const { watch, fetch } = make()
    watch.start(order('completed'))
    await tick(MIN)
    expect(fetch).not.toHaveBeenCalled()
    expect(watch.getState()?.active).toBe(false)
  })

  it('start 的订单已过期超过 10 分钟：不轮询（只能手动「我已付款」）', async () => {
    const expiresAt = new Date(T0 - 11 * MIN).toISOString()
    const { watch, fetch } = make(['expired'], { expiresAt })
    watch.start(order('expired', { expiresAt }))
    await tick(MIN)
    expect(fetch).not.toHaveBeenCalled()
    expect(watch.getState()?.active).toBe(false)
  })

  it('过期的单核实后其实已付：adopt 之后重新开始 2 秒一查', async () => {
    const expiresAt = new Date(T0 + 5_000).toISOString()
    const { watch, fetch } = make(['expired', 'completed'], { expiresAt })
    watch.start(order('pending', { expiresAt }))
    await tick(5_000)
    expect(watch.getState()).toMatchObject({ active: true, order: { status: 'expired' } })
    const calls = fetch.mock.calls.length
    watch.adopt(order('paid', { expiresAt }))
    expect(watch.getState()).toMatchObject({ active: true, order: { status: 'paid' } })
    await tick(PAID_INTERVAL_MS)
    expect(fetch.mock.calls.length).toBe(calls + 1)
    expect(watch.getState()?.order.status).toBe('completed')
  })
})

describe('失败、重叠与关闭', () => {
  it('连续 5 次失败才报错并停下；之前只记次数', async () => {
    const boom = new Error('network down')
    const { watch, fetch } = make([boom])
    watch.start(order())
    await tick(FAST_INTERVAL_MS * (MAX_FAILURES - 1))
    expect(watch.getState()).toMatchObject({ failures: MAX_FAILURES - 1, error: null, active: true })
    await tick(FAST_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ failures: MAX_FAILURES, error: boom, active: false })
    await tick(MIN)
    expect(fetch).toHaveBeenCalledTimes(MAX_FAILURES)
  })

  it('成功一次就清零；报错后「重试」马上查一次并继续', async () => {
    const boom = new Error('x')
    const { watch, fetch } = make([boom, boom, 'pending', boom, boom, boom, boom, boom, 'pending'])
    watch.start(order())
    await tick(FAST_INTERVAL_MS * 3)
    expect(watch.getState()?.failures).toBe(0) // 第三次成功，之前的两次作废
    await tick(FAST_INTERVAL_MS * 5)
    expect(watch.getState()).toMatchObject({ failures: 5, active: false })
    const calls = fetch.mock.calls.length
    watch.retry()
    expect(fetch.mock.calls.length).toBe(calls + 1)
    await tick(0)
    expect(watch.getState()).toMatchObject({ failures: 0, error: null, active: true })
  })

  it('请求慢、节奏快：连续失败按真实回来的失败次数算，跳过的拍不算', async () => {
    const fetch = vi.fn(
      () =>
        new Promise<CheckoutOrder>((_, reject) => {
          setTimeout(() => reject(new Error('slow fail')), 5_000)
        }),
    )
    const watch = new OrderWatch({ fetch })
    watch.start(order())
    // 3 秒发出第一次，8 秒回来（失败 1）；3 秒节拍里 6 秒那拍因在途被跳过
    await tick(8_000)
    expect(watch.getState()?.failures).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    await tick(60_000)
    const s = watch.getState()!
    expect(s.error).not.toBeNull() // 第 5 次回来时报错并停
    expect(s.failures).toBe(MAX_FAILURES)
    expect(fetch).toHaveBeenCalledTimes(MAX_FAILURES) // 失败数 = 真正发出的请求数，跳过的拍不算
  })

  it('过期后的慢节奏里也是连续 5 次失败才报错，「重试」在窗口内马上查一次', async () => {
    const expiresAt = new Date(T0 - MIN).toISOString()
    const boom = new Error('down')
    const { watch, fetch } = make([boom], { expiresAt })
    watch.start(order('expired', { expiresAt }))
    await tick(EXPIRED_INTERVAL_MS * (MAX_FAILURES - 1))
    expect(watch.getState()).toMatchObject({ failures: MAX_FAILURES - 1, error: null, active: true })
    await tick(EXPIRED_INTERVAL_MS)
    expect(watch.getState()).toMatchObject({ failures: MAX_FAILURES, error: boom, active: false })
    const calls = fetch.mock.calls.length
    watch.retry()
    expect(fetch).toHaveBeenCalledTimes(calls + 1)
  })

  it('窗口已过的过期单报错后点「重试」：只清掉错误，不再查', async () => {
    const expiresAt = new Date(T0 - 7 * MIN).toISOString()
    const boom = new Error('down')
    const { watch, fetch } = make([boom], { expiresAt })
    watch.start(order('expired', { expiresAt }))
    await tick(EXPIRED_INTERVAL_MS * MAX_FAILURES)
    expect(watch.getState()?.error).toBe(boom)
    await tick(2 * MIN) // 窗口过了
    const calls = fetch.mock.calls.length
    watch.retry()
    expect(fetch).toHaveBeenCalledTimes(calls)
    expect(watch.getState()).toMatchObject({ error: null, failures: 0, active: false })
  })

  it('上一次查询还没回来：跳过这一拍，不叠加请求', async () => {
    const fetch = vi.fn(() => new Promise<CheckoutOrder>(() => undefined))
    const watch = new OrderWatch({ fetch })
    watch.start(order())
    await tick(FAST_INTERVAL_MS * 10)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stop（关闭弹窗）后在途的结果作废，不再轮询', async () => {
    let resolve!: (o: CheckoutOrder) => void
    const fetch = vi.fn(() => new Promise<CheckoutOrder>(r => (resolve = r)))
    const watch = new OrderWatch({ fetch })
    watch.start(order())
    await tick(FAST_INTERVAL_MS)
    expect(fetch).toHaveBeenCalledTimes(1)
    watch.stop()
    resolve(order('completed'))
    await tick(0)
    expect(watch.getState()).toMatchObject({ active: false, order: { status: 'pending' } })
    await tick(MIN)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('stop 之后晚到的失败也不计数', async () => {
    let reject!: (e: Error) => void
    const fetch = vi.fn(() => new Promise<CheckoutOrder>((_, r) => (reject = r)))
    const watch = new OrderWatch({ fetch })
    watch.start(order())
    await tick(FAST_INTERVAL_MS)
    watch.stop()
    reject(new Error('late'))
    await tick(0)
    expect(watch.getState()?.failures).toBe(0)
  })

  it('订阅者在每次状态变化时被通知', async () => {
    const { watch } = make(['pending', 'completed'])
    const seen: string[] = []
    watch.subscribe(() => seen.push(watch.getState()?.order.status ?? ''))
    watch.start(order())
    await tick(FAST_INTERVAL_MS * 2)
    expect(seen[0]).toBe('pending')
    expect(seen.at(-1)).toBe('completed')
  })
})

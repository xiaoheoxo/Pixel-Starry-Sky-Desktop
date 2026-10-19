// 付款后的到账检测（docs/ui/settings.md §9.4）：打开支付页前先刷新一次账号定基准（baselineBeforeOpen），
// 打开后前 2 分钟每 15 秒刷新一次，余额 / 套餐比基准多就算到账并停止；「我已付款，刷新」是随时可点的手动检查。
// 纯 TypeScript，不依赖 React，定时器和刷新函数都可以替换，方便测试。
import type { AccountInfo, AccountRefreshResult } from '../../../../shared/types/account'
import { diffAccount, snapOf, type AccountChange, type AccountSnap } from './storeLogic'

export const WATCH_INTERVAL_MS = 15_000
export const WATCH_DURATION_MS = 2 * 60_000

export type WatchOutcome = { kind: 'arrived'; change: AccountChange } | { kind: 'pending' }

export interface WatchState {
  /** 正在自动轮询 */
  watching: boolean
  /** 手动刷新进行中 */
  refreshing: boolean
  outcome: WatchOutcome | null
  /** 手动刷新失败的原因（宿主文案，显示时用 translateMessage） */
  error: string | null
}

const IDLE: WatchState = { watching: false, refreshing: false, outcome: null, error: null }

/** 打开支付页前等账号刷新最多这么久；超时就用缓存，照样打开 */
export const BASELINE_TIMEOUT_MS = 5_000

/**
 * 打开支付页**之前**强制刷新一次账号，拿到的就是这次付款前的基准：页面还没打开，这次的钱不可能已经到账，
 * 之前的入账（别处充值、缓存过期期间的入账）和会话扣费都算进基准里，之后的增加才是这次付款。
 * 刷新失败或超时就用缓存（这时打开前的入账会被当成这次到账，只在刷新失败时才可能发生）
 */
export async function baselineBeforeOpen(
  refresh: () => Promise<AccountRefreshResult>,
  cached: Pick<AccountInfo, 'balance' | 'plan'>,
  timeoutMs = BASELINE_TIMEOUT_MS,
): Promise<Pick<AccountInfo, 'balance' | 'plan'>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), timeoutMs)))
  try {
    const res = await Promise.race([refresh().catch(() => null), timeout])
    return res && !res.error && res.account ? res.account : cached
  } finally {
    clearTimeout(timer)
  }
}

export class PaymentWatch {
  private snapshot: WatchState = IDLE
  private baseline: AccountSnap | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private ticks = 0
  private autoBusy = false
  /** begin / stop 都会加一：让还在途中的刷新结果作废 */
  private gen = 0
  private readonly listeners = new Set<() => void>()
  private readonly maxTicks: number

  constructor(
    private readonly refresh: () => Promise<AccountRefreshResult>,
    private readonly intervalMs = WATCH_INTERVAL_MS,
    durationMs = WATCH_DURATION_MS,
  ) {
    this.maxTicks = Math.max(1, Math.round(durationMs / intervalMs))
  }

  getState = (): WatchState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<WatchState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const l of this.listeners) l()
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 支付页已经打开：以 baseline（打开前取到的账号数据，见 baselineBeforeOpen）为基准开始自动轮询，
   * 之后余额 / 套餐比它多才算到账（重复打开会重新计时）
   */
  begin(baseline: Pick<AccountInfo, 'balance' | 'plan'>): void {
    this.clearTimer()
    this.gen++
    this.baseline = snapOf(baseline)
    this.ticks = 0
    this.autoBusy = false
    this.snapshot = { watching: true, refreshing: false, outcome: null, error: null }
    for (const l of this.listeners) l()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  /** 停止自动轮询（离开商店页）；已有的结果保留 */
  stop(): void {
    this.clearTimer()
    this.gen++
    this.autoBusy = false
    if (this.snapshot.watching || this.snapshot.refreshing) this.set({ watching: false, refreshing: false })
  }

  private async tick(): Promise<void> {
    if (this.autoBusy) return
    this.ticks++
    const last = this.ticks >= this.maxTicks
    if (last) {
      this.clearTimer()
      this.set({ watching: false })
    }
    this.autoBusy = true
    const gen = this.gen
    try {
      await this.check(gen, false)
      // 自动检查结束仍没到账：留下「暂未到账」，不让提示直接消失
      if (last && gen === this.gen && !this.snapshot.outcome) this.set({ outcome: { kind: 'pending' } })
    } finally {
      if (gen === this.gen) this.autoBusy = false
    }
  }

  /** 「我已付款，刷新」：失败显示错误；没变化显示「暂未到账」；有变化显示前后对比 */
  async manual(): Promise<void> {
    if (this.snapshot.refreshing) return
    const gen = this.gen
    this.set({ refreshing: true, error: null })
    await this.check(gen, true)
    if (gen === this.gen) this.set({ refreshing: false })
  }

  private async check(gen: number, manual: boolean): Promise<void> {
    let res: AccountRefreshResult | undefined
    try {
      res = await this.refresh()
    } catch (e) {
      res = { error: e instanceof Error ? e.message : String(e), account: null }
    }
    if (gen !== this.gen) return
    if (res?.error) {
      if (manual) this.set({ error: res.error })
      return
    }
    const change = res?.account && this.baseline ? diffAccount(this.baseline, snapOf(res.account)) : null
    if (change) this.arrive(change)
    else if (manual && this.snapshot.outcome?.kind !== 'arrived') this.set({ outcome: { kind: 'pending' } })
  }

  private arrive(change: AccountChange): void {
    this.clearTimer()
    this.set({ watching: false, outcome: { kind: 'arrived', change }, error: null })
  }
}

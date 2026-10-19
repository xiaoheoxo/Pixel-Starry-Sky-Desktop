// 付款到账检测的 React 外壳：控制器见 paymentWatch.ts
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { AccountInfo, AccountRefreshResult } from '../../../../shared/types/account'
import { PaymentWatch, baselineBeforeOpen, type WatchState } from './paymentWatch'

type Baseline = Pick<AccountInfo, 'balance' | 'plan'>

export interface UsePaymentWatchResult extends WatchState {
  /** 打开支付页之前调用：强制刷新一次账号，返回这次付款前的基准（失败 / 超时时是缓存的账号数据） */
  prepare: () => Promise<Baseline>
  /** 支付页打开后调用：以 prepare 拿到的基准开始检测 */
  begin: (baseline: Baseline) => void
  /** 「我已付款，刷新」 */
  refreshNow: () => Promise<void>
  /** 停止自动检测（打开软件内付款弹窗时：两种到账检测不同时运行） */
  stop: () => void
}

/** 离开商店页（组件卸载）时自动停止轮询 */
export function usePaymentWatch(
  account: Baseline,
  refresh: () => Promise<AccountRefreshResult>,
): UsePaymentWatchResult {
  const accountRef = useRef(account)
  accountRef.current = account
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const watchRef = useRef<PaymentWatch | null>(null)
  watchRef.current ??= new PaymentWatch(() => refreshRef.current())
  const watch = watchRef.current

  useEffect(() => () => watch.stop(), [watch])
  const state = useSyncExternalStore(watch.subscribe, watch.getState, watch.getState)
  const prepare = useCallback(() => baselineBeforeOpen(() => refreshRef.current(), accountRef.current), [])
  const begin = useCallback((baseline: Baseline) => watch.begin(baseline), [watch])
  const refreshNow = useCallback(() => watch.manual(), [watch])
  const stop = useCallback(() => watch.stop(), [watch])
  return { ...state, prepare, begin, refreshNow, stop }
}

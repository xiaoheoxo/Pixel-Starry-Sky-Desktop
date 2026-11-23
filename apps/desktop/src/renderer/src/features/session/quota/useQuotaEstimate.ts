// 订阅额度估算的数据（docs/ui/quota-estimate.md §2）：这个引擎走订阅登录（route cli）的用量记录 + 月费选择。
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  QUOTA_WINDOW_MINS,
  quotaWindowObservedAt,
  type WeeklyApiSample,
  type AccountQuota,
  type QuotaProvider,
  type UsageGroupRow,
} from '@pixelsky/protocol'
import { onUsageChange, readQuotaMonth } from '@/features/usage/source'
import {
  PLAN_FEES,
  PROVIDER_ENGINE,
  defaultFeeId,
  monthValue,
  windowEstimate,
  type MonthValue,
  type WindowEstimate,
} from './estimate'
import { quotaEntries } from './quotaModel'
import { quotaObservations } from './observations'
import { weeklyApiCalibration, weeklyApiValue } from './weeklyApi'

/** 一轮记下来后等这么久再重读：连着几轮结束、多个模型各记一条时只读一次 */
const REREAD_DELAY_MS = 15_000

export interface QuotaEstimate {
  /** 按额度条目 id（同卡片 id） */
  windows: Record<string, WindowEstimate>
  month: MonthValue | null
  weeklyApi?: { id: string; value: ReturnType<typeof weeklyApiValue> }
}

/** Account forecasts and this computer's aggregate API comparison are independent. */
export function useQuotaEstimate(
  provider: QuotaProvider | null,
  quota: AccountQuota | null,
  now: number,
): QuotaEstimate | null {
  const engine = provider ? PROVIDER_ENGINE[provider] : undefined
  const supported = !!engine && !!quota && quota.status !== 'unsupported'
  const windows = useMemo(
    () => (supported ? quotaEntries(quota, now).filter(e => e.kind === 'window') : []),
    [supported, quota, now],
  )
  const day = new Date(now).toDateString()
  const [data, setData] = useState<{ engine: string; models: UsageGroupRow[] } | null>(null)
  const [version, setVersion] = useState(0)
  const week = provider === 'chatgpt' ? windows.find(w => w.durationMins === QUOTA_WINDOW_MINS.week) : undefined
  const calibration =
    week && quota ? weeklyApiCalibration(quota, week.id, now, quotaObservations.forWindow(quota, week.id)) : null
  const { account, plan, from, to, resetsAt } = calibration?.query ?? {}
  const [weekly, setWeekly] = useState<{ key: string; sample: WeeklyApiSample | null } | null>(null)
  const key = account && from !== undefined ? JSON.stringify([account, plan, from, to, resetsAt, version]) : ''
  useEffect(() => {
    if (!key || !account || plan === undefined || from === undefined || to === undefined || resetsAt === undefined)
      return
    let cancelled = false
    window.pixelsky?.quota
      ?.weeklyApiSample?.({ account, plan, from, to, resetsAt })
      .then(sample => !cancelled && setWeekly({ key, sample }))
      .catch(() => !cancelled && setWeekly({ key, sample: null }))
    return () => {
      cancelled = true
    }
  }, [key, account, plan, from, to, resetsAt])
  const weeklyValue = calibration && weekly?.key === key ? weeklyApiValue(weekly.sample, calibration.pointsUsed) : null
  const weeklyId = week?.id
  useEffect(() => {
    if (!supported) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = onUsageChange(() => {
      timer ??= setTimeout(() => {
        timer = null
        setVersion(v => v + 1)
      }, REREAD_DELAY_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [supported])
  useEffect(() => {
    if (!supported || !engine) return
    let cancelled = false
    readQuotaMonth({ engine, route: 'cli' })
      .then(models => !cancelled && setData({ engine, models }))
      .catch(() => !cancelled && setData(null))
    return () => {
      cancelled = true
    }
  }, [supported, engine, day, version])
  return useMemo(() => {
    if (!supported || !quota) return null
    const out: Record<string, WindowEstimate> = {}
    for (const e of windows) {
      const est = windowEstimate(
        e,
        now,
        quota.status === 'ok' && !quota.pending ? quotaWindowObservedAt(quota, e.id) : null,
        quotaObservations.forWindow(quota, e.id),
      )
      if (est) out[e.id] = est
    }
    return {
      windows: out,
      month: data && data.engine === engine ? monthValue(data.models) : null,
      ...(weeklyId ? { weeklyApi: { id: weeklyId, value: weeklyValue } } : {}),
    }
  }, [supported, data, engine, quota, windows, now, weeklyId, weeklyValue])
}

const FEE_KEY = 'pixelsky.quotaFee.'
const feeListeners = new Set<() => void>()
const subscribeFee = (cb: () => void): (() => void) => {
  feeListeners.add(cb)
  return () => feeListeners.delete(cb)
}

/** 月费：用户在明细里选过的（存本机，弹窗和概况同步），没选过按套餐猜；认不出为 null */
export function usePlanFee(provider: QuotaProvider | null, plan: string | null) {
  const list = provider === 'claude' || provider === 'chatgpt' || provider === 'google' ? PLAN_FEES[provider] : null
  const picked = useSyncExternalStore(subscribeFee, () => (provider ? localStorage.getItem(FEE_KEY + provider) : null))
  const id = (list?.some(f => f.id === picked) ? picked : null) ?? (provider ? defaultFeeId(provider, plan) : null)
  const fee = list?.find(f => f.id === id) ?? null
  const pick = (next: string): void => {
    if (!provider) return
    localStorage.setItem(FEE_KEY + provider, next)
    feeListeners.forEach(l => l())
  }
  return { options: list ?? [], fee, pick }
}

/** 折合金额是月费的几倍，一位小数 */
export const feeRatio = (month: MonthValue | null, fee: { usd: number } | null): string | null =>
  month && month.usd > 0 && !month.unpricedModels && fee ? (month.usd / fee.usd).toFixed(1) : null

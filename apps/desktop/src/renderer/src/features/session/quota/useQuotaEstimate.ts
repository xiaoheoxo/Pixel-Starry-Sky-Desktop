// 订阅额度估算的数据（docs/ui/quota-estimate.md §2）：这个引擎走订阅登录（route cli）的用量记录 + 月费选择。
import { useEffect, useMemo, useState } from 'react'
import type { AccountQuota, QuotaProvider, UsageGroupRow, UsageRecord } from '@pixelsky/protocol'
import { onUsageChange, readQuotaUsage } from '@/features/usage/source'
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

const WEEK = 7 * 86_400_000

export interface QuotaEstimate {
  /** 按额度条目 id（同卡片 id） */
  windows: Record<string, WindowEstimate>
  month: MonthValue | null
}

/**
 * 弹窗、概况共用。不支持的账号（平台、读不到额度）为 null。
 * shortcut: 记录不带账号，按「这个引擎走订阅登录」算，同一台电脑换过账号会混在一起；记录带上账号后再按账号筛
 */
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
  // 最早的窗口开始（按分钟取整，分钟时钟走动不重读）；没有时长的按 7 天
  const from = windows.reduce(
    (min, e) => (e.durationMins && e.resetsAt !== null ? Math.min(min, e.resetsAt - e.durationMins * 60_000) : min),
    now,
  )
  const fromKey = Math.floor(Math.max(from, now - WEEK) / 60_000)
  const [data, setData] = useState<{ records: UsageRecord[]; models: UsageGroupRow[] } | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => (supported ? onUsageChange(() => setVersion(v => v + 1)) : undefined), [supported])
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    readQuotaUsage({ engine, route: 'cli' }, fromKey * 60_000)
      .then(d => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null))
    return () => {
      cancelled = true
    }
  }, [supported, engine, fromKey, version])
  return useMemo(() => {
    if (!supported || !data) return null
    const out: Record<string, WindowEstimate> = {}
    for (const e of windows) {
      const est = windowEstimate(e, data.records, now)
      if (est) out[e.id] = est
    }
    return { windows: out, month: monthValue(data.models) }
  }, [supported, data, windows, now])
}

const FEE_KEY = 'pixelsky.quotaFee.'

/** 月费：用户在明细里选过的（存本机），没选过按套餐猜；认不出为 null */
export function usePlanFee(provider: QuotaProvider | null, plan: string | null) {
  const list = provider === 'claude' || provider === 'chatgpt' ? PLAN_FEES[provider] : null
  const [picked, setPicked] = useState(() => (provider ? localStorage.getItem(FEE_KEY + provider) : null))
  const id = (list?.some(f => f.id === picked) ? picked : null) ?? (provider ? defaultFeeId(provider, plan) : null)
  const fee = list?.find(f => f.id === id) ?? null
  const pick = (next: string): void => {
    if (!provider) return
    localStorage.setItem(FEE_KEY + provider, next)
    setPicked(next)
  }
  return { options: list ?? [], fee, pick }
}

/** 折合金额是月费的几倍，一位小数 */
export const feeRatio = (month: MonthValue | null, fee: { usd: number } | null): string | null =>
  month && fee ? (month.usd / fee.usd).toFixed(1) : null

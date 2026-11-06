// 用量数据来源（docs/ui/usage.md §6）：
// - 演示模式：mock/usage.ts 生成的假数据，在界面里现场汇总；
// - 真实模式：引擎层提供 usage* 接口后从主进程读取；接口还没有时显示空状态。
import { useCallback, useEffect, useState } from 'react'
import { isDemo } from '@/data'
import { groupByDay, heatmapDays, listRecords, summarize, toCsv } from './aggregate'
import type { UsageBucket, UsageFilter, UsagePage, UsageRangeId, UsageRecord, UsageSummary, UsageTotals } from './types'
import { demo } from '@/data/demo'

export interface UsageQuery {
  range: UsageRangeId
  filter: UsageFilter
}

/** 引擎层约定的接口（§6.3）；实现前这些方法不存在 */
interface UsageBridge {
  usageSummary?: (q: UsageQuery & { now: number; tzOffset: number }) => Promise<UsageSummary>
  usageList?: (q: UsageQuery & { now: number; offset: number; limit: number }) => Promise<UsagePage>
  /** 旧版远端辅助进程没有这个通道：调用会报错，页面不显示热力图 */
  usageDaily?: (q: { filter: UsageFilter; now: number }) => Promise<UsageBucket[]>
  usageExport?: (q: UsageQuery & { now: number }) => Promise<boolean>
  usageClear?: () => Promise<void>
  /** 主进程事件；写入新记录或清空后是 { kind: 'usage_recorded' } */
  onEvent?: (cb: (e: { kind: string }) => void) => () => void
}

function bridge(): UsageBridge | null {
  if (isDemo) return null
  const engine = (window.pixelsky as unknown as { engine?: UsageBridge } | undefined)?.engine
  return engine?.usageSummary ? engine : null
}

// 本地记录：演示模式是假数据；真实模式在引擎接口实现前为空
let localRecords: UsageRecord[] = isDemo ? demo().usageRecords(Date.now()) : []
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(l => l())

export const PAGE_SIZE = 50

/** 读取汇总和一页明细；记录变化（新的一轮结束、清空）时自动刷新 */
export function useUsage(query: UsageQuery, offset: number) {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [page, setPage] = useState<UsagePage | null>(null)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    listeners.add(bump)
    const off = bridge()?.onEvent?.(e => {
      if (e.kind === 'usage_recorded') bump()
    })
    return () => {
      listeners.delete(bump)
      off?.()
    }
  }, [])

  const { range, filter } = query
  const filterKey = JSON.stringify(filter)

  useEffect(() => {
    let cancelled = false
    const now = Date.now()
    const b = bridge()
    setError(null)
    if (b?.usageSummary && b.usageList) {
      Promise.all([
        b.usageSummary({ range, filter, now, tzOffset: new Date().getTimezoneOffset() }),
        b.usageList({ range, filter, now, offset, limit: PAGE_SIZE }),
      ])
        .then(([s, p]) => {
          if (cancelled) return
          setSummary(s)
          setPage(p)
        })
        .catch((e: unknown) => !cancelled && setError(String((e as Error)?.message ?? e)))
    } else {
      setSummary(summarize(localRecords, range, filter, now))
      setPage(listRecords(localRecords, range, filter, now, offset, PAGE_SIZE))
    }
    return () => {
      cancelled = true
    }
    // filterKey 代替 filter 对象做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, filterKey, offset, version])

  return { summary, page, error }
}

/** 热力图：最近 53 周每天的合计；读不到时为 null，页面不显示这一块 */
export function useUsageDaily(filter: UsageFilter, enabled: boolean): UsageBucket[] | null {
  const [days, setDays] = useState<UsageBucket[] | null>(null)
  const [version, setVersion] = useState(0)
  const filterKey = JSON.stringify(filter)

  useEffect(() => {
    if (!enabled) return
    const bump = () => setVersion(v => v + 1)
    listeners.add(bump)
    const off = bridge()?.onEvent?.(e => {
      if (e.kind === 'usage_recorded') bump()
    })
    return () => {
      listeners.delete(bump)
      off?.()
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const now = Date.now()
    const b = bridge()
    if (!b) {
      setDays(heatmapDays(groupByDay(localRecords, filter), now))
      return
    }
    if (!b.usageDaily) {
      setDays(null)
      return
    }
    b.usageDaily({ filter, now })
      .then(d => !cancelled && setDays(d))
      .catch(() => !cancelled && setDays(null))
    return () => {
      cancelled = true
    }
    // filterKey 代替 filter 对象做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, filterKey, version])

  return days
}

/** 今天的合计（悬停用量图标时读一次）；读不到时为 null */
export async function readTodayUsage(): Promise<UsageTotals | null> {
  const now = Date.now()
  const b = bridge()
  try {
    if (!b?.usageSummary) return summarize(localRecords, 'today', {}, now).totals
    return (await b.usageSummary({ range: 'today', filter: {}, now, tzOffset: new Date().getTimezoneOffset() })).totals
  } catch {
    return null
  }
}

/** 导出当前筛选范围的全部记录为 CSV */
export function useUsageActions() {
  const exportCsv = useCallback(async (query: UsageQuery): Promise<void> => {
    const now = Date.now()
    const b = bridge()
    if (b?.usageExport) {
      await b.usageExport({ ...query, now })
      return
    }
    const all = listRecords(localRecords, query.range, query.filter, now, 0, Number.MAX_SAFE_INTEGER).records
    const url = URL.createObjectURL(new Blob([toCsv(all)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    const d = new Date(now)
    a.href = url
    a.download = `pixelsky-usage-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [])

  const clear = useCallback(async (): Promise<void> => {
    const b = bridge()
    if (b?.usageClear) await b.usageClear()
    else localRecords = []
    notify()
  }, [])

  return { exportCsv, clear }
}

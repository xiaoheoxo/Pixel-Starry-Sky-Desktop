// 账号远端调用记录的数据来源（docs/ui/usage.md §9.3）：
// - 演示模式：mock/remoteCalls.ts 的假数据；
// - 真实模式：通过主进程读取已上线的用户调用接口；
//   不存在时返回 NOT_IMPLEMENTED，页面显示「需认证服务提供接口」的占位说明。
import { useEffect, useState } from 'react'
import { isDemo } from '@/data'
import type { RemoteCallPage } from './remote-types'
import type { RemoteUsageQuery, RemoteUsageSummary } from '@pixelsky/protocol'
import { callTiming, remoteDays, statTotals, summarizeCalls, toUsageSummary, type CallTiming } from './remoteSummary'
import { heatmapDays, mergeTotals, emptyTotals } from './aggregate'
import type { UsageBucket, UsageSummary } from './types'
import type { UsageRangeId } from './types'
import { demo } from '@/data/demo'

export const NOT_IMPLEMENTED = 'not_implemented'

export interface RemoteCallsQuery {
  range: UsageRangeId
  /** 按模型筛选；null 表示不筛选。远端现在只支持模型和时间，传输更简单 */
  model: string | null
  offset: number
  limit: number
}

/** 兼容旧 preload；新版本通过 AccountBridge.listCalls 读取。 */
interface RemoteCallsBridge {
  listCalls?: (q: RemoteCallsQuery & { now: number }) => Promise<RemoteCallPage>
  /** 旧 preload 没有；云端没有这个接口时会报错，页面只显示明细 */
  summary?: (q: RemoteUsageQuery) => Promise<RemoteUsageSummary>
}

function bridge(): RemoteCallsBridge | null {
  const account = (window.pixelsky as unknown as { account?: RemoteCallsBridge } | undefined)?.account
  return account?.listCalls ? account : null
}

/** 远端接口是否已经可用（用于提示） */
export function remoteCallsAvailable(): boolean {
  return isDemo || bridge() !== null
}

export interface RemoteCallsResult {
  page: RemoteCallPage | null
  loading: boolean
  /** NOT_IMPLEMENTED = 服务端还没这个接口；其他字符串是错误信息 */
  error: string | null
  status: 'ready' | 'not-implemented' | 'error' | 'loading'
}

const DAY = 24 * 60 * 60 * 1000

/** 本地筛选 + 分页：演示数据，将来也可以在接口只给「整段数据」时用 */
function queryLocal(query: RemoteCallsQuery, now: number): RemoteCallPage {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const from =
    query.range === 'today'
      ? today.getTime()
      : query.range === '7d'
        ? today.getTime() - 6 * DAY
        : query.range === '30d'
          ? today.getTime() - 29 * DAY
          : today.getTime() - 89 * DAY
  const all = demo()
    .remoteCalls(now)
    .filter(c => c.createdAt >= from && c.createdAt <= now && (query.model === null || c.model === query.model))
    .sort((a, b) => b.createdAt - a.createdAt)
  return {
    calls: all.slice(query.offset, query.offset + query.limit),
    total: all.length,
    offset: query.offset,
    nextCursor: null,
  }
}

/** 读取一页账号调用记录 */
export function useRemoteCalls(query: RemoteCallsQuery): RemoteCallsResult {
  const [result, setResult] = useState<RemoteCallsResult>({ page: null, loading: true, error: null, status: 'loading' })
  const key = JSON.stringify(query)

  useEffect(() => {
    let cancelled = false
    const now = Date.now()
    const b = bridge()
    if (isDemo) {
      setResult({ page: queryLocal(query, now), loading: false, error: null, status: 'ready' })
      return
    }
    if (!b) {
      // 适配层还没这个接口（framework 阶段的真实模式）
      setResult({ page: null, loading: false, error: NOT_IMPLEMENTED, status: 'not-implemented' })
      return
    }
    setResult({ page: null, loading: true, error: null, status: 'loading' })
    b.listCalls!({ ...query, now })
      .then(page => !cancelled && setResult({ page, loading: false, error: null, status: 'ready' }))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setResult({ page: null, loading: false, error: String((e as Error)?.message ?? e), status: 'error' }),
      )
    return () => {
      cancelled = true
    }
    // key 代替 query 对象做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return result
}

export interface RemoteSummaryResult {
  summary: UsageSummary | null
  status: 'ready' | 'unavailable' | 'loading'
}

/** 读取账号调用的合计（卡片、图表、按模型分布）；读不到时不挡住明细表 */
export function useRemoteSummary(query: { range: UsageRangeId; model: string | null }): RemoteSummaryResult {
  const [result, setResult] = useState<RemoteSummaryResult>({ summary: null, status: 'loading' })
  const key = JSON.stringify(query)

  useEffect(() => {
    let cancelled = false
    const now = Date.now()
    if (isDemo) {
      const remote = summarizeCalls(demo().remoteCalls(now), query.range, query.model, now)
      setResult({ summary: toUsageSummary(remote, query.range, now), status: 'ready' })
      return
    }
    const summary = bridge()?.summary
    if (!summary) {
      setResult({ summary: null, status: 'unavailable' })
      return
    }
    setResult(r => ({ summary: r.summary, status: 'loading' }))
    summary({ ...query, now })
      .then(s => !cancelled && setResult({ summary: toUsageSummary(s, query.range, now), status: 'ready' }))
      .catch(() => !cancelled && setResult({ summary: null, status: 'unavailable' }))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return result
}

/** 账号调用的热力图：最近 53 周每天；读不到（云端查不了这么久）时为 null，页面不显示这一块 */
export function useRemoteDaily(model: string | null, enabled: boolean): UsageBucket[] | null {
  const [days, setDays] = useState<UsageBucket[] | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const now = Date.now()
    if (isDemo) {
      const parts = demo()
        .remoteCalls(now)
        .filter(c => model === null || c.model === model)
        .map(c => {
          const t = emptyTotals()
          mergeTotals(
            t,
            statTotals({
              requests: 1,
              input: c.input,
              output: c.output,
              cacheRead: c.cacheRead,
              cacheWrite: c.cacheWrite,
              costUsd: c.costUsd ?? 0,
            }),
          )
          return { ...t, start: c.createdAt }
        })
      setDays(heatmapDays(parts, now))
      return
    }
    const summary = bridge()?.summary
    if (!summary) {
      setDays(null)
      return
    }
    summary({ range: 'year', model, now })
      .then(s => !cancelled && setDays(remoteDays(s, now)))
      .catch(() => !cancelled && setDays(null))
    return () => {
      cancelled = true
    }
  }, [model, enabled])

  return days
}

/** 速度和首字按最近这么多次调用算；一页最多 100 条 */
const TIMING_PAGES = 10

/** 账号调用的速度和首字（云端没有合计，docs/ui/usage-learn.md §1.3）；读不到时为 null，这两列显示「—」 */
export function useRemoteCallTiming(
  query: { range: UsageRangeId; model: string | null },
  enabled: boolean,
): { total: CallTiming; models: Map<string, CallTiming> } | null {
  const [timing, setTiming] = useState<ReturnType<typeof callTiming> | null>(null)
  const key = JSON.stringify(query)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const now = Date.now()
    // 新范围读完之前不显示上一个范围的数字
    setTiming(null)
    const read = async () => {
      const calls: RemoteCallPage['calls'] = []
      for (let i = 0; i < TIMING_PAGES && !cancelled; i++) {
        const q = { ...query, offset: i * 100, limit: 100 }
        const page = isDemo ? queryLocal(q, now) : await bridge()!.listCalls!({ ...q, now })
        calls.push(...page.calls)
        if (page.calls.length < 100) break
      }
      return callTiming(calls)
    }
    if (!isDemo && !bridge()) return
    read()
      .then(t => !cancelled && setTiming(t))
      .catch(() => !cancelled && setTiming(null))
    return () => {
      cancelled = true
    }
    // key 代替 query 对象做依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  return timing
}

export type { CallClient, CallStatus, RemoteCall, RemoteCallPage } from './remote-types'

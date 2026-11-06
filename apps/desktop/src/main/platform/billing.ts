import { heatmapStart, rangeWindow } from '@pixelsky/protocol'
import type {
  PlatformCharge,
  PlatformSettlement,
  RemoteCall,
  RemoteCallPage,
  RemoteCallsQuery,
  RemoteUsageQuery,
  RemoteUsageStat,
  RemoteUsageSummary,
} from '@pixelsky/protocol'
import { platformFetch, signedInEmail } from '../account/account'

const date = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const localDate = (ms: number): string => date(ms - new Date(ms).getTimezoneOffset() * 60000)
async function query(params: URLSearchParams, signal: AbortSignal, path = '/v1/oauth/usage/calls?'): Promise<unknown> {
  const response = await platformFetch(path + params, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('暂时无法读取账号调用记录')
  }
  return response.json()
}

export async function platformCharges(settlement: PlatformSettlement, signal: AbortSignal): Promise<PlatformCharge[]> {
  if (signedInEmail() !== settlement.account) throw new Error('平台账号已退出或切换，请登录原账号后重试')
  const charges: PlatformCharge[] = []
  for (let offset = 0; offset < settlement.requests.length; offset += 100) {
    if (signedInEmail() !== settlement.account) throw new Error('平台账号已退出或切换，请登录原账号后重试')
    const params = new URLSearchParams({
      request_ids: settlement.requests
        .slice(offset, offset + 100)
        .map(r => r.chargeId ?? r.id)
        .join(','),
      start_date: date(settlement.startedAt - 86400000),
    })
    const data = (await query(params, signal)) as { charges?: PlatformCharge[] }
    if (signedInEmail() !== settlement.account || !Array.isArray(data.charges)) throw new Error('平台费用数据不可用')
    charges.push(...data.charges)
  }
  return charges
}

export async function accountCalls(value: unknown): Promise<RemoteCallPage> {
  const q = value as RemoteCallsQuery
  if (
    !q ||
    !['today', '7d', '30d', '90d'].includes(q.range) ||
    !Number.isFinite(q.now) ||
    !Number.isInteger(q.offset) ||
    q.offset < 0 ||
    q.offset > 1000000 ||
    !Number.isInteger(q.limit) ||
    q.limit < 1 ||
    q.limit > 100 ||
    (q.model !== null && (typeof q.model !== 'string' || q.model.length > 200))
  )
    throw new Error('无效的调用记录查询')
  const params = new URLSearchParams({
    offset: String(q.offset),
    limit: String(q.limit),
    start_date: localDate(rangeWindow(q.range, q.now).from),
    end_date: localDate(q.now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  if (q.model) params.set('model', q.model)
  const page = (await query(params, AbortSignal.timeout(25000))) as RemoteCallPage
  if (!page || !Array.isArray(page.calls) || !Number.isFinite(page.total)) throw new Error('平台费用数据不可用')
  return page
}

/** 这个账号在这段时间的全部调用（旧记录按时间补录实扣用，docs/ui/usage.md §11.2），最多 3000 条 */
export async function platformCalls(
  q: { account: string; from: number; to: number },
  signal: AbortSignal,
): Promise<RemoteCall[]> {
  const calls: RemoteCall[] = []
  for (let offset = 0; offset < 3000; offset += 100) {
    if (signedInEmail() !== q.account) throw new Error('平台账号已退出或切换，请登录原账号后重试')
    const params = new URLSearchParams({
      offset: String(offset),
      limit: '100',
      start_date: localDate(q.from),
      end_date: localDate(q.to),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    const page = (await query(params, AbortSignal.any([signal, AbortSignal.timeout(25000)]))) as RemoteCallPage
    if (!page || !Array.isArray(page.calls) || !Number.isFinite(page.total)) throw new Error('平台费用数据不可用')
    calls.push(...page.calls)
    if (page.calls.length < 100 || offset + 100 >= page.total) break
  }
  if (signedInEmail() !== q.account) throw new Error('平台账号已退出或切换，请登录原账号后重试')
  return calls
}

const STAT_KEYS = ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'costUsd'] as const
const isStat = (v: unknown): v is RemoteUsageStat =>
  !!v && typeof v === 'object' && STAT_KEYS.every(k => Number.isFinite((v as Record<string, unknown>)[k]))

/**
 * 账号调用的合计（docs/ui/usage.md §9.4）：本期按格子 + 按模型，上一期只要总计。
 * 日期按本机时区算，和本机记录的 rangeWindow 一致。
 */
export async function accountSummary(value: unknown): Promise<RemoteUsageSummary> {
  const q = value as RemoteUsageQuery
  if (
    !q ||
    !['today', '7d', '30d', '90d', 'year'].includes(q.range) ||
    !Number.isFinite(q.now) ||
    (q.model !== null && (typeof q.model !== 'string' || q.model.length > 200))
  )
    throw new Error('无效的调用记录查询')
  const params = (from: number, to: number, granularity: 'hour' | 'day') => {
    const p = new URLSearchParams({
      start_date: localDate(from),
      end_date: localDate(to),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      granularity,
    })
    if (q.model) p.set('model', q.model)
    return p
  }
  const read = async (p: URLSearchParams) => {
    const data = (await query(p, AbortSignal.timeout(25000), '/v1/oauth/usage/summary?')) as Partial<RemoteUsageSummary>
    if (
      !data ||
      !isStat(data.total) ||
      !Array.isArray(data.buckets) ||
      !data.buckets.every(b => isStat(b) && Number.isFinite(b.start)) ||
      !Array.isArray(data.models) ||
      !data.models.every(m => isStat(m) && typeof m.model === 'string')
    )
      throw new Error('平台费用数据不可用')
    return data as Omit<RemoteUsageSummary, 'prevTotal'>
  }
  if (q.range === 'year') {
    const year = await read(params(heatmapStart(q.now), q.now, 'day'))
    return { buckets: year.buckets, models: year.models, total: year.total, prevTotal: year.total }
  }
  const w = rangeWindow(q.range, q.now)
  const [current, prev] = await Promise.all([
    read(params(w.from, q.now, w.bucket)),
    read(params(w.prevFrom, w.from - 1, 'day')),
  ])
  return { buckets: current.buckets, models: current.models, total: current.total, prevTotal: prev.total }
}

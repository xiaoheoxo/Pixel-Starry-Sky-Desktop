// 账号调用的合计换成本机记录同样的 UsageSummary（docs/ui/usage.md §9.4），卡片、图表、分布表直接复用。
// 账号调用没有「轮次」：每次请求算一条记录、一轮；金额都是实扣，所以 costKnown = costActual = 请求数。
import { SPEED_MIN_GEN_MS, type RemoteCall, type RemoteUsageStat, type RemoteUsageSummary } from '@pixelsky/protocol'
import { emptyTotals, heatmapDays, mergeTotals, outputSpeed, rangeWindow, summarize, totalTokens } from './aggregate'
import type { UsageBucket, UsageGroupRow, UsageRangeId, UsageSummary, UsageTotals } from './types'

export function statTotals(s: RemoteUsageStat): UsageTotals {
  return {
    input: s.input,
    cacheRead: s.cacheRead,
    cacheWrite: s.cacheWrite,
    output: s.output,
    costUsd: s.costUsd,
    costKnown: s.requests,
    costActual: s.requests,
    records: s.requests,
    turns: s.requests,
    requests: s.requests,
  }
}

export function toUsageSummary(remote: RemoteUsageSummary, range: UsageRangeId, now: number): UsageSummary {
  // 格子和本机记录一样（没有调用的格子补 0）
  const grid = summarize([], range, {}, now)
  const buckets = grid.buckets.map(b => ({ ...b, costActual: 0 }))
  for (const r of remote.buckets) {
    // 云端按服务器时区分天；落在本机第一格之前的（时区差几小时）算进第一格
    let i = buckets.length - 1
    while (i > 0 && buckets[i].start > r.start) i--
    if (buckets.length > 0) mergeTotals(buckets[i], statTotals(r))
  }
  const models: UsageGroupRow[] = remote.models
    .map(m => ({ ...statTotals(m), key: m.model }))
    .sort((a, b) => totalTokens(b) - totalTokens(a))
  return {
    totals: statTotals(remote.total),
    prevTotals: statTotals(remote.prevTotal),
    bucket: grid.bucket,
    buckets,
    groups: { model: models, project: [], engine: [], route: [], cost: [], session: [] },
  }
}

/** 热力图：云端按天的格子 → 最近 53 周每一天 */
export function remoteDays(remote: RemoteUsageSummary, now: number): UsageBucket[] {
  return heatmapDays(
    remote.buckets.map(b => ({ ...statTotals(b), start: b.start })),
    now,
  )
}

/** 首字晚于耗时的这个比例：输出大多在首字前就生成了（思考不可见、上游整段返回），首字后的时间不代表生成时间 */
const LATE_FIRST_TOKEN = 0.8

/** 一次调用的输出时间：从首字到结束；非流式、没有首字、失败的，以及首字后太短的量不了（docs/ui/usage-learn.md §7） */
function callGenMs(c: RemoteCall): number | null {
  if (!c.stream || c.status !== 'success' || c.firstTokenMs === null) return null
  const ms = c.durationMs - c.firstTokenMs
  return ms >= SPEED_MIN_GEN_MS && c.firstTokenMs <= c.durationMs * LATE_FIRST_TOKEN ? ms : null
}

/** 一次调用的速度；输出太少时没有 */
export function callSpeed(c: RemoteCall): number | null {
  const genMs = callGenMs(c)
  return genMs === null ? null : outputSpeed({ genMs, genOutput: c.output })
}

export type CallTiming = Pick<UsageTotals, 'genMs' | 'genOutput' | 'firstTokenMs' | 'firstTokens'>

/** 云端没有按模型的速度和首字：用最近一批调用算（docs/ui/usage-learn.md §1.3） */
export function callTiming(calls: RemoteCall[]): { total: CallTiming; models: Map<string, CallTiming> } {
  const total: CallTiming = {}
  const models = new Map<string, CallTiming>()
  const add = (t: CallTiming, c: RemoteCall, genMs: number | null) => {
    if (genMs !== null) {
      t.genMs = (t.genMs ?? 0) + genMs
      t.genOutput = (t.genOutput ?? 0) + c.output
    }
    if (c.stream && c.status === 'success' && c.firstTokenMs !== null) {
      t.firstTokenMs = (t.firstTokenMs ?? 0) + c.firstTokenMs
      t.firstTokens = (t.firstTokens ?? 0) + 1
    }
  }
  for (const c of calls) {
    const genMs = callGenMs(c)
    add(total, c, genMs)
    let m = models.get(c.model)
    if (!m) models.set(c.model, (m = {}))
    add(m, c, genMs)
  }
  return { total, models }
}

export function withCallTiming(summary: UsageSummary, timing: ReturnType<typeof callTiming>): UsageSummary {
  return {
    ...summary,
    totals: { ...summary.totals, ...timing.total },
    groups: {
      ...summary.groups,
      model: summary.groups.model.map(r => ({ ...r, ...timing.models.get(r.key) })),
    },
  }
}

function emptyStat(): RemoteUsageStat {
  const { requests, input, output, cacheRead, cacheWrite, costUsd } = emptyTotals()
  return { requests, input, output, cacheRead, cacheWrite, costUsd }
}

function addCall(s: RemoteUsageStat, c: RemoteCall): void {
  s.requests += 1
  s.input += c.input
  s.output += c.output
  s.cacheRead += c.cacheRead
  s.cacheWrite += c.cacheWrite
  s.costUsd += c.costUsd ?? 0
}

/** 演示模式：把假调用记录按云端接口的样子合计 */
export function summarizeCalls(
  calls: RemoteCall[],
  range: UsageRangeId,
  model: string | null,
  now: number,
): RemoteUsageSummary {
  const w = rangeWindow(range, now)
  const starts = summarize([], range, {}, now).buckets.map(b => b.start)
  const total = emptyStat()
  const prevTotal = emptyStat()
  const buckets = new Map<number, RemoteUsageStat & { start: number }>()
  const models = new Map<string, RemoteUsageStat & { model: string }>()
  for (const c of calls) {
    if (model !== null && c.model !== model) continue
    if (c.createdAt >= w.prevFrom && c.createdAt < w.from) addCall(prevTotal, c)
    if (c.createdAt < w.from || c.createdAt > now) continue
    addCall(total, c)
    const start = starts.findLast(s => s <= c.createdAt) ?? w.from
    let b = buckets.get(start)
    if (!b) buckets.set(start, (b = { ...emptyStat(), start }))
    addCall(b, c)
    let m = models.get(c.model)
    if (!m) models.set(c.model, (m = { ...emptyStat(), model: c.model }))
    addCall(m, c)
  }
  return {
    buckets: [...buckets.values()].sort((a, b) => a.start - b.start),
    models: [...models.values()],
    total,
    prevTotal,
  }
}

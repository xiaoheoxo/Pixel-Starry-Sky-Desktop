// 用量与调用记录（docs/ui/usage.md §2、§6）：记录的类型 + 汇总 / 分页 / CSV 的纯函数。
// 引擎层（UsageStore）和界面（演示模式）共用，同一份规则。

export type UsageRoute = 'cli' | 'pixelsky' | 'api-key' | 'unknown'
export type UsageOutcome = 'completed' | 'interrupted' | 'failed'

/** 一条记录 = 一轮对话里一个模型的用量 */
export interface UsageRecord {
  costSource?: import('./billing').CostSource
  billing?: import('./billing').BillingSource
  v: 1
  /** 会话ID:轮次ID:模型，唯一 */
  id: string
  sessionId: string
  turnId: string
  startedAt: number
  endedAt: number
  /** 这一轮总耗时（毫秒） */
  durationMs: number
  /** 记录时的会话标题 */
  sessionTitle: string
  project: string | null
  engine: string
  model: string
  route: UsageRoute
  requests?: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 引擎报告的费用（美元）；不报告时为 null */
  costUsd: number | null
  /**
   * 旧的云端记录没有请求 ID 对不上实扣，事后按时间对账号调用补录（docs/ui/usage.md §11.2）：
   * 'time' = 按时间对上，金额是实扣；'none' = 对过但没对上，不再重试
   */
  costMatch?: 'time' | 'none'
  outcome: UsageOutcome
  /** 量到的输出时间（毫秒）和这段时间的输出量；旧记录和量不准的引擎没有（docs/ui/usage-learn.md §1.1） */
  genMs?: number
  genOutput?: number
  /** 这一轮从开始到第一次收到内容（毫秒） */
  firstTokenMs?: number
}

export type UsageRangeId = 'today' | '7d' | '30d' | '90d'
export type UsageDimension = 'model' | 'project' | 'engine' | 'route' | 'cost' | 'session'

/** 筛选条件：每个维度一个值，可以叠加；费用情况（cost）多一个值 'missing' = 所有没有费用的记录 */
export type UsageFilter = Partial<Record<UsageDimension, string>>

/**
 * 费用情况（docs/ui/usage.md §12，GitHub #22）：没有费用的记录为什么没有。
 * 不写盘，读取时从 route / costSource / costMatch / token 推出来，旧记录也能归类。
 * - known：有费用
 * - pending：平台线路等结算（补录对过没对上的不算，见 platform）
 * - empty：没用到 token（一开始就中断或出错）；平台线路不算这个（平台可能照样扣了费），归 platform
 * - platform：平台线路在账单里没对上（重试完没查到、旧记录还没补录、补录没对上）；不拿估算代替（D052）
 * - no-price：自定义 API 的模型对不上官方价格，也没选计价参照
 * - engine：引擎没报费用（例如 Codex）
 */
export type CostState = 'known' | 'pending' | 'empty' | 'platform' | 'no-price' | 'engine'
export const COST_STATES: readonly CostState[] = ['known', 'pending', 'empty', 'platform', 'no-price', 'engine']
/** 费用情况筛选里「所有没有费用的记录」 */
export const COST_MISSING = 'missing'

export function costState(r: UsageRecord): CostState {
  if (r.costUsd !== null) return 'known'
  if (r.route === 'pixelsky' && r.costSource === 'pending' && r.costMatch !== 'none') return 'pending'
  if (r.route === 'pixelsky') return 'platform'
  if (totalTokens(r) === 0) return 'empty'
  if (r.route === 'api-key') return 'no-price'
  return 'engine'
}

export interface UsageTotals {
  /** Known charges supplied by the platform, without estimation. */
  costActual?: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 有费用的记录的费用合计 */
  costUsd: number
  /** 有费用的记录条数（小于 records 时，费用合计是下限，显示「≥」） */
  costKnown: number
  records: number
  /** 轮次数（同一轮的多个模型算一轮） */
  turns: number
  requests: number
  /** 失败的记录条数；旧版远端和账号调用没有这个字段（不是 0） */
  failed?: number
  /** 有输出时间的部分：合计算速度用，旧记录不算进来 */
  genMs?: number
  genOutput?: number
  /** 有首字的条数和首字合计，算平均用 */
  firstTokenMs?: number
  firstTokens?: number
}

export interface UsageBucket extends UsageTotals {
  /** 这一格的开始时间（毫秒） */
  start: number
}

export interface UsageGroupRow extends UsageTotals {
  /** 按会话时是原始会话 ID（筛选用，远端机器上没有机器前缀） */
  key: string
  /** 按会话（docs/ui/usage.md §13）：会话 ID。字段名叫 sessionId，远端响应经 identity.ts 自动加机器前缀，打开会话用它 */
  sessionId?: string
  /** 按会话：最近一条记录里的标题和项目（记录时的快照） */
  title?: string
  project?: string | null
  /** 按会话：「其余 N 个会话」汇总行，N 在这里；不能点 */
  others?: number
}

/** 按会话最多列出的行数，其余合成一行（§13） */
export const SESSION_ROWS_MAX = 50
export const SESSION_OTHERS_KEY = '__others__'

export interface UsageSummary {
  totals: UsageTotals
  /** 上一个同样长度的时间段，用于 ▲ / ▼ 比较 */
  prevTotals: UsageTotals
  /** 「今天」按小时，其余按天 */
  bucket: 'hour' | 'day'
  buckets: UsageBucket[]
  groups: Record<UsageDimension, UsageGroupRow[]>
}

export interface UsagePage {
  records: UsageRecord[]
  total: number
  offset: number
}

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

export interface TimeWindow {
  from: number
  to: number
  prevFrom: number
  bucket: 'hour' | 'day'
}

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 时间范围：「今天」从本地零点到现在；N 天包含今天 */
export function rangeWindow(range: UsageRangeId, now: number): TimeWindow {
  const today = startOfDay(now)
  if (range === 'today') return { from: today, to: now, prevFrom: today - DAY, bucket: 'hour' }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const from = startOfDay(today - (days - 1) * DAY + HOUR) // +1 小时：避开夏令时边界
  return { from, to: now, prevFrom: from - days * DAY, bucket: 'day' }
}

export function emptyTotals(): UsageTotals {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
    costKnown: 0,
    records: 0,
    turns: 0,
    requests: 0,
    failed: 0,
  }
}

const OPTIONAL_SUMS = ['costActual', 'failed', 'genMs', 'genOutput', 'firstTokenMs', 'firstTokens'] as const

/** 把 s 加进 t；可选字段两边都没有时还是没有 */
export function mergeTotals(t: UsageTotals, s: UsageTotals): void {
  t.input += s.input
  t.cacheRead += s.cacheRead
  t.cacheWrite += s.cacheWrite
  t.output += s.output
  t.costUsd += s.costUsd
  t.costKnown += s.costKnown
  t.records += s.records
  t.turns += s.turns
  t.requests += s.requests
  for (const k of OPTIONAL_SUMS) if (s[k] !== undefined) t[k] = (t[k] ?? 0) + s[k]
}

/** 单条输出少于这么多 token 时不算速度：太短算出来不准 */
export const SPEED_MIN_OUTPUT = 100

/** 每秒输出多少 token；没有量到时为 null */
export function outputSpeed(t: { genMs?: number; genOutput?: number }): number | null {
  if (!t.genMs || !t.genOutput || t.genOutput < SPEED_MIN_OUTPUT) return null
  return (t.genOutput / t.genMs) * 1000
}

/** 平均首字（毫秒）；没有时为 null */
export function averageFirstToken(t: Pick<UsageTotals, 'firstTokenMs' | 'firstTokens'>): number | null {
  return t.firstTokens ? (t.firstTokenMs ?? 0) / t.firstTokens : null
}

/** 成功率：中断的不算失败；旧版远端没有 failed 时为 null */
export function successRate(t: Pick<UsageTotals, 'failed' | 'records'>): number | null {
  return t.failed === undefined || t.records === 0 ? null : 1 - t.failed / t.records
}

function add(t: UsageTotals, r: UsageRecord, turns: Set<string>): void {
  t.input += r.input
  t.cacheRead += r.cacheRead
  t.cacheWrite += r.cacheWrite
  t.output += r.output
  t.requests += r.requests ?? 0
  t.records += 1
  if (r.outcome === 'failed') t.failed = (t.failed ?? 0) + 1
  if (r.genMs && r.genOutput) {
    t.genMs = (t.genMs ?? 0) + r.genMs
    t.genOutput = (t.genOutput ?? 0) + r.genOutput
  }
  if (r.firstTokenMs !== undefined) {
    t.firstTokenMs = (t.firstTokenMs ?? 0) + r.firstTokenMs
    t.firstTokens = (t.firstTokens ?? 0) + 1
  }
  if (r.costUsd !== null) {
    t.costUsd += r.costUsd
    t.costKnown += 1
    if (r.costSource === 'platform') t.costActual = (t.costActual ?? 0) + 1
  }
  const key = `${r.sessionId}:${r.turnId}`
  if (!turns.has(key)) {
    turns.add(key)
    t.turns += 1
  }
}

function matches(r: UsageRecord, filter: UsageFilter): boolean {
  for (const [dim, value] of Object.entries(filter) as Array<[UsageDimension, string | undefined]>) {
    if (value === undefined) continue
    if (dim === 'cost' && value === COST_MISSING ? r.costUsd !== null : dimValue(r, dim) !== value) return false
  }
  return true
}

/** 记录在某个维度上的值；项目为空时归为「未归属项目」 */
export function dimValue(r: UsageRecord, dim: UsageDimension): string {
  if (dim === 'project') return r.project ?? ''
  if (dim === 'cost') return costState(r)
  if (dim === 'session') return r.sessionId
  return r[dim]
}

/** 总 token：输入 + 缓存读 + 缓存写 + 输出 */
export function totalTokens(t: Pick<UsageTotals, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output
}

/** 缓存命中率 = 缓存读 / 全部输入；没有输入时为 null */
export function cacheHitRate(t: Pick<UsageTotals, 'input' | 'cacheRead' | 'cacheWrite'>): number | null {
  const all = t.input + t.cacheRead + t.cacheWrite
  return all > 0 ? t.cacheRead / all : null
}

export function summarize(records: UsageRecord[], range: UsageRangeId, filter: UsageFilter, now: number): UsageSummary {
  const w = rangeWindow(range, now)
  const totals = emptyTotals()
  const prevTotals = emptyTotals()
  const turns = new Set<string>()
  const prevTurns = new Set<string>()

  // 时间格：没有数据的格子也要有（柱状图补 0）
  const step = w.bucket === 'hour' ? HOUR : DAY
  const buckets: UsageBucket[] = []
  const bucketTurns: Array<Set<string>> = []
  for (let t = w.from; t <= w.to; t = w.bucket === 'hour' ? t + HOUR : startOfDay(t + DAY + HOUR)) {
    buckets.push({ ...emptyTotals(), start: t })
    bucketTurns.push(new Set())
  }

  const groupMaps: Record<UsageDimension, Map<string, { row: UsageGroupRow; turns: Set<string> }>> = {
    model: new Map(),
    project: new Map(),
    engine: new Map(),
    route: new Map(),
    cost: new Map(),
    session: new Map(),
  }
  const sessionLatest = new Map<string, number>()

  for (const r of records) {
    if (!matches(r, filter)) continue
    if (r.endedAt >= w.prevFrom && r.endedAt < w.from) add(prevTotals, r, prevTurns)
    if (r.endedAt < w.from || r.endedAt > w.to) continue
    add(totals, r, turns)
    // 找到所在的格子（按天时用本地日期，跨夏令时也正确）
    let i = Math.floor((r.endedAt - w.from) / step)
    if (w.bucket === 'day') {
      i = buckets.findIndex(
        (b, k) => r.endedAt >= b.start && (k === buckets.length - 1 || r.endedAt < buckets[k + 1].start),
      )
    }
    if (i >= 0 && i < buckets.length) add(buckets[i], r, bucketTurns[i])
    for (const dim of Object.keys(groupMaps) as UsageDimension[]) {
      const key = dimValue(r, dim)
      let g = groupMaps[dim].get(key)
      if (!g) {
        g = { row: { ...emptyTotals(), key }, turns: new Set() }
        groupMaps[dim].set(key, g)
      }
      add(g.row, r, g.turns)
      if (dim === 'session' && r.endedAt >= (sessionLatest.get(key) ?? 0)) {
        sessionLatest.set(key, r.endedAt)
        Object.assign(g.row, { sessionId: r.sessionId, title: r.sessionTitle, project: r.project })
      }
    }
  }

  const sortRows = (m: Map<string, { row: UsageGroupRow }>) =>
    [...m.values()].map(g => g.row).sort((a, b) => totalTokens(b) - totalTokens(a))

  return {
    totals,
    prevTotals,
    bucket: w.bucket,
    buckets,
    groups: {
      model: sortRows(groupMaps.model),
      project: sortRows(groupMaps.project),
      engine: sortRows(groupMaps.engine),
      route: sortRows(groupMaps.route),
      cost: sortRows(groupMaps.cost),
      session: sessionRows(groupMaps.session),
    },
  }
}

/** 按会话：费用从高到低（没费用的按 token），只留前 SESSION_ROWS_MAX 个，其余合成一行（§13） */
function sessionRows(m: Map<string, { row: UsageGroupRow }>): UsageGroupRow[] {
  const all = [...m.values()].map(g => g.row).sort((a, b) => b.costUsd - a.costUsd || totalTokens(b) - totalTokens(a))
  if (all.length <= SESSION_ROWS_MAX) return all
  const rest = all.slice(SESSION_ROWS_MAX)
  const others: UsageGroupRow = { ...emptyTotals(), key: SESSION_OTHERS_KEY, others: rest.length }
  for (const r of rest) mergeTotals(others, r)
  return [...all.slice(0, SESSION_ROWS_MAX), others]
}

/** 热力图的周数：今天所在的一周算最后一列 */
export const HEATMAP_WEEKS = 53

/** 热力图第一天：52 周前那一周的周一（周一开头，和界面一列 7 格对齐） */
export function heatmapStart(now: number): number {
  const today = startOfDay(now)
  const weekday = (new Date(today).getDay() + 6) % 7
  return startOfDay(today - (52 * 7 + weekday) * DAY + HOUR)
}

/** 按本地日期合计；只有有记录的日子。同一轮跨模型算一轮 */
export function groupByDay(records: UsageRecord[], filter: UsageFilter): UsageBucket[] {
  const days = new Map<number, { bucket: UsageBucket; turns: Set<string> }>()
  for (const r of records) {
    if (!matches(r, filter)) continue
    const start = startOfDay(r.endedAt)
    let d = days.get(start)
    if (!d) days.set(start, (d = { bucket: { ...emptyTotals(), start }, turns: new Set() }))
    add(d.bucket, r, d.turns)
  }
  return [...days.values()].map(d => d.bucket)
}

/** 热力图的每一天（第一天到今天，没记录的补 0）；parts 可以来自多个文件或云端，同一天的合起来 */
export function heatmapDays(parts: UsageBucket[], now: number): UsageBucket[] {
  const out: UsageBucket[] = []
  const index = new Map<number, number>()
  for (let t = heatmapStart(now); t <= now; t = startOfDay(t + DAY + HOUR)) {
    index.set(t, out.length)
    out.push({ ...emptyTotals(), start: t })
  }
  for (const p of parts) {
    const i = index.get(startOfDay(p.start))
    if (i !== undefined) mergeTotals(out[i], p)
  }
  return out
}

/** 明细：最新在前，分页 */
export function listRecords(
  records: UsageRecord[],
  range: UsageRangeId,
  filter: UsageFilter,
  now: number,
  offset: number,
  limit: number,
): UsagePage {
  const w = rangeWindow(range, now)
  const all = records
    .filter(r => r.endedAt >= w.from && r.endedAt <= w.to && matches(r, filter))
    .sort((a, b) => b.endedAt - a.endedAt)
  return { records: all.slice(offset, offset + limit), total: all.length, offset }
}

const OUTCOME_TEXT: Record<UsageRecord['outcome'], string> = {
  completed: '完成',
  interrupted: '已中断',
  failed: '失败',
}

/** CSV（UTF-8 带 BOM，Excel 直接打开不乱码） */
export function toCsv(records: UsageRecord[]): string {
  const head = [
    '时间',
    '会话',
    '项目',
    '引擎',
    '模型',
    '线路',
    '请求次数',
    '输入',
    '缓存读',
    '缓存写',
    '输出',
    '费用(USD)',
    '耗时(秒)',
    '结果',
  ]
  const esc = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = (t: number) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }
  const rows = records.map(r =>
    [
      time(r.endedAt),
      r.sessionTitle,
      r.project ?? '',
      r.engine,
      r.model,
      r.route,
      r.requests ?? '',
      r.input,
      r.cacheRead,
      r.cacheWrite,
      r.output,
      r.costUsd === null ? '' : r.costUsd.toFixed(r.costSource === 'platform' ? 6 : 4),
      (r.durationMs / 1000).toFixed(1),
      OUTCOME_TEXT[r.outcome],
    ]
      .map(esc)
      .join(','),
  )
  return '﻿' + [head.join(','), ...rows].join('\r\n') + '\r\n'
}

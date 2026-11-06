// 用量与调用记录（docs/ui/usage.md §2、§6.2）
//
// <dataDir>/usage/usage-YYYY-MM.jsonl：每一轮 × 每个模型一条记录，按月分文件、只追加，保留 400 天（够一年热力图）。
// 汇总、分页、CSV 都用 @pixelsky/protocol 里的纯函数，和界面演示模式的规则一致。
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  groupByDay,
  heatmapDays,
  heatmapStart,
  listRecords,
  rangeWindow,
  summarize,
  toCsv,
  type UsageBucket,
  type UsageFilter,
  type UsagePage,
  type UsageRangeId,
  type UsageRecord,
  type UsageSummary,
} from '@pixelsky/protocol'

/** 保留天数 */
export const USAGE_RETENTION_DAYS = 400
const DAY = 24 * 60 * 60 * 1000
const FILE = /^usage-(\d{4})-(\d{2})\.jsonl$/

export interface UsageQuery {
  range: UsageRangeId
  filter: UsageFilter
  /** 毫秒时间戳（界面传入，保证和它显示的「今天」一致） */
  now: number
}

function monthKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 按天合计的缓存最多留多少份（文件 × 筛选条件） */
const DAILY_CACHE_MAX = 128

export class UsageStore {
  readonly dir: string
  /** 一年的记录不能每次都读一遍：文件没变就用上次的按天合计（主进程，读文件是同步的） */
  private dailyCache = new Map<string, { stamp: string; days: UsageBucket[] }>()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'usage')
    mkdirSync(this.dir, { recursive: true })
  }

  /** 追加记录（按结束时间所在的月份分文件） */
  append(records: UsageRecord[]): void {
    const byMonth = new Map<string, string[]>()
    for (const r of records) {
      const key = monthKey(r.endedAt)
      byMonth.set(key, [...(byMonth.get(key) ?? []), JSON.stringify(r)])
    }
    for (const [key, lines] of byMonth)
      appendFileSync(join(this.dir, `usage-${key}.jsonl`), lines.join('\n') + '\n', 'utf8')
  }

  private files(): Array<{ name: string; year: number; month: number }> {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    return names.flatMap(name => {
      const m = FILE.exec(name)
      return m ? [{ name, year: Number(m[1]), month: Number(m[2]) }] : []
    })
  }

  /** 读出结束时间不早于 from 的记录；同一个 id 只保留最后一条 */
  load(from: number): UsageRecord[] {
    const start = new Date(from)
    const startKey = start.getFullYear() * 12 + start.getMonth()
    const byId = new Map<string, UsageRecord>()
    for (const f of this.files()) {
      if (f.year * 12 + (f.month - 1) < startKey) continue
      this.readInto(f.name, from, byId)
    }
    return [...byId.values()]
  }

  private readInto(name: string, from: number, byId: Map<string, UsageRecord>): void {
    let text: string
    try {
      text = readFileSync(join(this.dir, name), 'utf8')
    } catch {
      return
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as UsageRecord
        if (r && typeof r.id === 'string' && r.endedAt >= from)
          byId.set(
            r.id,
            r.route === 'pixelsky' && !r.costSource ? { ...r, costUsd: null, costSource: 'unavailable' } : r,
          )
      } catch {
        // 跳过写坏的行
      }
    }
  }

  /** 热力图：最近 53 周每天的合计 */
  daily(q: { filter: UsageFilter; now: number }): UsageBucket[] {
    const from = heatmapStart(q.now)
    const start = new Date(from)
    const startKey = start.getFullYear() * 12 + start.getMonth()
    const filterKey = JSON.stringify(q.filter)
    const parts: UsageBucket[] = []
    for (const f of this.files()) {
      if (f.year * 12 + (f.month - 1) < startKey) continue
      let stamp: string
      try {
        const s = statSync(join(this.dir, f.name))
        stamp = `${s.mtimeMs}:${s.size}`
      } catch {
        continue
      }
      const key = `${f.name}\n${filterKey}`
      let cached = this.dailyCache.get(key)
      if (cached?.stamp !== stamp) {
        const byId = new Map<string, UsageRecord>()
        this.readInto(f.name, 0, byId)
        if (this.dailyCache.size >= DAILY_CACHE_MAX) this.dailyCache.clear()
        cached = { stamp, days: groupByDay([...byId.values()], q.filter) }
        this.dailyCache.set(key, cached)
      }
      parts.push(...cached.days)
    }
    return heatmapDays(parts, q.now)
  }

  summary(q: UsageQuery): UsageSummary {
    const w = rangeWindow(q.range, q.now)
    return summarize(this.load(w.prevFrom), q.range, q.filter, q.now)
  }

  list(q: UsageQuery & { offset: number; limit: number }): UsagePage {
    const w = rangeWindow(q.range, q.now)
    return listRecords(this.load(w.from), q.range, q.filter, q.now, q.offset, q.limit)
  }

  csv(q: UsageQuery): string {
    const w = rangeWindow(q.range, q.now)
    return toCsv(listRecords(this.load(w.from), q.range, q.filter, q.now, 0, Number.MAX_SAFE_INTEGER).records)
  }

  clear(): void {
    this.dailyCache.clear()
    for (const f of this.files()) rmSync(join(this.dir, f.name), { force: true })
  }

  /** 删掉整个月都在保留期之前的文件（启动时调用） */
  prune(now = Date.now()): void {
    const cutoff = now - USAGE_RETENTION_DAYS * DAY
    for (const f of this.files()) {
      const monthEnd = new Date(f.year, f.month, 1).getTime() // 下个月 1 号零点
      if (monthEnd <= cutoff) rmSync(join(this.dir, f.name), { force: true })
    }
  }
}

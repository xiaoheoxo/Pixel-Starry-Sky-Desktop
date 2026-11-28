// Claude Code 的 /goal（docs/ui/claude-goal.md）：stdout 只有一句「Goal set: …」，状态只记在会话记录里
// （type: "attachment"、attachment.type: "goal_status"）。从记录末尾倒着读最近那条，换成 SessionGoal
import type { SessionGoal } from '@pixelsky/protocol'
import { scanBack } from './transcript'

/** 目标状态最多往回读这么多：进行中每次检查都会写一条新的，比这更早的就当没有目标 */
const GOAL_SCAN_BYTES = 4 * 1024 * 1024

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const time = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

/** 会话记录里的一条 goal_status；不是时 null */
interface GoalStatusEntry {
  condition: string
  met: boolean
  failed: boolean
  /** 设目标（met=false）或清除（met=true）时 Claude Code 写的标记条目，不是检查结果 */
  sentinel: boolean
  reason: string
  iterations: number | null
  durationMs: number | null
  tokens: number | null
  at: number
}

export function goalStatusEntry(entry: Rec): GoalStatusEntry | null {
  if (entry.type !== 'attachment') return null
  const a = obj(entry.attachment)
  if (a.type !== 'goal_status' || typeof a.condition !== 'string' || !a.condition.trim()) return null
  return {
    condition: a.condition.trim(),
    met: a.met === true,
    failed: a.failed === true,
    sentinel: a.sentinel === true,
    reason: typeof a.reason === 'string' ? a.reason.trim() : '',
    iterations: num(a.iterations),
    durationMs: num(a.durationMs),
    tokens: num(a.tokens),
    at: time(entry.timestamp),
  }
}

/**
 * 从新到旧的 goal_status 条目算出当前目标：最新一条定状态（清除了就是 null），往前找设这个目标的那条拿开始时间，
 * 最近一条检查结果当「上次检查」
 */
export function claudeGoal(newestFirst: GoalStatusEntry[]): SessionGoal | null {
  const latest = newestFirst[0]
  if (!latest || (latest.sentinel && latest.met)) return null
  const same = newestFirst.filter(e => e.condition === latest.condition)
  const set = same.find(e => e.sentinel && !e.met)
  const check = same.find(e => !e.sentinel)
  const done = !latest.sentinel && (latest.met || latest.failed)
  const startedAt = set?.at || (done && latest.durationMs !== null ? latest.at - latest.durationMs : 0)
  return {
    objective: latest.condition,
    status: done ? (latest.met ? 'complete' : 'blocked') : 'active',
    tokensUsed: done ? (latest.tokens ?? 0) : 0,
    tokenBudget: null,
    timeUsedSeconds: done && latest.durationMs !== null ? Math.round(latest.durationMs / 1000) : 0,
    updatedAt: latest.at,
    ...(startedAt ? { startedAt } : {}),
    ...(done && latest.iterations !== null ? { turns: latest.iterations } : {}),
    ...(check?.reason ? { lastCheck: { reason: check.reason, at: check.at, met: check.met } } : {}),
  }
}

/** 读会话记录末尾，返回当前目标；没有目标、文件读不了时 null */
export function readClaudeGoal(file: string): SessionGoal | null {
  const seen: GoalStatusEntry[] = []
  try {
    scanBack(
      file,
      entry => {
        const e = goalStatusEntry(entry)
        if (!e) return null
        seen.push(e)
        const latest = seen[0]
        // 最新一条是清除：不用再往前读；找到设这个目标的那条就够了
        if (latest.sentinel && latest.met) return true
        return e.sentinel && !e.met && e.condition === latest.condition ? true : null
      },
      GOAL_SCAN_BYTES,
    )
  } catch {
    return null
  }
  return claudeGoal(seen)
}

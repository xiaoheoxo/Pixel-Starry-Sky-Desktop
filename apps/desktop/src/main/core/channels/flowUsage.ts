// 流程步骤的用量（docs/ui/channels-pipeline.md §10.1）：按步骤记下的轮次从用量记录里加总，口径和用量页一样。纯函数
import { costState, type UsageRecord } from '@pixelsky/protocol'
import type { FlowStep, FlowUsage } from '../../../shared/types/channels'

/** 步骤记的轮次：会话 id + 轮次 id（和用量记录的 sessionId、turnId 对得上） */
export const turnKey = (sessionId: string, turnId: string): string => `${sessionId}:${turnId}`

export const emptyUsage = (): FlowUsage => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  costUsd: 0,
  costKnown: 0,
  records: 0,
  turns: 0,
  unrecorded: 0,
  why: {},
})

/** 一步的用量：只算 keys 里的轮次（共用会话的成员不能按整个会话算） */
export function sumUsage(records: readonly UsageRecord[], keys: readonly string[]): FlowUsage {
  const want = new Set(keys)
  const found = new Set<string>()
  const u = emptyUsage()
  for (const r of records) {
    const key = turnKey(r.sessionId, r.turnId)
    if (!want.has(key)) continue
    found.add(key)
    u.input += r.input
    u.cacheRead += r.cacheRead
    u.cacheWrite += r.cacheWrite
    u.output += r.output
    u.records += 1
    if (r.costUsd !== null) {
      u.costUsd += r.costUsd
      u.costKnown += 1
      if (r.costSource === 'platform') u.costActual = (u.costActual ?? 0) + 1
    } else {
      const why = costState(r)
      u.why[why] = (u.why[why] ?? 0) + 1
    }
  }
  u.turns = want.size
  u.unrecorded = want.size - found.size
  return u
}

/** 几步加起来（各步骤的轮次不重叠） */
export function addUsage(a: FlowUsage, b: FlowUsage): FlowUsage {
  const why = { ...a.why }
  for (const [k, n] of Object.entries(b.why) as [keyof FlowUsage['why'], number][]) why[k] = (why[k] ?? 0) + n
  const actual = (a.costActual ?? 0) + (b.costActual ?? 0)
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    costUsd: a.costUsd + b.costUsd,
    costKnown: a.costKnown + b.costKnown,
    ...(actual ? { costActual: actual } : {}),
    records: a.records + b.records,
    turns: a.turns + b.turns,
    unrecorded: a.unrecorded + b.unrecorded,
    why,
  }
}

/** 整条流程的已知花费（下限，花费上限用） */
export const knownCost = (steps: readonly FlowStep[]): number => steps.reduce((n, s) => n + (s.usage?.costUsd ?? 0), 0)

/** 成员 / 频道的用量（docs/ui/channels-local-rest.md §3.2）：30 天、今天（today 起的记录）、耗时（每轮取一次 durationMs） */
export function rangeUsage(
  records: readonly UsageRecord[],
  keys: readonly string[],
  today: number,
): { month: FlowUsage; today: FlowUsage; ms: number } {
  const want = new Set(keys)
  const mine = records.filter(r => want.has(turnKey(r.sessionId, r.turnId)))
  const ms = new Map<string, number>()
  for (const r of mine) {
    const k = turnKey(r.sessionId, r.turnId)
    ms.set(k, Math.max(ms.get(k) ?? 0, r.durationMs))
  }
  const recent = mine.filter(r => r.endedAt >= today)
  return {
    month: sumUsage(mine, keys),
    today: sumUsage(recent, [...new Set(recent.map(r => turnKey(r.sessionId, r.turnId)))]),
    ms: [...ms.values()].reduce((a, b) => a + b, 0),
  }
}

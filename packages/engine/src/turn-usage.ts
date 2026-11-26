// 一轮用量按模型累加（子智能体、晚到的用量共用，docs/ui/usage.md §14）
import type { ModelTurnUsage } from '@pixelsky/protocol'

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 加进 models[model]；cost 为 null 是不知道费用（加上后整个模型的费用也记成不知道） */
export function addModelUsage(
  models: Record<string, ModelTurnUsage>,
  model: string,
  counts: TokenCounts,
  cost: number | null,
  requests?: number,
): void {
  const m = (models[model] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: cost === null ? null : 0 })
  m.input += counts.input
  m.cacheRead += counts.cacheRead
  m.cacheWrite += counts.cacheWrite
  m.output += counts.output
  m.costUsd = cost === null || m.costUsd === null ? null : (m.costUsd ?? 0) + cost
  if (requests !== undefined) m.requests = (m.requests ?? 0) + requests
}

/** 两份按模型的用量合在一起（late 加进 into，返回 into） */
export function mergeModelUsage(
  into: Record<string, ModelTurnUsage>,
  late: Record<string, ModelTurnUsage>,
): Record<string, ModelTurnUsage> {
  for (const [model, m] of Object.entries(late)) addModelUsage(into, model, m, m.costUsd ?? null, m.requests)
  return into
}

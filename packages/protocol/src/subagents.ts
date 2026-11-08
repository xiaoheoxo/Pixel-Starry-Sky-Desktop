import type { Effort } from './types/base'

/** 用户为本会话后续子任务指定的配置。缺省沿用类型；null 跟随主会话。model 只选主会话当前通道。 */
export interface SubagentOverride {
  type: string
  model?: string | null
  effort?: Effort | null
}

export const SUBAGENT_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const subagentEffort = (value: unknown): Effort | null =>
  SUBAGENT_EFFORTS.includes(value as Effort) ? (value as Effort) : null

/** IPC 与读盘共用；不接收路线或密钥，模型能否用由派活时的网关再校验。 */
export function parseSubagentOverrides(value: unknown): SubagentOverride[] {
  if (!Array.isArray(value)) return []
  const result: SubagentOverride[] = []
  for (const raw of value.slice(0, 20)) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(raw.type))
      continue
    if (result.some(x => x.type === raw.type)) continue
    const item: SubagentOverride = { type: raw.type }
    if (raw.model === null) item.model = null
    else if (
      typeof raw.model === 'string' &&
      raw.model.length <= 200 &&
      raw.model.trim() &&
      !/\s/.test(raw.model) &&
      ![...raw.model].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      item.model = raw.model
    if (raw.effort === null || subagentEffort(raw.effort)) item.effort = subagentEffort(raw.effort)
    if ('model' in item || 'effort' in item) result.push(item)
  }
  return result
}

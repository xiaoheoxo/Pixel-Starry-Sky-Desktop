// Pixel CLI 扩展与桌面适配器共用的约定。纯协议，独立 CLI 可以直接导入。
import type { GoalAction, SessionGoal } from './types/goal'

export const PIXEL_GOAL_COMMAND = 'pixelsky-goal'
export const PIXEL_GOAL_STATUS = 'pixelsky-goal'
export const PIXEL_GOAL_ENTRY = 'pixelsky-goal'
export const PIXEL_GOAL_CONTINUE = 'pixelsky-goal-continue'
export const PIXEL_GOAL_CONTEXT = 'pixelsky-goal-context'
export type PixelGoalAction = GoalAction | { kind: 'hold' }

export interface PixelGoalReport {
  version: 1
  goal: SessionGoal | null
  req?: string
  error?: string
}

/** 扩展状态和保存的目标都走同一校验；损坏的状态不能被当成「已清除」。 */
export function pixelGoalReport(value: unknown): PixelGoalReport | null {
  if (!value || typeof value !== 'object') return null
  const r = value as PixelGoalReport
  if (r.version !== 1 || (r.req !== undefined && typeof r.req !== 'string')) return null
  if (r.error !== undefined && typeof r.error !== 'string') return null
  if (r.goal === null) return r
  const g = r.goal
  if (!g || typeof g !== 'object' || typeof g.objective !== 'string' || !g.objective.trim()) return null
  if (!['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(g.status)) return null
  if (![g.tokensUsed, g.timeUsedSeconds, g.updatedAt].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0))
    return null
  if (g.tokenBudget !== null && (!Number.isSafeInteger(g.tokenBudget) || g.tokenBudget <= 0)) return null
  return r
}

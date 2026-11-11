// Codex 目标模式（docs/ui/codex-goal.md）：thread/goal/* 返回的 ThreadGoal 换成 SessionGoal，判断是不是旧版没有这组接口
import type { GoalStatus, SessionGoal } from '@pixelsky/protocol'
import { object, string } from './process'
export { sameGoal } from '@pixelsky/protocol'

const STATUSES: readonly GoalStatus[] = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** ThreadGoal → SessionGoal；不是目标（没有目标文字、状态不认识）返回 null。Codex 的时间是秒，界面要毫秒 */
export function codexGoal(raw: unknown): SessionGoal | null {
  const g = object(raw)
  const objective = string(g.objective).trim()
  const status = string(g.status) as GoalStatus
  if (!objective || !STATUSES.includes(status)) return null
  const updated = num(g.updatedAt)
  return {
    objective,
    status,
    tokensUsed: num(g.tokensUsed),
    tokenBudget: typeof g.tokenBudget === 'number' && Number.isFinite(g.tokenBudget) ? g.tokenBudget : null,
    timeUsedSeconds: num(g.timeUsedSeconds),
    updatedAt: updated && updated < 1e12 ? updated * 1000 : updated,
  }
}

/** 旧版 Codex（0.128 以前）或关了 goals 开关：thread/goal/* 不认识 */
export function goalUnsupported(error: unknown): boolean {
  return /unknown variant|unknown method|method not found|not supported|-32601|goals? (?:feature|are|is) (?:disabled|not enabled)/i.test(
    (error as Error)?.message ?? String(error),
  )
}

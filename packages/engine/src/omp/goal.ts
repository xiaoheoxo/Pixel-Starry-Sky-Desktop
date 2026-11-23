// oh-my-pi 的目标（docs/omp-engine.md §13.1）和内置命令的输出（§13.0）：omp 的格式换成我们的
import type { GoalStatus, SessionGoal } from '@pixelsky/protocol'
import { number, object, string } from '../pixel/process'

const STATUS: Record<string, GoalStatus> = {
  active: 'active',
  paused: 'paused',
  complete: 'complete',
  'budget-limited': 'budgetLimited',
}

/** goal_updated、goal 命令里的目标；清掉的（dropped）、不认识的返回 null */
export function ompGoal(raw: unknown): SessionGoal | null {
  const g = object(raw)
  const objective = string(g.objective).trim()
  const status = STATUS[string(g.status)]
  if (!objective || !status) return null
  return {
    objective,
    status,
    tokensUsed: number(g.tokensUsed),
    tokenBudget: number(g.tokenBudget) || null,
    timeUsedSeconds: number(g.timeUsedSeconds),
    updatedAt: number(g.updatedAt),
  }
}

/** 两个目标是不是同一个状态 */
export function sameGoal(a: SessionGoal | null, b: SessionGoal | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// eslint-disable-next-line no-control-regex
export const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

/** 这么多行以内的直接显示 */
const OUTPUT_LINES = 10

/** 内置命令的输出：去掉终端颜色；短的直接显示，长的第一行当标题、全文折叠 */
export function ompOutput(raw: string): { text: string; detail: string | null } | null {
  const text = raw.replace(ANSI, '').trim()
  if (!text) return null
  const lines = text.split('\n')
  return lines.length > OUTPUT_LINES ? { text: lines[0]!.trim(), detail: text } : { text, detail: null }
}

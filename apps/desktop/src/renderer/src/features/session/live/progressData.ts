// 进度卡片的数据（docs/ui/progress-card.md §2、§3）：当前计划、子智能体行、这一轮的 key
import type { AgentRuns, Item, SubagentStatus, TodoStep } from '@pixelsky/protocol'
import { runState, type RunState } from './agentTrace'
import { agentSteps, type AgentStep } from './agentActivity'

export interface Plan {
  id: string
  steps: TodoStep[]
  done: number
  /** 上一轮没做完的，不算进度（docs/ui/progress-card.md §11） */
  carried?: TodoStep[]
}

export interface ProgressAgent {
  id: string
  label: string
  state: RunState
  model: string
  type: string
  message: string | null
  startedAt: number
  durationMs: number
  /** 后台子智能体（只有它们能单独停） */
  background: boolean
  /** 「正在做什么」那一行的来源（agentActivity.ts）：最新进度摘要、结束时的结果、任务说明 */
  summary?: string
  result?: string
  task?: string
  /** 它调用过的工具（对话里带 subagentCall 的条目），按先后；后台子智能体的不一定有 */
  steps: AgentStep[]
}

/** 新的一轮：用户自己发、送到了的消息。引导、断线重连 / 额度恢复后自动发的「继续」（都带 reconnect）、没送达的都不算 */
const isTurnStart = (item: Item): boolean =>
  item.kind === 'user' && item.mode !== 'guidance' && item.reconnect === undefined && !item.dismissed

/** 最近一轮的 key：最后一条开始新一轮的用户消息的 id（还没有时为空字符串） */
export function turnKey(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) if (isTurnStart(items[i])) return items[i].id
  return ''
}

/**
 * 要显示的计划：最新一条待办，属于最近一轮；或者是上一轮没做完的、会话正在运行（你说「继续」时还看得到）。
 * 再往前的不显示：额度用完、中断后没勾完的旧计划，不能在之后每次回复时都冒出来
 */
export function currentPlan(items: Item[], running: boolean): Plan | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'todo' || item.steps.length === 0) continue
    const done = item.steps.filter(s => s.status === 'completed').length
    const later = items.slice(i + 1).filter(isTurnStart).length
    if (later === 0 || (running && later === 1 && done < item.steps.length))
      return { id: item.id, steps: item.steps, done, ...(item.carried?.length ? { carried: item.carried } : {}) }
    return null
  }
  return null
}

/** 子智能体条的状态和进度，按 id 合并追踪里的模型、类型和时间 */
export function progressAgents(
  subagents: SubagentStatus[],
  runs: AgentRuns | undefined,
  items: readonly Item[] = [],
): ProgressAgent[] {
  const byId = new Map((runs?.agents ?? []).filter(a => a.id).map(a => [a.id, a]))
  const steps = agentSteps(items)
  return subagents.map(a => {
    const run = byId.get(a.id)
    const call = a.toolUseId ?? run?.toolUseId
    const task = a.task || run?.prompt
    return {
      id: a.id,
      label: a.label || run?.label || a.id.slice(0, 8),
      state: runState(a.status),
      model: run?.model ?? '',
      type: run?.type ?? '',
      message: a.message,
      startedAt: run?.startedAt ?? 0,
      durationMs: run?.durationMs ?? 0,
      background: a.background === true,
      ...(a.summary ? { summary: a.summary } : {}),
      ...(a.result ? { result: a.result } : {}),
      ...(task ? { task } : {}),
      steps: (call && steps.get(call)) || [],
    }
  })
}

/** 做完几步起收成一行：只做完一步时收起来也是一行，不如直接写是哪一步 */
const FOLD_DONE_FROM = 2

/** 已完成的步骤能不能收成一行：全做完时列全，看得到做了什么 */
export const canFoldDone = (plan: Plan): boolean => plan.done >= FOLD_DONE_FROM && plan.done < plan.steps.length

/** 这一轮计划的结果（写在执行那一行上，docs/ui/progress-card.md §11）：stoppedAt 是没做完时停在哪一步 */
export function planResult(items: readonly Item[]): { done: number; total: number; stoppedAt: string | null } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'todo' || item.steps.length === 0) continue
    const done = item.steps.filter(s => s.status === 'completed').length
    const at = item.steps.find(s => s.status === 'in_progress') ?? item.steps.find(s => s.status !== 'completed')
    return { done, total: item.steps.length, stoppedAt: at?.text ?? null }
  }
  return null
}

/** 当前步骤（进行中的第一个）的下标；没有时 -1 */
export const activeStep = (steps: TodoStep[]): number => steps.findIndex(s => s.status === 'in_progress')

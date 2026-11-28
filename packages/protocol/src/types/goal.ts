// 目标模式（Codex /goal，docs/ui/codex-goal.md）：线程有一个目标时引擎自己一轮接一轮地做，直到完成、暂停、卡住或用完预算

/** active 进行中；paused 已暂停；blocked 卡住了；usageLimited 额度用完；budgetLimited 预算用完；complete 已完成 */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete'

export interface SessionGoal {
  objective: string
  status: GoalStatus
  tokensUsed: number
  /** 预算（token）；没设为 null */
  tokenBudget: number | null
  timeUsedSeconds: number
  /** 毫秒 */
  updatedAt: number
  /**
   * 设目标的时间（毫秒）。Claude Code 的目标（docs/ui/claude-goal.md）进行中不报用量，用时由界面按它现算；
   * 没有时省略
   */
  startedAt?: number | null
  /** 一共做了几轮（Claude Code 完成 / 做不到时才给）；没有时省略 */
  turns?: number | null
  /** Claude Code 上一次检查条件的说明（英文原文）、时间（毫秒）、那次算不算达成；还没检查过时省略 */
  lastCheck?: { reason: string; at: number; met: boolean } | null
}

/** 输入框的 /goal 和目标栏的按钮：get 看当前目标；set 换成新目标（进行中）；pause / resume / clear */
export type GoalAction =
  | { kind: 'get' }
  | { kind: 'set'; objective: string }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }

/**
 * engine:goal 的错误代码（codedError）：引擎进程没在跑 / 这个会话现在的引擎没有目标模式。
 * 输入框遇到这两个就把 /goal 按普通消息发（进程起来后由 Codex 会话处理；Claude Code 有自己的 /goal）
 */
export const GOAL_NO_PROCESS = 'engine.goalNoProcess'
export const GOAL_NO_ENGINE = 'engine.goalNoEngine'

const ACTIONS = new Set(['pause', 'resume', 'clear'])

/**
 * 解析输入框里的 /goal（不是 /goal 开头返回 null）：`/goal` 看当前目标；`/goal pause|resume|clear`；
 * 其他的整段当新目标（去掉首尾空白，换行保留）
 */
export function parseGoalCommand(text: string): GoalAction | null {
  const m = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (!rest) return { kind: 'get' }
  const word = rest.toLowerCase()
  if (ACTIONS.has(word)) return { kind: word as 'pause' | 'resume' | 'clear' }
  return { kind: 'set', objective: rest }
}

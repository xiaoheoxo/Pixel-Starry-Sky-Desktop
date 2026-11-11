// 目标模式（Codex / Pixel）：会话有目标时引擎持续执行，直到完成、暂停、卡住或用完预算

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
}

/** 输入框的 /goal 和目标栏的按钮：get 看当前目标；set 换成新目标（进行中）；pause / resume / clear */
export type GoalAction =
  | { kind: 'get' }
  | { kind: 'set'; objective: string; tokenBudget?: number | null }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }

/**
 * engine:goal 的错误代码（codedError）：引擎进程没在跑 / 这个会话现在的引擎没有目标模式。
 * 输入框遇到这两个就把 /goal 按普通消息发（进程起来后由 Codex 会话处理；Claude Code 有自己的 /goal）
 */
export const GOAL_NO_PROCESS = 'engine.goalNoProcess'
export const GOAL_NO_ENGINE = 'engine.goalNoEngine'

/** 两个目标是不是同一个状态（界面要不要重画）。 */
export function sameGoal(a: SessionGoal | null, b: SessionGoal | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 引擎和独立 CLI 共用的目标提示；桌面端按原文翻译。 */
export const GOAL_TEXT = {
  goalSet: (objective: string, engine = 'Codex') =>
    `已设目标：${objective}。${engine}${engine === '像素星空' ? '' : ' '}会一轮接一轮地做，直到完成；输入 /goal pause 暂停，/goal clear 清除`,
  goalWaiting: 'Codex 已经记下目标，会自己接着做',
  goalNone: '这个对话没有目标。输入 /goal 加上要达成的目标来设一个',
  goalShow: (objective: string, status: string) => `当前目标（${status}）：${objective}`,
  goalPaused: '目标已暂停',
  goalResumed: '目标继续进行',
  goalCleared: '目标已清除',
  goalComplete: (objective: string) => `目标已完成：${objective}`,
  goalBlocked: (objective: string, engine = 'Codex') =>
    `目标卡住了，${engine}${engine === '像素星空' ? '' : ' '}需要你帮忙：${objective}`,
  goalUsageLimited: '额度用完了，目标先停下',
  goalBudgetLimited: '目标的 token 预算用完了',
  goalUnsupported: '这个 Codex 版本没有目标模式（/goal），请更新到 0.128 以上',
  goalPixelUnsupported: '这个像素星空命令行版本没有目标模式，请更新像素星空或使用自带的命令行',
  goalImages: '目标只能是文字，/goal 不能带图片',
  goalBudgetResume: '目标的 token 预算已用完，请修改目标并设置新的预算后继续',
  goalStatus: {
    active: '进行中',
    paused: '已暂停',
    blocked: '卡住了',
    usageLimited: '额度用完',
    budgetLimited: '预算用完',
    complete: '已完成',
  },
} as const

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

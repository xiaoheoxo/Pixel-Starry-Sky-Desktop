// 进行中的任务卡「正在做什么」（docs/ui/channels-local-ai.md §3.1 #2）：和进度卡片子智能体那一行同一套说法（agentActivity.ts）。
// AI 最近说的一句比最近一步新时写那一句，否则写最近一步（带几秒前）；悬停看完整的一句和最近 3 步。纯函数。
import type { ChannelTask } from '@/data/types'
import type { ChannelStep } from '../../../../shared/types/channels'
import { agentActivity, type Activity, type AgentStep } from '@/features/session/live/agentActivity'

export interface TaskActivity {
  line: Activity
  /** 给 activityTooltip 的最近几步（先后顺序） */
  steps: AgentStep[]
  /** 每一步第一次看到的时间 */
  seen: (id: string) => number
}

/** 任务卡上的一步只带了显示要用的字段，正好是 stepText / stepFull 读的那几个 */
const asStep = (step: ChannelStep): AgentStep => step as unknown as AgentStep

export function taskActivity(task: Pick<ChannelTask, 'status' | 'activity'>): TaskActivity | null {
  if (task.status !== 'running' || !task.activity) return null
  const { steps, say } = task.activity
  const last = steps.at(-1)
  const summary = say && (!last || say.at >= last.at) ? say.text : undefined
  const line = agentActivity({ state: 'running', summary }, steps.map(asStep))
  if (!line) return null
  const at = new Map(steps.map(s => [s.id, s.at]))
  return { line, steps: steps.map(asStep), seen: id => at.get(id) ?? Date.now() }
}

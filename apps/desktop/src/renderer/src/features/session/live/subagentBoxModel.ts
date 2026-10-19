// 子智能体小框的数据（docs/ui/subagent-box.md §3）：派发的工具调用 / 后台任务完成的提示 + 追踪里的运行记录 → 小框要显示的内容。纯函数，SubagentBox 和测试共用
import type {
  AgentRun,
  AgentRuns,
  ApprovalRequest,
  Item,
  ItemStatus,
  NoticeTask,
  WorkflowRun,
} from '@pixelsky/protocol'
import { elapsed, runState, shortModel, type RunState } from './agentTrace'
import type { TraceTarget } from './trace'
import { tr } from '../../../i18n/core'

/** 后台任务结束提示按界面语言写的文字（引擎给的 text 是中文，只用于导出和旧界面）：类型 + 状态 + 摘要 */
export function taskNoticeText(task: NoticeTask): string {
  const head = tr(`subagent.notice.${task.status}`, { kind: tr(`subagent.notice.${task.kind}`) })
  return task.summary ? tr('subagent.notice.withSummary', { text: head, summary: task.summary }) : head
}

export type BoxIcon = 'bot' | 'workflow' | 'terminal'
/** approval：子智能体在等你批准 */
export type BoxState = RunState | 'approval'

export interface BoxModel {
  icon: BoxIcon
  /** 任务名；为空时界面写默认名 */
  label: string
  /** 模型短名；没有为空 */
  model: string
  fullModel: string
  /** 子智能体的类型名（像素星空，设置 › 子智能体）；没有为空 */
  typeLabel: string
  state: BoxState
  /** 开始时间（毫秒时间戳，0：不知道）和已报告的时长，运行中用 now 往前走 */
  startedAt: number
  durationMs: number
  /** Workflow 编排里的智能体个数；其余为 null */
  agents: number | null
  /** 点了打开追踪里的哪里；null：不能点 */
  target: TraceTarget | null
  /** 结束时的摘要（完成小框的悬停提示） */
  summary: string
}

type ToolItem = Extract<Item, { kind: 'tool' }>

/** 条目状态 → 小框状态 */
function itemState(status: ItemStatus): RunState {
  switch (status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return 'stopped'
  }
}

const NONE: AgentRuns = { workflows: [], agents: [] }

/** 小框上的用时：运行中从开始时间走到现在；没有时间时为 0（不显示） */
export const boxElapsed = (model: Pick<BoxModel, 'startedAt' | 'durationMs' | 'state'>, now: number): number =>
  elapsed(model, model.state === 'approval' ? 'running' : model.state, now)

/**
 * Codex 派出子智能体的调用：派出去就返回了（子智能体在后台接着跑），条目完成不代表子智能体跑完。
 * 引擎把 collab 的派出调用（tool 为 spawnAgent）记成 spawn_agent；等待 / 发消息 / 关闭沿用原名，只看条目自己的状态
 */
const CODEX_SPAWN = /^spawn_agent$/

/** 派发小框：主智能体的 Agent / Task / Workflow 调用，以及 Codex 派出子智能体的调用 */
export function dispatchBox(item: ToolItem, runs: AgentRuns = NONE, approval = false): BoxModel {
  const workflow: WorkflowRun | undefined =
    item.name === 'Workflow' ? runs.workflows.find(w => w.toolUseId === item.id) : undefined
  const agent: AgentRun | undefined = workflow ? undefined : runs.agents.find(a => a.toolUseId === item.id)
  const run = workflow ?? agent
  // 条目已经结束就以条目为准；还在跑时看运行记录（后台子智能体的条目要等它真正结束才收尾）。
  // Codex 派出成功只说明派出去了，有运行记录时看子智能体自己的状态
  const state: RunState =
    item.status === 'completed' && agent && CODEX_SPAWN.test(item.name)
      ? runState(agent.state)
      : item.status !== 'running'
        ? itemState(item.status)
        : run
          ? runState(workflow ? workflow.status : agent!.state)
          : 'running'
  return {
    icon: item.name === 'Workflow' ? 'workflow' : 'bot',
    label: item.title,
    model: agent?.model ? shortModel(agent.model) : '',
    fullModel: agent?.model ?? '',
    typeLabel: agent?.typeLabel ?? '',
    state: approval && state === 'running' ? 'approval' : state,
    startedAt: run?.startedAt ?? 0,
    durationMs: run?.durationMs ?? 0,
    agents: workflow ? workflow.agents.length : null,
    target: { toolUseId: item.id },
    summary: '',
  }
}

const TASK_ICON: Record<NoticeTask['kind'], BoxIcon> = {
  agent: 'bot',
  remote_agent: 'bot',
  workflow: 'workflow',
  bash: 'terminal',
  monitor: 'terminal',
}

/** 完成小框：后台任务结束的提示（引擎带的结构化信息） */
export function completionBox(task: NoticeTask, runs: AgentRuns = NONE): BoxModel {
  const id = task.toolUseId
  const workflow = id && task.kind === 'workflow' ? runs.workflows.find(w => w.toolUseId === id) : undefined
  const agent = id && !workflow ? runs.agents.find(a => a.toolUseId === id) : undefined
  const run = workflow ?? agent
  const traceable = !!id && (task.kind === 'agent' || task.kind === 'workflow' || task.kind === 'remote_agent')
  return {
    icon: TASK_ICON[task.kind],
    label: task.label || agent?.label || workflow?.name || '',
    model: agent?.model ? shortModel(agent.model) : '',
    fullModel: agent?.model ?? '',
    typeLabel: agent?.typeLabel ?? '',
    state: task.status === 'completed' ? 'done' : task.status === 'failed' ? 'failed' : 'stopped',
    startedAt: 0,
    // 结束了：只用报告的时长，不再往前走
    durationMs: run?.durationMs ?? 0,
    agents: workflow ? workflow.agents.length : null,
    target: traceable ? { toolUseId: id } : null,
    summary: task.summary ?? '',
  }
}

/**
 * 正在等你批准的派发：子智能体的工具要批准时，批准请求对应的是它自己的工具条目（带派出它的 Agent 调用 id），
 * 小框状态写「等你批准」。返回这些 Agent 调用的 id
 */
export function approvalWaiting(items: readonly Item[], pending: readonly ApprovalRequest[]): Set<string> {
  const out = new Set<string>()
  if (pending.length === 0) return out
  const ids = new Set(pending.map(p => p.itemId).filter((id): id is string => !!id))
  for (const item of items)
    if (ids.has(item.id) && (item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool'))
      if (item.subagentCall) out.add(item.subagentCall)
  return out
}

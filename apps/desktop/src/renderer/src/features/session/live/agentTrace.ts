import { tr } from '../../../i18n/core'
// 智能体追踪的显示规则（参考 JuCode agentTrace.ts）：状态归类、共用时间轴、数字格式
import type { AgentRun, WorkflowRun } from '@pixelsky/protocol'

export type RunState = 'running' | 'done' | 'failed' | 'stopped' | 'queued'

export const RUN_STATE_LABEL: Record<RunState, string> = {
  get running() {
    return tr('session.live.agentTrace.running')
  },
  get done() {
    return tr('session.live.agentTrace.completed')
  },
  get failed() {
    return tr('session.live.agentTrace.failed')
  },
  get stopped() {
    return tr('session.live.agentTrace.stopped')
  },
  get queued() {
    return tr('session.live.agentTrace.queued')
  },
}

/** 引擎的各种状态词（done、completed、killed、pending …）归成五种 */
export function runState(state: string): RunState {
  switch (state) {
    case 'running':
    case 'thinking':
    case 'inProgress':
    case 'needsInput':
    case 'start':
    case 'started':
    case 'async_launched':
      return 'running'
    case 'done':
    case 'completed':
    case 'success':
      return 'done'
    case 'failed':
    case 'error':
    case 'errored':
    case 'notFound':
    case 'not_found':
      return 'failed'
    case 'stopped':
    case 'killed':
    case 'cancelled':
    case 'skipped':
    case 'interrupted':
    case 'shutdown':
      return 'stopped'
    case 'pendingInit':
    case 'pending_init':
      return 'queued'
    default:
      return state ? 'queued' : 'done'
  }
}

/** 已用时间：报告的时长；运行中时取「从开始到现在」 */
export function elapsed(run: { startedAt: number; durationMs: number }, state: RunState, now: number): number {
  if (state === 'running' && run.startedAt > 0) return Math.max(run.durationMs, now - run.startedAt)
  return run.durationMs
}

/** 1.8 秒、12 秒、2 分 05 秒、1 小时 02 分 */
export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return tr('session.live.agentTrace.n0s')
  const s = ms / 1000
  if (s < 60) return tr('session.live.agentTrace.s', { p0: s < 10 ? s.toFixed(1) : Math.round(s) })
  const m = Math.floor(s / 60)
  if (m < 60) return tr('session.live.agentTrace.mS', { p0: m, p1: String(Math.round(s % 60)).padStart(2, '0') })
  return tr('session.live.agentTrace.hM', { p0: Math.floor(m / 60), p1: String(m % 60).padStart(2, '0') })
}

/** 28,470 */
export const formatCount = (n: number): string => Math.round(n).toLocaleString('en-US')

/**
 * 列表里的短模型名：去掉厂商前缀、[1m] 标记和 claude-（GitHub #38），完整名放在悬停提示里。
 * claude-sonnet-5-5 → sonnet-5-5；anthropic/claude-v4.1flash[1m] → v4.1flash
 */
export const shortModel = (model: string): string =>
  model
    .replace(/\[1m\]$/i, '')
    .replace(/^.*\//, '')
    .replace(/^claude-/, '') || model

/** 编排的智能体按阶段分组（不在任何阶段里的放最后） */
export function byPhase(run: WorkflowRun): { title: string; agents: AgentRun[] }[] {
  const groups = run.phases.map(p => ({ index: p.index, title: p.title, agents: [] as AgentRun[] }))
  const rest: AgentRun[] = []
  for (const a of run.agents) {
    const g = groups.find(x => x.index === a.phase)
    if (g) g.agents.push(a)
    else rest.push(a)
  }
  const out = groups.filter(g => g.agents.length > 0).map(({ title, agents }) => ({ title, agents }))
  if (rest.length > 0) out.push({ title: '', agents: rest })
  return out
}

/**
 * 一个阶段的状态（阶段那一行的图标、默认展开）：有失败的算失败，有跑着的算跑着，全没开始算排队，
 * 有完成也有没开始的（中间等着）算跑着，有停掉的算停止，其余完成
 */
export function phaseState(agents: readonly Pick<AgentRun, 'state'>[]): RunState {
  const states = agents.map(a => runState(a.state))
  if (states.includes('failed')) return 'failed'
  if (states.includes('running')) return 'running'
  if (states.length > 0 && states.every(s => s === 'queued')) return 'queued'
  if (states.includes('queued')) return 'running'
  if (states.includes('stopped')) return 'stopped'
  return 'done'
}

/** 跑着的和有失败的阶段默认展开，其余收起（只看圆点） */
export const phaseOpenByDefault = (state: RunState): boolean => state === 'running' || state === 'failed'

export interface PhaseView {
  /** 阶段名；编排没分阶段、或不在任何阶段里的为空 */
  title: string
  agents: AgentRun[]
  state: RunState
  /** 完成了几个（失败、停掉的不算） */
  done: number
  /** 每个智能体一个圆点 */
  dots: RunState[]
  /** 这个阶段都用同一个模型时写在表头；不同时为空，每行自己写 */
  model: string
}

/** 编排的阶段（docs/ui/agent-trace-phases.md）：状态、圆点、完成数、共用的模型 */
export function phaseViews(run: WorkflowRun): PhaseView[] {
  return byPhase(run).map(({ title, agents }) => {
    const models = new Set(agents.map(a => a.model))
    const dots = agents.map(a => runState(a.state))
    return {
      title,
      agents,
      state: phaseState(agents),
      done: dots.filter(s => s === 'done').length,
      dots,
      model: models.size === 1 ? [...models][0] : '',
    }
  })
}

/** 阶段里先列这么多个智能体 */
export const PHASE_ROWS = 8

/** 阶段里列哪些：不超过 8 个全列；多了先列跑着、失败、停掉的，再按先后补满 8 个，其余收进「还有 N 个」 */
export function phaseRows(agents: readonly AgentRun[], all: boolean): { shown: AgentRun[]; hidden: number } {
  if (all || agents.length <= PHASE_ROWS) return { shown: [...agents], hidden: 0 }
  const urgent = new Set(agents.filter(a => !['done', 'queued'].includes(runState(a.state))))
  for (const a of agents) {
    if (urgent.size >= PHASE_ROWS) break
    urgent.add(a)
  }
  const shown = agents.filter(a => urgent.has(a))
  return { shown, hidden: agents.length - shown.length }
}

export function anyRunning(workflows: WorkflowRun[], agents: AgentRun[]): boolean {
  return workflows.some(w => runState(w.status) === 'running') || agents.some(a => runState(a.state) === 'running')
}

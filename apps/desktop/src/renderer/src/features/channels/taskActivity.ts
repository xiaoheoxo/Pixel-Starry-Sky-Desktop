// 进行中的任务卡「正在做什么」：和进度卡片子智能体那一行同一套说法（agentActivity.ts）。
// taskActivity：一句话和最近一步（拟计划时用）；activityView：状态条下面显示的几行（docs/ui/channels-live-activity.md）。纯函数。
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import type { ChannelTask } from '@/data/types'
import type { ChannelStep } from '../../../../shared/types/channels'
import { agentActivity, type Activity, type AgentStep } from '@/features/session/live/agentActivity'
import {
  STEP_CLOCK_MS,
  WAIT_CLOCK_MS,
  TURN_CLOCK_MS,
  baseName,
  firstLine,
  stepText,
} from '@/features/session/live/currentStep'

export interface TaskActivity {
  line: Activity
  /** 给 activityTooltip 的最近几步（先后顺序） */
  steps: AgentStep[]
  /** 每一步第一次看到的时间 */
  seen: (id: string) => number
}

/** 任务卡上的一步只带了显示要用的字段，正好是 stepText / stepFull 读的那几个 */
const asStep = (step: Pick<ChannelStep, 'kind'>): AgentStep => step as unknown as AgentStep

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

/** 一共显示几行步骤（包括「现在」） */
export const ACTIVITY_LINES = 3
/** 做完的一步慢过这么久才写用时，让人看得出时间花在哪 */
export const SLOW_STEP_MS = 10_000

export interface ActivityLine {
  id: string
  /** stopped：活已经结束（失败、断开）时还没做完的那一步，不再转 */
  state: 'running' | 'done' | 'failed' | 'stopped'
  verb: string
  /** 文件名、命令，用等宽字体；说明、子智能体这类整句放在 verb 里 */
  object: string | null
  /** 悬停时的完整内容 */
  full: string
  added?: number
  removed?: number
  exitCode?: number
  /** 子智能体最近在做什么 */
  inner?: string
  /** 还在跑：从什么时候开始、超过多久才写用时 */
  since?: { at: number; min: number }
  /** 做完的慢步骤用了多久 */
  spent?: number
}

export interface ActivityView {
  head: { kind: 'say' | 'plan' | 'error'; text: string; progress?: string } | null
  lines: ActivityLine[]
}

const VERBS = {
  done: {
    command: 'progressLine.verb.command',
    edit: 'progressLine.verb.edit',
    create: 'progressLine.verb.create',
    read: 'progressLine.verb.read',
    search: 'progressLine.verb.search',
    web: 'progressLine.verb.web',
  },
  running: {
    command: 'session.live.verb.command',
    edit: 'session.live.verb.edit',
    create: 'session.live.verb.create',
    read: 'session.live.verb.read',
    search: 'session.live.verb.search',
    web: 'session.live.verb.web',
  },
} as const satisfies Record<string, Record<string, TranslationKey>>

/** 这一步怎么写：动作 + 对象，和对话状态行（liveStep）一样；读文件只写文件名 */
function stepParts(step: ChannelStep, running: boolean): Pick<ActivityLine, 'verb' | 'object' | 'full'> {
  const verb = VERBS[running ? 'running' : 'done']
  switch (step.kind) {
    case 'command': {
      const command = firstLine(step.command)
      const description = step.description?.trim()
      return description
        ? { verb: description, object: null, full: command }
        : { verb: tr(verb.command), object: command, full: command }
    }
    case 'file_change': {
      const full = step.changes.map(c => c.path).join('\n')
      const [only] = step.changes
      if (step.changes.length !== 1) return { verb: stepText(asStep(step)), object: null, full }
      return { verb: tr(only.kind === 'add' ? verb.create : verb.edit), object: baseName(only.path), full }
    }
    case 'tool': {
      const title = firstLine(step.title)
      if (step.tool === 'read') return { verb: tr(verb.read), object: baseName(title) || null, full: title }
      if (step.tool === 'search' || step.tool === 'web')
        return { verb: tr(verb[step.tool]), object: title || null, full: title }
      return { verb: stepText(asStep(step)), object: null, full: title }
    }
  }
}

const plainRead = (s: ChannelStep): s is Extract<ChannelStep, { kind: 'tool' }> =>
  s.kind === 'tool' && s.tool === 'read' && !s.running && !s.failed && !s.stopped

/** 连续读文件合成一行：做完的才合；同一个文件读两次只算一个 */
function mergeReads(steps: readonly ChannelStep[]): Array<{ step: ChannelStep; reads: string[] }> {
  const out: Array<{ step: ChannelStep; reads: string[] }> = []
  for (const step of steps) {
    const last = out.at(-1)
    const title = plainRead(step) ? firstLine(step.title) : ''
    if (!title) out.push({ step, reads: [] })
    else if (last?.reads.length) last.reads = [...new Set([...last.reads, title])]
    else out.push({ step, reads: [title] })
  }
  return out
}

function lineOf({ step, reads }: { step: ChannelStep; reads: string[] }, ended: boolean): ActivityLine {
  const running = step.running && !ended
  const line: ActivityLine = {
    id: step.id,
    state: running ? 'running' : step.failed ? 'failed' : step.running || step.stopped ? 'stopped' : 'done',
    ...stepParts(step, running),
  }
  if (reads.length > 1) {
    const names = reads.slice(0, 2).map(baseName).join(tr('channels.composer.nameSep'))
    line.verb = tr('progressLine.readFiles', { n: reads.length })
    line.object = reads.length > 2 ? tr('progressLine.andMore', { names }) : names
    line.full = reads.join('\n')
  }
  if (step.kind === 'command' && step.exitCode) line.exitCode = step.exitCode
  if (step.kind === 'file_change' && line.state === 'done') {
    line.added = step.changes.reduce((n, c) => n + c.added, 0)
    line.removed = step.changes.reduce((n, c) => n + c.removed, 0)
  }
  if (running) {
    line.since = { at: step.at, min: STEP_CLOCK_MS }
    if (step.inner) line.inner = stepText(asStep(step.inner))
  } else if (reads.length <= 1 && step.endedAt && step.endedAt - step.at >= SLOW_STEP_MS) {
    line.spent = step.endedAt - step.at
  }
  return line
}

/** 第一轮真正开始的时间；追加要求和重试后不算（startedAt 只在第一轮记，中间空着的时间不该算进去） */
const firstRoundStart = (task: Pick<ChannelTask, 'startedAt' | 'round'>): number | null =>
  (task.round ?? 1) > 1 ? null : (task.startedAt ?? null)

export type ViewTask = Pick<ChannelTask, 'status' | 'activity' | 'progress' | 'error' | 'disconnected' | 'ownerId'>

/** 这项活现在该显示的几行；不用显示时为 null（只有进行中和失败的活有） */
export function activityView(task: ViewTask, limit = ACTIVITY_LINES): ActivityView | null {
  const failed = task.status === 'failed'
  if (task.status !== 'running' && !failed) return null
  const activity = task.activity ?? null
  // 团队频道的活：动态不同步到云端（service.ts patchTeam），没有数据时不能一直写「正在思考」
  if (!failed && !activity && task.ownerId) return null
  const ended = failed || !!task.disconnected
  const all = mergeReads(activity?.steps ?? []).map(g => lineOf(g, ended))
  const current = all.filter(l => l.state === 'running')
  const finished = all.filter(l => l.state !== 'running')
  if (!ended && !current.length) {
    // 两步之间在等什么；一步都还没有时在思考（不写用时：状态条上有总用时，重试时开始时间也不准）
    const wait = activity?.wait
    current.push({
      id: 'wait',
      state: 'running',
      verb: tr(`session.wait.${wait?.kind ?? 'thinking'}`),
      object: null,
      full: '',
      ...(wait ? { since: { at: wait.at, min: WAIT_CLOCK_MS } } : {}),
    })
  }
  const room = Math.max(0, limit - current.length)
  const lines = [...(room ? finished.slice(-room) : []), ...current]
  const error = failed && task.error ? translateMessage(task.error) : null
  if (failed && !error && !lines.length) return null
  const head: ActivityView['head'] = error
    ? { kind: 'error', text: error }
    : failed
      ? null
      : activity?.say
        ? { kind: 'say', text: activity.say.text }
        : activity?.plan
          ? {
              kind: 'plan',
              text: activity.plan,
              ...(task.progress ? { progress: `${task.progress.done}/${task.progress.total}` } : {}),
            }
          : null
  return { head, lines }
}

/** 状态条上的总用时；刚开始的几秒不写，追加要求和重试后不算（见 firstRoundStart） */
export function taskElapsed(
  task: Pick<ChannelTask, 'status' | 'startedAt' | 'endedAt' | 'round'>,
  now: number,
): number | null {
  const start = firstRoundStart(task)
  if (start === null) return null
  if (task.status === 'running') return now - start >= TURN_CLOCK_MS ? now - start : null
  if ((task.status === 'done' || task.status === 'failed') && task.endedAt) return task.endedAt - start
  return null
}

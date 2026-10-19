// 协作频道任务的状态跟踪（docs/ui/channels-phase-b.md §5.1）：会话事件 / 会话快照 → 任务卡的变化。
// 纯函数：输入一项活的运行信息和一个事件，返回新的运行信息、要改的任务卡字段，以及这一轮是不是结束了。
import { diffStat } from '@pixelsky/protocol'
import type { ApprovalRequest, EngineEvent, Item, SessionSnapshot } from '@pixelsky/protocol'
import type { ChannelActivity, ChannelStep, ChannelTask } from '../../../shared/types/channels'

/** 团队频道派来的活（Phase C §9.1）：任务卡在云端，状态写回云端；本机运行信息照存 runs.json */
export interface TeamRunRef {
  teamId: string
  channelId: string
  /** 云端任务卡消息 id（也是 TaskRun.taskId） */
  messageId: string
  /** 频道 AI 成员 id（ta_…）：发结果时用 */
  agentId?: string
  /** 派活的人（owner key）：结果里需要决定时 @ 他 */
  author?: string
  title?: string
  /** 最近一次已处理的追加要求（消息 id） */
  follow?: string | null
  /** 这一轮的收尾（任务卡字段 + 结果消息）还没写回云端时留着，重连后补发 */
  final?: { patch: Record<string, unknown>; result?: { text: string; mentions: string[] } }
}

/** 一项活这一轮的运行信息，存在 runs.json，重启后用来对账 */
export interface TaskRun {
  taskId: string
  channelId: string
  memberId: string
  /** waiting：等成员空出来；sent：已经发给会话；ended：这一轮结束了（留着给重试、追加要求用） */
  phase: 'waiting' | 'sent' | 'ended'
  /** 进入等待的时间：同一个成员的活按它排队 */
  queuedAt: number
  round: number
  sessionId: string | null
  /** 这一轮发给会话的消息 id：`ch-<任务 id>-<轮次>` */
  clientMessageId: string | null
  /** 接着原会话时发的内容 */
  prompt: string
  /** 会话没有了、要新开一个时发的内容（带最近讨论） */
  freshPrompt: string
  /** 这一轮的 user 条目出现过（引擎开始做了） */
  started: boolean
  turnId: string | null
  requests: ApprovalRequest[]
  /** file_change 条目 id → 改动统计 */
  diff: Record<string, { added: number; removed: number }>
  /** 这一轮最后一条 assistant 回复 */
  reply: string | null
  progress: { done: number; total: number } | null
  /** 这一轮「正在做什么」（任务卡上显示）；旧数据没有 */
  activity?: ChannelActivity | null
  /** 这一轮还没做完时追加的要求，做完后接着发 */
  followUps: string[]
  /** 最后一个错误通知（对账时当失败原因） */
  notice: string | null
  /** 团队频道派来的活（本机频道的活没有） */
  team?: TeamRunRef
  /** 这一轮要带上哪些消息的附件（发的时候再读，runs.json 里不存图片） */
  attach?: string[]
  /** 这一轮还没做完时追加的要求带的附件，做完后跟着 followUps 一起发 */
  followUpAttach?: string[]
}

/** 新的一轮运行信息（团队执行端用；本机频道在 service.ts 里自己拼） */
export function newTaskRun(
  init: Pick<TaskRun, 'taskId' | 'channelId' | 'memberId' | 'queuedAt' | 'round' | 'prompt' | 'freshPrompt'> &
    Partial<Pick<TaskRun, 'sessionId' | 'team'>>,
): TaskRun {
  return {
    sessionId: null,
    clientMessageId: null,
    phase: 'waiting',
    started: false,
    turnId: null,
    requests: [],
    diff: {},
    reply: null,
    progress: null,
    followUps: [],
    notice: null,
    ...init,
  }
}

export interface Finish {
  status: 'done' | 'failed' | 'stopped'
  error?: string | null
  note?: 'cancelled' | null
}

export interface Tracked {
  run: TaskRun
  patch: Partial<ChannelTask> | null
  finish: Finish | null
}

export const clientMessageId = (taskId: string, round: number): string => `ch-${taskId}-${round}`

const STARTED = new Set<Item['kind']>(['todo', 'command', 'file_change', 'tool'])

const isRunUser = (run: TaskRun, item: Item): boolean =>
  item.kind === 'user' &&
  !!run.clientMessageId &&
  (item.id === run.clientMessageId || item.id.startsWith(`${run.clientMessageId}-retry-`))

const firstLine = (text: string | null | undefined): string | null => text?.split('\n')[0]?.trim() || null

function progressOf(item: Extract<Item, { kind: 'todo' }>): TaskRun['progress'] {
  if (!item.steps.length) return null
  return { done: item.steps.filter(s => s.status === 'completed').length, total: item.steps.length }
}

/** 任务卡上留最近几步（悬停时列出来） */
export const ACTIVITY_STEPS = 3
/** AI 说的那一句最多这么长（第一行；界面再按宽度省略） */
const SAY_MAX = 200
/** 一步的命令 / 标题最多这么长 */
const STEP_TEXT_MAX = 300

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text)

/** 条目 → 任务卡上的一步；思考、待办等不算 */
function stepOf(item: Item, at: number): ChannelStep | null {
  if (item.kind !== 'command' && item.kind !== 'file_change' && item.kind !== 'tool') return null
  const base = { id: item.id, at, running: item.status === 'running' }
  if (item.kind === 'command')
    return { ...base, kind: 'command', command: clip(item.command, STEP_TEXT_MAX), description: item.description }
  if (item.kind === 'file_change')
    return {
      ...base,
      kind: 'file_change',
      changes: item.changes.slice(0, 20).map(c => ({ kind: c.kind, path: c.path })),
    }
  return { ...base, kind: 'tool', tool: item.tool, name: item.name, title: clip(item.title, STEP_TEXT_MAX) }
}

/** 记下一步：同一步（开始 → 完成）原地更新、保留第一次看到的时间；新的一步接在后面，只留最近几步 */
function withStep(activity: ChannelActivity | null | undefined, step: ChannelStep): ChannelActivity {
  const steps = activity?.steps ?? []
  const i = steps.findIndex(s => s.id === step.id)
  const next =
    i >= 0 ? steps.map((s, j) => (j === i ? { ...step, at: s.at } : s)) : [...steps, step].slice(-ACTIVITY_STEPS)
  return { steps: next, say: activity?.say ?? null }
}

/** 这一轮里的条目：更新回复、改动、进度、正在做什么、错误通知 */
function absorb(run: TaskRun, item: Item, now: number): TaskRun {
  const step = stepOf(item, now)
  if (step) run = { ...run, activity: withStep(run.activity, step) }
  switch (item.kind) {
    case 'assistant': {
      const text = item.text.trim()
      if (!text) return run
      const line = clip(firstLine(text) ?? '', SAY_MAX)
      const say = run.activity?.say?.text === line ? run.activity.say : { text: line, at: now }
      return { ...run, reply: item.text, activity: { steps: run.activity?.steps ?? [], say } }
    }
    case 'file_change': {
      if (item.status === 'running') return run
      // 被拒绝 / 失败的改动没有写到文件上，不算（和会话里的改动卡片一样只算完成的）
      if (item.status !== 'completed') {
        if (!(item.id in run.diff)) return run
        const { [item.id]: _dropped, ...diff } = run.diff
        return { ...run, diff }
      }
      return { ...run, diff: { ...run.diff, [item.id]: diffStat(item.changes) } }
    }
    case 'todo':
      return { ...run, progress: progressOf(item) }
    case 'notice':
      return item.level === 'error' ? { ...run, notice: item.text } : run
    default:
      return run
  }
}

/** 这一轮的改动合计；没有改动时 null */
export function diffTotal(run: Pick<TaskRun, 'diff'>): { added: number; removed: number } | null {
  let added = 0,
    removed = 0
  for (const s of Object.values(run.diff)) {
    added += s.added
    removed += s.removed
  }
  return added || removed ? { added, removed } : null
}

const waitingPatch = (requests: ApprovalRequest[]): Partial<ChannelTask> =>
  requests.length
    ? { status: 'waiting', request: requests[0], waitingCount: requests.length }
    : { status: 'running', request: null, waitingCount: 0 }

/** 一个会话事件。只处理已经发出去的这一轮；别的轮次（用户自己在会话里发的）不管 */
export function trackEvent(run: TaskRun, event: EngineEvent, now = Date.now()): Tracked {
  const none: Tracked = { run, patch: null, finish: null }
  if (run.phase !== 'sent') return none
  if (event.type === 'queue') {
    if (run.started) return none
    const item = event.items.find(q => q.id === run.clientMessageId)
    if (item?.status === 'failed')
      return { run, patch: null, finish: { status: 'failed', error: firstLine(item.error) } }
    // 还没开始就从队列里消失了：在会话里被撤回
    if (!item) return { run, patch: null, finish: { status: 'stopped', note: 'cancelled' } }
    return none
  }
  if (event.type === 'item_completed' && isRunUser(run, event.item)) {
    const next: TaskRun = {
      ...run,
      started: true,
      turnId: (event.item.kind === 'user' && event.item.turnId) || run.turnId,
      requests: [],
      diff: {},
      reply: null,
      progress: null,
      activity: null,
      notice: null,
    }
    return { run: next, patch: { status: 'running', request: null, progress: null, activity: null }, finish: null }
  }
  if (!run.started) return none
  if (event.type === 'turn_started')
    return run.turnId ? none : { run: { ...run, turnId: event.turnId }, patch: null, finish: null }
  if (event.type === 'item_completed' || event.type === 'item_started') {
    // 开始时就要记的：待办进度、正在跑的一步；其余等完成
    if (event.type === 'item_started' && !STARTED.has(event.item.kind)) return none
    const next = absorb(run, event.item, now)
    if (next === run) return none
    const patch: Partial<ChannelTask> = {}
    if (next.progress !== run.progress) patch.progress = next.progress
    if (next.activity !== run.activity) patch.activity = next.activity ?? null
    return { run: next, patch: Object.keys(patch).length ? patch : null, finish: null }
  }
  if (event.type === 'approval_request') {
    if (run.requests.some(r => r.requestId === event.request.requestId)) return none
    const requests = [...run.requests, event.request]
    return { run: { ...run, requests }, patch: waitingPatch(requests), finish: null }
  }
  if (event.type === 'approval_resolved') {
    if (!run.requests.some(r => r.requestId === event.requestId)) return none
    const requests = run.requests.filter(r => r.requestId !== event.requestId)
    return { run: { ...run, requests }, patch: waitingPatch(requests), finish: null }
  }
  if (event.type === 'turn_completed') {
    if (run.turnId && event.turnId !== run.turnId) return none
    const next = { ...run, requests: [] }
    if (event.outcome === 'completed') return { run: next, patch: null, finish: { status: 'done' } }
    if (event.outcome === 'interrupted') return { run: next, patch: null, finish: { status: 'stopped' } }
    return { run: next, patch: null, finish: { status: 'failed', error: firstLine(event.error ?? run.notice) } }
  }
  return none
}

/**
 * 重启 / 重连后对账（§5.1）：按会话快照推算这一轮现在的状态。
 * snapshot 为 null 表示会话已经没有了。
 */
export function reconcileRun(run: TaskRun, snapshot: SessionSnapshot | null, now = Date.now()): Tracked {
  if (run.phase !== 'sent') return { run, patch: null, finish: null }
  if (!snapshot) return { run, patch: null, finish: { status: 'failed', error: '会话已删除' } }
  let at = -1
  for (let i = snapshot.items.length - 1; i >= 0; i--)
    if (isRunUser(run, snapshot.items[i])) {
      at = i
      break
    }
  if (at < 0) {
    const queued = snapshot.queue.find(q => q.id === run.clientMessageId)
    if (queued?.status === 'failed')
      return { run, patch: null, finish: { status: 'failed', error: firstLine(queued.error) } }
    if (queued) return { run, patch: { status: 'queued' }, finish: null }
    return { run, patch: null, finish: { status: 'stopped', note: 'cancelled' } }
  }
  const user = snapshot.items[at] as Extract<Item, { kind: 'user' }>
  let next: TaskRun = {
    ...run,
    started: true,
    turnId: user.turnId ?? run.turnId,
    diff: {},
    reply: null,
    progress: null,
    activity: null,
    notice: null,
  }
  let last = true
  for (const item of snapshot.items.slice(at + 1)) {
    // 下一条不是这一轮的 user 条目：这一轮已经过去了
    if (item.kind === 'user' && item.turnId !== next.turnId) {
      last = false
      break
    }
    next = absorb(next, item, now)
  }
  const active = last && snapshot.state !== 'idle' && (!snapshot.turnId || snapshot.turnId === next.turnId)
  if (active) {
    const requests = snapshot.pending
    return {
      run: { ...next, requests },
      patch: { ...waitingPatch(requests), progress: next.progress, activity: next.activity ?? null },
      finish: null,
    }
  }
  next = { ...next, requests: [] }
  const outcome = last ? snapshot.record.lastOutcome : null
  if (outcome === 'failed')
    return { run: next, patch: null, finish: { status: 'failed', error: firstLine(next.notice) } }
  if (outcome === 'interrupted') return { run: next, patch: null, finish: { status: 'stopped' } }
  return { run: next, patch: null, finish: next.reply ? { status: 'done' } : { status: 'stopped' } }
}

// Claude Code stream-json 输出 → 统一事件（docs/engines.md §9）
//
// 要点：
// - system/init 每一轮都会发一次，从里面拿 session_id；
// - 开了 --include-partial-messages 之后，正文 / 思考先以 stream_event 的增量到达，
//   随后每个内容块各来一条 assistant 消息（带完整内容）。用 message.id + 块序号对应，不能按消息个数；
// - 子 agent（Task 工具）的消息带 parent_tool_use_id，v1 不展开，只显示那一行工具调用；
// - result 每轮正好一条，是一轮结束的标志；里面的花费和 modelUsage 是进程内累计值。
import type {
  BackgroundAgentRef,
  BackgroundTask,
  EngineEvent,
  Item,
  ItemStatus,
  ModelTurnUsage,
  NoticeError,
  NoticeTask,
  PermissionMode,
  SubagentStatus,
  TurnOutcome,
  TurnUsage,
  Usage,
  RequestRetryState,
} from '@pixelsky/protocol'
import { backgroundAgents, estimateCost, officialPrice } from '@pixelsky/protocol'
import { Runs } from './runs'
import { completeToolItem, toolItem } from './tools'
import { RequestCacheReader } from './request-cache'
import { requestRetryState } from './retry-state'
import { ContextReader } from './context'
import { obj, num, str } from './shape'
import { ERROR_TEXT, apiNoticeError, friendlyApiError } from './apiError'

type Msg = Record<string, unknown>
type CompactionItem = Extract<Item, { kind: 'compaction' }>

/** 一个模型的累计用量（Claude modelUsage 里的数字） */
interface UsageCounters {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  cost: number | null
}

const ZERO_COUNTERS: UsageCounters = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 }

/** 子智能体任务说明留多长（进度卡片只显示开头一行） */
const TASK_PREVIEW = 300

/** Claude 的权限模式名 → 我们的 */
export const FROM_CLAUDE_MODE: Record<string, PermissionMode> = {
  default: 'ask',
  acceptEdits: 'edits',
  plan: 'plan',
  bypassPermissions: 'full',
}

interface OpenBlock {
  itemId: string
  kind: 'assistant' | 'reasoning'
  text: string
  done: boolean
}

export interface TranslatorCallbacks {
  emit(e: EngineEvent): void
  sessionId(id: string): void
  permissionMode(mode: PermissionMode): void
  /** 这一轮结束（emit 了 turn_completed 之后调用） */
  turnEnded(outcome: TurnOutcome): void
  /** initialize 回复或 result 里报告的 Fast 模式状态 */
  fastState(state: string, blocked: string): void
}

/** 后台任务结束提示里的类型名 */
const TASK_KIND: Record<string, string> = {
  local_workflow: '多智能体编排',
  local_bash: '后台命令',
  local_agent: '子智能体',
  monitor: '监视任务',
}
const TASK_STATUS: Record<string, string> = { completed: '已完成', failed: '失败', stopped: '已停止' }
/** 跑完会叫醒主线接着干的后台任务；后台命令、监视器可能一直开着（例如开发服务器），不算（docs/ui/notifications.md §7） */
const WAKES_MAIN = ['local_agent', 'local_workflow', 'remote_agent']

/** 后台任务类型 → 结束提示里结构化信息的 kind；认不出的类型不带结构化信息，界面照旧显示文字 */
function noticeTaskKind(kind: string): NoticeTask['kind'] | null {
  const key = Object.keys(NOTICE_TASK_KIND).find(k => kind === k || kind.startsWith(k))
  return key ? NOTICE_TASK_KIND[key] : null
}
const NOTICE_TASK_KIND: Record<string, NoticeTask['kind']> = {
  local_agent: 'agent',
  local_workflow: 'workflow',
  local_bash: 'bash',
  monitor: 'monitor',
  remote_agent: 'remote_agent',
}

export function taskKindLabel(kind: string): string {
  const key = Object.keys(TASK_KIND).find(k => kind === k || kind.startsWith(k))
  return key ? TASK_KIND[key] : '后台任务'
}

interface TaskInfo {
  kind: string
  description: string
  background: boolean
  /** 派出它的 Task / Agent 工具调用 */
  toolUseId: string | null
}

/** 子智能体结束的状态 → 工具行的状态 */
const AGENT_STATUS: Record<string, ItemStatus> = { completed: 'completed', failed: 'failed' }

export class ClaudeTranslator {
  readonly context: ContextReader
  private readonly requestCache: RequestCacheReader
  private turnId: string | null = null
  /** 当前消息 id（message_start 时更新） */
  private messageId = ''
  /** 流式中的正文 / 思考块：key = `${messageId}:${index}` */
  private blocks = new Map<string, OpenBlock>()
  /** 已开始、还没拿到结果的工具调用：key = tool_use.id */
  private tools = new Map<string, Item>()
  /** 用户拒绝过的工具调用（结果标成 declined 而不是 failed） */
  private declined = new Set<string>()
  private usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    contextWindow: null,
    costUsd: null,
  }
  private retry: RequestRetryState | null = null
  /** 这一轮收到的合成报错消息（代码和英文原文），等结果一起出一条提示 */
  private apiError: { code: string; raw: string } | null = null
  private retrySignature = ''
  private seq = 0
  /**
   * 本进程里每个模型的累计用量：Claude 的 result.modelUsage 是**进程内累计值**，
   * 每一轮的用量 = 这次的累计 - 上次的累计。进程重启（空闲回收、崩溃、强制中断后 --resume）时必须清零。
   */
  private usageBase = new Map<string, UsageCounters>()
  /**
   * --resume 起的新进程：Claude Code 会把上次存在项目配置里的累计用量（lastModelUsage，按 lastSessionId）
   * 恢复进来，第一次 result 的累计值可能包含以前所有进程的用量。这时这一轮按逐条请求的用量算，不用累计值。
   */
  private usageRestored = false
  /** 这一轮逐条请求的用量（按消息 ID 去重，取各字段见到的最大值），包括子智能体的请求 */
  private turnTokens = new Map<
    string,
    { model: string; input: number; cacheRead: number; cacheWrite: number; output: number }
  >()
  private lastMessageId = ''
  /** 这一轮每个模型的请求次数（数 message_start，包括子智能体的请求） */
  private turnRequests = new Map<string, number>()
  private turnStartedAt = 0
  /** 主智能体调用过的工具的参数（子智能体的工具行用父工具的 description 当名字） */
  private toolInputs = new Map<string, Msg>()
  /** 子智能体调用中的工具 */
  private subTools = new Map<string, Item>()
  /** 强制结束过这一轮（进程被杀 / 意外退出）：之后迟到的帧不能自己开一轮，等下一次 startTurn */
  private halted = false
  /** 在后台跑的子智能体的 Agent 工具行：key = tool_use.id；「已在后台启动」不算完成，等它的 task_notification */
  private asyncAgents = new Map<string, Item>()
  /** 子智能体工具 → 派出它的 Task / Agent 工具调用 */
  private subParent = new Map<string, string>()
  /** system/task_* 里的任务 */
  private taskInfo = new Map<string, TaskInfo>()
  private bgTasks: BackgroundTask[] = []
  /** 上次报给宿主的后台工作数（background 事件） */
  private backgroundCount = 0
  private subagentList: SubagentStatus[] = []
  /** 连同主智能体一起停的任务 id：它们的「已停止」通知不单独提示 */
  private quietStops = new Set<string>()
  /** 这次压缩（docs/ui/compaction.md）：status 'compacting' 时开始；结果和 compact_boundary 先后不定，都到了才算完 */
  private compaction: CompactionItem | null = null
  /** 压缩完了但 Claude Code 没给压缩后的大小：用下一次请求的上下文占用补上 */
  private compactionSize: CompactionItem | null = null
  readonly runs = new Runs()

  constructor(
    private readonly cwd: string,
    private readonly cb: TranslatorCallbacks,
  ) {
    this.requestCache = new RequestCacheReader(e => this.cb.emit(e))
    this.context = new ContextReader(e => this.cb.emit(e))
  }

  get activeTurn(): string | null {
    return this.turnId
  }

  /**
   * 没有用户消息、引擎自己接着干活（后台任务完成的通知等）：主线开始新的模型请求或开始压缩时，自己开一轮并告诉宿主，
   * 这样状态、统计行、用量和收尾都和普通的一轮一样（docs/ui/conversation-review-2026-10-11.md A1）
   */
  private beginAutoTurn(): void {
    const turnId = this.nextId('turn')
    this.startTurn(turnId)
    this.cb.emit({ type: 'turn_started', turnId })
  }

  startTurn(turnId: string): void {
    this.requestCache.begin(turnId)
    this.turnId = turnId
    this.halted = false
    this.retry = null
    this.apiError = null
    this.retrySignature = ''
    this.turnRequests.clear()
    this.turnTokens.clear()
    this.turnStartedAt = Date.now()
    // 新的一轮：子智能体条只留还在跑的
    const running = this.subagentList.filter(a => a.status === 'running')
    if (running.length !== this.subagentList.length) {
      this.subagentList = running
      this.cb.emit({ type: 'subagents', subagents: [...running] })
    }
  }

  /**
   * 还在后台跑、跑完会叫醒主线的子智能体和编排数，变了就告诉宿主。两处来源取大的：CLI 的后台任务列表
   * （没有 background_tasks_changed 的旧版本为空）和还没等到 task_notification 的后台 Agent 工具行
   */
  private syncBackground(): number {
    const tasks = this.bgTasks.filter(t => WAKES_MAIN.some(k => t.kind.startsWith(k))).length
    const count = Math.max(tasks, this.asyncAgents.size)
    if (count !== this.backgroundCount) {
      this.backgroundCount = count
      this.cb.emit({ type: 'background', count })
    }
    return count
  }

  private emitRuns(): void {
    this.cb.emit({ type: 'runs', runs: this.runs.snapshot() })
  }

  /** 进程退出：后台任务、子智能体都没了，追踪里还在跑的标成已停止 */
  processGone(): void {
    if (this.bgTasks.length > 0) {
      this.bgTasks = []
      this.cb.emit({ type: 'tasks', tasks: [] })
    }
    if (this.subagentList.some(a => a.status === 'running')) {
      this.subagentList = this.subagentList.map(a => (a.status === 'running' ? { ...a, status: 'stopped' } : a))
      this.cb.emit({ type: 'subagents', subagents: [...this.subagentList] })
    }
    if (this.runs.stopAll()) this.emitRuns()
    this.taskInfo.clear()
    this.quietStops.clear()
    for (const id of [...this.subTools.keys()]) this.settleSubTool(id, 'interrupted')
    for (const item of this.asyncAgents.values())
      this.cb.emit({ type: 'item_completed', item: { ...item, status: 'interrupted' } as Item })
    this.asyncAgents.clear()
    this.syncBackground()
  }

  /** 子智能体的工具没等到结果就结束了（这一轮中断、进程退出、子智能体都结束了） */
  private settleSubTool(id: string, status: ItemStatus): void {
    const item = this.subTools.get(id)
    if (!item) return
    this.subTools.delete(id)
    this.subParent.delete(id)
    this.cb.emit({
      type: 'item_completed',
      item: completeToolItem(item, '', false, null, status === 'completed' ? 'interrupted' : status),
    })
  }

  private setSubagent(id: string, patch: Partial<SubagentStatus>): void {
    const i = this.subagentList.findIndex(a => a.id === id)
    const next: SubagentStatus = {
      id,
      label: '',
      status: 'running',
      message: null,
      ...(i >= 0 ? this.subagentList[i] : {}),
      ...patch,
    }
    this.subagentList = i >= 0 ? this.subagentList.map((a, j) => (j === i ? next : a)) : [...this.subagentList, next]
    this.cb.emit({ type: 'subagents', subagents: [...this.subagentList] })
  }

  /** 还在跑的后台子智能体和编排（停止时一起停的对象） */
  backgroundTargets(): BackgroundAgentRef[] {
    return backgroundAgents(this.subagentList, this.bgTasks)
  }

  muteStopNotices(ids: string[]): void {
    for (const id of ids) this.quietStops.add(id)
  }

  /** 这些 id 的停止提示还没到（停止通知还在路上） */
  pendingStopNotices(ids: string[]): boolean {
    return ids.some(id => this.quietStops.has(id))
  }

  /** 停止没成功的：不再静音，之后单独停它时照常提示 */
  unmuteStopNotices(ids: string[]): void {
    for (const id of ids) this.quietStops.delete(id)
  }

  /** 停主智能体时一起停了后台子智能体：合成一条提示 */
  stoppedWithMain(labels: string[]): void {
    this.notice('info', `已停止，连同 ${labels.length} 个后台子智能体（${labels.join('、')}）`)
  }

  markDeclined(toolUseId: string): void {
    this.declined.add(toolUseId)
  }

  private nextId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.seq}`
  }

  notice(
    level: 'info' | 'warn' | 'error',
    text: string,
    detail?: string | null,
    task?: NoticeTask,
    error?: NoticeError,
  ): void {
    this.cb.emit({
      type: 'item_completed',
      item: {
        kind: 'notice',
        id: this.nextId('notice'),
        level,
        text,
        ...(detail ? { detail } : {}),
        ...(task ? { task } : {}),
        ...(error ? { error } : {}),
      },
    })
  }

  /** 新进程启动时调用：累计用量从零开始；resumed 时第一次累计值可能带着恢复的旧用量 */
  resetUsageBaseline(resumed = false): void {
    this.context.reset(false, true)
    this.usageBase.clear()
    this.usageRestored = resumed
    this.requestCache.reset()
  }

  handle(msg: Msg): void {
    if (!this.turnId && !this.halted && !msg.parent_tool_use_id && msg.isReplay !== true && msg.is_replay !== true) {
      const event = obj(msg.event)
      const starts =
        (msg.type === 'stream_event' && event.type === 'message_start') ||
        (msg.type === 'system' && msg.subtype === 'status' && msg.status === 'compacting')
      if (starts) this.beginAutoTurn()
    }
    this.context.handle(msg)
    this.requestCache.handle(msg)
    if (!msg.parent_tool_use_id && msg.type === 'stream_event' && obj(msg.event).type === 'message_start')
      this.clearRetry()
    if (!msg.parent_tool_use_id && msg.type === 'assistant' && !msg.error) this.clearRetry()
    if (msg.type === 'stream_event') {
      const ev = obj(msg.event)
      if (ev.type === 'message_start') {
        const message = obj(ev.message)
        const model = str(message.model)
        if (model) this.turnRequests.set(model, (this.turnRequests.get(model) ?? 0) + 1)
        this.lastMessageId = str(message.id)
        this.requestTokens(this.lastMessageId, model, message.usage)
      } else if (ev.type === 'message_delta') this.requestTokens(this.lastMessageId, '', ev.usage)
    } else if (msg.type === 'assistant') {
      const message = obj(msg.message)
      this.requestTokens(str(message.id), str(message.model), message.usage)
    }
    if (msg.parent_tool_use_id && msg.type !== 'system' && msg.type !== 'result') {
      this.onSubagentFrame(msg, str(msg.parent_tool_use_id))
      return
    }
    switch (msg.type) {
      case 'system':
        this.onSystem(msg)
        return
      case 'stream_event':
        this.onStreamEvent(obj(msg.event))
        return
      case 'assistant':
        this.onAssistant(msg)
        return
      case 'user':
        this.onUser(msg)
        return
      case 'result':
        if (typeof msg.fast_mode_state === 'string')
          this.cb.fastState(msg.fast_mode_state, str(msg.fast_mode_disabled_reason))
        this.onResult(msg)
        return
      case 'prompt_suggestion':
        if (str(msg.suggestion).trim()) this.cb.emit({ type: 'suggestion', text: str(msg.suggestion).trim() })
        return
    }
  }

  /**
   * 子智能体（Task / Agent 工具派出的）的消息：只把它调用的工具显示在对话流里，标上子智能体的名字；
   * 它的文字回复不进主对话流（在智能体追踪里看）。
   */
  private onSubagentFrame(msg: Msg, parent: string): void {
    const label = str(this.toolInputs.get(parent)?.description) || '子智能体'
    const content = obj(msg.message).content
    if (!Array.isArray(content)) return
    if (msg.type === 'assistant') {
      for (const block of content as Msg[]) {
        if (block.type !== 'tool_use') continue
        const id = str(block.id)
        if (!id || this.subTools.has(id)) continue
        const item = toolItem(id, str(block.name), obj(block.input), this.cwd, label, parent)
        this.subTools.set(id, item)
        this.subParent.set(id, parent)
        this.cb.emit({ type: 'item_started', item })
      }
    } else if (msg.type === 'user') {
      for (const block of content as Msg[]) {
        if (block.type !== 'tool_result') continue
        const id = str(block.tool_use_id)
        const item = this.subTools.get(id)
        if (!item) continue
        this.subTools.delete(id)
        this.subParent.delete(id)
        this.cb.emit({
          type: 'item_completed',
          item: completeToolItem(item, block.content, block.is_error === true, msg.tool_use_result),
        })
      }
    }
  }

  /** system/task_*：子智能体条、后台任务进度、智能体追踪、后台任务结束提示 */
  private onTask(msg: Msg): void {
    const id = str(msg.task_id)
    let traced = false
    switch (msg.subtype) {
      case 'task_started': {
        traced = this.runs.started(msg)
        const kind = str(msg.task_type)
        const info: TaskInfo = {
          kind,
          description: str(msg.description),
          background: msg.is_backgrounded === true || (kind !== 'local_agent' && msg.is_backgrounded !== false),
          toolUseId: str(msg.tool_use_id) || null,
        }
        this.taskInfo.set(id, info)
        if (kind === 'local_agent') {
          const task = (str(msg.prompt) || str(info.toolUseId ? this.toolInputs.get(info.toolUseId)?.prompt : ''))
            .trim()
            .slice(0, TASK_PREVIEW)
          this.setSubagent(id, {
            label: info.description || '子智能体',
            status: 'running',
            message: null,
            ...(info.background ? { background: true } : {}),
            ...(info.toolUseId ? { toolUseId: info.toolUseId } : {}),
            ...(task ? { task } : {}),
          })
        }
        break
      }
      case 'task_progress': {
        traced = this.runs.progress(msg)
        const info = this.taskInfo.get(id)
        if (!info) break
        if (info.kind === 'local_agent') {
          // 摘要不是每次都有：有过摘要后，只带工具名的进度不再把它盖掉
          const summary = str(msg.summary).trim(),
            tool = str(msg.last_tool_name)
          const kept = this.subagentList.find(a => a.id === id)?.summary
          if (summary) this.setSubagent(id, { summary, message: summary })
          else if (tool) this.setSubagent(id, { lastTool: tool, message: kept || tool })
        } else {
          const message = str(msg.summary) || str(msg.description) || null
          this.bgTasks = this.bgTasks.map(t => (t.id === id ? { ...t, message } : t))
          this.cb.emit({ type: 'tasks', tasks: [...this.bgTasks] })
        }
        break
      }
      case 'task_updated': {
        const info = this.taskInfo.get(id)
        if (info && obj(msg.patch).is_backgrounded === true) {
          info.background = true
          if (info.kind === 'local_agent') this.setSubagent(id, { background: true })
        }
        break
      }
      case 'task_notification': {
        traced = this.runs.finished(msg)
        const info = this.taskInfo.get(id)
        this.taskInfo.delete(id)
        const status = str(msg.status) || 'completed'
        if (this.bgTasks.some(t => t.id === id)) {
          this.bgTasks = this.bgTasks.filter(t => t.id !== id)
          this.cb.emit({ type: 'tasks', tasks: [...this.bgTasks] })
        }
        // 连同主智能体一起停的：不逐个提示，最后由 stoppedWithMain 合成一条
        const quiet = this.quietStops.delete(id) && status !== 'completed' && status !== 'failed'
        // 后台子智能体真正结束了：它的 Agent 工具行这时才收尾
        const call = info?.toolUseId ?? (str(msg.tool_use_id) || null)
        const launched = call ? this.asyncAgents.get(call) : undefined
        if (call && launched) {
          this.asyncAgents.delete(call)
          this.syncBackground()
          const summary = str(msg.summary)
          this.cb.emit({
            type: 'item_completed',
            item: {
              ...launched,
              status: AGENT_STATUS[status] ?? 'interrupted',
              ...(summary && launched.kind === 'tool' ? { output: summary } : {}),
            } as Item,
          })
        }
        if (info?.kind === 'local_agent') {
          const result = str(msg.summary).trim()
          this.setSubagent(id, { status, message: result || null, ...(result ? { result } : {}) })
          // 子智能体都结束了：还挂着的工具不会再有结果
          if (!this.subagentList.some(a => a.status === 'running'))
            for (const toolId of [...this.subTools.keys()]) this.settleSubTool(toolId, 'interrupted')
        }
        const background = !info || info.background
        if (background && !quiet && msg.skip_transcript !== true && msg.ambient !== true) {
          const kind = taskKindLabel(info?.kind ?? '')
          // 子智能体因 API 报错提前结束：报错部分和主会话一样说人话
          const raw = str(msg.summary)
          const apiRaw = status === 'failed' ? /API error:\s*([^]*)$/i.exec(raw)?.[1] : undefined
          const summary = (apiRaw && friendlyApiError(null, apiRaw)) || raw
          // 结构化信息给界面画完成小框（docs/ui/subagent-box.md §4.4）；text 照旧，旧界面、导出、通知还用它
          const taskKind = noticeTaskKind(info?.kind ?? '')
          const task: NoticeTask | undefined = taskKind
            ? {
                ...(call ? { toolUseId: call } : {}),
                kind: taskKind,
                status: status === 'completed' || status === 'failed' ? status : 'stopped',
                label: info?.description ?? '',
                ...(summary ? { summary } : {}),
              }
            : undefined
          this.notice(
            status === 'failed' ? 'warn' : 'info',
            kind + (TASK_STATUS[status] ?? '已结束') + (summary ? '：' + summary : ''),
            null,
            task,
          )
        }
        break
      }
    }
    if (traced) this.emitRuns()
  }

  private compactionStarted(): void {
    if (this.compaction?.status === 'running') return
    this.compactionSize = null
    this.compaction = {
      kind: 'compaction',
      id: this.nextId('compact'),
      status: 'running',
      trigger: null,
      startedAt: Date.now(),
      durationMs: null,
      preTokens: this.context.used,
      postTokens: null,
    }
    this.cb.emit({ type: 'item_started', item: this.compaction })
  }

  /** 压缩结束（结果帧、这一轮结束）；成功时留着等 compact_boundary 补上大小 */
  private settleCompaction(status: ItemStatus, error: string | null = null): void {
    const current = this.compaction
    if (current?.status !== 'running') return
    const item: CompactionItem = {
      ...current,
      status,
      durationMs: Date.now() - current.startedAt,
      ...(error ? { error } : {}),
    }
    this.compaction = status === 'completed' ? item : null
    this.cb.emit({ type: 'item_completed', item })
  }

  /** compact_boundary：带压缩前后的大小和用时；旧版 CLI 没有前面的 status 帧，直接记一条完成的 */
  private compactionBoundary(meta: Msg): void {
    const current = this.compaction
    this.compaction = null
    const startedAt = current?.startedAt ?? Date.now()
    const item: CompactionItem = {
      kind: 'compaction',
      id: current?.id ?? this.nextId('compact'),
      status: 'completed',
      trigger: meta.trigger === 'manual' || meta.trigger === 'auto' ? meta.trigger : null,
      startedAt,
      durationMs: num(meta.duration_ms) || current?.durationMs || (current ? Date.now() - startedAt : null),
      preTokens: num(meta.pre_tokens) || current?.preTokens || null,
      postTokens: typeof meta.post_tokens === 'number' && meta.post_tokens >= 0 ? meta.post_tokens : null,
    }
    this.compactionSize = item.postTokens === null ? item : null
    this.cb.emit({ type: 'item_completed', item })
  }

  private clearRetry(): void {
    if (!this.retry) return
    this.retry = null
    this.retrySignature = ''
    this.cb.emit({ type: 'request_retry', retry: null })
  }

  private onSystem(msg: Msg): void {
    switch (msg.subtype) {
      case 'init':
        if (str(msg.session_id)) this.cb.sessionId(str(msg.session_id))
        if (typeof msg.permissionMode === 'string' && FROM_CLAUDE_MODE[msg.permissionMode]) {
          this.cb.permissionMode(FROM_CLAUDE_MODE[msg.permissionMode])
        }
        return
      case 'status':
        if (typeof msg.permissionMode === 'string' && FROM_CLAUDE_MODE[msg.permissionMode]) {
          this.cb.permissionMode(FROM_CLAUDE_MODE[msg.permissionMode])
        }
        if (msg.parent_tool_use_id) return
        if (msg.status === 'compacting') this.compactionStarted()
        else if (msg.compact_result === 'failed') this.settleCompaction('failed', str(msg.compact_error) || null)
        else if (msg.compact_result === 'success') this.settleCompaction('completed')
        return
      case 'api_retry':
        if (!this.turnId || msg.parent_tool_use_id) return
        {
          const retry = requestRetryState(msg, this.turnId)
          const signature = JSON.stringify([
            retry.turnId,
            retry.attempt,
            retry.maxRetries,
            msg.retry_delay_ms,
            retry.reason,
          ])
          if (signature === this.retrySignature) return
          this.retrySignature = signature
          this.retry = retry
          this.cb.emit({ type: 'request_retry', retry })
        }
        return
      case 'compact_boundary':
        if (!msg.parent_tool_use_id) this.compactionBoundary(obj(msg.compact_metadata))
        return
      case 'task_started':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        this.onTask(msg)
        return
      case 'background_tasks_changed': {
        const prev = new Map(this.bgTasks.map(t => [t.id, t]))
        this.bgTasks = (Array.isArray(msg.tasks) ? (msg.tasks as Msg[]) : [])
          .filter(t => t.ambient !== true)
          .map(t => ({
            id: str(t.task_id),
            kind: str(t.task_type),
            description: str(t.description),
            message: prev.get(str(t.task_id))?.message ?? null,
          }))
        this.cb.emit({ type: 'tasks', tasks: [...this.bgTasks] })
        this.syncBackground()
        return
      }
    }
  }

  private onStreamEvent(ev: Msg): void {
    switch (ev.type) {
      case 'message_start': {
        this.messageId = str(obj(ev.message).id) || this.nextId('msg')
        return
      }
      case 'content_block_start': {
        const block = obj(ev.content_block)
        const key = `${this.messageId}:${num(ev.index)}`
        if (block.type === 'text' || block.type === 'thinking') {
          const kind = block.type === 'text' ? 'assistant' : 'reasoning'
          const text = str(block.type === 'text' ? block.text : block.thinking)
          this.blocks.set(key, { itemId: key, kind, text, done: false })
          this.cb.emit({ type: 'item_started', item: { kind, id: key, text, status: 'running' } })
        }
        return
      }
      case 'content_block_delta': {
        const delta = obj(ev.delta)
        const open = this.blocks.get(`${this.messageId}:${num(ev.index)}`)
        if (!open || open.done) return
        const piece =
          delta.type === 'text_delta' ? str(delta.text) : delta.type === 'thinking_delta' ? str(delta.thinking) : ''
        if (!piece) return
        open.text += piece
        this.cb.emit({ type: 'item_delta', itemId: open.itemId, field: 'text', delta: piece })
        return
      }
      case 'message_delta': {
        const u = obj(ev.usage)
        if (Object.keys(u).length > 0) this.updateUsage(u, false)
        return
      }
    }
  }

  /** 找这条消息里第一个还没完成的同类块 */
  private takeOpen(messageId: string, kind: OpenBlock['kind']): OpenBlock | null {
    for (const [key, b] of this.blocks) {
      if (key.startsWith(`${messageId}:`) && b.kind === kind && !b.done) return b
    }
    return null
  }

  private finishBlock(b: OpenBlock, text: string, status: ItemStatus): void {
    b.done = true
    this.cb.emit({ type: 'item_completed', item: { kind: b.kind, id: b.itemId, text, status } })
  }

  private onAssistant(msg: Msg): void {
    const message = obj(msg.message)
    const messageId = str(message.id) || this.messageId
    const aborted = msg.aborted === true
    const content = Array.isArray(message.content) ? (message.content as Msg[]) : []
    if (typeof msg.error === 'string' && msg.error && str(message.model) === '<synthetic>') {
      // Claude Code 自己合成的报错消息（API 报错时先发它再发失败结果）：不当成回复，
      // 等这一轮的结果一起出一条提示（docs/ui/conversation-ux-2.md §2.1）
      const raw = content
        .filter(b => b.type === 'text')
        .map(b => str(b.text))
        .join('\n')
        .trim()
      this.apiError = { code: msg.error, raw }
      return
    }
    for (const block of content) {
      if (block.type === 'text' || block.type === 'thinking') {
        const kind = block.type === 'text' ? 'assistant' : 'reasoning'
        const full = str(block.type === 'text' ? block.text : block.thinking)
        const open = this.takeOpen(messageId, kind)
        const status: ItemStatus = aborted ? 'interrupted' : 'completed'
        if (open) {
          // 思考内容可能被隐藏（只给签名），这时保留流式拿到的文字
          this.finishBlock(open, full || open.text, status)
        } else if (full) {
          const id = this.nextId(kind)
          this.cb.emit({ type: 'item_completed', item: { kind, id, text: full, status } })
        }
      } else if (block.type === 'tool_use') {
        const id = str(block.id) || this.nextId('tool')
        if (this.tools.has(id)) continue
        const item = toolItem(id, str(block.name), obj(block.input), this.cwd)
        this.toolInputs.set(id, obj(block.input))
        this.tools.set(id, item)
        this.cb.emit({ type: 'item_started', item })
      }
    }
    // 带报错代码的回复：先记下，等这一轮的结果一起出一条（失败的结果本身也会报错，原来会出两条）；
    // 不在一轮里（零散消息）时马上提示
    if (typeof msg.error === 'string' && msg.error) {
      if (!this.turnId)
        this.notice(
          'error',
          ERROR_TEXT[msg.error] ?? `请求出错（${msg.error}）`,
          null,
          undefined,
          apiNoticeError(msg.error, ''),
        )
      // 这条消息的文字是真的回复（例如写到上限被截断），不当报错原文
      else if (!this.apiError)
        this.apiError = { code: msg.error, raw: ERROR_TEXT[msg.error] ?? `请求出错（${msg.error}）` }
    }
  }

  private onUser(msg: Msg): void {
    const content = obj(msg.message).content
    if (!Array.isArray(content)) return
    for (const block of content as Msg[]) {
      if (block.type !== 'tool_result') continue
      const id = str(block.tool_use_id)
      const item = this.tools.get(id)
      if (!item) continue
      this.tools.delete(id)
      const isError = block.is_error === true
      const result = obj(msg.tool_use_result)
      if (str(result.agentId) && this.runs.agentResult(result)) this.emitRuns()
      const status: ItemStatus | undefined = isError && this.declined.has(id) ? 'declined' : undefined
      this.declined.delete(id)
      // 后台子智能体：工具马上返回「已在后台启动」，子智能体还在干活，这一行保持运行中（不随这一轮收尾）
      if (!isError && (result.isAsync === true || result.status === 'async_launched')) {
        const running = {
          ...completeToolItem(item, block.content, false, msg.tool_use_result, 'running'),
          background: true,
        } as Item
        this.asyncAgents.set(id, running)
        this.cb.emit({ type: 'item_started', item: running })
        this.syncBackground()
        continue
      }
      this.cb.emit({
        type: 'item_completed',
        item: completeToolItem(item, block.content, isError, msg.tool_use_result, status),
      })
    }
  }

  private updateUsage(u: Msg, final: boolean): void {
    const input = num(u.input_tokens)
    const cacheRead = num(u.cache_read_input_tokens)
    const cacheWrite = num(u.cache_creation_input_tokens)
    const output = num(u.output_tokens)
    this.usage = {
      ...this.usage,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      // result 里的 usage 是整轮累计，不能当作当前上下文大小；只有每次请求的 message_delta 才是
      contextTokens: final ? this.usage.contextTokens : input + cacheRead + cacheWrite,
    }
    const size = this.compactionSize
    if (!final && size && this.usage.contextTokens > 0) {
      this.compactionSize = null
      this.cb.emit({ type: 'item_completed', item: { ...size, postTokens: this.usage.contextTokens } })
    }
  }

  private onResult(msg: Msg): void {
    const turnId = this.turnId ?? this.nextId('turn')
    this.turnId = null

    if (typeof msg.total_cost_usd === 'number') this.usage = { ...this.usage, costUsd: msg.total_cost_usd }
    for (const m of Object.values(obj(msg.modelUsage))) {
      const w = num(obj(m).contextWindow)
      if (w > 0) this.usage = { ...this.usage, contextWindow: w }
    }
    this.cb.emit({ type: 'usage', usage: { ...this.usage } })

    const terminal = str(msg.terminal_reason)
    const outcome: TurnOutcome = terminal.startsWith('aborted')
      ? 'interrupted'
      : msg.subtype === 'success' && msg.is_error !== true
        ? 'completed'
        : 'failed'

    // 收尾：流式中断时可能有没完成的块和工具调用，统一结束掉（持久化只保存完成的条目）
    const leftover: ItemStatus =
      outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed'
    for (const b of this.blocks.values()) if (!b.done) this.finishBlock(b, b.text, leftover)
    this.blocks.clear()
    this.settleCompaction(leftover)
    for (const item of this.tools.values()) {
      this.cb.emit({
        type: 'item_completed',
        item: completeToolItem(item, '', false, null, leftover === 'completed' ? 'interrupted' : leftover),
      })
    }
    this.tools.clear()
    this.declined.clear()
    // 子智能体的工具：正常结束时还在跑的属于后台子智能体，标成后台、等它自己的结果；中断 / 失败时一起收尾
    for (const [id, item] of this.subTools) {
      if (outcome === 'completed') {
        const background = { ...item, background: true } as Item
        this.subTools.set(id, background)
        this.cb.emit({ type: 'item_started', item: background })
      } else this.settleSubTool(id, leftover)
    }

    let error: string | null = null
    const apiError = this.apiError
    this.apiError = null
    if (outcome === 'failed') {
      const errors = Array.isArray(msg.errors) ? (msg.errors as unknown[]).map(String).filter(Boolean) : []
      const raw = errors.join('\n') || str(msg.result) || apiError?.raw || terminal || '这一轮失败了'
      // 一次报错只出一条提示：第一行说人话，英文原文放「详情」；认不出的照原文（docs/ui/conversation-ux-2.md §2.1）
      const friendly = friendlyApiError(apiError?.code ?? null, raw)
      error = friendly ?? raw
      if (this.retry?.attempt !== null && this.retry?.attempt !== undefined)
        error += `\n本次请求已重试 ${this.retry.attempt} 次${this.retry.maxRetries !== null && this.retry.attempt >= this.retry.maxRetries ? '，达到重试上限' : ''}。`
      this.notice('error', error, friendly ? raw : null, undefined, apiNoticeError(apiError?.code ?? null, raw))
    } else if (apiError) {
      // 收到报错消息、这一轮却没算失败：也只提示一次
      const friendly = friendlyApiError(apiError.code, apiError.raw)
      this.notice(
        'error',
        friendly ?? apiError.raw,
        friendly ? apiError.raw : null,
        undefined,
        apiNoticeError(apiError.code, apiError.raw),
      )
    }
    const usage = this.turnUsage(msg)
    // 这一轮说完了，派出去的后台子智能体可能还在跑：带上个数，宿主和通知按「还没做完」处理
    const background = this.syncBackground()
    this.cb.emit({
      type: 'turn_completed',
      turnId,
      outcome,
      error,
      ...(usage ? { usage } : {}),
      ...(background ? { background } : {}),
    })
    this.cb.turnEnded(outcome)
  }

  private requestTokens(id: string, model: string, raw: unknown): void {
    if (!this.turnId || !id) return
    const u = obj(raw)
    const t = this.turnTokens.get(id) ?? { model: '', input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    if (model) t.model = model
    t.input = Math.max(t.input, num(u.input_tokens))
    t.cacheRead = Math.max(t.cacheRead, num(u.cache_read_input_tokens))
    t.cacheWrite = Math.max(t.cacheWrite, num(u.cache_creation_input_tokens))
    t.output = Math.max(t.output, num(u.output_tokens))
    this.turnTokens.set(id, t)
  }

  /** 这一轮这个模型逐条请求加起来的用量；一条都没有返回 null */
  private requestSum(model: string): Omit<UsageCounters, 'cost'> | null {
    let found = false
    const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    for (const t of this.turnTokens.values()) {
      if (t.model !== model) continue
      found = true
      sum.input += t.input
      sum.cacheRead += t.cacheRead
      sum.cacheWrite += t.cacheWrite
      sum.output += t.output
    }
    return found ? sum : null
  }

  /** 这一轮每个模型的用量（docs/ui/usage.md §6.1）；没有任何 token 时返回 null */
  private turnUsage(msg: Msg): TurnUsage | null {
    const models: Record<string, ModelTurnUsage> = {}
    const restored = this.usageRestored
    this.usageRestored = false
    for (const [model, raw] of Object.entries(obj(msg.modelUsage))) {
      const m = obj(raw)
      const now: UsageCounters = {
        input: num(m.inputTokens),
        cacheRead: num(m.cacheReadInputTokens),
        cacheWrite: num(m.cacheCreationInputTokens),
        output: num(m.outputTokens),
        cost: typeof m.costUSD === 'number' ? m.costUSD : null,
      }
      const prev = this.usageBase.get(model)
      this.usageBase.set(model, now)
      if (restored && !prev) {
        // 累计值里可能有恢复的旧用量：明显多于这一轮逐条请求的总和时按逐条请求算，费用按官方价估算；
        // 看不到逐条请求的模型（如后台的小模型）不记，宁少勿多
        const d = this.requestSum(model)
        if (!d) continue
        const total = (c: Omit<UsageCounters, 'cost'>) => c.input + c.cacheRead + c.cacheWrite + c.output
        if (total(d) <= 0) continue
        if (total(now) > total(d) * 1.05 + 10_000) {
          models[model] = {
            ...d,
            costUsd: estimateCost(d, officialPrice(model)),
            requests: Math.max(1, this.turnRequests.get(model) ?? 0),
          }
          continue
        }
      }
      // 累计值变小：说明是新进程而基线没清零，这时整个当前值都算这一轮
      const shrunk =
        !!prev &&
        (now.input < prev.input ||
          now.cacheRead < prev.cacheRead ||
          now.cacheWrite < prev.cacheWrite ||
          now.output < prev.output)
      const base = !prev || shrunk ? ZERO_COUNTERS : prev
      const d = {
        input: now.input - base.input,
        cacheRead: now.cacheRead - base.cacheRead,
        cacheWrite: now.cacheWrite - base.cacheWrite,
        output: now.output - base.output,
      }
      if (d.input + d.cacheRead + d.cacheWrite + d.output <= 0) continue
      models[model] = {
        ...d,
        costUsd: now.cost === null ? null : Math.max(0, now.cost - (base.cost ?? 0)),
        requests: Math.max(1, this.turnRequests.get(model) ?? 0),
      }
    }
    if (Object.keys(models).length === 0) return null
    const durationMs = this.turnStartedAt ? Date.now() - this.turnStartedAt : num(msg.duration_ms)
    return { models, durationMs }
  }

  /** 进程意外退出：结束这一轮 */
  abortTurn(reason: string): void {
    const turnId = this.turnId
    this.halted = true
    if (!turnId) return
    this.requestCache.end()
    this.turnId = null
    this.apiError = null
    for (const b of this.blocks.values()) if (!b.done) this.finishBlock(b, b.text, 'failed')
    this.blocks.clear()
    this.settleCompaction('failed')
    for (const item of this.tools.values()) {
      this.cb.emit({ type: 'item_completed', item: completeToolItem(item, '', true, null, 'failed') })
    }
    this.tools.clear()
    this.notice('error', reason)
    this.cb.emit({ type: 'turn_completed', turnId, outcome: 'failed', error: reason })
    this.cb.turnEnded('failed')
  }

  /** 强制中断后（进程被杀，没有 result）：结束这一轮 */
  interruptTurn(): void {
    const turnId = this.turnId
    this.halted = true
    if (!turnId) return
    this.requestCache.end()
    this.turnId = null
    for (const b of this.blocks.values()) if (!b.done) this.finishBlock(b, b.text, 'interrupted')
    this.blocks.clear()
    this.settleCompaction('interrupted')
    for (const item of this.tools.values()) {
      this.cb.emit({ type: 'item_completed', item: completeToolItem(item, '', false, null, 'interrupted') })
    }
    this.tools.clear()
    this.cb.emit({ type: 'turn_completed', turnId, outcome: 'interrupted', error: null })
    this.cb.turnEnded('interrupted')
  }
}

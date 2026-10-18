// Pi（像素星空命令行）的 RPC 事件 → 统一条目和事件（docs/own-cli.md §4.1）。事件形状见 Pi 文档的 JSON Event Stream。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type {
  AgentRun,
  ApprovalRequest,
  EngineEvent,
  FileChange,
  Item,
  ItemStatus,
  ModelTurnUsage,
  TodoStep,
  ToolKind,
  TurnUsage,
} from '@pixelsky/protocol'
import { IMAGE_PLACEHOLDER } from '@pixelsky/protocol'
import { displayPath } from '../claude/tools'
import { diffAdded, diffText } from '../diff'
import { MAX_OUTPUT, clip } from '../output'
import { cut } from '../text'
import { SUBAGENT_TOOL, subagentItemId, subagentRun, subagentStatus } from './agents'
import { array, number, object, string, type Message } from './process'

export const COMMAND_TOOLS = new Set(['bash', 'powershell'])
export const EDIT_TOOLS = new Set(['edit', 'write'])
export const TODO_TOOL = 'todo_write'
/** 计划模式交计划的工具（packages/cli/src/extensions/plan.ts）；条目名用 Claude 的 ExitPlanMode，界面按这个名字显示计划正文 */
export const EXIT_PLAN_TOOL = 'exit_plan_mode'
const PLAN_ITEM_NAME = 'ExitPlanMode'
/** 计划确认的标题第一行和两个选项（plan.ts 的 PLAN_TITLE / PLAN_OPTIONS，原文要一致） */
export const PLAN_TITLE = '计划已就绪，要开始执行吗？ / Ready to implement this plan?'
export const PLAN_OPTIONS = ['开始执行 / Start implementing', '继续完善计划 / Keep planning'] as const

/** 工具结果的文字（图片只留占位） */
export function resultText(result: unknown): string {
  return array(object(result).content)
    .map(block => {
      const b = object(block)
      return b.type === 'text' ? string(b.text) : b.type === 'image' ? IMAGE_PLACEHOLDER : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 批准扩展拒绝 / 用户拒绝 / 计划模式拦下的工具调用：显示成「已拒绝」，不算失败 */
export function isDeclined(text: string): boolean {
  return /^(The user denied the "|Tool ".*" is blocked: |Tool ".*" requires user approval)/.test(text)
}

/** Pi 的 unified patch（带文件头）→ 我们的 diff 正文（只留 @@ 行起的内容） */
export function diffFromPatch(patch: string): { diff: string; added: number; removed: number } | null {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => l.startsWith('@@'))
  if (start < 0) return null
  const body = lines.slice(start).filter(l => !l.startsWith('\\'))
  while (body.length && body[body.length - 1] === '') body.pop()
  let added = 0,
    removed = 0
  for (const l of body) {
    if (l.startsWith('+')) added++
    else if (l.startsWith('-')) removed++
  }
  return { diff: body.join('\n'), added, removed }
}

/** edit 工具的参数：edits 数组，或旧式的单个 oldText / newText */
function editPairs(args: Message): Array<{ oldText: string; newText: string }> {
  const list = array(args.edits).map(e => ({ oldText: string(object(e).oldText), newText: string(object(e).newText) }))
  if (list.length) return list
  if (typeof args.oldText === 'string' || typeof args.newText === 'string')
    return [{ oldText: string(args.oldText), newText: string(args.newText) }]
  return []
}

/** 读写之前的旧文件内容（太大或读不到当作没有），算覆盖写入的 diff 用 */
function readOld(path: string): string | null {
  try {
    if (!existsSync(path) || statSync(path).size > 1_000_000) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function fileChangesFromArgs(toolName: string, args: Message, cwd: string): FileChange[] {
  const raw = string(args.path) || string(args.file_path)
  const path = displayPath(raw, cwd)
  if (toolName === 'write') {
    const content = string(args.content)
    const old = raw ? readOld(isAbsolute(raw) ? raw : resolve(cwd, raw)) : null
    const d = old === null ? diffAdded(content) : diffText(old, content)
    return [{ path, kind: old === null ? 'add' : 'update', newText: content.slice(0, MAX_OUTPUT), ...d }]
  }
  const parts = editPairs(args).map(e => diffText(e.oldText, e.newText))
  return [
    {
      path,
      kind: 'update',
      newText: editPairs(args)[0]?.newText.slice(0, MAX_OUTPUT),
      diff: parts.map(p => p.diff).join('\n'),
      added: parts.reduce((n, p) => n + p.added, 0),
      removed: parts.reduce((n, p) => n + p.removed, 0),
    },
  ]
}

function todoSteps(args: Message): TodoStep[] {
  return array(args.todos).map(raw => {
    const t = object(raw)
    return {
      text: string(t.content) || string(t.activeForm),
      status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
    }
  })
}

/** 其余工具：归类和一行摘要 */
function toolTitle(name: string, args: Message, cwd: string): { tool: ToolKind; title: string } {
  const path = string(args.path) ? displayPath(string(args.path), cwd) : ''
  switch (name) {
    case 'read':
    case 'ls':
      return { tool: 'read', title: path }
    case 'find':
    case 'grep':
      return { tool: 'search', title: [string(args.pattern), path].filter(Boolean).join(' · ') }
  }
  if (name === 'web_fetch') return { tool: 'web', title: string(args.url) }
  if (name === 'web_search') return { tool: 'web', title: string(args.query) }
  // Pi 的 codemode：脚本里再调别的工具（每个调用另有自己的条目），这里显示脚本的第一行
  if (name === 'codemode') {
    const line =
      string(args.code)
        .split('\n')
        .map(l => l.trim())
        .find(l => l && !l.startsWith('// @options')) ?? ''
    return { tool: 'other', title: line.length > 120 ? `${cut(line, 0, 120)}…` : line }
  }
  if (/^mcp[_]/i.test(name)) return { tool: 'mcp', title: name.replace(/^mcp_+/i, '').replace(/__/g, ' · ') }
  const first = ['command', 'path', 'url', 'query', 'pattern'].map(k => string(args[k])).find(Boolean)
  if (first) return { tool: 'other', title: first.length > 120 ? `${cut(first, 0, 120)}…` : first }
  const brief = JSON.stringify(args) ?? ''
  return { tool: 'other', title: brief.length > 80 ? `${cut(brief, 0, 80)}…` : brief }
}

/** 工具调用开始 → 条目 */
export function toolItem(id: string, name: string, args: Message, cwd: string): Item {
  if (COMMAND_TOOLS.has(name))
    return {
      kind: 'command',
      id,
      command: string(args.command),
      description: null,
      output: '',
      exitCode: null,
      status: 'running',
    }
  if (EDIT_TOOLS.has(name))
    return { kind: 'file_change', id, changes: fileChangesFromArgs(name, args, cwd), status: 'running' }
  if (name === TODO_TOOL) return { kind: 'todo', id, steps: todoSteps(args), status: 'running' }
  // 子智能体：界面按 Claude 的 Agent 工具显示（能打开智能体追踪）
  if (name === SUBAGENT_TOOL)
    return {
      kind: 'tool',
      id,
      tool: 'task',
      name: 'Agent',
      title: string(args.description) || 'Subagent',
      output: '',
      status: 'running',
    }
  if (name === EXIT_PLAN_TOOL) {
    const plan = string(args.plan)
    const title =
      plan
        .split('\n')
        .map(l => l.replace(/^#+\s*/, '').trim())
        .find(Boolean) ?? ''
    return { kind: 'tool', id, tool: 'other', name: PLAN_ITEM_NAME, title, output: plan, status: 'running' }
  }
  const { tool, title } = toolTitle(name, args, cwd)
  return { kind: 'tool', id, tool, name, title, output: '', status: 'running' }
}

/**
 * 批准扩展询问时的三个选项（packages/cli/src/extensions/approval.ts 的 APPROVAL_OPTIONS，原文要一致）：
 * extension_ui_request 是 select、选项正好是这三个时当审批卡片，「本会话不再询问」= 始终允许（session）
 */
export const APPROVAL_OPTIONS = [
  '允许 / Allow',
  '本会话不再询问 / Always allow in this session',
  '拒绝 / Deny',
] as const

export function isPlanSelect(title: string, options: readonly string[]): boolean {
  return (
    title.split('\n')[0] === PLAN_TITLE &&
    options.length === PLAN_OPTIONS.length &&
    options.every((o, i) => o === PLAN_OPTIONS[i])
  )
}

/** 计划确认卡片（和 Claude 的 ExitPlanMode 一样：开始执行 / 继续完善） */
export function planApproval(requestId: string, title: string, item: Item | null): ApprovalRequest {
  const [, ...plan] = title.split('\n')
  return {
    requestId,
    itemId: item?.id ?? null,
    kind: 'plan',
    title: '计划已就绪，要开始执行吗？',
    plan: plan.join('\n'),
    alwaysScopes: [],
  }
}

export function isApprovalSelect(title: string, options: readonly string[]): boolean {
  return (
    !!toolNameFromTitle(title) &&
    options.length === APPROVAL_OPTIONS.length &&
    options.every((o, i) => o === APPROVAL_OPTIONS[i])
  )
}

/**
 * 批准请求 → 审批卡片。item 是对应的工具条目（找不到时按标题拼）。
 * 新的批准扩展用 select（标题第二行是摘要，能「本会话不再询问」），旧版用 confirm（只有允许 / 拒绝）
 */
export function approvalFor(
  requestId: string,
  title: string,
  message: string,
  item: Item | null,
  alwaysScopes: Array<'session'> = [],
): ApprovalRequest {
  const base = { requestId, itemId: item?.id ?? null, alwaysScopes }
  if (item?.kind === 'command')
    return { ...base, kind: 'command', title: 'Run command', command: item.command, description: '' }
  if (item?.kind === 'file_change')
    return { ...base, kind: 'file_change', title: 'File changes', changes: item.changes, description: '' }
  if (item?.kind === 'tool')
    return { ...base, kind: 'tool', title: `Use ${item.name}`, toolName: item.name, input: item.title, description: '' }
  // 没找到对应条目（例如批准扩展的询问先于工具开始事件）：用标题和摘要
  const name = toolNameFromTitle(title)
  return {
    ...base,
    kind: 'tool',
    title: name ? `Use ${name}` : title.split('\n')[0],
    toolName: name || undefined,
    input: message,
    description: '',
  }
}

/** 截断；边界落在 emoji（代理对）中间时少截一位（命令行 approval.ts 的 clip 要一致） */
function clipText(text: string, max: number): string {
  return text.length > max ? `${cut(text, 0, max)}…` : text
}

/**
 * 批准扩展询问标题第二行的摘要（packages/cli/src/extensions/approval.ts 的 describeToolCall，写法要一致）：
 * 用来把询问对上是哪个工具条目
 */
export function approvalSummary(args: Message, toolName = ''): string {
  if (toolName === 'web_fetch' && typeof args.url === 'string') {
    let target = args.url
    try {
      target = new URL(args.url.trim()).href
    } catch {
      // 不是合法网址：照原文
    }
    const ask = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    return ask ? `${clipText(target, 400)} — ${clipText(ask, 300)}` : clipText(target, 400)
  }
  if (typeof args.command === 'string') return clipText(args.command, 800)
  if (typeof args.path === 'string') return clipText(args.path, 400)
  if (typeof args.file_path === 'string') return clipText(args.file_path, 400)
  try {
    return clipText(JSON.stringify(args), 800)
  } catch {
    return ''
  }
}

/** 批准扩展的标题是「允许工具 xxx？ / Allow tool xxx?」 */
export function toolNameFromTitle(title: string): string {
  return /(?:允许工具 |Allow tool )([^\s？?]+)/.exec(title)?.[1] ?? ''
}

export interface TranslatorOptions {
  cwd: string
  /** 助手流式消息之外的用户消息（steer 交付）开始时回调 */
  userMessage?: (text: string) => void
  /** 当前模型的上下文窗口 */
  contextWindow?: () => number | null
}

interface Totals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** 一个会话的条目转换。生命周期和 PixelSession 相同；每轮开头 beginTurn() */
export class PixelTranslator {
  readonly items = new Map<string, Item>()
  /** 条目 id 前缀：进程重启后计数从头开始，加随机段避免和以前落盘的条目撞 id */
  private readonly prefix = 'px' + randomBytes(3).toString('hex')
  private messageSeq = 0
  private noticeSeq = 0
  /** 会话累计（切回旧会话时用 get_session_stats 的值作基线） */
  totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  /** 最近一次请求的上下文占用（token） */
  lastContext: number | null = null
  /** 最近一次请求用的模型 */
  lastModel: string | null = null
  private turnModels: Record<string, ModelTurnUsage> = {}
  private assistantError: string | null = null
  private compaction: { id: string; startedAt: number; preTokens: number | null } | null = null
  constructor(
    private readonly emit: (event: EngineEvent) => void,
    private readonly options: TranslatorOptions,
  ) {}

  beginTurn(): void {
    this.items.clear()
    this.toolNames.clear()
    this.toolSummaries.clear()
    this.turnModels = {}
    this.assistantError = null
  }
  /** 本轮的用量；一个请求都没有时没有 models */
  turnUsage(durationMs: number): TurnUsage {
    return { durationMs, models: this.turnModels }
  }
  /** 最后一条助手消息是错误结束时的说明（agent_settled 时判断这一轮是否失败） */
  takeError(): string | null {
    const error = this.assistantError
    this.assistantError = null
    return error
  }
  /**
   * 批准请求对应的工具条目（批准请求里没有 toolCallId）：本轮还在跑、不在 skip 里的同名条目，
   * 摘要（标题第二行）一样的优先，都对不上时取最早的
   */
  runningTool(name: string, skip: ReadonlySet<string>, summary?: string): Item | null {
    const open = [...this.items.values()].filter(
      item =>
        !skip.has(item.id) && 'status' in item && item.status === 'running' && this.toolNames.get(item.id) === name,
    )
    return (
      (summary === undefined ? undefined : open.find(item => this.toolSummaries.get(item.id) === summary)) ??
      open[0] ??
      null
    )
  }
  /** 工具条目 id → Pi 的工具名 */
  private readonly toolNames = new Map<string, string>()
  /** 工具条目 id → 批准扩展询问时会写的摘要（approvalSummary） */
  private readonly toolSummaries = new Map<string, string>()

  notice(level: 'info' | 'warn' | 'error', text: string, detail: string | null = null): void {
    this.emit({
      type: 'item_completed',
      item: { kind: 'notice', id: `${this.prefix}-n${++this.noticeSeq}`, level, text, detail },
    })
  }

  private put(item: Item, complete: boolean): void {
    this.items.set(item.id, item)
    this.emit({ type: complete ? 'item_completed' : 'item_started', item })
  }

  /** 流式文字 / 思考的条目 id：消息序号 + 内容块序号 */
  private blockId(index: number): string {
    return `${this.prefix}-m${this.messageSeq}-${index}`
  }

  event(raw: Message): void {
    switch (raw.type) {
      case 'message_start':
        return this.messageStart(object(raw.message))
      case 'message_update':
        return this.messageUpdate(object(raw.assistantMessageEvent))
      case 'message_end':
        return this.messageEnd(object(raw.message))
      case 'tool_execution_start':
        return this.toolStart(raw)
      case 'tool_execution_update':
        return this.toolUpdate(raw)
      case 'tool_execution_end':
        return this.toolEnd(raw)
      case 'compaction_start':
        return this.compactionStart(raw)
      case 'compaction_end':
        return this.compactionEnd(raw)
      case 'extension_error':
        return this.notice('warn', string(raw.error) || 'Extension error', string(raw.extensionPath) || null)
    }
  }

  private messageStart(message: Message): void {
    if (message.role === 'assistant') {
      this.messageSeq++
      this.assistantError = null
    } else if (message.role === 'user') {
      const content = message.content
      const text =
        typeof content === 'string'
          ? content
          : array(content)
              .map(b => string(object(b).text))
              .join('')
      this.options.userMessage?.(text)
    }
  }

  private messageUpdate(update: Message): void {
    const kind = string(update.type)
    const index = number(update.contentIndex)
    const id = this.blockId(index)
    const text = kind.startsWith('text_'),
      thinking = kind.startsWith('thinking_')
    if (!text && !thinking) return
    const itemKind = text ? 'assistant' : 'reasoning'
    const prior = this.items.get(id)
    if (kind.endsWith('_delta')) {
      const delta = string(update.delta)
      if (!delta) return
      if (!prior) this.put({ kind: itemKind, id, text: '', status: 'running' }, false)
      const item = this.items.get(id)
      if (item?.kind === 'assistant' || item?.kind === 'reasoning') {
        this.items.set(id, { ...item, text: item.text + delta })
        this.emit({ type: 'item_delta', itemId: id, field: 'text', delta })
      }
    } else if (kind.endsWith('_end')) {
      // 以 end 里的完整内容为准
      const content = string(update.content)
      const base = prior?.kind === itemKind ? prior : null
      const final = content || base?.text || ''
      if (final) this.put({ kind: itemKind, id, text: final, status: 'completed' }, true)
    }
  }

  private messageEnd(message: Message): void {
    if (message.role !== 'assistant') return
    // 流式没收全的块用最终内容补齐
    array(message.content).forEach((raw, index) => {
      const block = object(raw)
      const id = this.blockId(index)
      const prior = this.items.get(id)
      if (block.type === 'text' || block.type === 'thinking') {
        const kind = block.type === 'text' ? 'assistant' : 'reasoning'
        const text = string(block.type === 'text' ? block.text : block.thinking)
        if (
          text &&
          !(prior && 'status' in prior && prior.status === 'completed' && 'text' in prior && prior.text === text)
        )
          this.put({ kind, id, text, status: 'completed' }, true)
      }
    })
    if (message.stopReason === 'error') this.assistantError = string(message.errorMessage) || 'Model request failed'
    const usage = object(message.usage)
    const cost = number(object(usage.cost).total)
    const counts = {
      input: number(usage.input),
      output: number(usage.output),
      cacheRead: number(usage.cacheRead),
      cacheWrite: number(usage.cacheWrite),
    }
    if (!counts.input && !counts.output && !counts.cacheRead && !counts.cacheWrite && !cost) return
    this.lastModel = string(message.responseModel) || string(message.model) || 'Pixel'
    this.addUsage(this.lastModel, counts, cost)
    this.lastContext = number(usage.totalTokens) || counts.input + counts.output + counts.cacheRead + counts.cacheWrite
    this.emitUsage()
  }

  /** 把一次请求的用量记进本轮和会话累计（压缩生成摘要的那次调用也算） */
  addUsage(
    model: string,
    counts: { input: number; output: number; cacheRead: number; cacheWrite: number },
    cost: number,
  ): void {
    const t = this.totals
    t.input += counts.input
    t.output += counts.output
    t.cacheRead += counts.cacheRead
    t.cacheWrite += counts.cacheWrite
    t.cost += cost
    const m = (this.turnModels[model] ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, requests: 0 })
    m.input += counts.input
    m.cacheRead += counts.cacheRead
    m.cacheWrite += counts.cacheWrite
    m.output += counts.output
    m.costUsd = (m.costUsd ?? 0) + cost
    m.requests = (m.requests ?? 0) + 1
  }

  emitUsage(): void {
    const window = this.options.contextWindow?.() ?? null
    this.emit({
      type: 'usage',
      usage: {
        inputTokens: this.totals.input,
        outputTokens: this.totals.output,
        cacheReadTokens: this.totals.cacheRead,
        cacheWriteTokens: this.totals.cacheWrite,
        contextTokens: this.lastContext ?? 0,
        contextWindow: window,
        costUsd: this.totals.cost,
      },
    })
    this.emit({
      type: 'context',
      context: {
        model: this.lastModel,
        used: this.lastContext,
        window,
        input: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
        observedAt: Date.now(),
        source: 'request',
        stale: false,
        compacting: false,
        diagnostic: null,
        diagnosticStale: true,
      },
    })
  }

  /** 工具条目 id；子智能体的不带随机前缀（重新打开会话时追踪窗口按它找条目） */
  private toolId(raw: Message): string {
    const call = string(raw.toolCallId)
    return string(raw.toolName) === SUBAGENT_TOOL ? subagentItemId(call) : `${this.prefix}-t-${call}`
  }

  /** 这个会话的子智能体（整个会话的，不随一轮清空）：工具调用 id → 追踪里的一项 */
  private readonly agents = new Map<string, AgentRun>()
  private readonly agentTools = new Map<string, string | null>()
  /** 打开会话时从主会话文件读回以前的子智能体 */
  seedRuns(runs: readonly AgentRun[]): void {
    for (const run of runs) {
      const call = run.toolUseId?.replace(/^px-task-/, '') ?? run.id
      if (!this.agents.has(call)) this.agents.set(call, run)
    }
  }
  private subagentProgress(raw: Message, final: boolean): void {
    const call = string(raw.toolCallId)
    const details = object(final ? object(raw.result).details : object(raw.partialResult).details)
    if (!Object.keys(details).length && !final) return
    const prior = this.agents.get(call)
    let run = Object.keys(details).length ? subagentRun(details, call) : prior
    if (!run) return
    // 工具出错（子智能体失败）时 details 是空的：状态和原因从工具结果里拿（结果还是之前的进度）
    if (final && raw.isError === true && run.state === 'running')
      run = { ...run, state: 'failed', result: resultText(object(raw.result)).slice(0, 500) || run.result }
    this.agents.set(call, run)
    this.agentTools.set(call, string(details.lastTool) || this.agentTools.get(call) || null)
    this.emitRuns()
  }
  private emitRuns(): void {
    const runs = [...this.agents.values()]
    this.emit({ type: 'runs', runs: { workflows: [], agents: runs } })
    this.emit({
      type: 'subagents',
      subagents: [...this.agents.entries()]
        .filter(([, r]) => r.state === 'running')
        .map(([call, r]) => subagentStatus(r, this.agentTools.get(call) ?? null)),
    })
  }

  private toolStart(raw: Message): void {
    const name = string(raw.toolName)
    const id = this.toolId(raw)
    this.toolNames.set(id, name)
    this.toolSummaries.set(id, approvalSummary(object(raw.args), name))
    this.put(toolItem(id, name, object(raw.args), this.options.cwd), false)
  }

  private toolUpdate(raw: Message): void {
    if (string(raw.toolName) === SUBAGENT_TOOL) return this.subagentProgress(raw, false)
    const id = this.toolId(raw)
    const item = this.items.get(id)
    if (!item || (item.kind !== 'command' && item.kind !== 'tool')) return
    const text = clip(resultText(raw.partialResult))
    if (text === item.output) return
    // 部分结果可能是累计内容也可能被截断重写：能接上就发增量，否则整条替换
    if (text.startsWith(item.output) && item.output.length < MAX_OUTPUT) {
      const delta = text.slice(item.output.length)
      this.items.set(id, { ...item, output: text })
      this.emit({ type: 'item_delta', itemId: id, field: 'output', delta })
    } else {
      const next = { ...item, output: text }
      this.items.set(id, next)
      this.emit({ type: 'item_started', item: next })
    }
  }

  private toolEnd(raw: Message): void {
    if (string(raw.toolName) === SUBAGENT_TOOL) this.subagentProgress(raw, true)
    const id = this.toolId(raw)
    const prior = this.items.get(id)
    if (!prior) return
    const result = object(raw.result)
    const text = clip(resultText(result))
    const isError = raw.isError === true
    const status: ItemStatus = isError ? (isDeclined(text) ? 'declined' : 'failed') : 'completed'
    let item: Item = prior
    if (prior.kind === 'command') {
      const code = /exited with code (\d+)/i.exec(text)?.[1]
      item = {
        ...prior,
        output: text || prior.output,
        exitCode: !isError ? 0 : status === 'declined' ? null : code !== undefined ? Number(code) : 1,
        status,
      }
    } else if (prior.kind === 'file_change') {
      const patch = string(object(result.details).patch)
      const parsed = !isError && patch ? diffFromPatch(patch) : null
      item = {
        ...prior,
        changes: parsed ? prior.changes.map(c => ({ ...c, kind: 'update' as const, ...parsed })) : prior.changes,
        status,
      }
      // 写入类工具失败时，错误原因放进一条提示，条目本身只带状态
      if (isError && status === 'failed' && text) this.notice('error', text)
    } else if (prior.kind === 'todo') {
      item = { ...prior, status }
      if (isError && status === 'failed' && text) this.notice('error', text)
    } else if (prior.kind === 'tool' && prior.name === PLAN_ITEM_NAME) {
      // 展开看的是计划正文；用户选了继续完善算「已拒绝」（和 Claude 的 ExitPlanMode 一样）
      item = { ...prior, status: !isError && /keep refining/i.test(text) ? 'declined' : status }
    } else if (prior.kind === 'tool') {
      item = { ...prior, output: text, status }
    }
    this.put(item, true)
  }

  private compactionStart(raw: Message): void {
    const reason = string(raw.reason)
    const id = `${this.prefix}-c${++this.noticeSeq}`
    const item: Item = {
      kind: 'compaction',
      id,
      status: 'running',
      trigger: reason === 'manual' ? 'manual' : reason ? 'auto' : null,
      startedAt: Date.now(),
      durationMs: null,
      preTokens: this.lastContext,
      postTokens: null,
    }
    this.compaction = { id, startedAt: item.startedAt, preTokens: this.lastContext }
    this.put(item, false)
  }

  private compactionEnd(raw: Message): void {
    const current = this.compaction
    this.compaction = null
    const prior = current ? this.items.get(current.id) : null
    if (!current || prior?.kind !== 'compaction') return
    const result = object(raw.result)
    const failed = !!raw.errorMessage && raw.aborted !== true
    const status: ItemStatus = raw.aborted === true ? 'interrupted' : failed || !raw.result ? 'failed' : 'completed'
    const post = typeof result.estimatedTokensAfter === 'number' ? result.estimatedTokensAfter : null
    const before = typeof result.tokensBefore === 'number' ? result.tokensBefore : current.preTokens
    this.put(
      {
        ...prior,
        status,
        durationMs: Date.now() - current.startedAt,
        preTokens: before,
        postTokens: post,
        ...(failed ? { error: string(raw.errorMessage) } : {}),
      },
      true,
    )
    if (status === 'completed' && post !== null) {
      this.lastContext = post
      this.emitUsage()
    }
    // 生成摘要的那次调用也花了钱
    const usage = object(result.usage)
    if (Object.keys(usage).length)
      this.addUsage(
        'Pixel',
        {
          input: number(usage.input),
          output: number(usage.output),
          cacheRead: number(usage.cacheRead),
          cacheWrite: number(usage.cacheWrite),
        },
        number(object(usage.cost).total),
      )
  }

  /** 一轮结束：还在运行的条目收尾 */
  finish(outcome: ItemStatus): void {
    for (const item of [...this.items.values()]) {
      if (!('status' in item) || item.status !== 'running') continue
      const finished: Item =
        item.kind === 'compaction'
          ? { ...item, status: outcome, durationMs: Date.now() - item.startedAt }
          : { ...item, status: outcome }
      this.items.set(item.id, finished)
      this.emit({ type: 'item_completed', item: finished })
    }
    this.compaction = null
  }
}

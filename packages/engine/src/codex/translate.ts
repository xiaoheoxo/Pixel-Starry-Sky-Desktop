import type { AgentRun, EngineEvent, FileChange, Item, ItemStatus } from '@pixelsky/protocol'
import { array, object, string, number, type Message } from './process'
import { diffAdded } from '../diff'
import { MAX_OUTPUT, clip } from '../output'
import { codexCommandParts } from './command'
import { codexViewedImage } from './images'

export function codexChanges(value: unknown): FileChange[] {
  return array(value)
    .map((raw): FileChange => {
      const change = object(raw)
      const kind = string(object(change.kind).type || change.kind)
      // 新建文件时 Codex 给的可能是文件原文而不是 diff：换成全是 + 的 diff，行数才对
      const original = string(change.diff)
      const diff = kind === 'add' && original && !/^[+@-]/m.test(original) ? diffAdded(original).diff : original,
        lines = diff.split('\n')
      return {
        path: string(change.path),
        kind: kind === 'add' ? 'add' : kind === 'delete' ? 'delete' : 'update',
        diff,
        added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
        removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
      }
    })
    .filter(change => !!change.path)
}
const statusOf = (value: unknown, complete: boolean): ItemStatus =>
  value === 'failed'
    ? 'failed'
    : value === 'declined'
      ? 'declined'
      : value === 'interrupted'
        ? 'interrupted'
        : complete
          ? 'completed'
          : 'running'
/** 子智能体停在 running 的标成已中断（它的进程没了，或这一轮被中止，不会再有后续）；其他状态不动 */
export const interruptedAgent = (agent: AgentRun): AgentRun =>
  agent.state === 'running' ? { ...agent, state: 'interrupted' } : agent
/** 当前 thread 的条目转换；原生用户消息由宿主负责，只用于输入确认。 */
export class CodexTranslator {
  readonly items = new Map<string, Item>()
  /** 压缩完了还没有压缩后的大小：等下一次用量更新补上（docs/ui/compaction.md） */
  private compactionSize: string | null = null
  /**
   * 上一次有动静的时间（这一轮开始、条目开始 / 结束 / 增量）。Codex 的思考条目要等模型想完才开始、紧接着就结束，
   * 真正在想的是上一次动静到它出现的这段，思考用时从这里算
   */
  private lastAt = Date.now()
  private readonly reasoningStart = new Map<string, number>()
  constructor(
    private readonly emit: (event: EngineEvent) => void,
    /** 当前上下文占用（最近一次请求），压缩开始时当「压缩前」 */
    private readonly contextTokens: () => number | null = () => null,
    /** 子智能体按线程 id 记；会话传入同一个，跨轮保留（结束常在后面的轮次才到） */
    readonly agents = new Map<string, AgentRun>(),
    private readonly cwd?: string,
  ) {}
  /** timed：是否算思考用时。冷读的历史（子智能体记录）一次性全倒进来，算出来都是 0，不算，界面按没有用时显示 */
  item(raw: Message, complete: boolean, timed = true): void {
    const id = 'cx-' + string(raw.id),
      type = string(raw.type)
    if (type === 'subAgentActivity') return this.subagent(raw, complete)
    const status = statusOf(raw.status, complete),
      prior = this.items.get(id),
      // collab 调用有派出 / 发消息 / 等待 / 关闭几种（raw.tool），只有派出的才是子智能体的派发卡
      spawns = /^(collabAgentToolCall|collabToolCall)$/.test(type) && /^spawn_?agent$/i.test(string(raw.tool))
    const now = Date.now(),
      since = this.lastAt
    this.lastAt = now
    let item: Item | null = null
    if (type === 'agentMessage' || type === 'plan')
      item = {
        kind: 'assistant',
        id,
        text: string(raw.text) || (prior?.kind === 'assistant' ? prior.text : ''),
        status,
      }
    else if (type === 'reasoning') {
      if (!this.reasoningStart.has(id)) this.reasoningStart.set(id, since)
      item = {
        kind: 'reasoning',
        id,
        text: array(raw.summary).map(string).join('\n\n') || (prior?.kind === 'reasoning' ? prior.text : ''),
        status,
        ...(status === 'running' || !timed ? {} : { durationMs: now - this.reasoningStart.get(id)! }),
      }
    } else if (type === 'commandExecution') {
      const { command, wrapper } = codexCommandParts(string(raw.command))
      item = {
        kind: 'command',
        id,
        command,
        ...(wrapper ? { wrapper } : {}),
        // description 是命令说明（悬停时显示）；Codex 没有说明，不能放工作目录
        description: null,
        output: clip(string(raw.aggregatedOutput)) || (prior?.kind === 'command' ? prior.output : ''),
        exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
        status,
      }
    } else if (type === 'fileChange') item = { kind: 'file_change', id, changes: codexChanges(raw.changes), status }
    else if (type === 'contextCompaction') {
      const before = prior?.kind === 'compaction' ? prior : null
      const startedAt = before?.startedAt ?? Date.now()
      item = {
        kind: 'compaction',
        id,
        status,
        trigger: null,
        startedAt,
        durationMs: status !== 'running' && before ? Date.now() - startedAt : null,
        preTokens: before ? before.preTokens : this.contextTokens(),
        postTokens: null,
      }
      if (status === 'completed') this.compactionSize = id
    } else if (type !== 'userMessage') {
      const tool =
        type === 'mcpToolCall'
          ? 'mcp'
          : type === 'webSearch'
            ? 'web'
            : /collab|subAgent/.test(type)
              ? 'task'
              : type === 'imageView'
                ? 'read'
                : 'other'
      const image =
        type === 'imageView' && complete && status === 'completed'
          ? (prior?.kind === 'tool' ? prior.images?.[0] : null) ||
            codexViewedImage(string(raw.path) || (prior?.kind === 'tool' ? prior.title : ''), id, this.cwd)
          : null
      item = {
        kind: 'tool',
        id,
        tool,
        name: type === 'mcpToolCall' ? `${string(raw.server)} / ${string(raw.tool)}` : spawns ? 'spawn_agent' : type,
        title: string(raw.command || raw.query || raw.prompt || raw.path || raw.tool || raw.name) || type,
        output: clip(
          raw.error ? JSON.stringify(raw.error) : raw.result ? JSON.stringify(raw.result) : string(raw.output),
        ),
        status,
        ...(image ? { images: [image] } : {}),
      }
    }
    if (!item) return
    if (type === 'collabAgentToolCall' || type === 'collabToolCall') {
      const states = object(raw.agentsStates)
      for (const agentId of array(raw.receiverThreadIds ?? (raw.newThreadId ? [raw.newThreadId] : [])).map(string)) {
        if (!agentId) continue
        const state = object(states[agentId]),
          priorAgent = this.agents.get(agentId)
        this.agents.set(agentId, {
          id: agentId,
          label: agentId.slice(0, 8),
          type: 'Codex',
          model: string(raw.model) || priorAgent?.model || '',
          state: string(state.status) || (complete ? 'completed' : 'running'),
          startedAt: priorAgent?.startedAt ?? Date.now(),
          durationMs: 0,
          tokens: 0,
          toolCalls: 0,
          phase: null,
          prompt: string(raw.prompt) || priorAgent?.prompt || '',
          result: string(state.message),
          // 只有派出调用认领子智能体；等待 / 发消息 / 关闭沿用派出时的卡片 id
          toolUseId: spawns ? id : (priorAgent?.toolUseId ?? id),
        })
      }
      this.emitRuns()
    }
    this.items.set(id, item)
    this.emit({ type: complete ? 'item_completed' : 'item_started', item })
  }
  /**
   * 新版 Codex 的子智能体（collaboration 命名空间）：started 是派出（id 就是 spawn_agent 的调用 id），
   * interacted 是发消息 / 追加任务，completed 是跑完（id 是合成的，可能在后面的轮次才到）。
   * 只有派出出卡片，其余只更新追踪。
   */
  subagent(raw: Message, complete: boolean): void {
    const agentId = string(raw.agentThreadId)
    if (!agentId) return
    const kind = string(raw.kind),
      prior = this.agents.get(agentId),
      label = string(raw.agentPath).split('/').filter(Boolean).pop() || prior?.label || agentId.slice(0, 8),
      startedAt = prior?.startedAt ?? Date.now(),
      done = kind === 'completed'
    let toolUseId = prior?.toolUseId ?? null
    if (kind === 'started') {
      const id = 'cx-' + string(raw.id),
        item: Item = {
          kind: 'tool',
          id,
          tool: 'task',
          name: 'spawn_agent',
          title: label,
          output: '',
          status: statusOf(raw.status, complete),
        }
      toolUseId = id
      this.items.set(id, item)
      this.emit({ type: complete ? 'item_completed' : 'item_started', item })
    }
    this.agents.set(agentId, {
      id: agentId,
      label,
      type: 'Codex',
      model: string(raw.model) || prior?.model || '',
      state: done ? 'completed' : 'running',
      startedAt,
      durationMs: done ? Date.now() - startedAt : 0,
      tokens: prior?.tokens ?? 0,
      toolCalls: prior?.toolCalls ?? 0,
      phase: null,
      prompt: prior?.prompt ?? '',
      result: prior?.result ?? '',
      toolUseId,
    })
    this.emitRuns()
  }
  /** 子智能体线程自己的事件：只算工具次数和 token，不进主对话 */
  child(threadId: string, method: string, params: Message): void {
    const agent = this.agents.get(threadId)
    if (!agent) return
    let next = agent
    if (method === 'item/completed') {
      const type = string(object(params.item).type)
      if (!/^(agentMessage|plan|reasoning|userMessage|contextCompaction)$/.test(type))
        next = { ...agent, toolCalls: agent.toolCalls + 1 }
    } else if (method === 'thread/tokenUsage/updated')
      next = { ...agent, tokens: tokenCounts(object(params.tokenUsage).total).total }
    if (next === agent) return
    this.agents.set(threadId, next)
    this.emitRuns()
  }
  private emitRuns(): void {
    this.emit({ type: 'runs', runs: { workflows: [], agents: [...this.agents.values()] } })
    this.emit({
      type: 'subagents',
      subagents: [...this.agents.values()].map(agent => ({
        id: agent.id,
        label: agent.label,
        status: agent.state,
        message: agent.result || agent.prompt,
      })),
    })
  }
  delta(method: string, params: Message): void {
    const id = 'cx-' + string(params.itemId),
      prior = this.items.get(id)
    if (!prior) {
      this.item(
        {
          id: params.itemId,
          type: method.includes('reasoning')
            ? 'reasoning'
            : method.includes('commandExecution')
              ? 'commandExecution'
              : 'agentMessage',
        },
        false,
      )
    }
    this.lastAt = Date.now()
    const item = this.items.get(id)
    if (!item) return
    const field = item.kind === 'command' || item.kind === 'tool' ? 'output' : 'text'
    const delta = string(params.delta)
    if (!delta) return
    if ('text' in item && field === 'text') this.items.set(id, { ...item, text: item.text + delta })
    else if ('output' in item) {
      // 输出超过上限就不再追加（完成时 aggregatedOutput 会按头尾截好）
      if (item.output.length >= MAX_OUTPUT) return
      this.items.set(id, { ...item, output: item.output + delta })
    }
    this.emit({ type: 'item_delta', itemId: id, field, delta })
  }
  plan(params: Message): void {
    const id = 'cx-plan-' + string(params.turnId)
    this.lastAt = Date.now()
    const item: Item = {
      kind: 'todo',
      id,
      steps: array(params.plan).map(v => {
        const p = object(v)
        return {
          text: string(p.step),
          status: p.status === 'completed' ? 'completed' : p.status === 'inProgress' ? 'in_progress' : 'pending',
        }
      }),
      status: 'running',
    }
    this.items.set(id, item)
    this.emit({ type: 'item_completed', item })
  }
  /** 用量更新：刚压缩完的那条补上压缩后的大小（比压缩前小才算，没重新计数时不改） */
  usage(contextTokens: number): void {
    const id = this.compactionSize
    const item = id ? this.items.get(id) : null
    if (!id || item?.kind !== 'compaction' || contextTokens <= 0) return
    this.compactionSize = null
    if (item.preTokens !== null && contextTokens >= item.preTokens) return
    const next = { ...item, postTokens: contextTokens }
    this.items.set(id, next)
    this.emit({ type: 'item_completed', item: next })
  }
  finish(outcome: ItemStatus): void {
    for (const item of this.items.values())
      if ('status' in item && item.status === 'running') {
        const finished =
          item.kind === 'compaction'
            ? { ...item, status: outcome, durationMs: Date.now() - item.startedAt }
            : { ...item, status: outcome }
        this.items.set(item.id, finished)
        this.emit({ type: 'item_completed', item: finished })
      }
    // 进程退出 / 这一轮被中断或失败：还在 running 的子智能体小卡片不能一直转，标成已中断（同 runs.ts 读回磁盘时）。
    // 正常结束（completed）不动：子智能体可能在主轮结束后才跑完；之后到的「跑完」事件会把状态改回 completed
    if (outcome === 'completed') return
    let changed = false
    for (const [id, agent] of this.agents) {
      const next = interruptedAgent(agent)
      if (next === agent) continue
      this.agents.set(id, next)
      changed = true
    }
    if (changed) this.emitRuns()
  }
}

export function tokenCounts(raw: unknown): {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
} {
  const value = object(raw),
    cacheRead = number(value.cachedInputTokens),
    cacheWrite = number(value.cacheWriteInputTokens)
  return {
    input: Math.max(0, number(value.inputTokens) - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: number(value.outputTokens),
    total: number(value.totalTokens),
  }
}

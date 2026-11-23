// 像素星空的子智能体（命令行的 task 工具，packages/cli/src/tools/subagent.ts）→ 智能体追踪。
// 运行中：task 工具的 tool_execution_update / end 带 details（SubagentProgress），变成 AgentRun；
// 重新打开会话：从 Pi 主会话文件里的 pixelsky-subagent 条目读回来；子智能体的对话见 transcript.ts。
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { subagentEffort, type AgentRun, type SubagentStatus } from '@pixelsky/protocol'
import { LINE_MAX } from '../jsonl'
import { array, number, object, string, type Message } from './process'

export const SUBAGENT_TOOL = 'task'
/** 主会话文件里子智能体结果的条目类型（subagent.ts 的 SUBAGENT_ENTRY） */
export const SUBAGENT_ENTRY = 'pixelsky-subagent'

/**
 * 子智能体转审批之前报的上下文（subagent.ts 的 APPROVAL_CONTEXT_STATUS）：紧接着的那条审批询问是子进程里哪次工具调用。
 * 主会话里没有这个工具条目，卡片上的命令 / 改动按这里的参数显示
 */
export const APPROVAL_CONTEXT_STATUS = 'pixelsky-approval-context'

export interface SubagentApproval {
  /** 主会话里 task 工具调用的 id */
  toolCallId: string
  agentId: string
  label: string
  tool: string
  args: Message
}

export function subagentApproval(text: string): SubagentApproval | null {
  try {
    const o = object(JSON.parse(text))
    const tool = string(o.tool)
    if (!tool) return null
    return {
      toolCallId: string(o.toolCallId),
      agentId: string(o.agentId),
      label: string(o.label),
      tool,
      args: object(o.args),
    }
  } catch {
    return null
  }
}

/** task 工具条目的 id：不带进程随机前缀，重新打开会话时按工具调用 id 也能对上（追踪窗口用 toolUseId 找条目） */
export function subagentItemId(toolCallId: string): string {
  return `px-task-${toolCallId}`
}

/** 子智能体进度（details）→ 追踪里的一个智能体 */
export function subagentRun(details: Message, toolCallId: string): AgentRun {
  return {
    id: string(details.agentId) || toolCallId,
    label: string(details.label) || 'Subagent',
    // 设置 › 子智能体的类型；老的记录没有，仍是 subagent
    type: string(details.type) || 'subagent',
    ...(string(details.typeName) ? { typeLabel: string(details.typeName) } : {}),
    model: string(details.model),
    ...('effort' in details ? { effort: subagentEffort(details.effort) } : {}),
    ...(details.modelSource === 'chosen' || details.modelSource === 'default'
      ? { modelSource: details.modelSource }
      : {}),
    ...(details.outsideGroup === true ? { outsideGroup: true } : {}),
    state: string(details.state) || 'running',
    startedAt: number(details.startedAt),
    durationMs: number(details.durationMs),
    tokens: number(details.tokens),
    toolCalls: number(details.toolCalls),
    phase: null,
    prompt: string(details.prompt).slice(0, 500),
    result: string(details.result).slice(0, 500),
    toolUseId: subagentItemId(toolCallId),
  }
}

/** 子智能体按模型的累计用量（subagent.ts 的 SubagentModelUsage；老版本命令行没有） */
export type SubagentUsage = Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; requests: number }
>

export function subagentUsage(details: Message): SubagentUsage {
  const out: SubagentUsage = {}
  for (const [model, raw] of Object.entries(object(details.usage))) {
    const u = object(raw)
    out[model] = {
      input: number(u.input),
      output: number(u.output),
      cacheRead: number(u.cacheRead),
      cacheWrite: number(u.cacheWrite),
      cost: number(u.cost),
      requests: number(u.requests),
    }
  }
  return out
}

/** 主会话文件里记下的子智能体用量合计（同一个工具调用以最后一条为准）：切回旧会话时加进会话累计（Pi 的统计不含子进程） */
export function subagentTotals(list: Message[]): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
} {
  const byCall = new Map<string, SubagentUsage>()
  for (const e of list)
    if (e.type === 'custom' && e.customType === SUBAGENT_ENTRY) {
      const data = object(e.data)
      if (string(data.toolCallId)) byCall.set(string(data.toolCallId), subagentUsage(data))
    }
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  for (const usage of byCall.values())
    for (const u of Object.values(usage)) {
      sum.input += u.input
      sum.output += u.output
      sum.cacheRead += u.cacheRead
      sum.cacheWrite += u.cacheWrite
      sum.cost += u.cost
    }
  return sum
}

/** 子智能体条（运行中的那几个）上显示的一项 */
export function subagentStatus(run: AgentRun, lastTool: string | null): SubagentStatus {
  return {
    id: run.id,
    label: run.label,
    status: run.state,
    message: run.result || (lastTool ? lastTool : null) || run.prompt || null,
    ...(lastTool ? { lastTool } : {}),
    ...(run.result ? { result: run.result } : {}),
    task: run.prompt.slice(0, 200),
    toolUseId: run.toolUseId ?? undefined,
  }
}

const READ_CHUNK = 1024 * 1024

/**
 * 读 Pi 的会话文件（JSONL）：按块读、按行切，不把整个文件变成一个字符串（长会话的文件会超过 V8 字符串上限 512 MB）。
 * 给了 keep 就只解析含这段文字的行；写到一半的最后一行、超过 LINE_MAX 的行跳过。
 * start：从这个字节开始读（终端模式只读切过去之后追加的，tui.ts）；落在行中间时那半行解析不了，跳过
 */
export function entries(file: string, keep?: string, start = 0): Message[] {
  if (!file || !existsSync(file)) return []
  const out: Message[] = []
  const mark = keep ? Buffer.from(keep) : null
  let parts: Buffer[] = []
  let size = 0
  const take = (part: Buffer): void => {
    size += part.length
    if (size <= LINE_MAX) parts.push(part)
    else parts = []
  }
  const end = (): void => {
    const line = size <= LINE_MAX ? Buffer.concat(parts, size) : null
    parts = []
    size = 0
    if (!line || (mark && !line.includes(mark))) return
    try {
      out.push(object(JSON.parse(line.toString('utf8'))))
    } catch {
      // 空行、写到一半的最后一行
    }
  }
  const fd = openSync(file, 'r')
  let pos = start
  try {
    for (;;) {
      // 每块新分配：take 留着的是这块的切片
      const chunk = Buffer.allocUnsafe(READ_CHUNK)
      const n = readSync(fd, chunk, 0, READ_CHUNK, pos)
      pos += n
      if (!n) break
      const data = chunk.subarray(0, n)
      let from = 0
      for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, from)) {
        take(data.subarray(from, i))
        end()
        from = i + 1
      }
      if (from < n) take(data.subarray(from))
    }
  } finally {
    closeSync(fd)
  }
  if (size) end()
  return out
}

/** 主会话文件里记下的子智能体（同一个工具调用以最后一条为准） */
export function runsFromSession(
  file: string,
  list: Message[] = entries(file, SUBAGENT_ENTRY),
): Array<AgentRun & { sessionFile: string | null }> {
  const byCall = new Map<string, AgentRun & { sessionFile: string | null }>()
  for (const e of list) {
    if (e.type !== 'custom' || e.customType !== SUBAGENT_ENTRY) continue
    const data = object(e.data)
    const call = string(data.toolCallId)
    if (!call) continue
    byCall.set(call, { ...subagentRun(data, call), sessionFile: string(data.sessionFile) || null })
  }
  return [...byCall.values()]
}

/** oh-my-pi 的 task 工具进度（TaskToolDetails：results、progress，一次调用可以派几个子智能体，docs/omp-engine.md §11.4） */
export function isOmpTaskDetails(details: Message): boolean {
  return Array.isArray(details.results) && ('totalDurationMs' in details || Array.isArray(details.progress))
}

const OMP_AGENT_STATE: Record<string, string> = {
  pending: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  aborted: 'stopped',
}

/** omp 一次 task 调用里的各个子智能体 → 追踪里的智能体（id 是 omp 给的子智能体 id）；lastTool 是正在用的工具 */
export function ompSubagentRuns(
  details: Message,
  toolCallId: string,
  startedAt: (id: string) => number,
): Array<{ run: AgentRun; lastTool: string | null }> {
  const results = new Map(array(details.results).map(r => [string(object(r).id), object(r)]))
  const progress = new Map(array(details.progress).map(p => [string(object(p).id), object(p)]))
  const ids = [...new Set([...progress.keys(), ...results.keys()])].filter(Boolean)
  return ids.map(id => {
    const p = progress.get(id) ?? {},
      r = results.get(id)
    const src = r ?? p
    const state = r
      ? r.aborted === true
        ? 'stopped'
        : number(r.exitCode) === 0 && !string(r.error)
          ? 'completed'
          : 'failed'
      : (OMP_AGENT_STATE[string(p.status)] ?? 'running')
    const live = string(p.stage) || string(p.lastIntent) || string(array(p.recentOutput).at(-1))
    return {
      run: {
        id,
        // 没写说明时用它的名字（omp 的 id 就是派活时起的名字）
        label: string(src.description) || id,
        type: string(src.agent) || 'task',
        model: string(src.resolvedModel).replace(/:[^/:]*$/, ''),
        state,
        startedAt: startedAt(id),
        durationMs: number(src.durationMs),
        tokens: number(src.tokens),
        toolCalls: number(p.toolCount),
        phase: null,
        prompt: (string(src.assignment) || string(src.task)).slice(0, 500),
        result: (r ? string(r.output) || string(r.error) || string(r.stderr) : live).slice(0, 500),
        toolUseId: subagentItemId(toolCallId),
      },
      lastTool: string(p.currentTool) || null,
    }
  })
}

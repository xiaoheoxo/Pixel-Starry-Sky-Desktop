// 像素星空的子智能体（命令行的 task 工具，packages/cli/src/tools/subagent.ts）→ 智能体追踪。
// 运行中：task 工具的 tool_execution_update / end 带 details（SubagentProgress），变成 AgentRun；
// 重新打开会话：从 Pi 主会话文件里的 pixelsky-subagent 条目读回来；子智能体的对话见 transcript.ts。
import { existsSync, readFileSync } from 'node:fs'
import type { AgentRun, SubagentStatus } from '@pixelsky/protocol'
import { number, object, string, type Message } from './process'

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
    type: 'subagent',
    model: string(details.model),
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

/** 读 Pi 的会话文件（JSONL）；写到一半的最后一行跳过 */
export function entries(file: string): Message[] {
  if (!file || !existsSync(file)) return []
  const out: Message[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(object(JSON.parse(line)))
    } catch {
      // 写到一半的最后一行
    }
  }
  return out
}

/** 主会话文件里记下的子智能体（同一个工具调用以最后一条为准） */
export function runsFromSession(file: string): Array<AgentRun & { sessionFile: string | null }> {
  const byCall = new Map<string, AgentRun & { sessionFile: string | null }>()
  for (const e of entries(file)) {
    if (e.type !== 'custom' || e.customType !== SUBAGENT_ENTRY) continue
    const data = object(e.data)
    const call = string(data.toolCallId)
    if (!call) continue
    byCall.set(call, { ...subagentRun(data, call), sessionFile: string(data.sessionFile) || null })
  }
  return [...byCall.values()]
}

// 打开智能体追踪面板（docs/engines.md §15.4）：对话流里的工具行、子智能体条、后台任务条都通过这个上下文打开
import { createContext, useContext } from 'react'

/** 打开后定位到哪里：某个智能体，或某次 Agent / Workflow 工具调用；都不给时打开总览 */
export interface TraceTarget {
  agentId?: string
  filePath?: string
  toolUseId?: string
}

export const TraceContext = createContext<((target?: TraceTarget) => void) | null>(null)

/** 没有追踪面板（例如演示模式）时返回 null */
export function useOpenTrace(): ((target?: TraceTarget) => void) | null {
  return useContext(TraceContext)
}

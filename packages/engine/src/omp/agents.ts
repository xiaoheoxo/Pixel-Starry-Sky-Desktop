// oh-my-pi 的子智能体（docs/omp-engine.md §12.2）：对话在 <主会话文件去掉 .jsonl>/<子智能体 id>.jsonl，格式同主会话；
// 重开应用从主会话文件读回：task 的结果里有各个子智能体，后台跑完的结果在之后的 async-result 条目里
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AgentRun } from '@pixelsky/protocol'
import { entries, isOmpTaskDetails, ompSubagentRuns, type SubagentUsage } from '../pixel/agents'
import { array, number, object, string } from '../pixel/process'
import { ompPath, ompTree } from './branch'

/** 子智能体的会话文件；id 不是单个文件名、文件不在返回 null。会话改存到新文件时（§12.1）omp 会一起复制过去（实测） */
export function ompAgentFile(sessionFile: string, id: string): string | null {
  if (!sessionFile.endsWith('.jsonl') || !id || id === '.' || id === '..' || /[\\/:]/.test(id)) return null
  const file = join(dirname(sessionFile), basename(sessionFile, '.jsonl'), `${id}.jsonl`)
  return existsSync(file) ? file : null
}

export interface OmpAgentStats {
  size: number
  usage: SubagentUsage
  toolCalls: number
  tokens: number
}

/** 子智能体会话文件里的用量（含它自己的辅助请求 model_usage）和工具调用数 */
export function ompAgentStats(file: string): OmpAgentStats {
  const stats: OmpAgentStats = { size: statSync(file).size, usage: {}, toolCalls: 0, tokens: 0 }
  for (const e of entries(file, '"usage"')) {
    const m = e.type === 'message' ? object(e.message) : e
    if (e.type === 'message' ? m.role !== 'assistant' : e.type !== 'model_usage') continue
    if (e.type === 'message') stats.toolCalls += array(m.content).filter(b => object(b).type === 'toolCall').length
    const u = object(m.usage)
    const counts = {
      input: number(u.input),
      output: number(u.output),
      cacheRead: number(u.cacheRead),
      cacheWrite: number(u.cacheWrite),
    }
    const cost = number(object(u.cost).total)
    const total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite
    if (!total && !cost) continue
    const model = string(m.responseModel) || string(m.model) || 'oh-my-pi'
    const sum = (stats.usage[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 })
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) sum[key] += counts[key]
    sum.cost += cost
    sum.requests++
    if (e.type === 'message') stats.tokens += total
  }
  return stats
}

const JOB_STATE: Record<string, string> = { completed: 'completed', cancelled: 'stopped', aborted: 'stopped' }

/** async-result 正文里这个子智能体的结果（<task-result id="…"> 里的 <output> / <abort-reason>） */
function jobResult(content: string, id: string): string {
  const mark = `<task-result id="${id}"`
  const at = content.indexOf(mark)
  if (at < 0) return ''
  const from = content.indexOf('>', at) + 1
  const to = content.indexOf('</task-result>', from)
  const inner = content.slice(from, to < 0 ? undefined : to).trim()
  return /^<([\w-]+)>([\s\S]*)<\/\1>$/.exec(inner)?.[2].trim() ?? inner
}

/**
 * 主会话文件里记下的子智能体。没等到结果的算停了：读的时候它们所在的进程已经不在。
 * 只算当前分支上的（at：还没落实的截断点）：回退掉的轮次派的不再列
 */
export function ompRunsFromSession(sessionFile: string, at?: string | null): AgentRun[] {
  if (!existsSync(sessionFile)) return []
  let branch: Set<string> | null = null
  const kept = (e: { id?: unknown }): boolean => {
    branch ??= new Set(ompPath(ompTree(sessionFile), at).map(r => r.id))
    return branch.has(string(e.id))
  }
  const jobs = new Map<string, { state: string; durationMs: number; result: string }>()
  for (const e of entries(sessionFile, '"async-result"')) {
    if (e.type !== 'custom_message' || e.customType !== 'async-result' || !kept(e)) continue
    const text =
      typeof e.content === 'string'
        ? e.content
        : array(e.content)
            .map(b => string(object(b).text))
            .join('')
    for (const raw of array(object(e.details).jobs)) {
      const job = object(raw)
      const id = string(job.agentId) || string(job.jobId)
      if (job.type !== 'task' || !id) continue
      jobs.set(id, {
        state: JOB_STATE[string(job.status)] ?? 'failed',
        durationMs: number(job.durationMs),
        result: jobResult(text, id).slice(0, 500),
      })
    }
  }
  const runs = new Map<string, AgentRun>()
  for (const e of entries(sessionFile, '"toolName":"task"')) {
    const m = object(e.message)
    const details = object(m.details)
    if (e.type !== 'message' || m.role !== 'toolResult' || m.toolName !== 'task' || !isOmpTaskDetails(details)) continue
    if (!kept(e)) continue
    const call = string(m.toolCallId)
    const at = Date.parse(string(e.timestamp)) || 0
    for (const { run } of ompSubagentRuns(details, call, () => at)) {
      const job = jobs.get(run.id)
      const open = run.state === 'running' || run.state === 'queued'
      const next = job
        ? { ...run, ...job, result: job.result || run.result }
        : open
          ? { ...run, state: 'stopped' }
          : run
      const file = ompAgentFile(sessionFile, run.id)
      const stats = file ? ompAgentStats(file) : null
      runs.set(`${call}:${run.id}`, {
        ...next,
        tokens: stats?.tokens || next.tokens,
        toolCalls: stats?.toolCalls || next.toolCalls,
        model: next.model || Object.keys(stats?.usage ?? {})[0] || '',
      })
    }
  }
  return [...runs.values()]
}

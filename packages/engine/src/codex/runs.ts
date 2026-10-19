import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentRun, AgentRuns, EngineEvent } from '@pixelsky/protocol'
import { object, string } from './process'
import { CodexTranslator, interruptedAgent } from './translate'

const DAY = 86_400_000

/** UUIDv7 的线程 id：前 48 位是毫秒时间戳，rollout 按它的日期放目录；不是 v7 返回 null */
export function threadTime(threadId: string): number | null {
  const hex = threadId.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return null
  return parseInt(hex.slice(0, 12), 16)
}

/**
 * 线程的全部 rollout 文件：sessions/YYYY/MM/DD 下文件名带线程 id。
 * 接着跑的线程会另起一段（文件名后面带段的 id，放在当天的目录），所以从线程创建那天（前一天起，按本地日期）往后都要找。
 * 文件名以时间开头，排序就是先后顺序
 */
export function findCodexRollouts(codexHome: string, threadId: string): string[] {
  const at = threadTime(threadId)
  if (at === null) return []
  const from = new Date(at - DAY),
    pad = (n: number) => String(n).padStart(2, '0'),
    first = `${from.getFullYear()}/${pad(from.getMonth() + 1)}/${pad(from.getDate())}`,
    root = join(codexHome, 'sessions'),
    list = (dir: string, pattern: RegExp): string[] =>
      existsSync(dir) ? readdirSync(dir).filter(name => pattern.test(name)) : [],
    files: string[] = []
  for (const year of list(root, /^\d{4}$/))
    for (const month of list(join(root, year), /^\d{2}$/))
      for (const day of list(join(root, year, month), /^\d{2}$/)) {
        if (`${year}/${month}/${day}` < first) continue
        for (const name of list(join(root, year, month, day), /^rollout-.*\.jsonl$/))
          if (name.includes(threadId)) files.push(join(root, year, month, day, name))
      }
  return files.sort((a, b) => basename(a).localeCompare(basename(b)))
}

/** 重新打开会话时从 rollout 还原子智能体追踪（rollout 里字段是 snake_case） */
export function loadCodexRuns(codexHome: string, threadId: string): AgentRuns {
  const agents = new Map<string, AgentRun>()
  const translator = new CodexTranslator((_: EngineEvent) => {}, undefined, agents)
  const lines = findCodexRollouts(codexHome, threadId).flatMap(file => readFileSync(file, 'utf8').split('\n'))
  for (const line of lines) {
    if (!line.includes('SubAgentActivity')) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const payload = object(object(entry).payload),
      item = object(payload.item)
    if (object(entry).type !== 'event_msg' || payload.type !== 'item_completed' || item.type !== 'SubAgentActivity')
      continue
    const startedAt = typeof payload.started_at_ms === 'number' ? payload.started_at_ms : null,
      agentId = string(item.agent_thread_id),
      prior = agents.get(agentId)
    translator.subagent(
      {
        id: item.id,
        kind: item.kind,
        agentThreadId: agentId,
        agentPath: item.agent_path,
        model: item.model,
      },
      true,
    )
    const agent = agents.get(agentId)
    if (!agent || startedAt === null) continue
    // 用 rollout 里的时间，而不是读取时的时间
    const begun = prior?.startedAt ?? startedAt
    agents.set(agentId, {
      ...agent,
      startedAt: begun,
      durationMs: agent.state === 'completed' ? Math.max(0, startedAt - begun) : 0,
    })
  }
  // 从磁盘读回来的会话没有活着的子进程：还停在 running 的子智能体不会再有后续，标成已中断（与 Claude 侧把没结束的工具标中断一致）
  return {
    workflows: [],
    agents: [...agents.values()].map(interruptedAgent),
  }
}

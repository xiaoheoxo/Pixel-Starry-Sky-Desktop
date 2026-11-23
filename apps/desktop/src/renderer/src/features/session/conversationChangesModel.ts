import type { AgentRun, Item } from '@pixelsky/protocol'
import {
  isTurnUser,
  latestTurnChanges,
  relativePath,
  type TurnChanges,
  type TurnFile,
} from '@/features/coding/ai/turnChangesModel'

interface ChangeGroup {
  key: string
  label: string | null
  agentId?: string
  files: TurnFile[]
}

type CompletedChange = Extract<Item, { kind: 'file_change' }>

const windowsPath = (path: string): boolean => /^(?:[a-z]:[\/]|\\)/i.test(path)

export function conversationChangePath(cwd: string | null, path: string): string {
  const insensitive = windowsPath(cwd ?? path)
  const relative = relativePath(cwd ?? '', path, insensitive)
  return insensitive ? relative.toLowerCase() : relative
}

/** This transient control shows the current turn only, never the previously completed one. */
export function activeConversationChanges(
  items: readonly Item[],
  cwd: string | null,
  running: boolean,
  agents: readonly AgentRun[] = [],
): (TurnChanges & { groups: ChangeGroup[] }) | null {
  if (!running) return null
  const turnStart = items.findLastIndex(isTurnUser)
  const turnItems = turnStart > 0 ? items.slice(turnStart) : items
  const start = turnStart >= 0 ? turnItems[0] : null
  const currentCalls = new Set(turnItems.filter(item => item.kind === 'tool').map(item => item.id))
  const allCalls = new Set(items.filter(item => item.kind === 'tool').map(item => item.id))
  const byCall = new Map(agents.flatMap(agent => (agent.toolUseId ? [[agent.toolUseId, agent] as const] : [])))
  const editsInOrder: CompletedChange[] = []
  const byGroup = new Map<string, { label: string | null; agentId?: string; edits: CompletedChange[] }>()
  const insert = (key: string, label: string | null, edit: CompletedChange, agentId?: string) => {
    const group = byGroup.get(key) ?? { label, agentId, edits: [] }
    group.edits.push(edit)
    editsInOrder.push(edit)
    byGroup.set(key, group)
  }
  for (const item of turnItems) {
    if (item.kind !== 'file_change' || item.status !== 'completed') continue
    const call = item.subagentCall
    if (call && allCalls.has(call) && !currentCalls.has(call)) continue
    const agent = call ? byCall.get(call) : undefined
    const label = agent?.label || item.subagent || call || null
    insert(label ? `agent:${agent?.id ?? call ?? label}` : 'main', label, item, agent?.id)
  }
  for (const agent of agents) {
    if (!agent.toolUseId || !currentCalls.has(agent.toolUseId) || !agent.fileChanges?.length) continue
    insert(
      `agent:${agent.id}`,
      agent.label || agent.id,
      {
        id: `agent-edits:${agent.id}`,
        kind: 'file_change',
        status: 'completed',
        changes: agent.fileChanges.map(change => ({ ...change, diff: '' })),
      },
      agent.id,
    )
  }

  const caseInsensitive = !!cwd && /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd)
  const aggregate = (edits: CompletedChange[]) =>
    latestTurnChanges(start ? [start, ...edits] : edits, true, cwd ?? '', caseInsensitive)
  const total = aggregate(editsInOrder)
  if (!total?.files.length) return null
  const groups = [...byGroup]
    .sort(([a], [b]) => Number(b === 'main') - Number(a === 'main'))
    .flatMap(([key, { edits, label, agentId }]) => {
      const group = aggregate(edits)
      return group?.files.length ? [{ key, label, agentId, files: group.files }] : []
    })
  return { ...total, groups }
}

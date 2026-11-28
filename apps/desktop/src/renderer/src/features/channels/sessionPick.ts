// 「添加 AI 成员」里的「已有会话」（docs/ui/import-collab.md 第 5 项 ②b）：列哪些会话、每行标什么
import { isChatProject, type ProjectRecord, type SessionSummary } from '@pixelsky/protocol'
import type { AgentMember, Channel, ChannelMember } from '@/data/types'

/** 最多列这么多条（按最近更新），再多请用搜索 */
export const SESSION_PICK_LIMIT = 50

/**
 * in：已经在这个频道里（灰掉）；used：频道自己建的、一直共用一个会话的成员在用（灰掉，加进来会两个成员抢一个会话）；
 * bound：已是别的频道里的成员（加进来用同一个成员、同一个名字）
 */
export type SessionTag = { kind: 'in' | 'used' | 'bound'; name: string; memberId: string }

export interface SessionCandidate {
  id: string
  title: string
  engine: SessionSummary['record']['engine']
  projectId: string
  project: string
  updatedAt: number
  running: boolean
  tag: SessionTag | null
}

/** 灰掉、不能选的 */
export const pickBlocked = (c: SessionCandidate): boolean => c.tag?.kind === 'in' || c.tag?.kind === 'used'

function tagOf(sessionId: string, agents: readonly AgentMember[], memberIds: readonly string[]): SessionTag | null {
  const users = agents.filter(m => m.config?.mode === 'shared' && m.config.sharedSessionId === sessionId)
  const inside = users.find(m => memberIds.includes(m.id))
  if (inside) return { kind: 'in', name: inside.name, memberId: inside.id }
  // 后端 joinSession 只复用绑定的成员：频道自己建的共用会话成员不能再绑一次
  const own = users.find(m => !m.config?.bound)
  if (own) return { kind: 'used', name: own.name, memberId: own.id }
  const bound = users[0]
  return bound ? { kind: 'bound', name: bound.name, memberId: bound.id } : null
}

export function sessionCandidates(input: {
  sessions: readonly SessionSummary[]
  projects: readonly ProjectRecord[]
  members: readonly ChannelMember[]
  channel: Pick<Channel, 'memberIds'>
  /** null：全部项目 */
  projectId: string | null
  query: string
}): { list: SessionCandidate[]; more: boolean } {
  const names = new Map(input.projects.map(p => [p.id, p.name]))
  const agents = input.members.filter((m): m is AgentMember => m.kind === 'agent' && m.mine !== false)
  const q = input.query.trim().toLowerCase()
  const all = input.sessions
    .filter(({ record: r }) => {
      // 和后端 joinSession 的条件一致：没归档、频道能用的引擎、项目还在；「聊天」里不属于项目的不列
      if (r.archivedAt || r.engine === 'dot' || isChatProject(r.projectId) || !names.has(r.projectId)) return false
      if (input.projectId && r.projectId !== input.projectId) return false
      return !q || r.title.toLowerCase().includes(q) || names.get(r.projectId)!.toLowerCase().includes(q)
    })
    .sort((a, b) => b.record.updatedAt - a.record.updatedAt)
  return {
    list: all.slice(0, SESSION_PICK_LIMIT).map(({ record: r, state }) => ({
      id: r.id,
      title: r.title,
      engine: r.engine,
      projectId: r.projectId,
      project: names.get(r.projectId)!,
      updatedAt: r.updatedAt,
      running: state !== 'idle',
      tag: tagOf(r.id, agents, input.channel.memberIds),
    })),
    more: all.length > SESSION_PICK_LIMIT,
  }
}

/** 打开对话框时先显示哪一块：有能加的会话先「已有会话」，再「已有成员」，最后「新建成员」 */
export function firstTab(hasSessions: boolean, hasOthers: boolean): 'session' | 'member' | 'new' {
  return hasSessions ? 'session' : hasOthers ? 'member' : 'new'
}

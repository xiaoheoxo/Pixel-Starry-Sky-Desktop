import { bottomOrder, isChatProject, pinnedOrder, type ProjectRecord, type SessionSummary } from '@pixelsky/protocol'
import type { Project, RecentItem, Session, SessionStatus } from '@/data/types'
import type { DemoSessionChange } from '@/data/types'
import { tr } from '@/i18n/core'
import { tuiBusy } from '@/features/terminal/tuiActivity'
/** 会话所属项目的显示名：内置「对话」写「对话」；项目已移除时 undefined */
export const orChat = (name: string | undefined, projectId: string | null | undefined): string | undefined =>
  name ?? (isChatProject(projectId) ? tr('sidebar.Sidebar.chat') : undefined)
/**
 * 运行中，或这一轮说完了但后台子智能体还在跑（docs/ui/notifications.md §7），
 * 或在终端模式里干活（宿主看不到终端里的引擎，按输出节奏判断，docs/ui/tui-toggle.md §5.5）。
 * 终端那部分读的是全局状态：hook 里用的要另外订阅 useTuiBusy
 */
export const busy = (s: SessionSummary): boolean =>
  s.state !== 'idle' || !!s.background || (!!s.record.tui && tuiBusy().has(s.record.id))
/** 侧栏「置顶」分组里的会话：带上所属项目名 */
export type PinnedSession = Session & { project?: string; projectId?: string }
/** 冻结快照：会话 ID → 冻结那一刻的 updatedAt（侧栏按「最近」排的那把钥匙） */
export type RecencyFreeze = ReadonlyMap<string, number>

/** 抓一份冻结快照：鼠标进侧栏时调用 */
export function captureRecency(sessions: readonly SessionSummary[]): RecencyFreeze {
  return new Map(sessions.map(s => [s.record.id, s.record.updatedAt]))
}

/**
 * 冻结「按最近活动自动排序」：快照里的会话按冻结时的 updatedAt 排（相同保持原顺序），
 * 快照里没有的（冻结期间新建的）用它真实的 updatedAt，所以排在最前面。
 * 只冻结这一把钥匙：置顶 / 置底 / 归档 / 换项目 / 改名都不看它，照旧即时生效（下游的 bottomOrder / pinnedOrder 是稳定排序）。
 * 没有快照（没冻结）时原样返回
 */
export function freezeRecency(sessions: SessionSummary[], frozen: RecencyFreeze | null | undefined): SessionSummary[] {
  if (!frozen?.size) return sessions
  const key = (s: SessionSummary): number => frozen.get(s.record.id) ?? s.record.updatedAt
  return sessions
    .map((s, i) => ({ s, i, k: key(s) }))
    .sort((a, b) => b.k - a.k || a.i - b.i)
    .map(x => x.s)
}

export function sidebarData(
  projects: ProjectRecord[],
  allSessions: SessionSummary[],
  unread: Record<string, boolean>,
  time: (stamp: number) => string,
  /** 鼠标在侧栏里时的冻结快照；null / 不传是不冻结 */
  frozen?: RecencyFreeze | null,
): {
  projects: Project[]
  /** 不用项目的对话（没归档、没置顶的），按最近活动排 */
  chats: Session[]
  /** 归档了的不用项目的对话（「对话」分组底下的「已归档 N 个」） */
  chatsArchived: Session[]
  pinned: PinnedSession[]
  recent: Array<RecentItem & { status: SessionStatus }>
} {
  const sessions = freezeRecency(allSessions, frozen)
  const status = (s: SessionSummary): SessionStatus => (busy(s) ? 'running' : unread[s.record.id] ? 'unread' : 'idle')
  const row = (s: SessionSummary) => ({
    id: s.record.id,
    title: s.record.title,
    status: status(s),
    time: time(s.record.updatedAt),
    archivedAt: s.record.archivedAt ?? null,
    bottomedAt: s.record.bottomedAt ?? null,
    pinnedAt: s.record.pinnedAt ?? null,
    ...(s.record.branch ? { branch: { depth: 0, tag: branchTag(s.record.branch) } } : {}),
  })
  const parents = new Map(
    sessions.flatMap(s =>
      s.record.branch && s.record.forkedFrom ? [[s.record.id, s.record.forkedFrom.sessionId]] : [],
    ),
  )
  const active = sessions.filter(s => !s.record.archivedAt),
    names: Record<string, string> = Object.fromEntries(projects.map(p => [p.id, p.name]))
  const nameOf = (projectId: string): string | undefined => orChat(names[projectId], projectId)
  const chats = active
    .filter(s => isChatProject(s.record.projectId) && !s.record.pinnedAt)
    .map(row)
    .sort(bottomOrder)
  const chatsArchived = sessions
    .filter(s => isChatProject(s.record.projectId) && s.record.archivedAt)
    .map(row)
    .sort(bottomOrder)
  const result = projects.map(p => {
    const list = sessions.filter(s => s.record.projectId === p.id)
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      ...(p.folders?.length ? { folders: p.folders } : {}),
      expanded: true,
      running: list.some(s => !s.record.archivedAt && busy(s)),
      // 置顶的会话只显示在「置顶」分组
      sessions: nestBranches(
        list
          .filter(s => !s.record.archivedAt && !s.record.pinnedAt)
          .map(row)
          .sort(bottomOrder),
        id => parents.get(id) ?? null,
      ),
      archived: list
        .filter(s => s.record.archivedAt)
        .map(row)
        .sort(bottomOrder),
    }
  })
  const recent = active
    .slice(0, 8)
    .map(s => ({
      ...row(s),
      project: nameOf(s.record.projectId),
      projectId: s.record.projectId,
      time: time(s.record.updatedAt),
    }))
    .sort(bottomOrder)
  const pinned = active
    .filter(s => s.record.pinnedAt)
    .map(s => ({ ...row(s), project: nameOf(s.record.projectId), projectId: s.record.projectId }))
    .sort(pinnedOrder)
  return {
    projects: result,
    chats,
    chatsArchived,
    pinned,
    recent,
  }
}
/** 侧栏标签：分支（副本里）/ 同目录 / 已合并 */
function branchTag(b: NonNullable<SessionSummary['record']['branch']>): 'copy' | 'shared' | 'merged' {
  return b.copyRemoved || b.mergedAt ? 'merged' : b.copyId ? 'copy' : 'shared'
}

/**
 * 开分支开出的会话挂在上级下面（docs/ui/branch-merge.md §4）：上级在同一个列表里时紧跟在它后面、按层缩进，
 * 子会话之间保持原来的先后；上级不在列表里（归档、置顶）的照常单独显示
 */
export function nestBranches<T extends { id: string; branch?: { depth: number; tag: 'copy' | 'shared' | 'merged' } }>(
  rows: T[],
  parentOf: (id: string) => string | null,
): T[] {
  const ids = new Set(rows.map(r => r.id))
  const children = new Map<string, T[]>()
  const top: T[] = []
  for (const r of rows) {
    const p = parentOf(r.id)
    if (p && p !== r.id && ids.has(p)) children.set(p, [...(children.get(p) ?? []), r])
    else top.push(r)
  }
  const out: T[] = []
  const seen = new Set<string>()
  const walk = (r: T, depth: number): void => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push(r.branch ? { ...r, branch: { ...r.branch, depth } } : r)
    for (const c of children.get(r.id) ?? []) walk(c, depth + 1)
  }
  for (const r of top) walk(r, 0)
  // 环（不该有）：剩下的按原样放在最后
  for (const r of rows) if (!seen.has(r.id)) out.push(r)
  return out
}

/** 最近任务来自两个以上项目才显示：只有一个项目时它和项目列表完全重复（docs/ui/conversation-ux-2.md §2.3） */
export function recentSpansProjects(recent: Array<Pick<RecentItem, 'projectId' | 'project'>>): boolean {
  return new Set(recent.map(r => r.projectId ?? r.project ?? '')).size > 1
}

/** 停止只压掉「运行中」；传了 store 的未读就以它为准（归档后恢复的会话也能标未读） */
function demoStatus(status: SessionStatus, unread: boolean | undefined, tracked: boolean): SessionStatus {
  if (!tracked || status === 'running') return status
  return unread ? 'unread' : 'idle'
}

export function demoSidebarData(
  projects: Project[],
  recent: RecentItem[],
  changes: Record<string, DemoSessionChange>,
  /** 传了就以它为准判断未读（演示模式也走引擎 store 的未读） */
  unread?: Record<string, true>,
) {
  const deleted = (id: string) => changes[id]?.deleted
  const map = (s: Project['sessions'][number]) => ({
    ...s,
    title: changes[s.id]?.title ?? s.title,
    bottomedAt: changes[s.id]?.bottomedAt === undefined ? (s.bottomedAt ?? null) : changes[s.id].bottomedAt,
    pinnedAt: changes[s.id]?.pinnedAt === undefined ? (s.pinnedAt ?? null) : changes[s.id].pinnedAt,
    archivedAt: changes[s.id] ? changes[s.id].archivedAt : (s.archivedAt ?? null),
    status: demoStatus(changes[s.id]?.stopped ? 'idle' : s.status, unread?.[s.id], !!unread),
  })
  const result = projects.map(p => {
    const all = [...p.sessions, ...(p.archived ?? [])].filter(s => !deleted(s.id)).map(map)
    return {
      ...p,
      sessions: all.filter(s => !s.archivedAt && !s.pinnedAt).sort(bottomOrder),
      archived: all.filter(s => s.archivedAt).sort(bottomOrder),
      running: all.some(s => !s.archivedAt && s.status === 'running'),
    }
  })
  const pinned = projects
    .flatMap(p =>
      [...p.sessions, ...(p.archived ?? [])]
        .filter(s => !deleted(s.id))
        .map(map)
        .filter(s => !s.archivedAt && s.pinnedAt)
        .map(s => ({ ...s, project: p.name, projectId: p.id })),
    )
    .sort(pinnedOrder)
  const active = new Map([...result.flatMap(p => p.sessions), ...pinned].map(s => [s.id, s] as const)),
    allIds = new Set(projects.flatMap(p => [...p.sessions, ...(p.archived ?? [])].map(s => s.id)))
  const restored = projects.flatMap(p =>
    (p.archived ?? [])
      .filter(s => active.has(s.id))
      .map(s => ({ id: s.id, title: s.title, project: p.name, time: s.time ?? '' })),
  )
  return {
    projects: result,
    chats: [] as Session[],
    chatsArchived: [] as Session[],
    pinned,
    recent: [...restored, ...recent]
      .filter(s => !deleted(s.id) && (!allIds.has(s.id) || active.has(s.id)))
      .map(s => ({
        ...s,
        title: changes[s.id]?.title ?? s.title,
        bottomedAt: active.get(s.id)?.bottomedAt ?? changes[s.id]?.bottomedAt ?? null,
        pinnedAt: active.get(s.id)?.pinnedAt ?? changes[s.id]?.pinnedAt ?? null,
        status: active.get(s.id)?.status,
      }))
      .slice(0, 8)
      .sort(bottomOrder),
  }
}

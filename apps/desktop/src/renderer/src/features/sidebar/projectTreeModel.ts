// 侧栏项目 → 对话两层（docs/ui/sidebar-hierarchy.md）：标题上的状态数、先列哪几个对话、多文件夹项目的文件夹。纯函数，不依赖 window。
import { folderLabel } from '@/features/files/extraFolderPaths'
import type { Project, Session } from '@/data'
import type { SessionLane } from '@/features/board/sessionLanes'

/** 「等你」一类：等你批准 / 回答、出错、已暂停（新回复单独用蓝点） */
export type NeedsYouLane = 'waiting' | 'failed' | 'paused'
export const needsYou = (lane: SessionLane | undefined): lane is NeedsYouLane =>
  lane === 'waiting' || lane === 'failed' || lane === 'paused'

/** 项目标题上的汇总：在跑几个、等你几个 */
export function projectCounts(
  sessions: readonly Pick<Session, 'id' | 'status'>[],
  lanes: ReadonlyMap<string, SessionLane>,
): { running: number; waiting: number } {
  let running = 0,
    waiting = 0
  for (const s of sessions) {
    const lane = lanes.get(s.id)
    if (needsYou(lane)) waiting++
    else if (lane === 'running' || s.status === 'running') running++
  }
  return { running, waiting }
}

/** 每个项目先列这么多个对话 */
export const SHOWN_SESSIONS = 5

/** First reveal adds five, then ten, fifteen, and so on. */
export const extraConversations = (pages: number): number => (SHOWN_SESSIONS * pages * (pages + 1)) / 2

/** List only the newest conversations up to the disclosure cap; filtering and show-all bypass it. */
export function visibleSessions<T extends Pick<Session, 'id'>>(
  sessions: readonly T[],
  options: { all: boolean; additional?: number },
): { shown: T[]; hidden: number } {
  const shown = options.all ? [...sessions] : sessions.slice(0, SHOWN_SESSIONS + (options.additional ?? 0))
  return { shown, hidden: sessions.length - shown.length }
}

/** 展开「已归档」后每次多列这么多个：用久了一个项目能归档上千个，一次全画会让侧栏卡住 */
export const ARCHIVED_PAGE = 50

/** 已归档的先列前 limit 个；当前打开的那个在后面也列出来 */
export function visibleArchived<T extends Pick<Session, 'id'>>(
  archived: readonly T[],
  limit: number,
  selected: string | null,
): { shown: T[]; hidden: number } {
  if (archived.length <= limit) return { shown: [...archived], hidden: 0 }
  const shown = archived.filter((s, i) => i < limit || s.id === selected)
  return { shown, hidden: archived.length - shown.length }
}

/** 多文件夹项目的每个文件夹：主文件夹在前（index 0），附加文件夹 index 从 1 起，和文件接口的「::N」对应；单文件夹项目返回空 */
export function projectFolders(
  project: Pick<Project, 'path' | 'folders'>,
): { index: number; name: string; path: string }[] {
  if (!project.folders?.length) return []
  const main = project.path ? [{ index: 0, name: folderLabel({ path: project.path }), path: project.path }] : []
  return [...main, ...project.folders.map((f, i) => ({ index: i + 1, name: folderLabel(f), path: f.path }))]
}

/** 项目下面的一行：一个会话，或同一频道收成的一行（docs/ui/sidebar-channel-fold.md） */
export type FoldEntry<T> =
  | { kind: 'session'; session: T }
  | { kind: 'channel'; key: string; name: string; sessions: T[]; running: number; waiting: number }

/**
 * 同一个频道有 2 个及以上会话时收成一行，放在它最近那个会话的位置；
 * 频道行不占名额；projectSessionRows 单独分页具体对话。
 * hidden / own 是项目自己的对话收起了几个、一共几个；channelOf 返回 null 的会话照常列
 */
export function foldChannels<T extends Pick<Session, 'id' | 'status'>>(
  sessions: readonly T[],
  options: {
    channelOf: (id: string) => string | null
    all: boolean
    lanes: ReadonlyMap<string, SessionLane>
  },
): { entries: FoldEntry<T>[]; hidden: number; own: number } {
  const byChannel = new Map<string, T[]>()
  for (const s of sessions) {
    const name = options.channelOf(s.id)
    if (name) byChannel.set(name, [...(byChannel.get(name) ?? []), s])
  }
  const folded = new Map([...byChannel].filter(([, list]) => list.length > 1))
  const own = sessions.filter(s => {
    const name = options.channelOf(s.id)
    return !name || !folded.has(name)
  })
  const { shown, hidden } = visibleSessions(own, options)
  const shownIds = new Set(shown.map(s => s.id))
  const entries: FoldEntry<T>[] = []
  const placed = new Set<string>()
  for (const s of sessions) {
    const name = options.channelOf(s.id)
    const list = name ? folded.get(name) : undefined
    if (name && list) {
      if (placed.has(name)) continue
      placed.add(name)
      entries.push({ kind: 'channel', key: name, name, sessions: list, ...projectCounts(list, options.lanes) })
    } else if (shownIds.has(s.id)) entries.push({ kind: 'session', session: s })
  }
  return { entries, hidden, own: own.length }
}

type ProjectSessionRow<T> =
  | Extract<FoldEntry<T>, { kind: 'session' }>
  | (Extract<FoldEntry<T>, { kind: 'channel' }> & { open: boolean; visibleMembers: T[] })

/** Page all conversations in recency order. Channel headers don't consume slots. */
export function projectSessionRows<T extends Pick<Session, 'id' | 'status'>>(
  sessions: readonly T[],
  options: {
    channelOf: (id: string) => string | null
    channelOpen: (key: string) => boolean | undefined
    all: boolean
    additional?: number
    filtering: boolean
    lanes: ReadonlyMap<string, SessionLane>
  },
): { rows: ProjectSessionRow<T>[]; hidden: number; hiddenInPreview: number; hasNextPage: boolean } {
  const flatRows = (): ProjectSessionRow<T>[] => sessions.map(session => ({ kind: 'session', session }))
  if (options.filtering) return { rows: flatRows(), hidden: 0, hiddenInPreview: 0, hasNextPage: false }

  const { entries } = foldChannels(sessions, {
    channelOf: options.channelOf,
    all: true,
    lanes: options.lanes,
  })
  const channelStates = new Map<string, boolean>()
  const collapsedMembers = new Set<string>()
  const expandedMembers = new Set<string>()
  for (const row of entries) {
    if (row.kind !== 'channel') continue
    const open = options.channelOpen(row.key)
    if (open === undefined) continue
    channelStates.set(row.key, open)
    const ids = open ? expandedMembers : collapsedMembers
    for (const session of row.sessions) ids.add(session.id)
  }

  // A hidden member of a manually collapsed channel must not consume a visible page slot.
  const pageable = collapsedMembers.size ? sessions.filter(s => !collapsedMembers.has(s.id)) : sessions
  const ids = new Set(pageable.slice(0, SHOWN_SESSIONS).map(s => s.id))
  for (const id of expandedMembers) ids.add(id)
  const hiddenInPreview = sessions.length - ids.size
  if (options.all) return { rows: flatRows(), hidden: 0, hiddenInPreview, hasNextPage: false }

  // An explicitly opened channel may already cover some older sessions. Skip those when paging.
  let additional = options.additional ?? 0
  for (const session of pageable) {
    if (additional === 0) break
    if (!ids.has(session.id)) {
      ids.add(session.id)
      additional--
    }
  }
  const rows = entries.flatMap<ProjectSessionRow<T>>(row => {
    if (row.kind === 'session') return ids.has(row.session.id) ? [row] : []
    const visibleMembers = row.sessions.filter(member => ids.has(member.id))
    return [{ ...row, open: channelStates.get(row.key) ?? visibleMembers.length > 0, visibleMembers }]
  })
  return { rows, hidden: sessions.length - ids.size, hiddenInPreview, hasNextPage: ids.size < pageable.length }
}

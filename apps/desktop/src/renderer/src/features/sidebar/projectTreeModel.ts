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

/**
 * 先列前 5 个；后面的里头当前打开的、在跑的、等你的、有新回复的也列出来，不会被藏进「还有 N 个」。
 * all 为 true（点了「还有 N 个」或按状态筛选时）全部列出
 */
export function visibleSessions<T extends Pick<Session, 'id' | 'status'>>(
  sessions: readonly T[],
  options: { all: boolean; selected: string | null; lanes: ReadonlyMap<string, SessionLane> },
): { shown: T[]; hidden: number } {
  if (options.all || sessions.length <= SHOWN_SESSIONS) return { shown: [...sessions], hidden: 0 }
  const shown = sessions.filter(
    (s, i) => i < SHOWN_SESSIONS || s.id === options.selected || s.status !== 'idle' || options.lanes.has(s.id),
  )
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
 * 「先列 5 个」只算项目自己的对话（visibleSessions），频道行不占名额。
 * hidden / own 是项目自己的对话收起了几个、一共几个；channelOf 返回 null 的会话照常列
 */
export function foldChannels<T extends Pick<Session, 'id' | 'status'>>(
  sessions: readonly T[],
  options: {
    channelOf: (id: string) => string | null
    all: boolean
    selected: string | null
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

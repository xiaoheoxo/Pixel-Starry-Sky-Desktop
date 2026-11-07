// 任务看板分列、排序、筛选（docs/ui/task-board.md §3、§5、§6）。纯函数，不依赖 window。
import type { ManualTask } from '../../../../shared/types/project-tools'
import { isWaiting, type SessionCard } from './sessionLanes'

// review = 待验收（docs/ui/channels-collab-v2.md §9）：交给 AI 成员的事项做完了等你验收；没有时这一列不显示
export type ColumnId = 'todo' | 'doing' | 'review' | 'waiting' | 'done'
// 「等你」放最前：最需要人处理，窗口窄时也不能被挤到屏幕外（docs/ui/desktop-parity.md）
export const COLUMNS: ColumnId[] = ['waiting', 'todo', 'doing', 'review', 'done']
/** 手动任务能拖进去的列（「等你」里只有会话） */
export const STATUS_OF: Partial<Record<ColumnId, ManualTask['status']>> = {
  todo: 'pending',
  doing: 'in_progress',
  review: 'review',
  done: 'completed',
}
export const RECENT_DONE_MS = 7 * 86_400_000

export type BoardKind = 'all' | 'mine' | 'ai' | 'schedule'
export interface BoardFilter {
  /** 空表示全部项目 */
  projects: string[]
  kind: BoardKind
  query: string
}

export interface Column {
  id: ColumnId
  tasks: ManualTask[]
  sessions: SessionCard[]
  /** 已完成列：超过 7 天、这次没显示的条数 */
  older: number
}

const PRIORITY = { high: 0, normal: 1, low: 2 } as const

/** 优先级高 → 有截止日期的按日期早 → 项目里原来的顺序 */
export function taskOrder(a: ManualTask, b: ManualTask): number {
  return (
    PRIORITY[a.priority] - PRIORITY[b.priority] ||
    (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99') ||
    a.order - b.order
  )
}

/** 完成时间；旧数据没有时用最后修改时间 */
export const doneAt = (task: ManualTask): number => task.completedAt ?? task.updatedAt

/** 截止日期过了（按本地日期，今天截止的不算过期） */
export function overdue(task: ManualTask, now: number): boolean {
  if (!task.due || task.status === 'completed') return false
  const today = new Date(now)
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return task.due < local
}

function matches(text: string, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const hay = text.toLocaleLowerCase()
  return terms.every(term => hay.includes(term))
}

export function buildColumns(input: {
  tasks: readonly ManualTask[]
  sessions: readonly SessionCard[]
  filter: BoardFilter
  /** 只显示这些项目（当前机器上的）；任务属于别的项目时不显示 */
  knownProjects: ReadonlySet<string>
  showOlder: boolean
  now: number
}): Column[] {
  const { filter } = input
  const inProjects = (projectId: string | null) =>
    !filter.projects.length || (!!projectId && filter.projects.includes(projectId))
  // 定时任务（docs/ui/board-schedule.md）只在「定时」列里，不进下面几列
  const tasks =
    filter.kind === 'ai' || filter.kind === 'schedule'
      ? []
      : input.tasks.filter(
          t =>
            !t.schedule &&
            input.knownProjects.has(t.projectId) &&
            inProjects(t.projectId) &&
            matches([t.title, t.note, ...t.tags].join('\n'), filter.query),
        )
  const sessions =
    filter.kind === 'mine'
      ? []
      : input.sessions.filter(
          s => (filter.kind !== 'schedule' || s.scheduled) && inProjects(s.projectId) && matches(s.title, filter.query),
        )
  const done = tasks.filter(t => t.status === 'completed').sort((a, b) => doneAt(b) - doneAt(a))
  const recent = done.filter(t => input.now - doneAt(t) <= RECENT_DONE_MS)
  const columns: Record<ColumnId, Column> = {
    waiting: { id: 'waiting', tasks: [], sessions: sessions.filter(s => isWaiting(s.lane)), older: 0 },
    todo: { id: 'todo', tasks: tasks.filter(t => t.status === 'pending').sort(taskOrder), sessions: [], older: 0 },
    doing: {
      id: 'doing',
      tasks: tasks.filter(t => t.status === 'in_progress').sort(taskOrder),
      sessions: sessions.filter(s => !isWaiting(s.lane)),
      older: 0,
    },
    review: { id: 'review', tasks: tasks.filter(t => t.status === 'review').sort(taskOrder), sessions: [], older: 0 },
    done: {
      id: 'done',
      tasks: input.showOlder ? done : recent,
      sessions: [],
      older: input.showOlder ? 0 : done.length - recent.length,
    },
  }
  return COLUMNS.map(id => columns[id])
}

/**
 * 「定时」列的任务（最左边，docs/ui/board-schedule.md §4）：有定时任务（或频道里有每天定时的流程）才显示，
 * 筛选「定时」时一直显示（没有时是模板空状态）；「我的待办」「AI」下不显示
 */
export function scheduleTasks(input: {
  tasks: readonly ManualTask[]
  filter: BoardFilter
  knownProjects: ReadonlySet<string>
}): ManualTask[] {
  const { filter } = input
  if (filter.kind === 'mine' || filter.kind === 'ai') return []
  return input.tasks
    .filter(
      t =>
        !!t.schedule &&
        input.knownProjects.has(t.projectId) &&
        (!filter.projects.length || filter.projects.includes(t.projectId)) &&
        matches([t.title, t.note, ...t.tags].join('\n'), filter.query),
    )
    .sort((a, b) => a.order - b.order)
}

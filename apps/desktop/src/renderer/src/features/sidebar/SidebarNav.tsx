import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { CountBadge, useComingSoon } from '@/ui'
import { useSidebarPrefs } from '@/features/appearance/sidebar'
import { getSidebarIcon } from '@/features/appearance/sidebarIcons'
import { NEW_TASK, OPEN_SEARCH, withShortcut } from '@/features/layout/shortcuts'
import { setPage, usePage } from '@/features/layout/page'
import { useBoardTasks } from '@/features/board/boardTasks'
import { useChannelUnreadTotal } from '@/features/channels/store'
import { useNeeds } from '@/features/channels/needs'
import { useEngineState, isLive } from '@/features/engine'
import { machineOf, useMachines } from '@/features/machines/store'
import { useOpenSearch } from '@/features/search/SearchProvider'
import { projects as demoProjects } from '@/data'
import { SidebarRow } from './SidebarSection'

/** 行右边的灰字（快捷键、待办数） */
const HINT = 'shrink-0 text-meta text-fg-faint'

/** 「任务看板」入口（docs/ui/task-board.md §2）：只管我的任务，显示没完成的手动任务数 */
function BoardEntry() {
  const page = usePage()
  const { tasks } = useBoardTasks()
  const machine = useMachines().currentId
  const projects = useEngineState(s => s.projects)
  const known = new Set(
    isLive ? projects.filter(p => machineOf(p.id) === machine).map(p => p.id) : demoProjects.map(p => p.id),
  )
  const todo = tasks.filter(t => t.status !== 'completed' && !t.schedule && known.has(t.projectId)).length
  const { icons } = useSidebarPrefs()
  const Icon = getSidebarIcon('board', icons)
  return (
    <SidebarRow
      selected={page === 'board'}
      onClick={() => setPage('board')}
      title={tr('board.open')}
      aria-current={page === 'board' ? 'page' : undefined}
    >
      <Icon size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate">{tr('board.title')}</span>
      {todo > 0 && <span className={HINT}>{tr('board.todoCount', { n: todo })}</span>}
    </SidebarRow>
  )
}

/** 「频道」入口：有未读时右边一个主色小圆点（数字放在提示里） */
function ChannelsEntry() {
  const page = usePage()
  const unread = useChannelUnreadTotal()
  const unreadText = tr('sidebar.channelsUnread', { n: unread })
  // 「需要你」的件数写在右边（docs/ui/channels-collab-v2.md §2）；没有时有未读才显示小圆点
  const needs = useNeeds().needs.length
  const { icons } = useSidebarPrefs()
  const Icon = getSidebarIcon('channels', icons)
  return (
    <SidebarRow
      selected={page === 'channels'}
      onClick={() => setPage('channels')}
      title={unread > 0 ? `${tr('channels.section')} · ${unreadText}` : tr('channels.section')}
      aria-current={page === 'channels' ? 'page' : undefined}
    >
      <Icon size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate">{tr('channels.section')}</span>
      {needs > 0 ? (
        <span data-needs-count="" title={tr('needs.title')}>
          <CountBadge count={needs} max={99} />
        </span>
      ) : (
        unread > 0 && <span role="img" aria-label={unreadText} className="size-1.5 shrink-0 rounded-full bg-accent" />
      )}
    </SidebarRow>
  )
}

/**
 * 侧栏顶部四行（docs/ui/layout-v2.md §3）：新建任务、搜索、任务看板、频道，正常和极简模式共用。
 * 外层 data-sidebar-nav：极简样式和截图脚本用 `[data-sidebar-nav] > button` 定位。
 */
export function SidebarNav({ onNewTask }: { onNewTask?: () => void }) {
  useI18n()
  const comingSoon = useComingSoon()
  const openSearch = useOpenSearch()
  const { icons } = useSidebarPrefs()
  const NewTaskIcon = getSidebarIcon('newTask', icons)
  const SearchIcon = getSidebarIcon('search', icons)
  return (
    <nav className="no-drag flex shrink-0 flex-col gap-px px-3 pt-1" data-sidebar-nav>
      {/* 演示模式没有 onNewTask：沿用「即将推出」 */}
      <SidebarRow onClick={onNewTask ?? (() => comingSoon(tr('sidebar.NewTaskButton.newTask')))}>
        <NewTaskIcon size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{tr('sidebar.action.newTask')}</span>
        <span data-nav-shortcut className={HINT}>
          {NEW_TASK.label}
        </span>
      </SidebarRow>
      <SidebarRow onClick={openSearch} aria-haspopup="dialog" title={withShortcut(tr('sidebar.search'), OPEN_SEARCH)}>
        <SearchIcon size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{tr('sidebar.search')}</span>
        <span data-nav-shortcut className={HINT}>
          {OPEN_SEARCH.label}
        </span>
      </SidebarRow>
      <BoardEntry />
      <ChannelsEntry />
    </nav>
  )
}

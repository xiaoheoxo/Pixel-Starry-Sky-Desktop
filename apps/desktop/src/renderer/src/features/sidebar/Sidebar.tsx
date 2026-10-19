import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from '@/features/appearance/ThemeProvider'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, FolderInput, FolderPlus, Import, X } from 'lucide-react'
import { IconButton, cn, useComingSoon, useToast } from '@/ui'
import { ActionMenu } from '@/ui/ActionMenu'
import {
  recentOpen,
  setProjectsCollapsed,
  setSidebarPrefs,
  useShortWindow,
  useSidebarPrefs,
} from '@/features/appearance/sidebar'
import { getSidebarIcon } from '@/features/appearance/sidebarIcons'
import { addProject, isLive, recentSpansProjects, useSidebarData, useSidebarFreezeOn } from '@/features/engine'
import { addProjectPaths, importProjects } from '@/features/engine/store'
import { useSettings } from '@/features/settings/SettingsProvider'
import { SidebarHeader } from './SidebarHeader'
import { SidebarNav } from './SidebarNav'
import { SidebarEmpty, SidebarRow, SidebarSection } from './SidebarSection'
import { PinnedList } from './PinnedList'
import { PinnedTasks } from './PinnedTasks'
import { TASK_DRAG_TYPE, draggedTask, pinTask } from '@/features/panel/pinnedTasks'
import { ProjectTree } from './ProjectTree'
import { arrangeProjects, groupKey } from './projectGroups'
import { RecentItem } from './RecentItem'
import { RunStatusPill } from './RunStatusPill'
import { cardsOf, filterProjects, filterSessions, lanesOf, useScrollFade, type RunFilter } from './runFilter'
import { useSessionCards } from '@/features/board/useSessionCards'
import { SidebarFooter } from './SidebarFooter'
import { WslHint } from './WslHint'
import { useFlip } from './useFlip'

export interface SidebarProps {
  selectedSessionId: string | null
  /** null 表示新会话（欢迎页） */
  onSelectSession: (id: string | null) => void
  onCollapse: () => void
}

/**
 * 侧边栏（docs/ui/design-refresh.md §5.1）：
 * 顶部与底部（运行状态、最近任务、设置、账户）固定，中间的项目与置顶分组独立滚动。
 * 宽度由外层 CollapsibleSlot 决定，这里始终撑满。
 */
export function Sidebar({ selectedSessionId, onSelectSession, onCollapse }: SidebarProps) {
  useI18n()
  const comingSoon = useComingSoon()
  const settings = useSettings()
  const prefs = useSidebarPrefs()
  const recentShown = recentOpen(prefs, useShortWindow())
  const recentId = useId()
  // 演示模式是 mock 数据，否则是引擎里的真实项目和会话
  const { projects, pinned: pinnedSessions, recent } = useSidebarData()
  const toast = useToast()
  const onAddProject = isLive ? () => void addProject() : () => comingSoon(tr('sidebar.Sidebar.addProject'))
  // 「项目」标题右边的「＋」：添加项目文件夹（可多选）/ 从一个文件夹导入（docs/ui/multi-root-projects.md §2）
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const openAddMenu = (e: React.MouseEvent<HTMLElement>): void => {
    if (!isLive) return onAddProject()
    const rect = e.currentTarget.getBoundingClientRect()
    setAddMenu({ x: rect.left, y: rect.bottom + 4 })
  }
  const onNewTask = isLive ? () => onSelectSession(null) : undefined
  const AddProjectIcon = getSidebarIcon('addProject', prefs.icons)
  // 把任务清单里的任务拖到侧栏任意位置松开：固定到「固定任务」（docs/ui/files-search-terminal-pins.md §5）
  const [dropping, setDropping] = useState(false)
  const taskDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(TASK_DRAG_TYPE)
  // 从资源管理器拖文件夹进来：加成项目（一次可以拖几个）
  const fileDrag = (e: React.DragEvent): boolean => isLive && e.dataTransfer.types.includes('Files')
  const dropFolders = (transfer: DataTransfer): void => {
    const folders = [...transfer.items]
      .filter(item => item.kind === 'file' && item.webkitGetAsEntry()?.isDirectory)
      .map(item => {
        const file = item.getAsFile()
        return file ? (window.pixelsky?.pathForFile(file) ?? '') : ''
      })
      .filter(Boolean)
    if (!folders.length) return toast(tr('projectImport.notFolders'))
    addProjectPaths(folders).catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
  }
  // 底部胶囊点了数字：置顶和项目只看运行中 / 等你的会话（不保存，重启后看全部）
  const cards = useSessionCards()
  const [runFilter, setRunFilter] = useState<RunFilter | null>(null)
  const lanes = useMemo(() => (runFilter ? lanesOf(cards) : undefined), [cards, runFilter])
  const cardById = useMemo(() => cardsOf(cards), [cards])
  const shownProjects = runFilter && lanes ? filterProjects(projects, lanes, runFilter) : projects
  const shownPinned = runFilter && lanes ? filterSessions(pinnedSessions, lanes, runFilter) : pinnedSessions
  useEffect(() => {
    if (runFilter && !cards.length) setRunFilter(null)
  }, [runFilter, cards.length])
  // 「项目」标题右边的全部收起 / 全部展开（分区也算）：有展开着的就全部收起
  const foldKeys = [
    ...projects.map(p => p.id),
    ...arrangeProjects(projects, prefs.groups ?? []).flatMap(e => (e.kind === 'group' ? [groupKey(e.group.id)] : [])),
  ]
  const anyOpen = foldKeys.some(key => !prefs.collapsed?.includes(key))
  const scroller = useRef<HTMLDivElement>(null)
  useScrollFade(scroller)
  // 鼠标在侧栏里时冻结按最近活动的自动换位置；离开后换到新顺序，行用 FLIP 滑过去，动画关了就直接换
  const root = useRef<HTMLElement>(null)
  useSidebarFreezeOn(root)
  const order = useMemo(
    () =>
      [...projects.flatMap(p => p.sessions.map(s => `${p.id}/${s.id}`)), ...recent.map(r => `recent/${r.id}`)].join(
        '|',
      ),
    [projects, recent],
  )
  useFlip(root, order, !useReducedMotion())
  return (
    <aside
      ref={root}
      className={cn('flex h-full w-full min-w-0 flex-col bg-sidebar', dropping && 'sidebar-task-drop')}
      onDragOver={e => {
        if (!taskDrag(e) && !fileDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropping) setDropping(true)
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={e => {
        if (fileDrag(e)) {
          e.preventDefault()
          setDropping(false)
          return dropFolders(e.dataTransfer)
        }
        if (!taskDrag(e)) return
        e.preventDefault()
        setDropping(false)
        const task = draggedTask()
        if (task) void pinTask(task, true).catch(() => undefined)
      }}
    >
      <SidebarHeader onCollapse={onCollapse} />

      <SidebarNav onNewTask={onNewTask} />

      <div
        ref={scroller}
        data-sidebar-scroll
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-3 pt-4 pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {runFilter && (
          <div className="-mb-2 flex h-7 shrink-0 items-center gap-1 rounded-md bg-selected pr-1 pl-2.5 text-meta text-fg">
            <span className="min-w-0 flex-1 truncate">
              {tr(runFilter === 'running' ? 'sidebar.runStatus.showingRunning' : 'sidebar.runStatus.showingWaiting')}
            </span>
            <button
              type="button"
              aria-label={tr('sidebar.runStatus.clearFilter')}
              title={tr('sidebar.runStatus.clearFilter')}
              onClick={() => setRunFilter(null)}
              className="inline-flex size-5 items-center justify-center rounded hover:bg-hover"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}
        {/* 置顶的会话；筛选时只列符合的，没有置顶会话就不显示这一组（看板入口在顶部四行） */}
        {shownPinned.length > 0 && (
          <SidebarSection title={tr('sidebar.Sidebar.pinned')}>
            <PinnedList
              sessions={shownPinned}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              lanes={lanes}
              cards={cardById}
            />
          </SidebarSection>
        )}

        {!runFilter && <PinnedTasks dropping={dropping} />}

        <SidebarSection
          title={tr('sidebar.Sidebar.projects')}
          count={projects.length || undefined}
          action={
            <span className="flex items-center gap-0.5">
              {!runFilter && projects.length > 1 && (
                <IconButton
                  icon={anyOpen ? ChevronsDownUp : ChevronsUpDown}
                  label={tr(anyOpen ? 'sidebar.tree.collapseAll' : 'sidebar.tree.expandAll')}
                  size={22}
                  iconSize={14}
                  onClick={() => setProjectsCollapsed(foldKeys, anyOpen)}
                />
              )}
              <IconButton
                icon={AddProjectIcon}
                label={tr('sidebar.action.addProject')}
                size={22}
                iconSize={14}
                aria-haspopup={isLive ? 'menu' : undefined}
                onClick={openAddMenu}
              />
            </span>
          }
        >
          {addMenu && (
            <ActionMenu
              x={addMenu.x}
              y={addMenu.y}
              label={tr('projectImport.menu')}
              onClose={() => setAddMenu(null)}
              actions={[
                { label: tr('projectImport.addFolders'), icon: FolderPlus, run: () => void addProject() },
                { label: tr('projectImport.fromFolder'), icon: FolderInput, run: importProjects },
                {
                  label: tr('projectImport.menuFromTools'),
                  icon: Import,
                  run: () => settings.openSettings('projects'),
                },
              ]}
            />
          )}
          <WslHint />
          {runFilter && shownProjects.length === 0 ? (
            <SidebarEmpty>
              {tr(runFilter === 'running' ? 'sidebar.runStatus.noneRunning' : 'sidebar.runStatus.noneWaiting')}
            </SidebarEmpty>
          ) : shownProjects.length > 0 ? (
            <ProjectTree
              projects={shownProjects}
              selectedSessionId={selectedSessionId}
              onSelectSession={onSelectSession}
              filtering={!!runFilter}
            />
          ) : (
            <>
              <SidebarEmpty>{tr('sidebar.Sidebar.noProjectsYet')}</SidebarEmpty>
              {isLive && (
                <SidebarRow onClick={onAddProject}>
                  <FolderPlus size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
                  <span className="truncate">{tr('sidebar.Sidebar.addProjectFolder')}</span>
                </SidebarRow>
              )}
            </>
          )}
        </SidebarSection>
      </div>

      {/* 最近任务来自两个以上项目才显示，否则和上面的项目列表完全重复（docs/ui/conversation-ux-2.md §2.3） */}
      {!runFilter && prefs.showRecent && recentSpansProjects(recent) && (
        <section className="mx-3 flex min-h-0 max-h-[35%] shrink-0 flex-col pb-2" data-sidebar-recent>
          <h3 className="shrink-0">
            <button
              type="button"
              aria-expanded={recentShown}
              aria-controls={recentId}
              title={tr(recentShown ? 'sidebar.recent.collapse' : 'sidebar.recent.expand')}
              onClick={() => setSidebarPrefs({ recentExpanded: !recentShown, recentChosen: true })}
              className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-label font-medium text-fg-muted hover:bg-hover hover:text-fg"
            >
              <span className="shrink-0">{tr('sidebar.Sidebar.recentTasks')}</span>
              <span className="h-px min-w-0 flex-1 bg-line-subtle" />
              <ChevronDown
                size={14}
                strokeWidth={1.5}
                className="sidebar-history-chevron shrink-0"
                data-expanded={recentShown}
              />
            </button>
          </h3>
          <div
            id={recentId}
            className="sidebar-history-content min-h-0 overflow-hidden"
            data-expanded={recentShown}
            aria-hidden={!recentShown}
            inert={!recentShown}
          >
            <div className="min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex flex-col gap-px">
                {recent.map(r => (
                  <RecentItem
                    key={r.id}
                    item={r}
                    status={r.status}
                    selected={r.id === selectedSessionId}
                    onSelect={onSelectSession}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 胶囊在最近任务下面、账号行上面（docs/ui/layout-v2.md §3） */}
      <RunStatusPill cards={cards} filter={runFilter} onFilter={setRunFilter} />
      <SidebarFooter />
    </aside>
  )
}

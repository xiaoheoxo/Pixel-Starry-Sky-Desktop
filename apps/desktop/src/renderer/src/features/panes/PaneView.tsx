import { draftWorkspace } from '@/features/machines/drafts'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { Columns2, Ellipsis, Folder, Maximize2, Minimize2, MousePointerClick, Plus, Rows2, X } from 'lucide-react'
import { IconButton, Popover, PopoverItem, Spinner, cn } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { isLive, useEngineState, useSessionTitle } from '@/features/engine'
import { busy, orChat } from '@/features/engine/sidebarData'
import { useTuiBusy } from '@/features/terminal/useTuiBusy'
import { SPLIT_DOWN, SPLIT_RIGHT, ZOOM_PANE, withShortcut } from '@/features/layout/shortcuts'
import { flipFrom } from './motion'
import { TabSlot } from './tabHost'
import { notify, paneActions, tabInUse, usePaneState } from './store'
import { isNewTab, isFileTab, parseFileTab, leaves, tabsToClose, type BulkClose, type Leaf } from './tree'
import { dirtyFile, showFiles, useFiles } from '@/features/files/store'
import { isDemo, projects } from '@/data'
import { useSessionActions } from '@/features/sidebar/SessionActions'
import { openRightTab } from '@/features/panel/workspaceStore'
import { useBeginTabDrag } from './drag'
import { useTabStripScroll } from './tabScroll'
import { TabStripArrows } from './TabStripArrows'
import { dropProblem, type DropTarget } from './drop'
import { FileIcon } from '@/features/files/icons/FileIcon'

type TabStatus = 'running' | 'waiting' | 'unread' | 'idle'

interface TabInfo {
  title: string
  project: string | null
  status: TabStatus
  file?: boolean
  dirty?: boolean
}

/** 标签的标题、所属项目、状态（运行中 / 待你确认 / 有新回复） */
function useTabInfo(tab: string | null): TabInfo {
  const sessionId = tab && !isNewTab(tab) && !isFileTab(tab) ? tab : null
  const files = useFiles(),
    file = files.tabs.find(t => t.id === tab),
    parsed = tab ? parseFileTab(tab) : null
  const title = useSessionTitle(sessionId)
  const summary = useEngineState(s => (sessionId ? s.sessions.find(x => x.record.id === sessionId) : undefined))
  useTuiBusy() // busy() 里终端模式那部分读全局状态，这里订阅它的变化
  const project = useEngineState(s => {
    if (summary)
      return orChat(s.projects.find(p => p.id === summary.record.projectId)?.name, summary.record.projectId) ?? null
    // 新对话标签还没有会话记录：写这个标签绑的项目（和发消息、状态栏一致），没绑时写当前项目
    if (tab && isNewTab(tab)) {
      const id = draftWorkspace(tab)?.projectId ?? s.currentProjectId
      return orChat(s.projects.find(p => p.id === id)?.name, id) ?? null
    }
    return null
  })
  const demoProject =
    isDemo && sessionId ? (projects.find(p => p.sessions.some(x => x.id === sessionId))?.name ?? null) : null
  const unread = useEngineState(s => (sessionId ? !!s.unread[sessionId] : false))
  const pending = useEngineState(s => (sessionId ? (s.snapshots[sessionId]?.pending.length ?? 0) : 0))
  const status: TabStatus = !isLive
    ? 'idle'
    : pending > 0 || summary?.state === 'waiting'
      ? 'waiting'
      : summary && busy(summary)
        ? 'running'
        : unread
          ? 'unread'
          : 'idle'
  if (parsed)
    return {
      title: file?.path ?? parsed.path,
      project: file?.project || null,
      status: 'idle',
      file: true,
      dirty: file ? dirtyFile(file) : false,
    }
  return { title: tab === null ? tr('panes.PaneView.emptyPane') : title, project: project ?? demoProject, status }
}

function StatusMark({ status }: { status: TabStatus }) {
  useI18n()
  if (status === 'running') return <Spinner size={11} className="shrink-0" />
  if (status === 'waiting')
    return (
      <span
        className="size-1.5 shrink-0 rounded-full bg-warn"
        aria-label={tr('panes.PaneView.waitingForConfirmation')}
      />
    )
  if (status === 'unread')
    return <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={tr('panes.PaneView.newReply')} />
  return null
}

export interface PaneViewProps {
  leaf: Leaf
  focused: boolean
  /** 是否画窗格头（只有一个窗格时不画，界面和单会话一样） */
  showHead: boolean
  maximized: boolean
  /** 窗格区的像素尺寸，拆分前检查放不放得下 */
  areaSize: () => { width: number; height: number }
}

/**
 * 一个窗格：窗格头 + 标签条 + 各标签的插槽。标签内容由 Workspace 的 TabHosts 渲染、搬进插槽（tabHost.tsx），
 * 其他标签保持挂载、只是隐藏，滚动位置和草稿都还在；标签换窗格时也不重建
 */
export const PaneView = memo(function PaneView(props: PaneViewProps) {
  useI18n()
  const { leaf, focused, showHead, maximized } = props
  const info = useTabInfo(leaf.active)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div
      // 分屏时窗格之间不留缝：分界是 Workspace 画的一条分隔线，当前窗格由 Workspace 的强调色框标出
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-app"
      data-pane-id={leaf.id}
      data-focused={showHead && focused ? '' : undefined}
      onPointerDownCapture={() => paneActions.focus(leaf.id)}
    >
      {showHead && (
        <div
          className={cn('pane-head relative shrink-0 border-b border-line', focused ? 'bg-selected' : 'bg-app')}
          onDoubleClick={e => {
            if ((e.target as HTMLElement).closest('button')) return
            paneActions.toggleMaximize(leaf.id)
          }}
        >
          {/* 标题只写在标签上（「📁 项目 / 标题」），窗格头就是标签那一行，右边放大 / 更多 / 关闭（docs/ui/tabs-only-mockup.html） */}
          <div className="flex min-h-10 items-center">
            {leaf.tabs.length > 0 ? (
              <TabStrip leaf={leaf} dim={!focused} areaSize={props.areaSize} />
            ) : (
              <span className={cn('min-w-0 flex-1 truncate pl-3 text-ui text-fg-muted', !focused && 'opacity-55')}>
                {info.title}
              </span>
            )}
            <div className={cn('flex shrink-0 items-center gap-0.5 pr-2', !focused && 'opacity-55')}>
              <IconButton
                icon={maximized ? Minimize2 : Maximize2}
                label={withShortcut(
                  maximized ? tr('panes.PaneView.restorePane') : tr('panes.PaneView.expandPane'),
                  ZOOM_PANE,
                )}
                iconSize={14}
                onClick={() => paneActions.toggleMaximize(leaf.id)}
              />
              <span className="relative">
                <IconButton
                  icon={Ellipsis}
                  label={tr('session.SessionHeader.more')}
                  active={menuOpen}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onMouseDown={e => menuOpen && e.stopPropagation()}
                  onClick={() => setMenuOpen(v => !v)}
                />
                <Popover open={menuOpen} onClose={() => setMenuOpen(false)} align="end">
                  <PopoverItem
                    icon={<Columns2 size={15} strokeWidth={1.5} className="text-fg-secondary" />}
                    onClick={() => {
                      setMenuOpen(false)
                      paneActions.focus(leaf.id)
                      paneActions.split('row', props.areaSize())
                    }}
                  >
                    {tr('panes.PaneView.splitRight')} {SPLIT_RIGHT.label}）
                  </PopoverItem>
                  <PopoverItem
                    icon={<Rows2 size={15} strokeWidth={1.5} className="text-fg-secondary" />}
                    onClick={() => {
                      setMenuOpen(false)
                      paneActions.focus(leaf.id)
                      paneActions.split('col', props.areaSize())
                    }}
                  >
                    {tr('panes.PaneView.splitDown')} {SPLIT_DOWN.label}）
                  </PopoverItem>
                  {leaf.tabs.length > 0 &&
                    (['inactive', 'all'] as const).map(kind => (
                      <PopoverItem
                        key={kind}
                        icon={<span className="size-[15px] shrink-0" />}
                        disabled={kind === 'inactive' && !tabsToClose(leaf, kind, null, tabInUse).length}
                        title={kind === 'inactive' ? tr('panes.PaneView.closeInactiveHint') : undefined}
                        onClick={() => {
                          setMenuOpen(false)
                          void paneActions.closeTabs(leaf.id, kind)
                        }}
                      >
                        {BULK_LABEL[kind]()}
                      </PopoverItem>
                    ))}
                  <PopoverItem
                    icon={<X size={15} strokeWidth={1.5} className="text-fg-secondary" />}
                    onClick={() => {
                      setMenuOpen(false)
                      paneActions.closePane(leaf.id)
                    }}
                  >
                    {tr('panes.PaneView.closePane')}{' '}
                  </PopoverItem>
                </Popover>
              </span>
              <IconButton
                icon={X}
                label={tr('panes.PaneView.closePaneConversationContinues')}
                iconSize={15}
                onClick={() => paneActions.closePane(leaf.id)}
              />
            </div>
          </div>
        </div>
      )}
      {!showHead && leaf.tabs.length > 0 && (
        <div data-tab-bar data-tab-count={leaf.tabs.length} className="shrink-0 border-b border-line-layout">
          <TabStrip leaf={leaf} dim={false} areaSize={props.areaSize} />
        </div>
      )}

      <div data-pane-content className="relative min-h-0 flex-1">
        {leaf.tabs.length === 0 ? <EmptyPane /> : leaf.tabs.map(tab => <TabSlot key={tab} tab={tab} />)}
      </div>
    </div>
  )
})

/** 标签条：标签增减、位置变化时其余标签平滑移位（FLIP） */
function TabStrip({ leaf, dim, areaSize }: { leaf: Leaf; dim: boolean; areaSize: PaneViewProps['areaSize'] }) {
  useI18n()
  const refs = useRef(new Map<string, HTMLDivElement>())
  const prev = useRef(new Map<string, number>())
  const seen = useRef(new Set(leaf.tabs))
  const activeProject = useTabInfo(leaf.active).project
  const [menu, setMenu] = useState<{ tab: string; x: number; y: number } | null>(null)
  // 标签栏空白处右键：关闭所有 / 不活跃的标签页（GitHub #32）
  const [blankMenu, setBlankMenu] = useState<{ x: number; y: number } | null>(null)
  // 滚轮横向滚、中键 / 空白处拖动平移、当前标签滚进可视区、两头淡出（GitHub #16，tabScroll.ts）
  const strip = useRef<HTMLDivElement>(null)
  useTabStripScroll(strip, leaf.active, leaf.tabs)

  useLayoutEffect(() => {
    const next = new Map<string, number>()
    for (const [tab, el] of refs.current) {
      const left = el.offsetLeft
      next.set(tab, left)
      const old = prev.current.get(tab)
      if (old !== undefined) flipFrom(el, old - left, 0, 200)
    }
    prev.current = next
  })

  const isNew = (tab: string): boolean => {
    if (seen.current.has(tab)) return false
    seen.current.add(tab)
    return true
  }

  return (
    <div className={cn('pane-head-content flex min-w-0 flex-1 items-center pr-2', dim && 'opacity-55')}>
      <div className="tab-strip-wrap">
        <div
          ref={strip}
          data-tab-strip
          role="tablist"
          aria-label={tr('panes.PaneView.conversationTabsDragTo')}
          className="pane-tab-strip relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 pt-1 pb-1.5 [scrollbar-width:none]"
          onContextMenu={e => {
            e.preventDefault()
            setBlankMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          {leaf.tabs.map(tab => (
            <Tab
              key={tab}
              tab={tab}
              leafId={leaf.id}
              active={tab === leaf.active}
              activeProject={activeProject}
              entering={isNew(tab)}
              onMenu={(x, y) => setMenu({ tab, x, y })}
              refCb={el => {
                if (el) refs.current.set(tab, el)
                else refs.current.delete(tab)
              }}
            />
          ))}
        </div>
        <TabStripArrows strip={strip} />
      </div>
      {/* 新建按钮固定在标签栏右边，标签多了也不会被挤出去；上下留白和标签栏一样，和标签对齐 */}
      <span data-tab-new className="flex shrink-0 pt-1 pb-1.5">
        <button
          type="button"
          aria-label={tr('panes.PaneView.newConversationInThis')}
          title={tr('panes.PaneView.newConversationInThis')}
          onClick={() => {
            paneActions.focus(leaf.id)
            paneActions.open(null)
          }}
          className="press flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg"
        >
          <Plus size={14} strokeWidth={1.5} />
        </button>
      </span>
      {blankMenu && (
        <ActionMenu
          x={blankMenu.x}
          y={blankMenu.y}
          label={tr('panes.PaneView.conversationTabsDragTo')}
          actions={bulkActions(leaf, null, ['inactive', 'all'])}
          onClose={() => setBlankMenu(null)}
        />
      )}
      {menu && (
        <TabMenu
          leaf={leaf}
          menu={menu}
          areaSize={areaSize}
          onClose={() => {
            setMenu(null)
            requestAnimationFrame(() => {
              if (!document.querySelector('[aria-modal="true"]')) refs.current.get(menu.tab)?.focus()
            })
          }}
        />
      )}
    </div>
  )
}

function Tab({
  tab,
  leafId,
  active,
  activeProject,
  entering,
  refCb,
  onMenu,
}: {
  tab: string
  leafId: string
  active: boolean
  /** 当前标签所属项目：别的标签项目不同时才在标题前写项目名 */
  activeProject: string | null
  entering: boolean
  refCb: (el: HTMLDivElement | null) => void
  onMenu: (x: number, y: number) => void
}) {
  useI18n()
  const info = useTabInfo(tab)
  const beginDrag = useBeginTabDrag()
  // 顶栏不写标题了，标题只在标签上：当前标签「📁 项目 / 标题」，别的标签项目和当前不同时写「项目 / 标题」
  const crumb = info.file || !info.project ? null : active ? 'full' : info.project !== activeProject ? 'project' : null
  return (
    <div
      ref={refCb}
      data-tab-id={tab}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      title={tr('panes.PaneView.dragToReorderMove', { p0: info.title })}
      onPointerDown={e => beginDrag(e, tab, info.title)}
      onContextMenu={e => {
        e.preventDefault()
        e.stopPropagation()
        onMenu(e.clientX, e.clientY)
      }}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          onMenu(r.left, r.bottom)
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          paneActions.activate(leafId, tab)
        } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          const strip = e.currentTarget.parentElement
          e.preventDefault()
          paneActions.focus(leafId)
          paneActions.cycleTab(e.key === 'ArrowLeft' ? -1 : 1)
          requestAnimationFrame(() => strip?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
        }
      }}
      onClick={() => paneActions.activate(leafId, tab)}
      onAuxClick={e => e.button === 1 && paneActions.closeTab(leafId, tab)}
      className={cn(
        'group/tab flex h-7 shrink-0 cursor-grab touch-none items-center gap-1.5 rounded-md border pr-1 pl-2 text-meta select-none transition-colors',
        active
          ? 'border-line bg-surface text-fg shadow-sm'
          : 'border-transparent text-fg-muted hover:bg-hover hover:text-fg',
        crumb === 'full' ? 'max-w-80' : 'max-w-60',
        entering && 'pane-tab-in',
      )}
    >
      {crumb && (
        <span data-tab-project className="flex shrink-0 items-center gap-1.5 text-fg-faint">
          {crumb === 'full' && <Folder size={13} strokeWidth={1.5} className="shrink-0" />}
          <span className={cn('max-w-32 truncate font-mono text-label', active && 'text-fg-muted')}>
            {info.project}
          </span>
          <span>/</span>
        </span>
      )}
      {info.file ? (
        <FileIcon name={info.title.split('/').pop() ?? info.title} kind="file" size={14} />
      ) : (
        <StatusMark status={info.status} />
      )}
      <span className="truncate">{info.file ? info.title.split('/').pop() : info.title}</span>
      {info.dirty && (
        <span aria-label={tr('panes.PaneView.unsavedChanges')} className="size-1.5 shrink-0 rounded-full bg-fg-muted" />
      )}
      <button
        type="button"
        aria-label={tr('panes.PaneView.close', { p0: info.title })}
        onClick={e => {
          e.stopPropagation()
          paneActions.closeTab(leafId, tab)
        }}
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-sm text-fg-faint hover:bg-hover hover:text-fg',
          active ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100',
        )}
      >
        <X size={11} strokeWidth={1.75} />
      </button>
    </div>
  )
}

/**
 * 标签右键菜单（docs/ui/ui-polish-2026-10-13.md §4、§7）：独立浮层，不被窄窗格或标签栏的滚动裁切。
 * 按作用对象分组：对话（重命名、归档；文件标签是文件的几项）→ 布局（分屏到 ›、标签位置 ›）→ 关闭（范围从小到大）
 * → 最下面单独一组红色的「删除对话」
 */
function TabMenu({
  leaf,
  menu,
  areaSize,
  onClose,
}: {
  leaf: Leaf
  menu: { tab: string; x: number; y: number }
  areaSize: PaneViewProps['areaSize']
  onClose: () => void
}) {
  useI18n()
  const layout = usePaneState(s => s.layout)
  const closing = usePaneState(s => s.closing)
  const all = leaves(layout.root)
  const sessionActions = useSessionActions()
  const summary = useEngineState(s => s.sessions.find(row => row.record.id === menu.tab))
  const info = useTabInfo(menu.tab)
  const demo = projects.flatMap(p => [...p.sessions, ...(p.archived ?? [])]).find(row => row.id === menu.tab)
  const sessionTarget =
    !isNewTab(menu.tab) && !isFileTab(menu.tab) && (summary || demo)
      ? {
          id: menu.tab,
          title: info.title,
          archived: !!summary?.record.archivedAt || !!demo?.archivedAt,
          running: summary ? summary.state !== 'idle' : demo?.status === 'running',
        }
      : null
  const index = leaf.tabs.indexOf(menu.tab)
  type Choice = { label: string; target: DropTarget; disabled?: boolean; separator?: boolean }
  // 分屏到 ›：四个方向 | 移到别的窗格
  const splits: Choice[] = [
    { label: tr('tabMenu.splitLeft'), target: { leafId: leaf.id, edge: 'left' } },
    { label: tr('tabMenu.splitRight'), target: { leafId: leaf.id, edge: 'right' } },
    { label: tr('tabMenu.splitUp'), target: { leafId: leaf.id, edge: 'top' } },
    { label: tr('tabMenu.splitDown'), target: { leafId: leaf.id, edge: 'bottom' } },
    ...all
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.id !== leaf.id && !closing[l.id])
      .map(({ l, i }, n) => ({
        label: tr('panes.PaneView.moveToPane', { p0: i + 1 }),
        target: { leafId: l.id, index: l.tabs.length },
        separator: n === 0,
      })),
  ]
  // 标签位置 ›：在标签栏里左右挪
  const positions: Choice[] = [
    { label: tr('tabMenu.moveLeft'), target: { leafId: leaf.id, index: index - 1 }, disabled: index <= 0 },
    {
      label: tr('tabMenu.moveRight'),
      target: { leafId: leaf.id, index: index + 2 },
      disabled: index >= leaf.tabs.length - 1,
    },
  ]
  if (index < 0) return null
  const toAction = (choice: Choice): MenuAction => {
    const problem = choice.disabled ? null : dropProblem(layout, menu.tab, choice.target, areaSize())
    return {
      label: choice.label,
      disabled: choice.disabled || !!problem,
      title: problem ?? undefined,
      separator: choice.separator,
      run: () => paneActions.dropTab(menu.tab, choice.target, areaSize()),
    }
  }
  const file = parseFileTab(menu.tab)
  // 按动作作用的对象分组：对话本身（文件标签是文件的几项）→ 布局 → 关闭 → 危险操作（D116）
  const actions: MenuAction[] = [
    ...(sessionTarget
      ? [
          {
            label: tr('session.rename'),
            disabled: sessionActions.busy,
            run: () => sessionActions.request('rename', sessionTarget),
          },
          {
            label: tr(sessionTarget.archived ? 'session.restore' : 'session.archive'),
            disabled: sessionActions.busy,
            run: () => sessionActions.request(sessionTarget.archived ? 'restore' : 'archive', sessionTarget),
          },
        ]
      : []),
    ...(file
      ? [
          {
            label: tr('workspace.moveRight'),
            run: () => {
              paneActions.detachFileTab(menu.tab)
              openRightTab(menu.tab)
            },
          },
          { label: tr('panes.PaneView.revealInFileTree'), run: () => showFiles(file.ref, file.path) },
          {
            label: tr('panes.PaneView.copyFilePath'),
            run: () => {
              if (!isDemo) void window.pixelsky!.files.copyPath(file.ref, file.path)
            },
          },
          {
            label: tr('panes.PaneView.openWithExternalEditor'),
            run: () => {
              if (!isDemo)
                void window.pixelsky!.editor.open(file.ref, undefined, file.path).catch(e => notify(e.message))
            },
          },
        ]
      : []),
    { label: tr('tabMenu.splitTo'), separator: true, children: splits.map(toAction) },
    { label: tr('tabMenu.tabPosition'), children: positions.map(toAction) },
    { label: tr('tabMenu.close'), separator: true, run: () => void paneActions.closeTab(leaf.id, menu.tab) },
    // 范围从小到大，「关闭所有」放最后
    ...bulkActions(leaf, menu.tab, ['others', 'right', 'inactive', 'all']),
    ...(sessionTarget
      ? [
          {
            label: tr('tabMenu.deleteConversation'),
            danger: true,
            separator: true,
            disabled: sessionActions.busy,
            run: () => sessionActions.request('delete', sessionTarget),
          },
        ]
      : []),
  ]
  return (
    <ActionMenu
      x={menu.x}
      y={menu.y}
      label={tr('panes.PaneView.moveConversationTab')}
      actions={actions}
      onClose={onClose}
    />
  )
}

const BULK_LABEL: Record<BulkClose, () => string> = {
  others: () => tr('panes.PaneView.closeOtherTabs'),
  right: () => tr('panes.PaneView.closeTabsToRight'),
  all: () => tr('panes.PaneView.closeAllTabs'),
  inactive: () => tr('panes.PaneView.closeInactiveTabs'),
}

/** 批量关闭的几项（GitHub #32）：没有可关的标签时灰掉 */
function bulkActions(leaf: Leaf, anchor: string | null, kinds: BulkClose[]): MenuAction[] {
  return kinds.map(kind => ({
    label: BULK_LABEL[kind](),
    disabled: !tabsToClose(leaf, kind, anchor, tabInUse).length,
    title: kind === 'inactive' ? tr('panes.PaneView.closeInactiveHint') : undefined,
    run: () => void paneActions.closeTabs(leaf.id, kind, anchor),
  }))
}

function EmptyPane() {
  useI18n()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-fg-muted">
      <MousePointerClick size={22} strokeWidth={1.5} />
      <span className="text-ui">{tr('panes.PaneView.openConversationFromSidebar')}</span>
      <span className="text-meta text-fg-faint">
        {SPLIT_RIGHT.label}
        {tr('panes.PaneView.splitRight2')} {SPLIT_DOWN.label}
        {tr('panes.PaneView.splitDown2')}{' '}
      </span>
      <button
        type="button"
        onClick={() => paneActions.open(null)}
        className="press mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-ui font-medium text-fg shadow-sm hover:border-fg-faint"
      >
        <Plus size={15} strokeWidth={1.5} />
        {tr('sidebar.NewTaskButton.newTask')}{' '}
      </button>
    </div>
  )
}

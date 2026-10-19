import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../i18n/core'
import { useEffect, useState } from 'react'
import { Sidebar } from '../features/sidebar/Sidebar'
import { SidebarFollow } from './SidebarFollow'
import { ToolbarContext } from '../features/layout/ToolbarContext'
import { RightPanel } from '../features/panel/RightPanel'
import { defaultPanelOpen, defaultSessionId } from '../data'
import { NEW_TASK, TOGGLE_BOTTOM_PANEL, TOGGLE_PANEL, TOGGLE_SIDEBAR } from '../features/layout/shortcuts'
import { cn, CollapsibleSlot, useComingSoon } from '../ui'
import { isLive, useEngineBoot, useOpenSessionRequests } from '../features/engine'
import { Workspace, WorkspaceHeader } from '../features/panes/Workspace'
import { paneActions, startPanes, usePaneState } from '../features/panes/store'
import { focusedTab, isNewTab, isFileTab } from '../features/panes/tree'
import { ResizeHandle } from '../ui/ResizeHandle'
import { DEFAULT_SIDEBAR_WIDTH, setLayoutSize, useLayoutSize } from '../features/layout/sizes'
import { autoPanelWidth } from '../features/layout/panelWidth'
import { CacheMissAlerts } from '../features/session/CacheMissAlerts'
import { NotificationDispatcher } from '../features/notifications/NotificationDispatcher'
import { FeedbackNotifier } from '../features/feedback/FeedbackNotifier'
import { TeamNotifier } from '../features/channels/TeamNotifier'
import { OPEN_FILES_EVENT } from '../features/files/store'
import { FileLifecycle } from '../features/files/FileLifecycle'
import { FileConfirm } from '../features/files/FileConfirm'
import { WindowControls } from '../features/layout/WindowControls'
import { FirstLaunch } from '../features/onboarding/FirstLaunch'
import { OPEN_RIGHT_WORKSPACE } from '../features/panel/workspaceStore'
import { CodingLayout } from '../features/coding/CodingLayout'
import { codingLayout } from '../features/coding/layoutStore'
import { getAppMode, useAppMode } from '../features/coding/mode'
import { usePaneHousekeeping } from '../features/panes/housekeeping'
import { MachineDialogs } from '../features/machines/MachineDialogs'
import { ProjectImport } from '../features/sidebar/ProjectImport'
import { WslCheckCard } from '../features/machines/WslCheckCard'
import { WhatsNewDialog } from '../features/update/WhatsNewDialog'
import { MachineStatus } from '../features/machines/MachineStatus'
import { showWorkbench, usePage } from '../features/layout/page'
import { ChannelsPage } from '../features/channels/ChannelsPage'
import { TaskBoardPage } from '../features/board/TaskBoardPage'

/** 各栏宽度，需与对应组件的 class 保持一致（docs/ui/workbench.md §2.1） */
const SESSION_MIN_WIDTH = 464 // SessionView min-w-[464px]

/** 协作频道页：频道列表 + 时间线最小宽 + 成员面板（docs/ui/channels.md §3） */
const CHANNEL_LIST_WIDTH = 260
const CHANNEL_CENTER_MIN = 360
/** 任务看板最窄：再窄就横向滚动（每列最窄 260px） */
const BOARD_MIN_WIDTH = 560
const CHANNEL_MEMBERS_WIDTH = 300
const MEMBERS_KEY = 'pixelsky.channels.members-open'
function fitsChannels(sidebarOpen: boolean, sidebarWidth: number): boolean {
  return (
    (sidebarOpen ? sidebarWidth : 0) + CHANNEL_LIST_WIDTH + CHANNEL_CENTER_MIN + CHANNEL_MEMBERS_WIDTH <=
    window.innerWidth
  )
}

/** 给定侧边栏、右侧面板的开合状态，当前窗口宽度能否放下所有打开的栏 */
function fits(sidebarOpen: boolean, panelOpen: boolean, sidebarWidth: number, panelWidth: number): boolean {
  const needed = (sidebarOpen ? sidebarWidth : 0) + SESSION_MIN_WIDTH + (panelOpen ? panelWidth : 0)
  return needed <= window.innerWidth
}

/** 布局：侧边栏 + 会话区（可拆成多个窗格，features/panes/）+ 右侧面板 */
export function App() {
  useI18n()
  const mode = useAppMode()
  // 主区显示工作台还是协作频道（docs/ui/channels.md §2）；工作台在频道页期间保持挂载
  const page = usePage()
  const onWorkbench = page === 'workbench'
  const comingSoon = useComingSoon()
  const preferredSidebarWidth = useLayoutSize('sidebar')
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [panelMaximized, setPanelMaximized] = useState(false)
  // 没拖过时按窗口宽度自动算（docs/ui/workbench-ux-3.md §2.3）
  const preferredPanelWidth = useLayoutSize('rightWorkspace') ?? autoPanelWidth(windowWidth, preferredSidebarWidth)
  const panelMax = Math.max(360, windowWidth - (sidebarOpen ? preferredSidebarWidth : 0) - SESSION_MIN_WIDTH)
  const panelWidth = Math.min(preferredPanelWidth, panelMax)
  const [panelOpen, setPanelOpen] = useState(
    () =>
      (localStorage.getItem('pixelsky.right-workspace.open') === 'true' || defaultPanelOpen) &&
      fits(true, true, preferredSidebarWidth, 360),
  )
  // 频道页的最窄情况是 220px 紧凑列表 + 360px 时间线
  const sidebarMax = Math.max(
    240,
    Math.min(
      480,
      onWorkbench
        ? windowWidth - SESSION_MIN_WIDTH - (panelOpen ? panelWidth : 0)
        : page === 'board'
          ? windowWidth - BOARD_MIN_WIDTH
          : windowWidth - 220 - CHANNEL_CENTER_MIN,
    ),
  )
  const sidebarWidth = Math.min(preferredSidebarWidth, sidebarMax)
  const [membersOpen, setMembersOpen] = useState(() => {
    try {
      return localStorage.getItem(MEMBERS_KEY) !== 'false'
    } catch {
      return true
    }
  })
  // 放不下时成员面板自动隐藏，偏好不变
  const membersShown = membersOpen && fitsChannels(sidebarOpen, sidebarWidth)
  useEffect(() => {
    try {
      localStorage.setItem(MEMBERS_KEY, String(membersOpen))
    } catch {}
  }, [membersOpen])
  // 多对话窗格：第一次渲染前读出保存的布局（没有记录时打开默认会话），docs/ui/multi-pane.md
  useState(() => startPanes(defaultSessionId))
  // 侧栏高亮当前窗格正在显示的会话；新会话（欢迎页）时为 null
  const current = usePaneState(s => focusedTab(s.layout))
  const sessionId = current && !isNewTab(current) && !isFileTab(current) ? current : null
  // 引擎系统：连接主进程（演示模式下什么都不做）；正在看的会话由 Workspace 统一标记
  useEngineBoot()
  // 设置 › 用量 里点「打开这个会话」：和在侧栏点一样，打开到当前窗格；
  // 代码模式下对话在右栏，右栏正显示通知 / 任务等别的视图（例如从「待处理」点「去回答」）时切回对话，不然看不到任何变化
  useOpenSessionRequests(id => {
    paneActions.open(id)
    if (getAppMode() === 'code') codingLayout.showRight('chat')
  })
  // 「正在看」标记和失效会话标签清理（两种模式都要跑）
  usePaneHousekeeping()
  useEffect(() => {
    try {
      localStorage.setItem('pixelsky.right-workspace.open', String(panelOpen))
    } catch {}
  }, [panelOpen])
  useEffect(() => {
    const reveal = () => {
      // 代码模式下这些事件由 coding/routing.ts 接
      if (getAppMode() === 'code') return
      showWorkbench()
      setPanelOpen(true)
      if (!fits(sidebarOpen, true, preferredSidebarWidth, 360)) setSidebarOpen(false)
    }
    const close = () => {
      if (getAppMode() === 'code') return
      setPanelOpen(false)
      setPanelMaximized(false)
    }
    const maximize = () => {
      if (getAppMode() === 'code') return
      showWorkbench()
      setPanelOpen(true)
      setPanelMaximized(v => !v)
    }
    const events = [OPEN_RIGHT_WORKSPACE, OPEN_FILES_EVENT, 'pixelsky:open-browser', 'pixelsky:open-task']
    events.forEach(name => window.addEventListener(name, reveal))
    window.addEventListener('pixelsky:panel-maximize', maximize)
    window.addEventListener('pixelsky:close-right-workspace', close)
    return () => {
      events.forEach(name => window.removeEventListener(name, reveal))
      window.removeEventListener('pixelsky:panel-maximize', maximize)
      window.removeEventListener('pixelsky:close-right-workspace', close)
    }
  }, [sidebarOpen, preferredSidebarWidth])

  useEffect(() => {
    const toggleSidebarEvent = () => {
      if (getAppMode() !== 'code') toggleSidebar()
    }
    const togglePanelEvent = () => {
      if (getAppMode() !== 'code') togglePanel()
    }
    window.addEventListener('pixelsky:toggle-sidebar', toggleSidebarEvent)
    window.addEventListener('pixelsky:toggle-panel', togglePanelEvent)
    return () => {
      window.removeEventListener('pixelsky:toggle-sidebar', toggleSidebarEvent)
      window.removeEventListener('pixelsky:toggle-panel', togglePanelEvent)
    }
  })

  // 窗口缩窄到放不下时自动收起右侧面板
  useEffect(() => {
    const onResize = () => {
      setWindowWidth(window.innerWidth)
      // 只在工作台可见时按右侧面板收侧栏；频道页的成员面板放不下时自己隐藏
      if (
        mode === 'chat' &&
        onWorkbench &&
        panelOpen &&
        !panelMaximized &&
        !fits(sidebarOpen, true, preferredSidebarWidth, 360)
      )
        setSidebarOpen(false)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [mode, sidebarOpen, panelOpen, preferredSidebarWidth, panelWidth, panelMaximized, onWorkbench])

  // 窄窗口下侧边栏和右侧面板不同时打开：打开一个时如果放不下，就收起另一个
  const togglePanel = () => {
    // 任务看板没有右侧面板（docs/ui/task-board.md §2）
    if (page === 'board') return
    // 频道页：面板开关和 Ctrl+Alt+B 开合成员面板，放不下时先收起侧栏
    if (!onWorkbench) {
      const next = !membersShown
      if (next && sidebarOpen && !fitsChannels(true, sidebarWidth)) setSidebarOpen(false)
      setMembersOpen(next)
      return
    }
    const next = !panelOpen
    if (next && sidebarOpen && !fits(true, true, preferredSidebarWidth, 360)) setSidebarOpen(false)
    setPanelOpen(next)
    if (!next) setPanelMaximized(false)
  }

  const toggleSidebar = () => {
    const next = !sidebarOpen
    if (onWorkbench && next && panelOpen && !fits(true, true, preferredSidebarWidth, panelWidth)) setPanelOpen(false)
    setSidebarOpen(next)
  }

  // 快捷键：Ctrl+B 侧边栏，Ctrl+Alt+B 右侧面板（macOS 用 ⌘），见 features/layout/shortcuts.ts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        document.querySelector('[aria-modal="true"]') ||
        (document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-terminal-input]'))
      )
        return
      // 新建任务 Ctrl+N：任务看板页里它是「新建卡片」，由看板自己处理（docs/ui/layout-v2.md §9）；演示模式弹「即将推出」
      const newTask =
        page !== 'board' && NEW_TASK.match(e)
          ? isLive
            ? () => paneActions.open(null)
            : () => comingSoon(tr('sidebar.NewTaskButton.newTask'))
          : null
      const code = getAppMode() === 'code'
      const action = TOGGLE_SIDEBAR.match(e)
        ? code
          ? () => codingLayout.toggle('left')
          : toggleSidebar
        : TOGGLE_PANEL.match(e)
          ? code
            ? () => codingLayout.toggle('right')
            : togglePanel
          : code && TOGGLE_BOTTOM_PANEL.match(e)
            ? () => codingLayout.toggle('bottom')
            : newTask
      if (!action) return
      e.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div className="flex h-full w-full overflow-hidden bg-app text-fg">
      <CacheMissAlerts />
      <NotificationDispatcher />
      <FeedbackNotifier />
      <TeamNotifier />
      <MachineDialogs />
      <ProjectImport />
      <WslCheckCard />
      <WhatsNewDialog />
      <FileLifecycle />
      <FileConfirm />
      {mode === 'code' ? (
        <CodingLayout />
      ) : (
        <>
          {/* 侧边栏、右侧面板一直挂载，收起 / 展开带滑动动画（docs/ui/workbench.md §4.1） */}
          <SidebarFollow open={sidebarOpen} />
          <div data-vt-chat-sidebar className="relative flex shrink-0">
            <CollapsibleSlot open={sidebarOpen} width={sidebarWidth} side="left" slide>
              <ToolbarContext.Provider
                value={{ panelOpen, filesPanelOpen: panelOpen, onCloseFiles: () => setPanelOpen(false) }}
              >
                <Sidebar
                  selectedSessionId={onWorkbench ? sessionId : null}
                  onSelectSession={paneActions.open}
                  onCollapse={() => setSidebarOpen(false)}
                />
              </ToolbarContext.Provider>
            </CollapsibleSlot>
            {sidebarOpen && (
              <ResizeHandle
                label={tr('App.resizeSidebar')}
                axis="x"
                className="sidebar-resize"
                value={sidebarWidth}
                min={240}
                max={sidebarMax}
                onChange={v => setLayoutSize('sidebar', v)}
                onCommit={v => setLayoutSize('sidebar', v, true)}
                onCancel={() => setLayoutSize('sidebar', preferredSidebarWidth, true)}
                onReset={() => setLayoutSize('sidebar', DEFAULT_SIDEBAR_WIDTH, true)}
              />
            )}
          </div>
          {/* 顶栏、会话与右面板直接拼接侧栏，主区不留外层间距或装饰轮廓。 */}
          <div className="workbench-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <WorkspaceHeader
              sidebarOpen={sidebarOpen}
              panelOpen={panelOpen}
              onToggleSidebar={toggleSidebar}
              onTogglePanel={togglePanel}
              filesPanelOpen={panelOpen}
              onCloseFiles={() => setPanelOpen(false)}
              membersShown={membersShown}
            />
            <MachineStatus />
            <div className="relative flex min-h-0 flex-1">
              {/* 频道页叠在工作台上面；工作台只是不可见（不用 display:none），窗格测量、终端、浏览器都保持原样 */}
              <div
                className={cn('workbench-content flex min-h-0 min-w-0 flex-1', !onWorkbench && 'invisible')}
                inert={!onWorkbench}
                aria-hidden={!onWorkbench || undefined}
              >
                <div
                  data-vt-chat-conversation
                  className={panelMaximized && panelOpen ? 'hidden' : 'relative flex min-h-0 min-w-0 flex-1 flex-col'}
                >
                  <Workspace
                    sidebarOpen={sidebarOpen}
                    panelOpen={panelOpen}
                    onToggleSidebar={toggleSidebar}
                    onTogglePanel={togglePanel}
                  />
                </div>
                <div data-vt-chat-right className="relative flex min-h-0 shrink-0">
                  <CollapsibleSlot
                    open={panelOpen}
                    width={panelMaximized ? windowWidth - (sidebarOpen ? sidebarWidth : 0) : panelWidth}
                    side="right"
                  >
                    <RightPanel maximized={panelMaximized} visible={panelOpen} />
                  </CollapsibleSlot>
                  {panelOpen && !panelMaximized && (
                    <ResizeHandle
                      label={tr('workspace.width')}
                      axis="x"
                      scale={-1}
                      className="right-workspace-resize"
                      value={panelWidth}
                      min={360}
                      max={panelMax}
                      onChange={v => setLayoutSize('rightWorkspace', v)}
                      onCommit={v => setLayoutSize('rightWorkspace', v, true)}
                      onReset={() => setLayoutSize('rightWorkspace', null, true)}
                    />
                  )}
                </div>
              </div>
              {page === 'channels' && <ChannelsPage membersShown={membersShown} onToggleMembers={togglePanel} />}
              {page === 'board' && <TaskBoardPage />}
            </div>
          </div>
        </>
      )}
      {/* 第一次打开的欢迎页：盖住整个窗口，窗口按钮在它上面 */}
      <FirstLaunch />
      {/* Electron 按 DOM 顺序收集拖动区域；窗口按钮必须在全部 drag 区域之后排除。 */}
      <WindowControls />
    </div>
  )
}

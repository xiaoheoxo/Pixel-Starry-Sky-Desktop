import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, GitBranch, History, MessagesSquare } from 'lucide-react'
import { SessionHeader } from './SessionHeader'
import { TerminalView } from '@/features/terminal/TerminalView'
import { useTerminalStore } from '@/features/terminal/store'
import { useOptionalTerminalUi } from '@/features/terminal/TerminalProvider'
import { RunPills } from '@/features/terminal/RunPills'
import { isDemoTuiTerminal } from './tuiMode'
import { useTuiToggle } from './tuiToggle'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { Transcript } from './Transcript'
import { Composer, composerDraftKey } from './Composer'
import { BranchBanner, BranchReadOnlyBar, BranchStartDivider, PendingMergeBar } from './branch/BranchViews'
import { branchReadOnly } from './branch/store'
import { ComposerArea } from './ComposerArea'
import { WelcomeView } from './WelcomeView'
import { hasConversation } from './conversation'
import { LiveTranscript } from './live/LiveTranscript'
import { ApprovalStack } from './live/approvals/ApprovalStack'
import type { PlanActions } from './live/PlanReview'
import { ApprovalWaitContext } from './live/approvals/focus'
import { focusComposer } from './composerTarget'
import { AgentTracePanel } from './live/AgentTracePanel'
import { KeptAgentsStrip, TaskStrip } from './live/SessionStrips'
import { keptAgents } from './live/subagentStop'
import { stopAgents } from './live/stopAgents'
import { ProgressCard, useProgress } from './live/ProgressCard'
import { SubagentSettingsDialog } from './SubagentSettingsDialog'
import { InlinePlan } from './live/InlinePlan'
import { useMinimal } from '@/features/appearance/ThemeProvider'
import { TraceContext, type TraceTarget } from './live/trace'
import { PathLinksProvider } from '@/features/files/PathLinksProvider'
import {
  ConversationFind,
  keyForConversation,
  useFindShortcut,
  type FoldedMatches,
} from '@/features/search/ConversationFind'
import { CYCLE_VIEW_MODE, TOGGLE_SIDE_CHAT } from '@/features/layout/shortcuts'
import { ViewModeButton, VIEW_MODE_META } from './ViewModeButton'
import { cycleViewMode, useViewMode, type ViewMode } from './viewMode'
import { expandItems } from '@/features/search/expand'
import { countFull, foldedMatches } from './live/foldedText'
import { fullItem } from './live/itemBody'
import { RetryStatus } from './live/RetryStatus'
import { RateLimitCard } from './live/RateLimitCard'
import { ReconnectStatus } from './live/ReconnectStatus'
import { MessageActionsContext } from './live/MessageActions'
import { useBranchActions } from './useBranchActions'
import { CheckpointWarmup, CheckpointsContext, useCheckpointsState } from './undo/checkpoints'
import { CheckpointPanel } from './undo/CheckpointPanel'
import { RewindUndoBar, ReviewCommentsBar } from './ComposerNotices'
import { SideChatPanel } from './sidechat/SideChatPanel'
import { sideRefusal } from './sidechat/store'
import { clearReviewComments, reviewMessage, useReviewComments } from './reviewComments'
import { DiffCommentsContext } from '@/ui/code/diffComments'
import { TurnCommentsContext, type TurnCommentsValue } from './TurnCommentCards'
import { openTurnComment, turnOfItem } from './turnComments'
import { paneActions, usePaneState } from '@/features/panes/store'
import { focusedTab } from '@/features/panes/tree'
import { useAppMode } from '@/features/coding/mode'
import { dockTarget } from '@/features/panel/overview/overviewModel'
import { useOverviewSlot } from '@/features/panel/overviewSlot'
import { openRightTab, useActivePanelTab } from '@/features/panel/workspaceStore'
import { isDemo, sessionDiff } from '@/data'
import { demo } from '@/data/demo'
import { cn, useToast } from '@/ui'
import { ENGINES } from '@pixelsky/protocol'
import {
  bridge,
  demoAnswer,
  isLive,
  useComposerController,
  useDemoQueueController,
  useSession,
  useStatusBar,
} from '@/features/engine'
import './conversation.css'
import { TranscriptMenu } from './contextMenu/TranscriptMenu'
import { openExport } from '@/features/export/store'
import { ImageSessionContext } from './attachments/imageSource'

export interface SessionViewProps {
  /** 当前会话，null 表示新会话（显示欢迎页） */
  sessionId: string | null
  title: string
  sidebarOpen: boolean
  panelOpen: boolean
  onToggleSidebar: () => void
  onTogglePanel: () => void
  /** 欢迎页发出第一条消息、创建了会话后切过去 */
  onOpenSession?: (id: string) => void
  /** 放在多窗格里：不画顶部栏（顶部栏由窗格区统一画，跟随当前窗格），也不设最小宽度（docs/ui/multi-pane.md） */
  embedded?: boolean
  /** 未发送的新会话与演示会话也按标签独立保留草稿。 */
  draftKey?: string
}

/** 顶部栏要不要显示会话操作（更多、编辑器、提交、终端、改动统计）：多窗格时顶部栏在窗格外面，用这个保持和单窗格一致 */
export function useHeaderActions(sessionId: string | null): boolean {
  const snapshot = useSession(isLive ? sessionId : null)
  if (!isLive) return sessionId !== null && (hasConversation || sessionDiff !== null)
  return !!snapshot && snapshot.items.length > 0
}

/** 会话主区：顶部栏 + 可滚动对话流 + 固定在底部的输入框；没有对话时显示欢迎页 */
export function SessionView(props: SessionViewProps) {
  useI18n()
  // 演示模式里的对话展示用真实会话的视图（docs/ui/demo-conversation.md）
  const live = isLive || (isDemo && !!props.sessionId && props.sessionId in demo().conversations.snapshots)
  return live ? <LiveSessionView {...props} /> : <DemoSessionView {...props} />
}

/** 演示模式：照参考图的静态内容（mock/demo.ts） */
function DemoSessionView({
  sessionId,
  title,
  sidebarOpen,
  panelOpen,
  onToggleSidebar,
  onTogglePanel,
  embedded,
  draftKey,
}: SessionViewProps) {
  useI18n()
  const showConversation = sessionId !== null && hasConversation
  return (
    <main
      className={cn('conversation-view flex flex-1 flex-col bg-app', embedded ? 'min-h-0 min-w-0' : 'min-w-[464px]')}
    >
      {!embedded && (
        <SessionHeader
          title={title}
          showActions={showConversation || (sessionId !== null && sessionDiff !== null)}
          sidebarOpen={sidebarOpen}
          panelOpen={panelOpen}
          onToggleSidebar={onToggleSidebar}
          onTogglePanel={onTogglePanel}
        />
      )}
      {showConversation ? (
        <>
          <Transcript sessionId={sessionId} />
          <ComposerArea>
            <Composer draftKey={draftKey} />
          </ComposerArea>
        </>
      ) : (
        <WelcomeView draftKey={draftKey} />
      )}
    </main>
  )
}

/** 真实会话：数据来自引擎（docs/engines.md §11、§15） */
function LiveSessionView({
  sessionId,
  title,
  sidebarOpen,
  panelOpen,
  onToggleSidebar,
  onTogglePanel,
  onOpenSession,
  embedded,
  draftKey,
}: SessionViewProps) {
  useI18n()
  const snapshot = useSession(sessionId)
  const terminals = useTerminalStore()
  const record = snapshot?.record
  const composer = useComposerController(sessionId, onOpenSession, draftKey)
  const demoQueue = useDemoQueueController(composer ? null : sessionId)
  const status = useStatusBar(sessionId, draftKey)
  // 智能体追踪面板：null 表示关着；focus 是定位到的智能体（null 是总览）
  const [trace, setTrace] = useState<{ focus: string | null } | null>(null)
  useEffect(() => setTrace(null), [sessionId])
  // 对话内搜索（Ctrl+F）：token 每按一次加一，已经打开时重新聚焦（docs/ui/content-highlight.md §2 E）
  const mainRef = useRef<HTMLElement>(null)
  // 界面 ⇄ 终端（TUI，docs/ui/tui-toggle.md）
  const tui = useTuiToggle(sessionId, mainRef)
  const terminalUi = useOptionalTerminalUi()
  const tuiMode = tui?.mode ?? 'ui'
  const tuiTerminal =
    tui?.terminalId && !isDemoTuiTerminal(tui.terminalId)
      ? (terminals.terminals.find(t => t.id === tui.terminalId) ?? null)
      : null
  const tuiBusy = tui?.busy ?? false
  const tuiConfirm = tui?.confirm ?? false
  const switchTui = tui?.onChange ?? (() => {})
  // 演示模式的假终端在 mock/ 里，经演示数据拿（真实模式不打包它）
  const DemoTui = isDemo ? demo().tuiPanel : undefined
  const [find, setFind] = useState<number | null>(null)
  useEffect(() => setFind(null), [sessionId])
  useFindShortcut(mainRef, !!sessionId, () => setFind(n => (n ?? 0) + 1))
  // 查看模式（docs/ui/view-mode.md §4、§6）：Ctrl+O 循环；只有触发的窗格弹提示，连按就地更新
  const [modeToast, setModeToast] = useState<{ mode: ViewMode; token: number } | null>(null)
  const showModeToast = useCallback(
    (mode: ViewMode) => setModeToast(prev => ({ mode, token: (prev?.token ?? 0) + 1 })),
    [],
  )
  useEffect(() => {
    if (!modeToast) return
    const timer = setTimeout(() => setModeToast(null), 1500)
    return () => clearTimeout(timer)
  }, [modeToast])
  useEffect(() => {
    if (!sessionId || tuiMode === 'terminal') return
    const onKey = (e: KeyboardEvent): void => {
      const el = mainRef.current
      if (!el || !CYCLE_VIEW_MODE.match(e) || !keyForConversation(el, e)) return
      e.preventDefault()
      showModeToast(cycleViewMode())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionId, tuiMode, showModeToast])
  const viewMode = useViewMode().mode
  // 模式不是普通、这个会话没开思考摘要：明说思考只显示用时（§4 第 2 条），引擎支持时给「下一轮开启」
  const thinkingNote =
    viewMode !== 'normal' && composer && !composer.thinkingSummaries ? (
      <div data-view-mode-note className="conversation-message flex items-center gap-2 px-2 text-meta text-fg-muted">
        <span>{tr(composer.thinkingSupported ? 'viewMode.noThinking' : 'viewMode.noThinkingUnsupported')}</span>
        {composer.thinkingSupported && (
          <button
            type="button"
            onClick={() => composer.setThinkingSummaries(true)}
            className="rounded-md px-1.5 py-0.5 text-accent-fg hover:bg-hover"
          >
            {tr('viewMode.enableThinking')}
          </button>
        )}
      </div>
    ) : null
  // 折叠着的条目里的命中（docs/ui/conversation-ux.md §2.6）：哪些折叠着看页面上的 data-fold，文字从会话数据里取
  const items = snapshot?.items
  // 截过的长输出（cutChars）：先按截过的数，再逐条取完整内容补算（只记数字），算完让搜索框重数；换了词、关了搜索就停
  const counting = useRef<{ term: string } | null>(null)
  const [fullCounted, setFullCounted] = useState(0)
  const finding = find !== null
  useEffect(
    () => () => {
      counting.current = null
    },
    [finding],
  )
  const folded = useCallback<FoldedMatches>(
    term => {
      const stream = mainRef.current?.querySelector('[data-conversation-stream]')
      if (!stream || !items || !sessionId) return { count: 0, expand: () => {} }
      const closed = new Set<string>(),
        hidden = new Set<string>()
      for (const el of stream.querySelectorAll('[data-fold="closed"]')) {
        // 收起的执行块：里面的条目整条不在页面上（docs/ui/conversation-concise.md §3）
        for (const id of el.getAttribute('data-fold-items')?.split(' ') ?? []) if (id) hidden.add(id)
        const id = el.closest<HTMLElement>('[data-search-item]')?.dataset.searchItem
        if (id) closed.add(id)
      }
      // 展开着但限高只画了前几行的（docs/ui/view-mode.md §13 A）
      const clamped = new Set<string>()
      for (const el of stream.querySelectorAll('[data-clamped]')) {
        const id = el.closest<HTMLElement>('[data-search-item]')?.dataset.searchItem
        if (id) clamped.add(id)
      }
      const { ids, count, missing } = foldedMatches(items, [term], closed, hidden, clamped)
      if (missing.length && counting.current?.term !== term) {
        const job = { term }
        counting.current = job
        void (async () => {
          for (const item of missing) {
            if (counting.current !== job) return
            countFull(item, await fullItem(item, sessionId), [term])
          }
          if (counting.current !== job) return
          counting.current = null
          setFullCounted(n => n + 1)
        })()
      }
      return { count, expand: () => expandItems(sessionId, ids) }
    },
    // fullCounted 变了：补算完了，换一个函数让搜索框重数
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, sessionId, fullCounted],
  )

  const runs = snapshot?.runs
  const openTrace = useCallback(
    (target?: TraceTarget) => {
      let focus = target?.agentId ?? null
      if (!focus && target?.toolUseId && runs) {
        // Agent 工具调用 → 它派出的子智能体；Workflow 工具调用 → 总览
        focus = runs.agents.find(a => a.toolUseId === target.toolUseId)?.id ?? null
      }
      setTrace({ focus })
    },
    [runs],
  )
  const hasRuns = !!runs && (runs.workflows.length > 0 || runs.agents.length > 0)
  const tasks = snapshot?.tasks ?? []
  // 计划和子智能体在右上角的进度卡片里；卡片显示时「智能体活动」也放进卡片（docs/ui/progress-card.md）
  // 右栏选中概况时卡片停靠进去（docs/ui/desktop-parity.md §3.1），对话区不留第二份。代码模式的 panelOpen 总是 false
  const appMode = useAppMode()
  const panelTab = useActivePanelTab()
  const focused = usePaneState(s => focusedTab(s.layout) === sessionId)
  const overviewSlot = useOverviewSlot()
  const dockTo = dockTarget({ panelOpen, focused, tab: panelTab, slot: overviewSlot })
  const docked = !!dockTo
  const fullProgress = useProgress(snapshot, docked)
  // 极简模式：计划写在对话末尾，浮动卡片只剩子智能体（docs/ui/minimal-mode.md §3）
  const minimal = useMinimal()
  const inlinePlan = minimal && !!snapshot && snapshot.state !== 'idle' ? fullProgress.plan : null
  const progress =
    minimal && fullProgress.plan
      ? { ...fullProgress, plan: null, visible: fullProgress.visible && fullProgress.agents.length > 0 }
      : fullProgress
  const traceInStrips = hasRuns && !progress.visible
  // 保留模式：主智能体停了、后台子智能体还在跑（docs/ui/subagent-stop.md §S4）
  const kept = useMemo(() => keptAgents(snapshot), [snapshot])
  // 对话里等审批的工具行标「等你决定」，点了跳到下面的审批（docs/ui/approval-stack.md）
  const pendingApprovals = snapshot?.pending
  const approvalWait = useMemo(() => {
    if (!sessionId || !pendingApprovals?.length) return null
    const byItem = new Map<string, string>()
    for (const r of pendingApprovals) if (r.itemId) byItem.set(r.itemId, r.requestId)
    return byItem.size ? { sessionId, byItem } : null
  }, [sessionId, pendingApprovals])
  const canStopAgents = !!snapshot && ENGINES[snapshot.record.engine].caps.backgroundTasks
  const [expandToken, setExpandToken] = useState(0)
  const expandSeen = useRef(0)
  const showStrips = !!sessionId && (tasks.length > 0 || traceInStrips)
  // 后台任务条的高度：进度卡片放到它下面（docs/ui/conversation-concise.md §3 F）
  const strips = useRef<HTMLDivElement>(null)
  const [stripsHeight, setStripsHeight] = useState(0)
  useLayoutEffect(() => {
    const el = strips.current
    if (!showStrips || !el) {
      setStripsHeight(0)
      return
    }
    const measure = (): void => setStripsHeight(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showStrips])

  // 回退（含代码、撤销）、分叉、旁聊（docs/ui/rewind-fork-sidechat.md）
  const composerKey = draftKey ?? sessionId ?? ''
  // 给运行胶囊：对象要稳定，流式输出时 SessionView 一直重画，胶囊不跟着
  const pillRef = useMemo(() => (sessionId ? { sessionId } : null), [sessionId])
  // 对话检查点：改动卡片按文件撤回、检查点面板（docs/ui/undo-changes.md）
  const checkpoints = useCheckpointsState(sessionId, snapshot)
  const branch = useBranchActions(sessionId, snapshot, composerKey, checkpoints)
  const [checkpointOpen, setCheckpointOpen] = useState(false)
  useEffect(() => setCheckpointOpen(false), [sessionId])
  const checkpointAnchor = useRef<HTMLButtonElement>(null)
  const engineCaps = snapshot ? ENGINES[snapshot.record.engine]?.caps : undefined
  // 旁聊面板：null 关着；token 每次从 /btw 打开加一
  // draft：文字只放进旁聊输入框，不直接发（对话区右键「在旁聊里问」）
  const [side, setSide] = useState<{ text: string; token: number; draft?: boolean } | null>(null)
  useEffect(() => setSide(null), [sessionId])
  const openSide = useCallback((text = '', draft = false) => {
    setTrace(null)
    setSide(prev => ({ text, token: (prev?.token ?? 0) + 1, draft }))
  }, [])
  const sideAvailable = !!branch.sideChat && tuiMode !== 'terminal'
  const sideOpen = side !== null
  useEffect(() => {
    if (!sideAvailable) return
    const onKey = (e: KeyboardEvent): void => {
      const el = mainRef.current
      if (!el || !TOGGLE_SIDE_CHAT.match(e) || !keyForConversation(el, e)) return
      e.preventDefault()
      if (sideOpen) setSide(null)
      else openSide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sideAvailable, sideOpen, openSide])
  // 对话区右键菜单挂在对话区外层
  const body = useRef<HTMLDivElement>(null)
  // 代码评论（§4）
  const review = useReviewComments(sessionId)
  // 会话评论（docs/ui/channels-collab-v2.md §7）：条目、输入框、是否在忙都用的时候现读。
  // 输入框控制器每来一个字都换新对象，放进依赖会让对话里每一条跟着重新渲染
  const latest = useRef(snapshot)
  latest.current = snapshot
  const composerRef = useRef(composer)
  composerRef.current = composer
  const toast = useToast()
  // 计划卡要会话层做的事（docs/ui/plan-review.md §3）
  const planActions: PlanActions | undefined = composer
    ? {
        // 「压缩上下文后执行」：卡片已经打回了计划；离开「只规划」，排上 /compact 和「按计划执行」，按顺序跑
        compact: snapshot?.flags.compactAvailable
          ? async plan => {
              const c = composerRef.current
              if (!c) return
              try {
                if (c.permissionMode === 'plan')
                  c.setPermissionMode(c.permissionModes.includes('ask') ? 'ask' : c.defaultPermissionMode)
                await c.submit('/compact')
                await c.submit(`${tr('plan.runApproved')}\n\n${plan}`)
              } catch (e) {
                toast(translateMessage((e as Error).message))
              }
            }
          : undefined,
        // 像素星空打回计划时只回「继续完善」、不带话（它会问要改什么）：意见作为下一条消息发
        feedback:
          snapshot?.record.engine === 'pixel'
            ? async message => {
                try {
                  await composerRef.current?.submit(message)
                } catch (e) {
                  toast(translateMessage((e as Error).message))
                }
              }
            : undefined,
      }
    : undefined
  const canHandoff = !!composer
  const turnComments = useMemo<TurnCommentsValue | null>(
    () =>
      sessionId
        ? {
            sessionId,
            title: title ?? '',
            items: () => latest.current?.items ?? [],
            handoff: canHandoff
              ? async text => {
                  const s = latest.current
                  const queued = !!s && (s.state !== 'idle' || s.queue.length > 0)
                  if (!composerRef.current) throw new Error(tr('turnComment.notReady'))
                  await composerRef.current.submit(text)
                  return queued ? 'queued' : 'started'
                }
              : null,
          }
        : null,
    [sessionId, title, canHandoff],
  )
  const forkedFrom = snapshot?.record.forkedFrom ?? null
  // 开分支开出的会话（docs/ui/branch-merge.md §4）：顶部横条代替「分叉自」，带过来的部分后面一行「分支从这里开始」
  const branchStart = useMemo(() => {
    const b = record?.branch
    if (!b || !items) return null
    const from = b.startAfter ? items.findIndex(i => i.id === b.startAfter) + 1 : 0
    if (from <= 0 && b.startAfter) return null
    return items.slice(from).find(i => i.kind === 'user')?.id ?? null
  }, [record?.branch, items])
  const readOnly = branchReadOnly(record)
  // 打开追踪面板时对话区的卡片让开；停靠的不在对话区，不用让
  const [subagentSettings, setSubagentSettings] = useState(false)
  const progressCard =
    sessionId && progress.visible && (docked || !trace) ? (
      <ProgressCard
        key={sessionId}
        progress={progress}
        belowFind={find !== null}
        offset={stripsHeight}
        onOpenTrace={hasRuns ? () => openTrace() : undefined}
        onStopAgents={canStopAgents ? ids => stopAgents(sessionId, ids) : undefined}
        expandToken={expandToken}
        expandSeen={expandSeen}
        docked={docked}
        onConfigure={snapshot?.record.engine === 'pixel' ? () => setSubagentSettings(true) : undefined}
        overrideCount={record?.subagentOverrides?.length ?? 0}
        onDock={appMode === 'code' ? undefined : () => openRightTab('overview')}
      />
    ) : null

  return (
    <PathLinksProvider sessionId={sessionId}>
      <TurnCommentsContext.Provider value={turnComments}>
        <DiffCommentsContext.Provider value={review.api}>
          <TraceContext.Provider value={sessionId ? openTrace : null}>
            <main
              ref={mainRef}
              className={cn(
                'conversation-view relative flex flex-1 flex-col bg-app',
                embedded ? 'min-h-0 min-w-0' : 'min-w-[464px]',
              )}
            >
              {!embedded && (
                <SessionHeader
                  title={title}
                  showActions={!!snapshot && snapshot.items.length > 0}
                  sidebarOpen={sidebarOpen}
                  panelOpen={panelOpen}
                  onToggleSidebar={onToggleSidebar}
                  onTogglePanel={onTogglePanel}
                  sessionId={sessionId}
                  tui={
                    tui
                      ? {
                          mode: tui.mode,
                          running: tui.running,
                          disabledReason: tui.disabledReason,
                          onChange: tui.onChange,
                        }
                      : null
                  }
                />
              )}
              {modeToast && tuiMode !== 'terminal' && (
                <div
                  key={modeToast.token}
                  role="status"
                  aria-live="polite"
                  data-view-mode-toast
                  className="pointer-events-none absolute top-12 left-1/2 z-20 -translate-x-1/2 rounded-md border border-line-card bg-popover px-3 py-1.5 text-meta text-fg-secondary shadow-popover motion-safe:animate-in motion-safe:fade-in"
                >
                  {tr('viewMode.toast', {
                    mode: tr(VIEW_MODE_META[modeToast.mode].label),
                    hint: tr(VIEW_MODE_META[modeToast.mode].hint),
                    key: CYCLE_VIEW_MODE.label,
                  })}
                </div>
              )}
              {sessionId && tuiMode === 'terminal' ? (
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {isDemoTuiTerminal(tui?.terminalId) && DemoTui ? (
                    <DemoTui
                      cwd={record?.cwd}
                      engineSessionId={record?.engineSessionId}
                      items={snapshot?.items}
                      onBack={() => switchTui('ui')}
                    />
                  ) : (
                    <>
                      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-meta text-fg-muted">
                        <span className="min-w-0 flex-1 truncate">{tr('session.tui.bannerShort')}</span>
                        <button
                          type="button"
                          className="press shrink-0 rounded px-1.5 text-accent-fg hover:bg-hover"
                          onClick={() => switchTui('ui')}
                        >
                          {tr('session.tui.switchBack')}
                        </button>
                      </div>
                      {/* TerminalView 的根是 flex-1：这层要是 flex 容器，不然终端高度跟着内容走、卡在起步的 24 行 */}
                      <div className="flex min-h-0 flex-1 flex-col">
                        {tuiTerminal ? (
                          <TerminalView
                            record={tuiTerminal}
                            visible
                            // 粘贴走终端面板同一套（多行先确认、超长拒绝）；搜索条长在右侧终端面板里，这里不开
                            onPaste={(id, text) => terminalUi?.paste(id, text)}
                            onFind={() => {}}
                            onCycle={() => {}}
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-ui text-fg-muted">
                            {tr('session.tui.opening')}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {tuiBusy && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-app/70 text-ui text-fg-muted">
                      {tr('session.tui.switching')}
                    </div>
                  )}
                  {tuiConfirm && tui && (
                    <ConfirmDialog
                      title={tr('session.tui.runningTitle')}
                      description={null}
                      busy={tuiBusy}
                      confirmLabel={tr('session.tui.forceClose')}
                      cancelLabel={tr('session.tui.stay')}
                      onConfirm={() => tui.forceClose()}
                      onCancel={() => tui.setConfirm(false)}
                    />
                  )}
                </div>
              ) : sessionId ? (
                <>
                  {record?.branch && <BranchBanner record={record} />}
                  <div ref={body} className="conversation-body relative flex min-h-0 flex-1 flex-col overflow-hidden">
                    {/* 要是对话区的直接子元素，放最前：收起时那一条占布局、排在最上面；搜索条靠 CSS 的 :has(> …) 避让 */}
                    {/* portal 保留 React 上下文：停靠后点子智能体照样走 TraceContext */}
                    {progressCard && dockTo ? createPortal(progressCard, dockTo) : progressCard}
                    {subagentSettings && snapshot?.record.engine === 'pixel' && (
                      <SubagentSettingsDialog
                        key={snapshot.record.id}
                        snapshot={snapshot}
                        onClose={() => setSubagentSettings(false)}
                      />
                    )}
                    {showStrips && (
                      <div
                        ref={strips}
                        className="conversation-inset conversation-reading conversation-reading-strips shrink-0 pt-3"
                      >
                        <div className="conversation-message flex flex-col gap-2">
                          {traceInStrips && (
                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() => openTrace()}
                                className="press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-meta text-fg-muted hover:bg-hover hover:text-fg"
                              >
                                <Bot size={13} strokeWidth={1.75} />
                                {tr('session.live.AgentTracePanel.agentActivity')}{' '}
                              </button>
                            </div>
                          )}
                          <TaskStrip sessionId={sessionId} tasks={tasks} />
                        </div>
                      </div>
                    )}
                    {/* 对话里的图片不带数据，按会话 id 按需取原图（attachments/imageSource.ts） */}
                    <ImageSessionContext.Provider value={sessionId}>
                      <CheckpointsContext.Provider value={checkpoints}>
                        <MessageActionsContext.Provider value={branch.messageActions}>
                          <ApprovalWaitContext.Provider value={approvalWait}>
                            <LiveTranscript
                              snapshot={snapshot}
                              footer={
                                // shortcut: 规格写在最后一轮的过程上方，这里放在对话末尾（离输入框近，不用改分块），有人觉得不明显再挪
                                (inlinePlan || thinkingNote) && (
                                  <>
                                    {thinkingNote}
                                    {inlinePlan && <InlinePlan plan={inlinePlan} working={fullProgress.working} />}
                                  </>
                                )
                              }
                              divider={branchStart ? { beforeItemId: branchStart, node: <BranchStartDivider /> } : null}
                              header={
                                forkedFrom &&
                                !record?.branch && (
                                  <button
                                    type="button"
                                    data-forked-from
                                    onClick={() => paneActions.open(forkedFrom.sessionId)}
                                    className="conversation-message press inline-flex items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 text-meta text-fg-muted hover:bg-hover hover:text-fg"
                                  >
                                    <GitBranch size={12} strokeWidth={1.75} />
                                    {tr('fork.from', { title: forkedFrom.title })}
                                  </button>
                                )
                              }
                            />
                          </ApprovalWaitContext.Provider>
                        </MessageActionsContext.Provider>
                      </CheckpointsContext.Provider>
                    </ImageSessionContext.Provider>
                    {find !== null && (
                      <ConversationFind
                        root={mainRef}
                        focusToken={find}
                        onClose={() => setFind(null)}
                        folded={folded}
                      />
                    )}
                    <TranscriptMenu
                      root={body}
                      composerKey={composerDraftKey(draftKey, composer)}
                      cwd={snapshot?.record.cwd ?? null}
                      items={snapshot?.items}
                      onFind={() => setFind(n => (n ?? 0) + 1)}
                      commentOn={turnComments ? itemId => commentOn(turnComments, itemId) : null}
                      onExportTurn={sessionId ? itemId => openExport({ sessionId, itemId }) : null}
                      onAskSide={branch.sideChat ? text => openSide(text, true) : null}
                      sideDisabled={branch.sideChat?.disabledReason ?? null}
                    />
                  </div>
                  <ComposerArea>
                    {kept.length > 0 && (
                      <KeptAgentsStrip
                        count={kept.length}
                        onView={() => {
                          setTrace(null)
                          fullProgress.reveal()
                          setExpandToken(n => n + 1)
                          if (fullProgress.agents.length === 0) openTrace()
                        }}
                        onStopAll={() =>
                          void stopAgents(
                            sessionId,
                            kept.map(k => k.id),
                          )
                        }
                      />
                    )}
                    <RetryStatus sessionId={sessionId} retry={snapshot?.retry} />
                    <ReconnectStatus sessionId={sessionId} queue={snapshot?.queue} paused={!!snapshot?.queuePaused} />
                    <RateLimitCard
                      sessionId={sessionId}
                      queue={snapshot?.queue}
                      paused={!!snapshot?.queuePaused}
                      engine={snapshot?.record.engine}
                    />
                    {snapshot && (
                      <ApprovalStack
                        key={`approvals:${sessionId}`}
                        sessionId={sessionId}
                        pending={snapshot.pending}
                        cwd={snapshot.record.cwd ?? null}
                        bounds={mainRef}
                        onAnswer={(req, d) =>
                          bridge ? bridge.answer(sessionId, req.requestId, d) : demoAnswer(sessionId, req.requestId, d)
                        }
                        onEscape={() => focusComposer(composerDraftKey(draftKey, composer))}
                        planActions={planActions}
                      />
                    )}
                    {branch.undo && (
                      <RewindUndoBar done={branch.undo} onUndo={branch.undoRewind} onDismiss={branch.dismissUndo} />
                    )}
                    <ReviewCommentsBar
                      count={review.comments.length}
                      onClear={() => clearReviewComments(sessionId)}
                      onHandoff={async () => {
                        const queued = !!snapshot && (snapshot.state !== 'idle' || snapshot.queue.length > 0)
                        if (composer) await composer.submit(reviewMessage(review.comments))
                        clearReviewComments(sessionId)
                        return queued ? 'queued' : 'started'
                      }}
                    />
                    {record?.pendingMerge && !readOnly && (
                      <PendingMergeBar sessionId={sessionId} pending={record.pendingMerge} />
                    )}
                    {readOnly ? (
                      <BranchReadOnlyBar />
                    ) : (
                      <Composer
                        key={sessionId}
                        live={composer}
                        demoQueue={demoQueue}
                        status={status}
                        draftKey={draftKey}
                        autoFocus
                        onSideQuestion={
                          branch.sideChat
                            ? q => {
                                const refused = sideRefusal(sessionId, branch.sideChat!.disabledReason)
                                if (!refused) openSide(q)
                                return refused
                              }
                            : undefined
                        }
                        statusExtra={
                          <>
                            {snapshot && (
                              <RunPills
                                projectId={snapshot.record.projectId}
                                cwd={snapshot.record.cwd}
                                panelOpen={panelOpen}
                                browserRef={pillRef}
                              />
                            )}
                            {checkpoints && snapshot && (
                              <button
                                ref={checkpointAnchor}
                                type="button"
                                data-checkpoint-toggle
                                aria-pressed={checkpointOpen}
                                aria-label={tr('checkpoint.button')}
                                title={tr('checkpoint.hint')}
                                onClick={() => setCheckpointOpen(v => !v)}
                                className={cn(
                                  'press inline-flex items-center gap-1 rounded px-1 hover:bg-hover hover:text-fg',
                                  checkpointOpen && 'text-fg',
                                )}
                              >
                                <History size={13} strokeWidth={1.5} />
                                <span data-composer-extra-label>{tr('checkpoint.button')}</span>
                              </button>
                            )}
                            <ViewModeButton onPick={showModeToast} />
                            {branch.sideChat && (
                              <button
                                type="button"
                                data-side-chat-toggle
                                aria-pressed={side !== null}
                                aria-label={tr('side.title')}
                                title={tr('side.hint')}
                                onClick={() => (side ? setSide(null) : openSide())}
                                className={cn(
                                  'press inline-flex items-center gap-1 rounded px-1 hover:bg-hover hover:text-fg',
                                  side && 'text-fg',
                                )}
                              >
                                <MessagesSquare size={13} strokeWidth={1.5} />
                                <span data-composer-extra-label>{tr('side.title')}</span>
                              </button>
                            )}
                          </>
                        }
                      />
                    )}
                  </ComposerArea>
                  {checkpoints && <CheckpointWarmup sessionId={sessionId} draftKey={composerKey} />}
                  {checkpoints && snapshot && checkpointOpen && (
                    <CheckpointPanel
                      open
                      anchor={checkpointAnchor}
                      snapshot={snapshot}
                      checkpoints={checkpoints}
                      canRewindConversation={!!engineCaps?.rewind}
                      engineRewindCode={engineCaps?.rewindCode === true}
                      preview={item =>
                        bridge
                          ? bridge.rewindPreview(sessionId, item.id)
                          : Promise.resolve(
                              demo().conversations.rewindPreview(
                                sessionId,
                                item.id,
                                snapshot.items.find(i => i.kind === 'user')?.id ?? null,
                              ),
                            )
                      }
                      rewind={branch.rewind}
                      onClose={() => setCheckpointOpen(false)}
                    />
                  )}
                  {side && !trace && branch.sideChat && (
                    <SideChatPanel
                      sessionId={sessionId}
                      ask={branch.sideChat.ask}
                      cancel={branch.sideChat.cancel}
                      disabledReason={branch.sideChat.disabledReason}
                      initialQuestion={side.text ? side : null}
                      belowHeader={!embedded}
                      onClose={() => setSide(null)}
                    />
                  )}
                  {trace && runs && (
                    <AgentTracePanel
                      sessionId={sessionId}
                      runs={runs}
                      focus={trace.focus}
                      onFocus={focus => setTrace({ focus })}
                      onClose={() => setTrace(null)}
                      belowHeader={!embedded}
                    />
                  )}
                </>
              ) : (
                <WelcomeView live={composer} status={status} draftKey={draftKey} />
              )}
            </main>
          </TraceContext.Provider>
        </DiffCommentsContext.Provider>
      </TurnCommentsContext.Provider>
    </PathLinksProvider>
  )
}

/** 右键「评论这段 / 这一轮」：这条所在的一轮还没做完时为 null（菜单里置灰） */
function commentOn(ctx: TurnCommentsValue, itemId: string): ((quote: string) => void) | null {
  const turn = turnOfItem(ctx.items(), itemId)
  return turn ? quote => openTurnComment({ sessionId: ctx.sessionId, ...turn, quote }) : null
}

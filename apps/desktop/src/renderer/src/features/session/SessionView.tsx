import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Bot, GitBranch, MessagesSquare } from 'lucide-react'
import { SessionHeader } from './SessionHeader'
import { Transcript } from './Transcript'
import { Composer, composerDraftKey } from './Composer'
import { ComposerArea } from './ComposerArea'
import { WelcomeView } from './WelcomeView'
import { hasConversation } from './conversation'
import { LiveTranscript } from './live/LiveTranscript'
import { ApprovalStack } from './live/approvals/ApprovalStack'
import { ApprovalWaitContext } from './live/approvals/focus'
import { focusComposer } from './composerTarget'
import { AgentTracePanel } from './live/AgentTracePanel'
import { KeptAgentsStrip, TaskStrip } from './live/SessionStrips'
import { keptAgents } from './live/subagentStop'
import { stopAgents } from './live/stopAgents'
import { ProgressCard, useProgress } from './live/ProgressCard'
import { InlinePlan } from './live/InlinePlan'
import { useMinimal } from '@/features/appearance/ThemeProvider'
import { TraceContext, type TraceTarget } from './live/trace'
import { PathLinksProvider } from '@/features/files/PathLinksProvider'
import { ConversationFind, useFindShortcut, type FoldedMatches } from '@/features/search/ConversationFind'
import { expandItems } from '@/features/search/expand'
import { foldedMatches } from './live/foldedText'
import { RetryStatus } from './live/RetryStatus'
import { ReconnectStatus } from './live/ReconnectStatus'
import { MessageActionsContext } from './live/MessageActions'
import { useBranchActions } from './useBranchActions'
import { RewindUndoBar, ReviewCommentsBar } from './ComposerNotices'
import { SideChatPanel } from './sidechat/SideChatPanel'
import { clearReviewComments, reviewMessage, useReviewComments } from './reviewComments'
import { DiffCommentsContext } from '@/ui/code/diffComments'
import { paneActions } from '@/features/panes/store'
import { isDemo, sessionDiff } from '@/data'
import { demo } from '@/data/demo'
import { cn } from '@/ui'
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
  const composer = useComposerController(sessionId, onOpenSession, draftKey)
  const demoQueue = useDemoQueueController(composer ? null : sessionId)
  const status = useStatusBar(sessionId, draftKey)
  // 智能体追踪面板：null 表示关着；focus 是定位到的智能体（null 是总览）
  const [trace, setTrace] = useState<{ focus: string | null } | null>(null)
  useEffect(() => setTrace(null), [sessionId])
  // 对话内搜索（Ctrl+F）：token 每按一次加一，已经打开时重新聚焦（docs/ui/content-highlight.md §2 E）
  const mainRef = useRef<HTMLElement>(null)
  const [find, setFind] = useState<number | null>(null)
  useEffect(() => setFind(null), [sessionId])
  useFindShortcut(mainRef, !!sessionId, () => setFind(n => (n ?? 0) + 1))
  // 折叠着的条目里的命中（docs/ui/conversation-ux.md §2.6）：哪些折叠着看页面上的 data-fold，文字从会话数据里取
  const items = snapshot?.items
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
      const { ids, count } = foldedMatches(items, [term], closed, hidden)
      return { count, expand: () => expandItems(sessionId, ids) }
    },
    [items, sessionId],
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
  const fullProgress = useProgress(snapshot)
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
  const branch = useBranchActions(sessionId, snapshot, composerKey)
  // 旁聊面板：null 关着；token 每次从 /btw 打开加一
  // draft：文字只放进旁聊输入框，不直接发（对话区右键「在旁聊里问」）
  const [side, setSide] = useState<{ text: string; token: number; draft?: boolean } | null>(null)
  useEffect(() => setSide(null), [sessionId])
  const openSide = useCallback((text = '', draft = false) => {
    setTrace(null)
    setSide(prev => ({ text, token: (prev?.token ?? 0) + 1, draft }))
  }, [])
  // 对话区右键菜单挂在对话区外层
  const body = useRef<HTMLDivElement>(null)
  // 代码评论（§4）
  const review = useReviewComments(sessionId)
  const forkedFrom = snapshot?.record.forkedFrom ?? null

  return (
    <PathLinksProvider sessionId={sessionId}>
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
              />
            )}
            {sessionId ? (
              <>
                <div ref={body} className="conversation-body relative flex min-h-0 flex-1 flex-col overflow-hidden">
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
                  <MessageActionsContext.Provider value={branch.messageActions}>
                    <ApprovalWaitContext.Provider value={approvalWait}>
                      <LiveTranscript
                        snapshot={snapshot}
                        footer={inlinePlan && <InlinePlan plan={inlinePlan} working={fullProgress.working} />}
                        header={
                          forkedFrom && (
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
                  {progress.visible && !trace && (
                    <ProgressCard
                      key={sessionId}
                      progress={progress}
                      belowFind={find !== null}
                      offset={stripsHeight}
                      onOpenTrace={hasRuns ? () => openTrace() : undefined}
                      onStopAgents={canStopAgents ? ids => stopAgents(sessionId, ids) : undefined}
                      expandToken={expandToken}
                    />
                  )}
                  {find !== null && (
                    <ConversationFind root={mainRef} focusToken={find} onClose={() => setFind(null)} folded={folded} />
                  )}
                  <TranscriptMenu
                    root={body}
                    composerKey={composerDraftKey(draftKey, composer)}
                    cwd={snapshot?.record.cwd ?? null}
                    items={snapshot?.items}
                    onFind={() => setFind(n => (n ?? 0) + 1)}
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
                  <Composer
                    key={sessionId}
                    live={composer}
                    demoQueue={demoQueue}
                    status={status}
                    draftKey={draftKey}
                    autoFocus
                    onSideQuestion={branch.sideChat ? q => openSide(q) : undefined}
                    statusExtra={
                      branch.sideChat && (
                        <button
                          type="button"
                          data-side-chat-toggle
                          aria-pressed={side !== null}
                          title={tr('side.hint')}
                          onClick={() => (side ? setSide(null) : openSide())}
                          className={cn(
                            'press inline-flex items-center gap-1 rounded px-1 hover:bg-hover hover:text-fg',
                            side && 'text-fg',
                          )}
                        >
                          <MessagesSquare size={13} strokeWidth={1.5} />
                          {tr('side.title')}
                        </button>
                      )
                    }
                  />
                </ComposerArea>
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
    </PathLinksProvider>
  )
}

// 会话页（AI 聊天样子，docs/mobile-remote.md §21.12、§26）：顶栏是浮动圆钮 ☰ 和 ⋯ 夹着标题 +「状态 · 引擎 · 项目」（空闲时不写状态），
// 背景整页 bg-workbench；对话按 foldTurns 折好的条目显示（向上加载更早的）、两轮相隔久了插时间；
// 审批 / 提问卡片替换输入框（逐个处理时进度和「跳过」在卡片顶上）；停止键在输入框里；回到最新。输入框由 App 传进来（features 之间不互相导入）。
// 输入框上面是消息队列和模式胶囊（点开改模式）；点图片全屏看；最近一轮出错可以「重试」（§17）。
// 右上角「⋯」见 SessionMenu。
// 从「等你处理」的通知点进来（§25）：审批已经在电脑上处理掉时说一声；逐个处理时顶上一条「等你处理 2 / 3」，答完自动去下一个。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Square } from 'lucide-react'
import { ENGINES, foldTurns, type ApprovalDecision } from '@pixelsky/protocol'
import type { Pairing } from '@/connection'
import { useDesktop, useSession } from '@/data/hooks'
import { contextLabel, contextUsage } from '@/data/context'
import { attemptFor, sendKey, type SendAttempt } from '@/data/retry'
import { toolError, type ToolId } from '@/data/tools'
import { projectNameOf } from '@/data/tasks'
import { retryMessage, retryNoticeId, timeDividers } from '@/data/turns'
import { L } from '@/i18n'
import { Banner, Dot, Screen, Spinner, cn } from '@/ui'
import { ContextRing } from '@/ui/ContextRing'
import { ImageViewer } from '@/ui/images'
import { ConnectionBanner } from '../tasks/Reconnect'
import { ApprovalCard, TriageProgress } from './ApprovalCard'
import { EntryView, ThinkingRow, type TurnActions } from './ItemView'
import { ModeChip } from './ModeChip'
import { QueuePanel } from './QueuePanel'
import { INTERACT_MS, stickAfterScroll, type ScrollPos } from './stickToBottom'
import { SessionMenu } from './SessionMenu'

export function SessionScreen({
  pairing,
  sessionId,
  leading,
  notify = false,
  triage = null,
  composer,
  onRecall,
  onNew,
  onTool,
  onArchived,
}: {
  pairing: Pairing
  sessionId: string
  /** 窄屏左上角的抽屉按钮（宽屏抽屉常驻，按钮自己藏起来） */
  leading?: ReactNode
  /** 从「等你处理」的通知点进来的 */
  notify?: boolean
  /** 逐个处理等你的会话：第几个、一共几个、去下一个 */
  triage?: { index: number; total: number; onNext(): void } | null
  /** 输入框；running 是会话页算好的「正在跑」（含启动中），停止键 / 占位字都跟它走；
   *  mode：模式胶囊（权限、模型），放在输入框里那一排按钮中间 */
  composer(running: boolean, mode: ReactNode): ReactNode
  /** 队列里撤回的消息：文字放回输入框 */
  onRecall(text: string): void
  /** 右上角「+」：在这个项目里新建对话 */
  onNew?(projectId: string): void
  /** 「⋯」里的改动 / 文件 / Git */
  onTool?(tool: ToolId, projectId: string): void
  /** 归档了这个会话 */
  onArchived?(): void
}) {
  const { link, state, sessions, projects } = useDesktop(pairing.deviceId)
  const { view, error, loadOlder, detail, image } = useSession(pairing.deviceId, sessionId)
  const summary = sessions.find(s => s.record.id === sessionId)
  const snapshot = view.snapshot
  // 有快照看有没有在跑的一轮；没快照时认 running 和 starting（启动中也要显示停止键）
  const running = snapshot ? !!snapshot.turnId : summary?.state === 'running' || summary?.state === 'starting'
  const canAct = state === 'ready' && link?.hello?.access === 'act'
  const pending = snapshot?.pending[0]
  const usage = contextUsage(snapshot?.context)
  const items = snapshot?.items
  const entries = useMemo(() => foldTurns(items ?? [], running), [items, running])
  const dividers = useMemo(() => timeDividers(items ?? []), [items])
  const record = snapshot?.record ?? summary?.record
  const project = projectNameOf(projects, record?.projectId)
  const engine = record?.engine ?? 'claude'
  // 空闲（等你回复）时不写状态，只剩「引擎 · 项目」
  const status = pending
    ? { text: L('等你允许', 'Waiting for your approval'), tone: 'danger' as const }
    : running
      ? { text: L('正在回复…', 'Replying…'), tone: 'online' as const }
      : record?.lastOutcome === 'failed'
        ? { text: L('出错了', 'Error'), tone: 'warn' as const }
        : null

  // 新内容到了、而且本来就在底部时，跟着滚到底；不在底部时显示「回到最新」
  const scroller = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const stick = useRef(true)
  const last = snapshot?.items.at(-1)
  const lastSize = last ? JSON.stringify(last).length : 0
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [snapshot?.items.length, lastSize, pending?.requestId])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const near = () => el.scrollHeight - el.scrollTop - el.clientHeight < 80
    let pos: ScrollPos | null = null
    let touched = 0
    const onPointerDown = () => {
      touched = performance.now()
    }
    const onScroll = () => {
      const now = { top: el.scrollTop, height: el.scrollHeight }
      stick.current = stickAfterScroll(stick.current, pos, now, near())
      pos = now
      setAtBottom(near())
    }
    // 高度变了不一定多一条（键盘弹出、输入框变高、图片解码）：在底部就跟到底
    const observer = new ResizeObserver(() => {
      if (stick.current && performance.now() - touched >= INTERACT_MS) {
        el.scrollTop = el.scrollHeight
        return
      }
      stick.current = near()
      setAtBottom(stick.current)
    })
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('scroll', onScroll)
    }
  }, [])
  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // 从通知点进来时，审批已经在电脑上处理掉了（快照到了、一直没见到待审批）：说一声，不然以为点错了
  const [seenPending, setSeenPending] = useState(false)
  useEffect(() => {
    if (pending) setSeenPending(true)
  }, [pending])
  // 只在打开后还没有新动静时说；会话里来了新条目（你发了消息、AI 接着做）就收起
  const firstCount = useRef<number | null>(null)
  if (snapshot && firstCount.current === null) firstCount.current = snapshot.items.length
  const handledElsewhere =
    (notify || !!triage) && !!snapshot && !pending && !seenPending && snapshot.items.length === firstCount.current
  // 逐个处理：这个会话等你的都答完了，停一下让人看到卡片收起，再去下一个
  const triageNext = useRef(triage?.onNext)
  triageNext.current = triage?.onNext
  const inTriage = !!triage
  useEffect(() => {
    if (!inTriage || !seenPending || pending) return
    const timer = setTimeout(() => triageNext.current?.(), 700)
    return () => clearTimeout(timer)
  }, [inTriage, seenPending, pending])

  const answer = async (d: ApprovalDecision) => {
    if (link && pending) await link.call('engine:answer', sessionId, pending.requestId, d)
  }

  // 全屏看图、出错后重试（连点只发一次）
  const [viewing, setViewing] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const retryId = canAct && snapshot ? retryNoticeId(snapshot.items, running, snapshot.queue.length) : null
  // 同一条错误再点「重试」沿用上次的 ID（上次可能已进电脑的队列、只是回应丢了，data/retry.ts）；换了一条错误才换新的
  const retryAttempt = useRef<SendAttempt | null>(null)
  const retry = useCallback(() => {
    if (!link || retrying || !retryId) return
    setRetrying(true)
    setRetryError(null)
    const text = retryMessage()
    const current = attemptFor(retryAttempt.current, sendKey(`${sessionId}/${retryId}`, text, []), () =>
      crypto.randomUUID(),
    )
    retryAttempt.current = current
    link
      .call('engine:send', sessionId, { text, clientMessageId: current.id })
      .then(() => {
        if (retryAttempt.current === current) retryAttempt.current = null
      })
      .catch((e: Error) => setRetryError(e.message))
      .finally(() => setRetrying(false))
  }, [link, retrying, retryId, sessionId])
  // 引用稳定：EntryView 是 memo 的，流式时每包只重画变了的那条（性能审核 B9）
  const actions = useMemo<TurnActions>(
    () => ({ sessionId, image, view: setViewing, retryId, retrying, retry }),
    [sessionId, image, retryId, retrying, retry],
  )
  const [menuError, setMenuError] = useState<string | null>(null)
  // 加载更早的消息、查看完整内容失败：和菜单的错误一样放在输入框上面
  const [loadError, setLoadError] = useState<string | null>(null)
  const load = useCallback((failed: string, run: () => Promise<void>) => {
    setLoadError(null)
    run().catch(e => setLoadError(L(`${failed}：${toolError(e)}`, `${failed}: ${toolError(e)}`)))
  }, [])
  const onDetail = useCallback(
    (id: string) => load(L('查看完整内容失败', "Couldn't load the full content"), () => detail(id)),
    [load, detail],
  )

  return (
    <Screen
      scroll={false}
      floating
      footerBg="bg-workbench"
      title={record?.title || L('会话', 'Conversation')}
      subtitle={
        <>
          {status && <Dot tone={status.tone} pulse={running && !pending} />}
          <span className="truncate">{[status?.text, ENGINES[engine]?.name, project].filter(Boolean).join(' · ')}</span>
        </>
      }
      leading={leading}
      actions={
        <SessionMenu
          link={link}
          record={record}
          canAct={canAct}
          running={running}
          onNew={onNew}
          onTool={onTool}
          onArchived={onArchived}
          onError={setMenuError}
        />
      }
      footer={
        // 宽屏：对话和输入框都在中间一栏，不铺满整个窗口
        <div className="mx-auto w-full max-w-3xl">
          {/* 「⋯」里置顶、归档的错误：放在输入框上面，对话滚到哪都看得见 */}
          {menuError && <p className="px-4 pt-1.5 pb-1 text-meta text-danger">{menuError}</p>}
          {loadError && <p className="px-4 pt-1.5 pb-1 text-meta text-danger">{loadError}</p>}
          {handledElsewhere && (
            <Banner>{L('这个请求已经在电脑上处理了', 'This request was already handled on the computer')}</Banner>
          )}
          {/* 逐个处理：有待审批时进度和「跳过」在审批卡顶上；没有待审批（答完了、已在电脑上处理）时留这一条细条 */}
          {triage && !pending && (
            <div
              data-triage
              className="mx-4 mb-2 flex items-center gap-2.5 rounded-2xl bg-notify/10 px-3.5 py-1.5 text-meta text-fg-secondary"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="shrink-0">{L('等你处理', 'Needs you')}</span>
                <TriageProgress index={triage.index} total={triage.total} />
              </span>
              <button type="button" onClick={triage.onNext} className="min-h-11 px-1 font-semibold text-accent-fg">
                {L('下一个', 'Next')}
              </button>
            </div>
          )}
          {pending ? (
            <>
              <ApprovalCard
                key={pending.requestId}
                request={pending}
                canAct={canAct}
                onAnswer={answer}
                more={(snapshot?.pending.length ?? 1) - 1}
                triage={triage}
              />
              {/* 等审批时输入框不显示，停止键放在审批卡下面，不然这一轮没法从手机打断 */}
              {running && canAct && (
                <button
                  type="button"
                  aria-label={L('停止', 'Stop')}
                  onClick={() => void link?.call('engine:interrupt', sessionId).catch(() => undefined)}
                  className="mx-auto mb-2 flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-meta text-fg-muted active:bg-hover"
                >
                  <Square size={14} /> {L('停止', 'Stop')}
                </button>
              )}
            </>
          ) : (
            <>
              {snapshot && (
                <QueuePanel link={link} sessionId={sessionId} snapshot={snapshot} canAct={canAct} onRecall={onRecall} />
              )}
              {composer(
                running,
                snapshot && (
                  <>
                    <ModeChip
                      deviceId={pairing.deviceId}
                      link={link}
                      sessionId={sessionId}
                      record={snapshot.record}
                      flags={snapshot.flags ?? null}
                      canAct={canAct}
                    />
                    {usage && <ContextRing percent={usage.percent} label={contextLabel(usage)} />}
                  </>
                ),
              )}
            </>
          )}
        </div>
      }
    >
      <div className="relative min-h-0 flex-1 bg-workbench">
        <div ref={scroller} className="h-full overflow-y-auto overscroll-contain">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-3 pb-6">
            <ConnectionBanner
              deviceId={pairing.deviceId}
              kept={
                snapshot
                  ? L('下面是断开前的内容。', 'Below is what was here before the connection dropped.')
                  : undefined
              }
            />
            {error && <Banner tone="danger">{error}</Banner>}
            {retryError && <Banner tone="danger">{retryError}</Banner>}
            {!snapshot && !error && (
              <div className="flex items-center justify-center gap-2 py-16 text-meta text-fg-muted">
                <Spinner /> {L('正在加载…', 'Loading…')}
              </div>
            )}
            {view.before && (
              <button
                type="button"
                onClick={() => load(L('加载更早的消息失败', "Couldn't load earlier messages"), loadOlder)}
                className="self-center rounded-full bg-subtle px-3 py-1.5 text-meta text-fg-secondary"
              >
                {L('加载更早的消息', 'Load earlier messages')}
              </button>
            )}
            {entries.map((entry, i) => {
              const user = entry.type === 'item' && entry.item.kind === 'user' ? entry.item : null
              const divider = user && dividers.get(user.id)
              return (
                // 每一轮从你的消息开始：和上一轮之间多留一点空；包一层让条目自己的 self-center 等对齐生效
                <div
                  key={entry.type === 'item' ? entry.item.id : entry.key}
                  className={cn('flex flex-col gap-3', user && user.mode !== 'guidance' && i > 0 && 'mt-3')}
                >
                  {divider && <div className="self-center text-label text-fg-faint">{divider}</div>}
                  <EntryView
                    entry={entry}
                    last={i === entries.length - 1}
                    waiting={!!pending}
                    truncated={view.truncated}
                    onDetail={onDetail}
                    actions={actions}
                  />
                </div>
              )
            })}
            {running && !pending && items?.at(-1)?.kind === 'user' && <ThinkingRow />}
          </div>
        </div>
        {/* chat-fade 默认渐隐到聊天底色（bg-chat），会话页的底是 bg-workbench */}
        <div
          className="chat-fade"
          style={{ background: 'linear-gradient(to bottom, transparent, var(--bg-workbench))' }}
        />
        <button
          type="button"
          aria-label={L('回到最新', 'Jump to latest')}
          onClick={toBottom}
          className={cn(
            'absolute right-4 bottom-3 flex size-10 items-center justify-center rounded-full border border-line bg-popover text-fg-secondary shadow-popover transition-all',
            atBottom ? 'pointer-events-none translate-y-2 opacity-0' : 'opacity-100',
          )}
        >
          <ArrowDown size={18} />
        </button>
      </div>
      {viewing && <ImageViewer src={viewing} onClose={() => setViewing(null)} />}
    </Screen>
  )
}

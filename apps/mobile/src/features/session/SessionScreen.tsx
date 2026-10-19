// 会话页（AI 聊天样子，docs/mobile-remote.md §21.12）：顶栏是引擎头像 + 标题 + 状态；对话按 foldTurns 折好的条目显示（向上加载更早的）、
// 两轮相隔久了插时间；审批 / 提问卡片替换输入框；停止键在输入框里；回到最新。输入框由 App 传进来（features 之间不互相导入）。
// 输入框上面是消息队列和模式胶囊（点开改模式）；点图片全屏看；最近一轮出错可以「重试」（§17）。
// 右上角「+」「⋯」见 SessionMenu；这一轮答完、手里没在写的时候，输入框上面给几句快捷回复（App 传给输入框的 suggest）。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, Square } from 'lucide-react'
import { foldTurns, type ApprovalDecision } from '@pixelsky/protocol'
import type { Pairing } from '@/connection'
import type { ToolId } from '@/data/tools'
import { useDesktop, useSession } from '@/data/hooks'
import { RETRY_MESSAGE, retryNoticeId, timeDividers } from '@/data/turns'
import { linkStateText } from '@/i18n/zh'
import { Banner, Screen, Spinner, cn } from '@/ui'
import { EngineAvatar } from '@/ui/EngineAvatar'
import { ImageViewer } from '@/ui/images'
import { ApprovalCard } from './ApprovalCard'
import { EntryView, ThinkingRow, type TurnActions } from './ItemView'
import { ModeChip } from './ModeChip'
import { QueuePanel } from './QueuePanel'
import { SessionMenu } from './SessionMenu'

export function SessionScreen({
  pairing,
  sessionId,
  leading,
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
  /** 输入框；running 是会话页算好的「正在跑」（含启动中），停止键 / 占位字都跟它走；suggest：这一轮答完了，可以给快捷回复 */
  composer(running: boolean, suggest: boolean): ReactNode
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
  const items = snapshot?.items
  const entries = useMemo(() => foldTurns(items ?? [], running), [items, running])
  const dividers = useMemo(() => timeDividers(items ?? []), [items])
  const record = snapshot?.record ?? summary?.record
  const project = projects.find(p => p.id === record?.projectId)?.name
  const engine = record?.engine ?? 'claude'
  const status = pending
    ? { text: '等你允许', tone: 'danger' as const }
    : running
      ? { text: '正在回复…', tone: 'online' as const }
      : record?.lastOutcome === 'failed'
        ? { text: '出错了', tone: 'warn' as const }
        : { text: '等你回复', tone: 'muted' as const }

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
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      stick.current = bottom
      setAtBottom(bottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const answer = async (d: ApprovalDecision) => {
    if (link && pending) await link.call('engine:answer', sessionId, pending.requestId, d)
  }

  // 全屏看图、出错后重试（连点只发一次）
  const [viewing, setViewing] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const retryId = canAct && snapshot ? retryNoticeId(snapshot.items, running, snapshot.queue.length) : null
  const retry = useCallback(() => {
    if (!link || retrying) return
    setRetrying(true)
    setRetryError(null)
    link
      .call('engine:send', sessionId, { text: RETRY_MESSAGE, clientMessageId: crypto.randomUUID() })
      .catch((e: Error) => setRetryError(e.message))
      .finally(() => setRetrying(false))
  }, [link, retrying, sessionId])
  const actions: TurnActions = { sessionId, image, view: setViewing, retryId, retrying, retry }
  const [menuError, setMenuError] = useState<string | null>(null)
  // 快捷回复：答完了（最后一条不是你的）、没在跑、没排队、没有「重试」
  const suggest =
    canAct && !!snapshot && !running && !pending && !retryId && !snapshot.queue.length && !!last && last.kind !== 'user'

  return (
    <Screen
      scroll={false}
      centered
      footerBg="bg-chat"
      title={
        <>
          <EngineAvatar engine={engine} size={36} status={{ tone: status.tone, pulse: running && !pending }} />
          <span className="max-w-full truncate">{record?.title || '会话'}</span>
        </>
      }
      subtitle={`${status.text}${project ? ` · ${project}` : ''}`}
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
          {pending ? (
            <>
              <ApprovalCard
                key={pending.requestId}
                request={pending}
                canAct={canAct}
                onAnswer={answer}
                more={(snapshot?.pending.length ?? 1) - 1}
              />
              {/* 等审批时输入框不显示，停止键放在审批卡下面，不然这一轮没法从手机打断 */}
              {running && canAct && (
                <button
                  type="button"
                  aria-label="停止"
                  onClick={() => void link?.call('engine:interrupt', sessionId).catch(() => undefined)}
                  className="mx-auto mb-3 flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-meta text-fg-secondary active:bg-hover"
                >
                  <Square size={14} /> 停止
                </button>
              )}
            </>
          ) : (
            <>
              {snapshot && (
                <QueuePanel link={link} sessionId={sessionId} snapshot={snapshot} canAct={canAct} onRecall={onRecall} />
              )}
              {snapshot && (
                <ModeChip
                  deviceId={pairing.deviceId}
                  link={link}
                  sessionId={sessionId}
                  record={snapshot.record}
                  canAct={canAct}
                />
              )}
              {composer(running, suggest)}
            </>
          )}
        </div>
      }
    >
      <div className="relative min-h-0 flex-1 bg-chat">
        <div ref={scroller} className="h-full overflow-y-auto overscroll-contain">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-3 pb-6">
            {state !== 'ready' && state && (
              <Banner tone="warn" icon={<Spinner size={14} />}>
                {linkStateText[state]}
              </Banner>
            )}
            {error && <Banner tone="danger">{error}</Banner>}
            {retryError && <Banner tone="danger">{retryError}</Banner>}
            {!snapshot && !error && (
              <div className="flex items-center justify-center gap-2 py-16 text-meta text-fg-muted">
                <Spinner /> 正在加载…
              </div>
            )}
            {view.before && (
              <button
                type="button"
                onClick={() => void loadOlder()}
                className="self-center rounded-full bg-subtle px-3 py-1.5 text-meta text-fg-secondary"
              >
                加载更早的消息
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
                    onDetail={id => void detail(id)}
                    actions={actions}
                  />
                </div>
              )
            })}
            {running && !pending && items?.at(-1)?.kind === 'user' && <ThinkingRow />}
          </div>
        </div>
        <div className="chat-fade" />
        <button
          type="button"
          aria-label="回到最新"
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

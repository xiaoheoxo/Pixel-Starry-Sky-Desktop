import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { settledResizeObserver } from '@/features/panes/motion'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  EyeOff,
  FastForward,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react'
import type { QueuedMessage } from '@pixelsky/protocol'
import { Button, IconButton, Spinner, cn } from '@/ui'
import { effortLabel, type ComposerController, type QueueController } from '@/features/engine'
import { ImageAttachments } from '@/features/session/attachments/ImageAttachments'
import { FileAttachments } from '@/features/session/attachments/FileAttachments'
import { canDismiss, isReconnecting, isSendFailure, isStarting, queueMoveKey, queueMoveTarget } from './queueView'
import { useProviders } from '@/features/account/providers'
import { canCopyImported, isResumeLiveError } from '@/features/resume/model'
import { nativeSessionAction, useEngineState } from '@/features/engine/store'

const same = (a: QueuedMessage['settings'], b: ComposerController['execution']) =>
  !!b &&
  a.model === b.model &&
  a.effort === b.effort &&
  a.platform?.groupId === b.platform?.groupId &&
  a.platform?.account === b.platform?.account &&
  (a.provider?.id ?? null) === (b.provider?.id ?? null)

/** 对话区比这还矮时，队列默认收起成一行，先让输入框露出来 */
const SHORT_VIEW_PX = 420
/** 队列列表最高占对话区高度的三成，不低于 120px、不高于 256px */
export const queueListMaxHeight = (viewHeight: number): number =>
  Math.round(Math.max(120, Math.min(256, viewHeight * 0.3)))

export function QueuedMessages({
  live,
  onRecall,
  onPrepareRecall,
  sessionId,
}: {
  live: QueueController
  /** 这个输入框的会话 id；发送失败是「终端里正开着」时用它改成复制一份接着聊 */
  sessionId?: string | null
  onRecall: (text: string) => void
  onPrepareRecall?: (message: QueuedMessage) => Promise<(() => Promise<void>) | void>
}) {
  useI18n()
  const providers = useProviders().providers
  // 「复制一份接着聊」只在对话仍然接着原会话时显示：没导入过的、已经是复制出来的、换过执行者的、线程已经换掉的都不显示
  const record = useEngineState(s => (sessionId ? s.sessions.find(x => x.record.id === sessionId) : undefined)?.record)
  const canCopyNative = canCopyImported(record)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 按所在对话区的高度定列表最高多高、要不要先收起（窗格很矮时不和上面的内容叠在一起）
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const [viewHeight, setViewHeight] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  // 键盘调序后要把焦点留在被挪的那一行：重排时浏览器会让被移动的节点失焦，队列变了 / 操作结束都补一次
  const refocus = useRef<string | null>(null)
  const focusRow = (queueId: string): void => {
    if (!root) return
    // 只在焦点没有去别处时才补：落在 body（被挪的节点失焦）或队列内部；输入框等地方的焦点绝不抢
    const active = document.activeElement
    if (active && active !== document.body && !root.contains(active)) return
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-queue-id]'))
    const at = rows.findIndex(r => r.dataset.queueId === queueId)
    const focusable = (r: HTMLElement | undefined): r is HTMLElement => !!r && r.hasAttribute('tabindex')
    // 那一行已经不能聚焦（开始交付了）：改给相邻的一行，都没有就给队列容器，不让焦点掉到 body
    const target =
      (focusable(rows[at]) && rows[at]) ||
      rows.slice(at + 1).find(focusable) ||
      rows.slice(0, Math.max(at, 0)).reverse().find(focusable) ||
      root.querySelector<HTMLElement>('[data-queue-list]')
    target?.focus({ preventScroll: false })
  }
  useLayoutEffect(() => {
    if (refocus.current) focusRow(refocus.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在队列变化时补焦点
  }, [live.queue])
  useLayoutEffect(() => {
    const view = root?.closest<HTMLElement>('.conversation-view')
    if (!view) return
    const measure = (): void => setViewHeight(view.clientHeight)
    measure()
    const ro = settledResizeObserver(measure)
    ro.observe(view)
    return () => ro.disconnect()
  }, [root])
  // 正在执行的、以及空闲时直接发送正在启动的消息都显示在对话里，不算排队；正在自动重连的显示重连卡片
  const items = live.queue.filter(q => q.status !== 'running' && !isStarting(q, live.queuePaused) && !isReconnecting(q))
  if (!items.length) return null
  const action = async (id: string, fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(id)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const move = (queueId: string, dir: -1 | 1) => {
    const to = queueMoveTarget(items, queueId, dir)
    return to ? action(queueId, () => live.moveQueued(queueId, to)) : Promise.resolve()
  }
  // Alt+↑ / Alt+↓ 调序，焦点跟着那一行走（被拒绝时也留在原行）
  const onRowKey = (e: KeyboardEvent<HTMLElement>, q: QueuedMessage): void => {
    const dir = queueMoveKey(e.nativeEvent)
    if (!dir || q.status !== 'queued') return
    e.preventDefault()
    e.stopPropagation()
    refocus.current = q.id
    void move(q.id, dir).finally(() => {
      requestAnimationFrame(() => {
        focusRow(q.id)
        if (refocus.current === q.id) refocus.current = null
      })
    })
  }
  const visible = expanded ? items : items.slice(0, 3)
  const held = items.some(q => q.held)
  const paused = live.queuePaused || held
  const onlyFailures = items.every(isSendFailure)
  // 模型 · 强度 · 线路：大家都一样时只在标题行写一次，否则写在各自那一行
  const settingsOf = (q: QueuedMessage): string =>
    `${q.settings.model ?? tr('session.QueuedMessages.engineDefaultModel')} · ${effortLabel(q.settings.effort)} · ${
      q.settings.platform
        ? tr('session.QueuedMessages.platformRoute', { p0: q.settings.platform.groupId })
        : q.settings.provider
          ? tr('customApi.queued', {
              p0: providers.find(p => p.id === q.settings.provider?.id)?.name ?? q.settings.provider.id,
            })
          : tr('session.QueuedMessages.ownCredits')
    }`
  const common = items.every(q => settingsOf(q) === settingsOf(items[0])) ? settingsOf(items[0]) : null
  const short = viewHeight !== null && viewHeight < SHORT_VIEW_PX
  const collapsed = short && !open
  const title = (
    <>
      {onlyFailures
        ? tr('session.queue.sendFailed')
        : paused
          ? tr('session.QueuedMessages.queuePaused')
          : tr('session.QueuedMessages.messageQueue')}{' '}
      · {items.length}
    </>
  )
  return (
    <section
      ref={setRoot}
      className="@container/queue mb-2 flex flex-col gap-1.5"
      aria-label={tr('session.QueuedMessages.messageQueue')}
    >
      <div className="flex shrink-0 items-center gap-2 px-1 text-meta text-fg-muted">
        {paused && !onlyFailures ? <Pause size={12} /> : <CornerDownRight size={12} />}
        {short ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => setOpen(v => !v)}
            className="inline-flex shrink-0 items-center gap-1 rounded hover:text-fg"
          >
            {title}
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
        ) : (
          <span className="shrink-0">{title}</span>
        )}
        {common && (
          <span className="min-w-0 truncate text-fg-faint" title={tr('session.QueuedMessages.modelEffortAndCredit')}>
            · {common}
          </span>
        )}
        {paused && !onlyFailures && live.state === 'idle' && (
          <span className="min-w-0 truncate text-fg-faint">{tr('session.QueuedMessages.heldHint')}</span>
        )}
        <span className="flex-1" />
        {paused && (
          <Button
            variant="ghost"
            icon={Play}
            disabled={!!busy}
            className="h-6 px-2 text-meta"
            onClick={() => void action('resume', live.resumeQueue)}
          >
            {tr('session.QueuedMessages.resumeQueue')}
          </Button>
        )}
        {!collapsed && items.length > 3 && (
          <button type="button" className="rounded-md px-2 py-1 hover:bg-hover" onClick={() => setExpanded(v => !v)}>
            {expanded ? tr('session.ModelSourceMenu.collapse') : tr('session.QueuedMessages.expandAll')}
          </button>
        )}
      </div>
      {!collapsed && (
        // 一个框里按行列出、细线分隔；框本身滚动，滚动时被切开的那行上面始终有框的边
        <div
          role="list"
          tabIndex={-1}
          data-queue-list
          style={viewHeight === null ? undefined : { maxHeight: queueListMaxHeight(viewHeight) }}
          className="flex max-h-64 min-h-0 flex-col outline-none divide-y divide-line-card overflow-y-auto rounded-lg border border-line-card bg-surface"
        >
          {visible.map(q => {
            const pending = q.status === 'dispatching' || q.status === 'delivering'
            const canSteer =
              q.status === 'queued' &&
              live.steerAvailable &&
              live.state === 'running' &&
              same(q.settings, live.execution)
            const steerReason = !live.steerAvailable
              ? tr('session.QueuedMessages.steeringHasNotBeen')
              : live.state !== 'running'
                ? tr('session.QueuedMessages.noTaskCanAccept')
                : !same(q.settings, live.execution)
                  ? tr('session.QueuedMessages.settingsDifferFromCurrent')
                  : tr('session.QueuedMessages.sendAdditionalInstructionsTo')
            const label = isSendFailure(q)
              ? tr('session.queue.sendFailed')
              : q.status === 'failed'
                ? tr('session.QueuedMessages.executionFailed')
                : q.status === 'uncertain'
                  ? tr('session.QueuedMessages.deliveryNeedsVerification')
                  : q.status === 'delivering'
                    ? tr('session.QueuedMessages.waitingForAdoption')
                    : q.status === 'dispatching'
                      ? tr('session.QueuedMessages.starting')
                      : q.held
                        ? tr('session.QueuedMessages.held')
                        : tr('session.live.agentTrace.queued')
            return (
              <div
                key={q.id}
                data-queue-id={q.id}
                role="listitem"
                aria-label={tr('session.queue.rowLabel', { p0: q.text.slice(0, 80), p1: label })}
                tabIndex={q.status === 'queued' ? 0 : undefined}
                aria-keyshortcuts={q.status === 'queued' ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                onKeyDown={e => {
                  // 只处理行自己或行里按钮上的按键，输入框之类的不拦
                  if (e.target === e.currentTarget || (e.target as HTMLElement).closest('button')) onRowKey(e, q)
                }}
                className="shrink-0 px-3 py-1.5 transition-colors outline-none hover:bg-hover/40 focus-visible:bg-hover/40 focus-visible:ring-2 focus-visible:ring-composer-ring focus-visible:ring-inset"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {pending || busy === q.id ? (
                    <Spinner size={11} />
                  ) : (
                    <span className={cn('size-1.5 rounded-full', q.error ? 'bg-warn' : 'bg-fg-faint')} />
                  )}
                  {/* 全是发送失败时标题行已经写了，每行不再重复 */}
                  {!onlyFailures && (
                    <span className={cn('shrink-0 text-meta', q.error ? 'text-warn' : 'text-fg-muted')}>{label}</span>
                  )}
                  <span className="min-w-20 flex-1 truncate text-list text-fg-secondary" title={q.text}>
                    {q.text}
                  </span>
                  {/* 各条设置不一样时：宽的时候放在按钮左边排成一列，窄的时候放到错误原因后面 */}
                  {!common && (
                    <span
                      className="hidden shrink-0 text-label text-fg-faint tabular-nums @min-[600px]/queue:inline"
                      title={tr('session.QueuedMessages.modelEffortAndCredit')}
                    >
                      {settingsOf(q)}
                    </span>
                  )}
                  <div className="flex shrink-0 items-center gap-0.5">
                    {q.status === 'queued' && (
                      <>
                        <IconButton
                          icon={ArrowUp}
                          size={24}
                          iconSize={12}
                          label={tr('session.QueuedMessages.moveMessageUp')}
                          disabled={!!busy || !queueMoveTarget(items, q.id, -1)}
                          onClick={() => void move(q.id, -1)}
                        />
                        <IconButton
                          icon={ArrowDown}
                          size={24}
                          iconSize={12}
                          label={tr('session.QueuedMessages.moveMessageDown')}
                          disabled={!!busy || !queueMoveTarget(items, q.id, 1)}
                          onClick={() => void move(q.id, 1)}
                        />
                        <span title={steerReason}>
                          <Button
                            variant="ghost"
                            icon={CornerDownRight}
                            className="h-6 px-1.5 text-meta"
                            disabled={!!busy || !canSteer}
                            onClick={() => void action(q.id, () => live.steerQueued(q.id))}
                          >
                            {tr('session.QueuedMessages.steer')}
                          </Button>
                        </span>
                      </>
                    )}
                    {!pending && (
                      <>
                        {/* 导入的会话启动时发现终端里正开着：改成复制一份接着聊再重发（docs/ui/claude-resume.md §4.6） */}
                        {sessionId && isResumeLiveError(q.error) && canCopyNative && (
                          <Button
                            variant="subtle"
                            data-native-action="copy"
                            className="h-6 px-1.5 text-meta"
                            disabled={!!busy}
                            onClick={() =>
                              void action(q.id, async () => {
                                await nativeSessionAction(sessionId, 'copy')
                                await live.runQueuedNow(q.id)
                              })
                            }
                          >
                            {tr('resume.copy')}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          icon={q.error ? RotateCcw : FastForward}
                          className="h-6 px-1.5 text-meta"
                          disabled={!!busy}
                          title={
                            q.status === 'uncertain'
                              ? tr('session.QueuedMessages.runAgainAfterChecking')
                              : tr('session.QueuedMessages.interruptCurrentTaskAnd')
                          }
                          onClick={() => void action(q.id, () => live.runQueuedNow(q.id))}
                        >
                          {q.error ? tr('session.ModelSourceMenu.retry') : tr('session.QueuedMessages.runNext')}
                        </Button>
                        <Button
                          variant="ghost"
                          icon={X}
                          className="h-6 px-1.5 text-meta"
                          disabled={!!busy}
                          onClick={() =>
                            void action(q.id, async () => {
                              const rollback = await onPrepareRecall?.(q)
                              try {
                                onRecall(await live.cancelQueued(q.id))
                              } catch (error) {
                                await rollback?.()
                                throw error
                              }
                            })
                          }
                        >
                          {tr('session.QueuedMessages.withdraw')}
                        </Button>
                        {/* 不重发也不撤回：消息留在对话里标「未送达」，队列不再卡住，可以直接接着说 */}
                        {canDismiss(q) && (
                          <Button
                            variant="ghost"
                            icon={EyeOff}
                            data-queue-dismiss
                            className="h-6 px-1.5 text-meta"
                            disabled={!!busy}
                            title={tr('session.queue.dismissHint')}
                            onClick={() => void action(q.id, () => live.dismissQueued(q.id))}
                          >
                            {tr('session.queue.dismiss')}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {/* 原因只显示第一行：完整说明和原文在对话里的错误卡片上（docs/ui/conversation-ux-2.md §2.1）；
                    窄的时候设置跟在后面 */}
                {(q.error || !common) && (
                  <p className={cn('truncate pl-3.5 text-meta', !q.error && '@min-[600px]/queue:hidden')}>
                    {q.error && (
                      <span className="text-warn" title={translateMessage(q.error)}>
                        {translateMessage(q.error.split('\n')[0])}
                        {!!q.reconnected && ` · ${tr('session.reconnect.tried', { p0: q.reconnected })}`}
                      </span>
                    )}
                    {q.error && !common && <span className="text-fg-faint @min-[600px]/queue:hidden"> · </span>}
                    {!common && (
                      <span
                        className="text-label text-fg-faint @min-[600px]/queue:hidden"
                        title={tr('session.QueuedMessages.modelEffortAndCredit')}
                      >
                        {settingsOf(q)}
                      </span>
                    )}
                  </p>
                )}
                {!!q.attachments?.length && (
                  <div className="mt-1.5 pl-3.5">
                    <ImageAttachments images={q.attachments} compact />
                  </div>
                )}
                {!!q.files?.length && (
                  <div className="mt-1.5 pl-3.5">
                    <FileAttachments files={q.files} />
                  </div>
                )}
                {(q.text.length > 60 || q.text.includes('\n')) && (
                  <details className="mt-1 pl-3.5 text-meta text-fg-muted">
                    <summary className="cursor-pointer text-label hover:text-fg">
                      {tr('session.QueuedMessages.viewFullMessage')}
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap break-words">{q.text}</p>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}
      {error && (
        <p role="alert" className="px-1 text-meta whitespace-pre-wrap text-danger">
          {translateMessage(error)}
        </p>
      )}
    </section>
  )
}

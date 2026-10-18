// 消息队列（docs/mobile-remote.md §17 第 2 项，规则同桌面 QueuedMessages）：输入框上面列出排着的消息，
// 点一条弹出能做的事：插队 / 重试、引导、上移、下移、撤回（撤回的文字放回输入框）、关掉；
// 断线自动重连中的那条：立即重连、停止（队列暂停时是继续重连、停止）。
import { useState } from 'react'
import { ChevronDown, ChevronUp, CornerDownRight, ImageIcon, Pause } from 'lucide-react'
import type { QueuedMessage, SessionSnapshot } from '@pixelsky/protocol'
import type { DesktopLink } from '@/connection'
import {
  canDismiss,
  canSteer,
  isPending,
  isReconnecting,
  isSendFailure,
  queueErrorText,
  queueItems,
  queueLabel,
  queueMoveArg,
  queueTitle,
} from '@/data/queue'
import { Button, Spinner, cn } from '@/ui'
import { ActionSheet, type SheetAction } from '@/ui/sheet'

/** 收起时露出几条 */
const COLLAPSED = 2

export function QueuePanel({
  link,
  sessionId,
  snapshot,
  canAct,
  onRecall,
}: {
  link: DesktopLink | undefined
  sessionId: string
  snapshot: SessionSnapshot
  canAct: boolean
  onRecall(text: string): void
}) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<QueuedMessage | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const items = queueItems(snapshot)
  if (!items.length) return null
  const paused = snapshot.queuePaused || items.some(q => q.held)
  const shown = open ? items : items.slice(0, COLLAPSED)

  const run = async (id: string, method: string, ...args: unknown[]) => {
    if (!link || busy) return
    setBusy(id)
    setError(null)
    try {
      const result = await link.call(method, sessionId, ...args)
      if (method === 'engine:cancelQueued' && typeof result === 'string') onRecall(result)
    } catch (e) {
      setError(
        (e as Error).message === 'MOBILE_FORBIDDEN' ? '这部手机是「只看」。' : queueErrorText((e as Error).message),
      )
    } finally {
      setBusy(null)
    }
  }

  const actionsFor = (q: QueuedMessage): SheetAction[] => {
    const before = link?.hello?.queueMoveBefore === true
    const up = queueMoveArg(snapshot.queue, items, q.id, -1, before)
    const down = queueMoveArg(snapshot.queue, items, q.id, 1, before)
    const list: SheetAction[] = []
    if (isReconnecting(q))
      return [
        {
          label: snapshot.queuePaused ? '继续重连' : '立即重连',
          hint: snapshot.queuePaused ? '自动重连已暂停，现在接着连' : '不等倒计时，现在就连',
          disabled: q.status === 'dispatching',
          onSelect: () => void run(q.id, 'engine:runQueuedNow', q.id),
        },
        {
          label: '停止',
          hint: '不再自动重连，这条算发送失败',
          danger: true,
          onSelect: () => void run(q.id, 'engine:interrupt'),
        },
      ]
    if (!isPending(q))
      list.push(
        q.error
          ? {
              label: '重试',
              hint: q.status === 'uncertain' ? '核对过再重新执行，可能重复上次已经做过的操作' : undefined,
              onSelect: () => void run(q.id, 'engine:runQueuedNow', q.id),
            }
          : {
              label: '插队',
              hint: '停下当前这一轮，先发这条',
              onSelect: () => void run(q.id, 'engine:runQueuedNow', q.id),
            },
      )
    if (canSteer(q, snapshot))
      list.push({
        label: '引导',
        hint: '不停下，把这条作为补充说明交给正在做的这一轮',
        onSelect: () => void run(q.id, 'engine:steerQueued', q.id, snapshot.turnId),
      })
    if (q.status === 'queued') {
      list.push(
        { label: '上移', disabled: up === null, onSelect: () => void run(q.id, 'engine:moveQueued', q.id, up) },
        {
          label: '下移',
          disabled: down === null,
          onSelect: () => void run(q.id, 'engine:moveQueued', q.id, down),
        },
      )
    }
    if (!isPending(q))
      list.push({
        label: '撤回',
        hint: '文字放回输入框（图片不会放回）',
        danger: true,
        onSelect: () => void run(q.id, 'engine:cancelQueued', q.id),
      })
    if (canDismiss(q))
      list.push({
        label: '关掉',
        hint: '不重发也不撤回：消息留在对话里标「未送达」，可以直接接着说',
        onSelect: () => void run(q.id, 'engine:dismissQueued', q.id),
      })
    return list
  }

  return (
    <section aria-label="消息队列" className="border-t border-line-subtle px-3 pt-2">
      <div className="flex min-h-8 items-center gap-1.5 px-1 text-meta text-fg-muted">
        {paused ? <Pause size={13} /> : <CornerDownRight size={13} />}
        <span>
          {queueTitle(items, snapshot.queuePaused)} · {items.length}
        </span>
        <span className="flex-1" />
        {paused && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!canAct || !!busy}
            onClick={() => void run('resume', 'engine:resumeQueue')}
            className="min-h-8 px-2 text-accent-fg"
          >
            {busy === 'resume' ? <Spinner size={12} /> : null}继续队列
          </Button>
        )}
        {items.length > COLLAPSED && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="flex min-h-8 items-center gap-0.5 rounded-lg px-1.5 active:bg-hover"
          >
            {open ? '收起' : `全部 ${items.length} 条`}
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
      <div
        className={cn(
          'flex flex-col gap-1.5 pb-1',
          open && 'max-h-[calc(var(--app-height,100dvh)*0.35)] overflow-y-auto',
        )}
      >
        {shown.map(q => (
          <button
            key={q.id}
            type="button"
            disabled={!canAct}
            onClick={() => setMenu(q)}
            className="flex w-full flex-col gap-0.5 rounded-xl border border-line-subtle bg-surface px-3 py-2 text-left active:bg-hover disabled:opacity-100"
          >
            <span className="flex items-center gap-1.5 text-label">
              {isPending(q) || busy === q.id ? (
                <Spinner size={10} className="text-fg-faint" />
              ) : (
                <span className={cn('size-1.5 rounded-full', q.error ? 'bg-warn' : 'bg-fg-faint')} />
              )}
              <span className={q.error || isSendFailure(q) ? 'text-warn' : 'text-fg-muted'}>
                {queueLabel(q, snapshot.queuePaused)}
              </span>
              {!!q.attachments?.length && (
                <span className="flex items-center gap-0.5 text-fg-faint">
                  <ImageIcon size={12} /> {q.attachments.length}
                </span>
              )}
            </span>
            <span className="line-clamp-2 text-list text-fg-secondary">{q.text || '（只有图片）'}</span>
            {q.error && (
              <span className="truncate text-label text-warn">
                {q.error.split('\n')[0]}
                {!!q.reconnected && ` · 已自动重连 ${q.reconnected} 次`}
              </span>
            )}
            {q.reconnect && isReconnecting(q) && (
              <span className="truncate text-label text-fg-faint">{q.reconnect.reason || '连接中断'}</span>
            )}
          </button>
        ))}
      </div>
      {error && <p className="px-1 pb-1 text-meta text-danger">{error}</p>}
      {menu && (
        <ActionSheet
          title={menu.text.length > 40 ? menu.text.slice(0, 40) + '…' : menu.text || '这条消息'}
          actions={actionsFor(menu)}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  )
}

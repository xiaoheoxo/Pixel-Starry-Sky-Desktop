// 任务看板的两种卡片（docs/ui/task-board.md §4）：手动任务卡、AI 卡片（会话）
import type { KeyboardEvent, MouseEvent } from 'react'
import {
  Check,
  Circle,
  CircleAlert,
  CirclePause,
  Ellipsis,
  MessageSquareDot,
  Pin,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'
import { Button, Spinner, cn } from '@/ui'
import { tr, translateMessage, type TranslationKey } from '@/i18n/core'
import { relativeTime } from '@/features/engine'
import { canAnswerInline, canResume } from '@/features/panel/inbox/inboxModel'
import type { ManualTask } from '../../../../shared/types/project-tools'
import { overdue } from './boardModel'
import { IssueLine } from './IssueParts'
import type { SessionCard, SessionLane } from './sessionLanes'
import { useSessionChannel } from '@/features/channels/store'

const CARD =
  'group relative flex w-full flex-col gap-1 rounded-lg border border-line-card bg-surface px-3 py-2.5 text-left shadow-sm outline-none transition-colors hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent'

const PRIORITY_KEY = {
  low: 'projectTools.priority.low',
  normal: 'projectTools.priority.normal',
  high: 'projectTools.priority.high',
} as const

/** 卡片之间的方向键：上下在同一列里走，左右换列（docs/ui/task-board.md §5） */
export function moveFocus(e: KeyboardEvent<HTMLElement>): boolean {
  const all = [...document.querySelectorAll<HTMLElement>('[data-board-card]')]
  const here = e.currentTarget
  const column = here.dataset.column
  const inColumn = all.filter(el => el.dataset.column === column)
  const i = inColumn.indexOf(here)
  let next: HTMLElement | undefined
  if (e.key === 'ArrowDown') next = inColumn[i + 1]
  else if (e.key === 'ArrowUp') next = inColumn[i - 1]
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const columns = [...new Set(all.map(el => el.dataset.column))]
    const step = e.key === 'ArrowLeft' ? -1 : 1
    for (let c = columns.indexOf(column) + step; c >= 0 && c < columns.length; c += step) {
      const target = all.filter(el => el.dataset.column === columns[c])
      if (target.length) {
        next = target[Math.min(Math.max(i, 0), target.length - 1)]
        break
      }
    }
  } else return false
  e.preventDefault()
  next?.focus()
  return true
}

export function TaskCard({
  task,
  column,
  project,
  now,
  busy,
  onToggle,
  onOpen,
  onMenu,
  onDragStart,
  onDragEnd,
  onDispatch,
  onReview,
  onWakeup,
}: {
  task: ManualTask
  column: string
  project: string
  now: number
  busy: boolean
  onToggle: () => void
  onOpen: () => void
  onMenu: (x: number, y: number, trigger: HTMLElement) => void
  onDragStart: () => void
  onDragEnd: () => void
  /** 事项（docs/ui/channels-collab-v2.md §9）：交给负责人、验收 */
  onDispatch: () => void
  onReview: () => void
  /** 事项唤醒（docs/multica-learn.md §11.6）：派出去的卡能挂时才有 */
  onWakeup?: () => void
}) {
  const done = task.status === 'completed'
  const late = overdue(task, now)
  const firstLine = task.note.split('\n')[0]
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      data-board-card
      data-board-task={task.id}
      data-column={column}
      aria-label={task.title}
      onClick={onOpen}
      onDragStart={e => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('application/x-pixelsky-board-task', task.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onContextMenu={(e: MouseEvent<HTMLDivElement>) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY, e.currentTarget)
      }}
      onKeyDown={e => {
        if (moveFocus(e)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          onOpen()
        } else if (e.key === ' ') {
          e.preventDefault()
          if (!busy) onToggle()
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          onMenu(r.right - 180, r.bottom + 4, e.currentTarget)
        }
      }}
      className={cn(CARD, 'cursor-grab active:cursor-grabbing')}
    >
      <div className="flex min-w-0 items-start gap-2">
        <button
          type="button"
          tabIndex={-1}
          aria-label={tr(done ? 'board.markNotDone' : 'board.markDone') + ': ' + task.title}
          aria-pressed={done}
          disabled={busy}
          onClick={e => {
            e.stopPropagation()
            onToggle()
          }}
          className="-ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:text-fg"
        >
          {done ? (
            <Check size={14} strokeWidth={1.75} className="text-success" />
          ) : (
            <Circle size={14} strokeWidth={1.5} />
          )}
        </button>
        <span
          className={cn(
            'line-clamp-2 min-w-0 flex-1 break-words text-list text-fg',
            done && 'text-fg-muted line-through',
          )}
        >
          {task.title}
        </span>
        {!!task.pinnedAt && (
          <span title={tr('board.pinned')} className="mt-0.5 shrink-0 text-fg-faint">
            <Pin size={12} strokeWidth={1.5} />
          </span>
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-label={tr('board.cardActions')}
          onClick={e => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            onMenu(r.left, r.bottom + 4, e.currentTarget.closest<HTMLElement>('[data-board-card]')!)
          }}
          className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 hover:bg-hover hover:text-fg"
        >
          <Ellipsis size={14} />
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-6 text-meta text-fg-faint">
        {project && <span className="max-w-full truncate">{project}</span>}
        {task.priority !== 'normal' && (
          <span className={cn('inline-flex items-center gap-1', task.priority === 'high' && 'text-accent-fg')}>
            · {task.priority === 'high' && <span className="size-1.5 rounded-full bg-accent" aria-hidden />}
            {tr(PRIORITY_KEY[task.priority])}
          </span>
        )}
        {task.due && (
          <span className={cn(late && 'text-warn')}>
            · {tr(late ? 'board.overdue' : 'board.due', { date: task.due.slice(5) })}
          </span>
        )}
        {task.tags.map(tag => (
          <span key={tag} className="rounded bg-subtle px-1.5 text-label text-fg-muted">
            {tag}
          </span>
        ))}
      </div>
      {firstLine && <p className="truncate pl-6 text-meta text-fg-muted">{firstLine}</p>}
      <IssueLine task={task} busy={busy} onDispatch={onDispatch} onReview={onReview} onWakeup={onWakeup} />
    </div>
  )
}

const LANE: Record<SessionLane, { label: TranslationKey; icon: LucideIcon | null; tone: string }> = {
  waiting: { label: 'board.lane.waiting', icon: ShieldAlert, tone: 'text-warn' },
  failed: { label: 'board.lane.failed', icon: CircleAlert, tone: 'text-danger' },
  paused: { label: 'board.lane.paused', icon: CirclePause, tone: 'text-fg-muted' },
  unread: { label: 'board.lane.unread', icon: MessageSquareDot, tone: 'text-accent-fg' },
  running: { label: 'board.lane.running', icon: null, tone: 'text-fg-muted' },
}

function reasonOf(card: SessionCard): string | null {
  if (card.lane === 'waiting') {
    const r = card.request
    return r ? r.command?.trim() || r.questions?.[0]?.question || r.title || null : null
  }
  if (card.lane === 'failed') return card.error ? translateMessage(card.error.split('\n')[0]) : null
  if (card.lane === 'paused')
    return tr('projectTools.inbox.pausedCount', { count: (card.queue?.queued ?? 0) + (card.queue?.failed ?? 0) })
  if (card.lane === 'running' && card.progress)
    return tr('board.progress', { done: card.progress.done, total: card.progress.total })
  return null
}

export function AiCard({
  card,
  column,
  now,
  busy,
  onOpen,
  onAllow,
  onDeny,
  onRetry,
  onResume,
}: {
  card: SessionCard
  column: string
  now: number
  busy: boolean
  onOpen: () => void
  onAllow: () => void
  onDeny: () => void
  onRetry: () => void
  onResume: () => void
}) {
  const lane = LANE[card.lane]
  const channel = useSessionChannel(card.id)
  const reason = reasonOf(card)
  const inline = card.lane === 'waiting' && canAnswerInline(card.request)
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div
      role="button"
      tabIndex={0}
      data-board-card
      data-board-session={card.id}
      data-column={column}
      aria-label={card.title}
      onClick={onOpen}
      onKeyDown={e => {
        if (moveFocus(e)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(CARD, 'cursor-pointer')}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center', lane.tone)}>
          {lane.icon ? <lane.icon size={14} strokeWidth={1.75} /> : <Spinner size={12} />}
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-list text-fg">{card.title}</span>
        <span className="mt-0.5 shrink-0 rounded bg-subtle px-1.5 text-label text-fg-muted">{tr('board.ai')}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-6 text-meta text-fg-faint">
        {card.scheduled && <span className="shrink-0 text-accent-fg">{tr('board.schedule.badge')} ·</span>}
        <span className={cn('shrink-0', lane.tone)}>{tr(lane.label)}</span>
        {card.project && <span className="min-w-0 truncate">· {card.project}</span>}
        {channel && <span className="min-w-0 truncate">· # {channel}</span>}
        <span className="shrink-0 tabular-nums">· {relativeTime(card.at, now)}</span>
      </div>
      {reason && (
        <p
          title={reason}
          className={cn(
            'line-clamp-2 break-words pl-6 text-meta',
            card.lane === 'failed' ? 'text-danger' : 'text-fg-muted',
            card.lane === 'waiting' && card.request?.command && 'font-mono',
          )}
        >
          {reason}
        </p>
      )}
      {card.lane !== 'running' && (
        <div className="mt-1 flex flex-wrap gap-1.5 pl-6">
          {inline ? (
            <>
              <Button variant="primary" className="h-7 px-2.5 text-meta" disabled={busy} onClick={stop(onAllow)}>
                {tr('projectTools.inbox.allow')}
              </Button>
              {card.request?.canDeny !== false && (
                <Button className="h-7 px-2.5 text-meta" disabled={busy} onClick={stop(onDeny)}>
                  {tr('projectTools.inbox.deny')}
                </Button>
              )}
            </>
          ) : card.lane === 'waiting' ? (
            <Button variant="primary" className="h-7 px-2.5 text-meta" onClick={stop(onOpen)}>
              {tr('board.answer')}
            </Button>
          ) : card.lane === 'failed' ? (
            <>
              <Button className="h-7 px-2.5 text-meta" disabled={busy} onClick={stop(onRetry)}>
                {tr('board.retry')}
              </Button>
              <Button variant="ghost" className="h-7 px-2.5 text-meta" onClick={stop(onOpen)}>
                {tr('board.openSession')}
              </Button>
            </>
          ) : card.lane === 'paused' ? (
            <>
              {canResume(card.queue) && (
                <Button className="h-7 px-2.5 text-meta" disabled={busy} onClick={stop(onResume)}>
                  {tr('board.resume')}
                </Button>
              )}
              <Button variant="ghost" className="h-7 px-2.5 text-meta" onClick={stop(onOpen)}>
                {tr('board.openSession')}
              </Button>
            </>
          ) : (
            <Button className="h-7 px-2.5 text-meta" onClick={stop(onOpen)}>
              {tr('board.view')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

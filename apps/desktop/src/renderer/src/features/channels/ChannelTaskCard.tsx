import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import { useState } from 'react'
import { CircleCheck, CirclePause, CircleX, Clock, Hand, ShieldAlert, Unplug, type LucideIcon } from 'lucide-react'
import { Button, cn, DiffStat, Spinner, useToast } from '@/ui'
import { canAnswerInline } from '@/features/panel/inbox/inboxModel'
import type { ChannelMember, ChannelTask, ChannelTaskStatus } from '@/data/types'
import type { ChannelTaskAction } from '../../../../shared/types/channels'
import { formatClock } from './format'
import { agentPlace } from './ChannelMessage'
import { canApprove, canControlTask, canWithdraw, isMyTask } from './teamModel'
import { approvalSummary } from '@/features/session/live/approvals/model'
import { activityTooltip, agoText } from '@/features/session/live/agentActivity'
import { useNow } from '@/features/session/live/stepClock'
import { taskActivity } from './taskActivity'

const STATUS_LABEL: Record<ChannelTaskStatus, TranslationKey> = {
  queued: 'channels.task.queued',
  approval: 'team.task.approval',
  running: 'channels.task.running',
  waiting: 'channels.task.waiting',
  done: 'channels.task.done',
  failed: 'channels.task.failed',
  stopped: 'channels.task.stopped',
}
const STATUS_ICON: Record<Exclude<ChannelTaskStatus, 'running'>, { icon: LucideIcon; className: string }> = {
  queued: { icon: Clock, className: 'text-fg-faint' },
  approval: { icon: Hand, className: 'text-fg-faint' },
  waiting: { icon: ShieldAlert, className: 'text-warn' },
  done: { icon: CircleCheck, className: 'text-success' },
  failed: { icon: CircleX, className: 'text-danger' },
  stopped: { icon: CirclePause, className: 'text-fg-faint' },
}

export interface TaskCardActions {
  onOpenSession: (sessionId: string) => void
  /** 正式模式才有：取消 / 停止 / 重试 */
  onAction?: (taskId: string, action: ChannelTaskAction) => Promise<void>
  /** 等你确认：允许 / 拒绝（engine:answer） */
  onAnswer?: (task: ChannelTask, allow: boolean) => Promise<void>
  /** 追加要求：放一条引用这张卡的引用条 */
  onFollowUp?: (taskId: string) => void
  /** Phase C：当前用户（只有 AI 成员的主人能同意、回答、打开会话） */
  selfId?: string | null
  /** Phase C：等同意的活，主人点同意 / 拒绝 */
  onApprove?: (taskId: string, approve: boolean) => Promise<void>
}

/** 状态文字：团队频道里等同意、等别人确认时要写明是谁 */
function statusText(task: ChannelTask, owner: string, mine: boolean): string {
  if (task.status === 'approval') return tr('team.task.approval', { owner })
  if (task.status === 'waiting' && !mine) return tr('team.task.waitingOwner', { owner })
  return tr(STATUS_LABEL[task.status])
}

const PENDING_KEY: Record<NonNullable<ChannelTask['pendingAction']>, TranslationKey> = {
  cancel: 'team.task.pendingCancel',
  stop: 'team.task.pendingStop',
  retry: 'team.task.pendingRetry',
}

/** 状态后面的补充：排队位置、计划进度、取消 */
function statusDetail(task: ChannelTask, owner: string): string | null {
  if (task.status === 'queued' && task.ahead) return tr('channels.task.ahead', { count: task.ahead })
  if ((task.status === 'running' || task.status === 'waiting') && task.progress)
    return tr('channels.task.progress', { done: task.progress.done, total: task.progress.total })
  if (task.status === 'stopped' && task.note === 'cancelled') return tr('channels.task.cancelled')
  if (task.status === 'stopped' && task.note === 'rejected') return tr('team.task.rejected', { owner })
  if (task.status === 'stopped' && task.note === 'expired') return tr('team.task.expired')
  return null
}

/** 派给 AI 成员的一项活（docs/ui/channels.md §5.2，Phase B 改动见 channels-phase-b.md §6），状态变化时原地更新 */

/** 等你确认的那一项写什么：提问写问题，其余和会话里的审批列表同一套摘要（docs/ui/approval-stack.md §3） */
function waitingText(request: NonNullable<ChannelTask['request']>): string {
  if (request.kind === 'question') return request.questions?.[0]?.question || request.title
  if (request.kind === 'plan') return request.title
  const s = approvalSummary(request, null)
  return [s.label, s.text].filter(Boolean).join(' ') || request.title
}
export function ChannelTaskCard({
  task,
  membersById,
  onOpenSession,
  onAction,
  onAnswer,
  onFollowUp,
  selfId = null,
  onApprove,
  highlight = false,
}: {
  task: ChannelTask
  membersById: ReadonlyMap<string, ChannelMember>
  /** 刚跳过来（提醒点进来、置顶列表）：闪一下 */
  highlight?: boolean
} & TaskCardActions) {
  useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const assignee = membersById.get(task.assigneeId)
  const author = membersById.get(task.authorId)
  const place = agentPlace(assignee)
  const status = task.status === 'running' ? null : STATUS_ICON[task.status]
  // AI 成员的主人：别人的 AI 成员显示「林夏」，我自己的不用写
  const ownerName =
    (assignee?.kind === 'agent' && assignee.ownerName) || membersById.get(task.ownerId ?? '')?.name || '?'
  const mine = isMyTask(task, selfId)
  const control = canControlTask(task, selfId)
  const detail = statusDetail(task, ownerName)
  const pending = task.pendingAction ?? null
  const live = !!onAction
  const inline = task.status === 'waiting' && mine && canAnswerInline(task.request ?? null)
  // 进行中：正在做什么（「几秒前」每秒刷新）
  const activity = taskActivity(task)
  const now = useNow(!!activity)
  const run = (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    fn()
      .catch(error => toast(tr('channels.task.actionFailed', { error: translateMessage((error as Error).message) })))
      .finally(() => setBusy(false))
  }
  const open = task.sessionId && mine ? () => onOpenSession(task.sessionId!) : null
  const meta = [task.round && task.round > 1 ? tr('channels.task.round', { count: task.round }) : '', place]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="conversation-message mt-3 pl-10" data-channel-message={task.id}>
      <article
        aria-label={`${statusText(task, ownerName, mine)}：${task.title}`}
        className={cn(
          'max-w-[560px] rounded-lg border border-line-card bg-surface p-3 shadow-sm',
          (task.status === 'waiting' || task.decision) && 'border-warn/40',
          highlight && 'search-hit',
        )}
      >
        <div className="flex items-center gap-2 text-meta">
          {status ? (
            <status.icon size={14} strokeWidth={1.75} className={cn('shrink-0', status.className)} />
          ) : (
            <Spinner size={13} />
          )}
          <span
            className={cn(
              'shrink-0 font-medium',
              task.status === 'waiting' ? 'text-warn' : task.status === 'failed' ? 'text-danger' : 'text-fg-muted',
            )}
          >
            {statusText(task, ownerName, mine)}
            {detail && <span className="font-normal text-fg-faint"> · {detail}</span>}
          </span>
          <span className="min-w-0 flex-1 truncate text-fg-faint">
            {tr('channels.task.assigned', { author: author?.name ?? '?', assignee: assignee?.name ?? '?' })}
          </span>
          <time dateTime={new Date(task.at).toISOString()} className="shrink-0 text-fg-faint tabular-nums">
            {formatClock(task.at)}
          </time>
        </div>
        <div className="mt-1.5 text-list font-medium break-words text-fg">{task.title}</div>
        {task.summary && <p className="mt-1 text-list break-words text-fg-secondary">{task.summary}</p>}
        {activity && (
          <p
            data-task-activity={activity.line.kind}
            title={activityTooltip(activity.line, activity.steps, activity.seen, now)}
            className="mt-1 truncate text-meta text-fg-muted"
          >
            {activity.line.text}
            {activity.line.kind === 'step' && activity.line.stepId && (
              <span className="text-fg-faint tabular-nums">
                {' '}
                · {agoText(now - activity.seen(activity.line.stepId))}
              </span>
            )}
          </p>
        )}
        {task.status === 'failed' && task.error && (
          <p className="mt-1 line-clamp-3 text-meta break-words text-danger" title={translateMessage(task.error)}>
            {translateMessage(task.error)}
          </p>
        )}
        {task.status === 'waiting' && task.request && (
          <p
            className={cn('mt-1 line-clamp-2 text-meta break-words text-fg-muted', task.request.command && 'font-mono')}
            title={task.request.command ?? task.request.title}
          >
            {waitingText(task.request)}
            {(task.waitingCount ?? 1) > 1 && (
              <span data-waiting-more className="ml-1.5 font-sans text-fg-faint">
                {tr('channels.task.waitingMore', { n: (task.waitingCount ?? 1) - 1 })}
              </span>
            )}
          </p>
        )}
        {task.decision && (
          <p className="mt-1.5 text-list break-words text-warn">
            {tr('channels.task.decision', { text: task.decision })}
          </p>
        )}
        {task.status === 'queued' && task.ownerOffline && !mine && (
          <p className="mt-1 text-meta text-fg-muted">{tr('team.task.ownerOffline', { owner: ownerName })}</p>
        )}
        {pending && <p className="mt-1 text-meta text-fg-faint">{tr(PENDING_KEY[pending])}</p>}
        {task.disconnected && (
          <p className="mt-1 flex items-center gap-1.5 text-meta text-fg-muted">
            <Unplug size={12} strokeWidth={1.75} className="shrink-0" />
            {tr('channels.task.disconnected')}
          </p>
        )}
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-meta text-fg-faint">
          {meta && <span className="min-w-0 truncate">{meta}</span>}
          {task.diff && <DiffStat added={task.diff.added} removed={task.diff.removed} className="shrink-0" />}
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
            {onApprove && canApprove(task, selfId) && (
              <>
                <Button
                  variant="primary"
                  className="h-7 px-2.5 text-meta"
                  disabled={busy}
                  onClick={() => run(() => onApprove(task.id, true))}
                >
                  {tr('team.task.approve')}
                </Button>
                <Button
                  className="h-7 px-2.5 text-meta"
                  disabled={busy}
                  onClick={() => run(() => onApprove(task.id, false))}
                >
                  {tr('team.task.reject')}
                </Button>
              </>
            )}
            {live && canWithdraw(task, selfId) && !pending && (
              <Button
                variant="ghost"
                className="h-7 px-2.5 text-meta"
                disabled={busy}
                onClick={() => run(() => onAction!(task.id, 'cancel'))}
              >
                {tr('channels.task.cancel')}
              </Button>
            )}
            {live && task.status === 'queued' && control && !pending && (
              <Button
                variant="ghost"
                className="h-7 px-2.5 text-meta"
                disabled={busy}
                onClick={() => run(() => onAction!(task.id, 'cancel'))}
              >
                {tr('channels.task.cancel')}
              </Button>
            )}
            {live && task.status === 'running' && control && !pending && (
              <Button
                variant="ghost"
                className="h-7 px-2.5 text-meta"
                disabled={busy}
                onClick={() => run(() => onAction!(task.id, 'stop'))}
              >
                {tr('channels.task.stop')}
              </Button>
            )}
            {live && inline && onAnswer && (
              <>
                <Button
                  variant="primary"
                  className="h-7 px-2.5 text-meta"
                  disabled={busy}
                  onClick={() => run(() => onAnswer(task, true))}
                >
                  {tr('channels.task.allow')}
                </Button>
                {task.request?.canDeny !== false && (
                  <Button
                    className="h-7 px-2.5 text-meta"
                    disabled={busy}
                    onClick={() => run(() => onAnswer(task, false))}
                  >
                    {tr('channels.task.deny')}
                  </Button>
                )}
              </>
            )}
            {live && task.status === 'waiting' && mine && !inline && open && (
              <Button variant="primary" className="h-7 px-2.5 text-meta" onClick={open}>
                {tr('channels.task.answer')}
              </Button>
            )}
            {live && (task.status === 'failed' || task.status === 'stopped') && control && !pending && (
              <Button
                className="h-7 px-2.5 text-meta"
                disabled={busy}
                onClick={() => run(() => onAction!(task.id, 'retry'))}
              >
                {tr('channels.task.retry')}
              </Button>
            )}
            {live && task.status === 'done' && onFollowUp && (
              <Button variant="ghost" className="h-7 px-2.5 text-meta" onClick={() => onFollowUp(task.id)}>
                {tr('channels.task.followUp')}
              </Button>
            )}
            {open && (live || task.status !== 'waiting') && (
              <Button variant="outline" className="h-7 px-2.5 text-meta" onClick={open}>
                {tr('channels.openSession')}
              </Button>
            )}
            {!live && open && task.status === 'waiting' && (
              <Button variant="outline" className="h-7 px-2.5 text-meta" onClick={open}>
                {tr('channels.approve')}
              </Button>
            )}
          </div>
        </div>
      </article>
    </div>
  )
}

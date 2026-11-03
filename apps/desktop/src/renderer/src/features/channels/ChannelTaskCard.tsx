import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import { useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  CircleCheck,
  CirclePause,
  CircleX,
  Clock,
  Hand,
  ShieldAlert,
  Shuffle,
  SquareKanban,
  Unplug,
  type LucideIcon,
} from 'lucide-react'
import { setPage } from '@/features/layout/page'
import { Button, cn, DiffStat, Popover, PopoverItem, Spinner, useToast } from '@/ui'
import { canAnswerInline } from '@/features/panel/inbox/inboxModel'
import type { ChannelMember, ChannelTask, ChannelTaskStatus } from '@/data/types'
import { RELAY_PRESETS, relayRulesOf, type ChannelTaskAction } from '../../../../shared/types/channels'
import { ChannelDialog } from './ChannelDialogs'
import { relayDuration } from './RelayRules'
import { useChannels } from './store'
import { formatClock } from './format'
import { agentPlace, MemberAvatar } from './ChannelMessage'
import { canApprove, canControlTask, canWithdraw, isMyTask } from './teamModel'
import { approvalSummary } from '@/features/session/live/approvals/model'
import { activityTooltip, agoText } from '@/features/session/live/agentActivity'
import { useNow } from '@/features/session/live/stepClock'
import { taskActivity } from './taskActivity'
import { CheckSummary } from '@/features/checks/CheckSummary'

export const STATUS_LABEL: Record<ChannelTaskStatus, TranslationKey> = {
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
  onAction?: (taskId: string, action: ChannelTaskAction, memberId?: string) => Promise<void>
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
  if (task.status === 'queued' && task.relay?.held) return tr('channels.task.heldStatus')
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
export function waitingText(request: NonNullable<ChannelTask['request']>): string {
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
  compact = false,
  attached = false,
  resultShown = false,
  align = 'start',
  thread,
}: {
  task: ChannelTask
  membersById: ReadonlyMap<string, ChannelMember>
  /** 刚跳过来（提醒点进来、置顶列表）：闪一下 */
  highlight?: boolean
  /** 主时间线：缩成一行状态条，点开看详情和操作；要你处理的（等确认、等同意、接力停下）默认展开 */
  compact?: boolean
  /** 挂在派活那条消息下面：标题就是那条消息，不再重复 */
  attached?: boolean
  /** 主时间线上已经有这项活的结果消息：不再重复结果摘要 */
  resultShown?: boolean
  /** 状态条靠哪边（自己派的活靠右） */
  align?: 'start' | 'end'
  /** 状态条旁边的「N 条回复」 */
  thread?: ReactNode
} & TaskCardActions) {
  useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [expandedByUser, setExpanded] = useState<boolean | null>(null)
  const assignee = membersById.get(task.assigneeId)
  const author = membersById.get(task.authorId)
  const place = agentPlace(assignee)
  // AI 互相派活被防刷规则拦下（docs/ui/import-collab.md 第 5 项①）：等你点「继续」或「到此为止」
  const held = task.status === 'queued' ? (task.relay?.held ?? null) : null
  // 停下时的上限：老数据没记，按原来写死的规则（谨慎）；互派次数的时间窗口按频道现在的规则
  const channel = useChannels(s => s.channels.find(c => c.id === task.channelId) ?? null)
  const [editRules, setEditRules] = useState(false)
  const careful = RELAY_PRESETS.careful
  const limit = task.relay?.limit ?? (held === 'pair' ? careful.pair! : held === 'hops' ? careful.hops! : 0)
  const window = relayDuration(channel ? relayRulesOf(channel).windowMinutes : careful.windowMinutes)
  const status = held
    ? { icon: CirclePause, className: 'text-warn' }
    : task.status === 'running'
      ? null
      : STATUS_ICON[task.status]
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
  const meta = [
    task.relay ? tr('channels.task.hop', { count: task.relay.hop }) : '',
    task.round && task.round > 1 ? tr('channels.task.round', { count: task.round }) : '',
    place,
  ]
    .filter(Boolean)
    .join(' · ')
  const dialog = editRules && channel && (
    <ChannelDialog channel={channel} agents={[]} onClose={() => setEditRules(false)} />
  )
  // 要你处理的：等你确认、等主人同意、接力停下等放行
  const attention = !!held || task.status === 'waiting' || task.status === 'approval'
  const expanded = expandedByUser ?? attention
  // 失败、要你决定的事：状态条上标出来
  const flagged = attention || task.status === 'failed' || !!task.decision
  // AI 交给 AI、派活那句不在主时间线上（task_handover 发在串里）：淡化成居中的一行
  const relayLine = compact && !attached && !!task.relay && !attention
  const article = (header: boolean) => (
    <article
      aria-label={`${statusText(task, ownerName, mine)}：${task.title}`}
      className={cn(
        'rounded-lg border border-line-card bg-surface p-3 shadow-sm',
        header ? 'max-w-[560px]' : 'w-[480px] max-w-full',
        (task.status === 'waiting' || task.decision || held) && 'border-warn/40',
        highlight && header && 'search-hit',
      )}
    >
      {header && (
        <div className="mb-1.5 flex items-center gap-2 text-meta">
          {status ? (
            <status.icon size={14} strokeWidth={1.75} className={cn('shrink-0', status.className)} />
          ) : (
            <Spinner size={13} />
          )}
          <span
            className={cn(
              'shrink-0 font-medium',
              task.status === 'waiting' || held
                ? 'text-warn'
                : task.status === 'failed'
                  ? 'text-danger'
                  : 'text-fg-muted',
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
      )}
      {(header || !attached) && <div className="text-list font-medium break-words text-fg">{task.title}</div>}
      {!header && (
        <div className="text-meta text-fg-faint">
          {tr('channels.task.assigned', { author: author?.name ?? '?', assignee: assignee?.name ?? '?' })} ·{' '}
          <time dateTime={new Date(task.at).toISOString()} className="tabular-nums">
            {formatClock(task.at)}
          </time>
        </div>
      )}
      {task.issue && (
        // 从任务看板的事项派来的：点了去看板（docs/ui/channels-collab-v2.md §9）
        <button
          type="button"
          data-task-issue
          onClick={() => setPage('board')}
          className="press mt-1 inline-flex max-w-full items-center gap-1 self-start rounded px-1 text-meta text-fg-muted hover:bg-hover hover:text-fg"
        >
          <SquareKanban size={12} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate">{tr('board.issue.chip', { title: task.issue.title })}</span>
        </button>
      )}
      {task.routedBy && (
        <RoutedLine
          task={task}
          membersById={membersById}
          memberIds={channel?.memberIds ?? []}
          // 结束了的不能改派：改派走的旧卡会停下，留着按钮会把同一件事再派一份（失败、停下的用「重试」）
          canMove={
            live &&
            control &&
            !pending &&
            task.status !== 'done' &&
            task.status !== 'failed' &&
            task.status !== 'stopped' &&
            channel?.scope === 'local'
          }
          busy={busy}
          onMove={memberId => run(() => onAction!(task.id, 'reassign', memberId))}
        />
      )}
      {task.summary && !resultShown && <p className="mt-1 text-list break-words text-fg-secondary">{task.summary}</p>}
      {activity && (
        <p
          data-task-activity={activity.line.kind}
          title={activityTooltip(activity.line, activity.steps, activity.seen, now)}
          className="mt-1 truncate text-meta text-fg-muted"
        >
          {activity.line.text}
          {activity.line.kind === 'step' && activity.line.stepId && (
            <span className="text-fg-faint tabular-nums"> · {agoText(now - activity.seen(activity.line.stepId))}</span>
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
      {held && (
        <p data-relay-held={held} className="mt-1.5 text-meta break-words text-warn">
          {held === 'hops'
            ? tr('channels.task.heldHops', { count: limit })
            : held === 'duration'
              ? tr('channels.task.heldDuration', { time: relayDuration(limit) })
              : tr('channels.task.heldPair', {
                  a: author?.name ?? '?',
                  b: assignee?.name ?? '?',
                  count: limit,
                  window,
                })}
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
      {task.checks && (
        <CheckSummary
          run={task.checks}
          className="mt-1.5"
          onFix={
            onAction
              ? () =>
                  onAction(task.id, 'fix').catch(e =>
                    toast(tr('checks.fixFailed', { error: translateMessage((e as Error).message) })),
                  )
              : undefined
          }
        />
      )}
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
          {live && held && control && (
            <>
              <Button
                variant="primary"
                className="h-7 px-2.5 text-meta"
                disabled={busy}
                onClick={() => run(() => onAction!(task.id, 'continue'))}
              >
                {held === 'hops'
                  ? tr('channels.task.continueHops', { count: limit })
                  : held === 'duration'
                    ? tr('channels.task.continueDuration', { time: relayDuration(limit) })
                    : tr('channels.task.continue')}
              </Button>
              <Button
                className="h-7 px-2.5 text-meta"
                disabled={busy}
                onClick={() => run(() => onAction!(task.id, 'unlimit'))}
              >
                {tr('channels.task.unlimit')}
              </Button>
              <Button
                variant="ghost"
                className="h-7 px-2.5 text-meta"
                disabled={busy}
                onClick={() => run(() => onAction!(task.id, 'cancel'))}
              >
                {tr('channels.task.stopRelay')}
              </Button>
              {channel && channel.scope === 'local' && (
                <Button variant="ghost" className="h-7 px-2.5 text-meta" onClick={() => setEditRules(true)}>
                  {tr('channels.task.editRules')}
                </Button>
              )}
            </>
          )}
          {live && task.status === 'queued' && !held && control && !pending && (
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
  )
  if (!compact)
    return (
      <div className="conversation-message mt-3 pl-10" data-channel-message={task.id}>
        {dialog}
        {article(true)}
      </div>
    )
  const pill = pillTone(task, !!held)
  const chip = (
    <button
      type="button"
      aria-expanded={expanded}
      title={task.title}
      onClick={() => setExpanded(!expanded)}
      className={cn(
        'press inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-0.5 text-meta text-fg-muted hover:border-line-strong hover:text-fg',
        relayLine ? 'border-dashed border-line-strong bg-transparent' : 'bg-surface',
        !relayLine && (task.status === 'failed' ? 'border-danger/50' : flagged ? 'border-warn/50' : 'border-line-card'),
        highlight && 'search-hit',
      )}
    >
      <MemberAvatar member={assignee} size={18} className="rounded-full" />
      <span className="shrink-0">
        {!attached
          ? `${author?.name ?? '?'} → ${assignee?.name ?? '?'}`
          : tr('channels.task.chipTo', { name: assignee?.name ?? '?' })}
      </span>
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] leading-4 font-medium',
          pill,
        )}
      >
        {status ? <status.icon size={11} strokeWidth={2} className="shrink-0" /> : <Spinner size={9} />}
        {statusText(task, ownerName, mine)}
        {detail && <span className="font-normal opacity-80">· {detail}</span>}
      </span>
      {!attached && <span className="min-w-0 truncate text-fg-faint">{task.title}</span>}
      {attached && activity && !expanded && (
        <span className="min-w-0 truncate text-fg-faint">{activity.line.text}</span>
      )}
      {task.diff && task.status === 'done' && (
        <DiffStat added={task.diff.added} removed={task.diff.removed} className="shrink-0" />
      )}
      <ChevronDown
        size={12}
        strokeWidth={2}
        className={cn('shrink-0 text-fg-faint transition-transform', expanded && 'rotate-180')}
      />
    </button>
  )
  return (
    <div
      data-channel-message={task.id}
      data-task-chip={task.status}
      className={cn(
        'group/thread flex max-w-full min-w-0 flex-col gap-1',
        relayLine ? 'conversation-message mt-2 items-center' : align === 'end' ? 'items-end' : 'items-start',
        !attached && !relayLine && 'conversation-message mt-2',
        !attached && !relayLine && align === 'start' && 'pl-[38px]',
        attached && 'mt-1',
      )}
    >
      {dialog}
      <div
        className={cn(
          'flex max-w-full min-w-0 items-center gap-1',
          align === 'end' && !relayLine && 'flex-row-reverse',
        )}
      >
        {chip}
        {/* 讨论串入口不让状态条挤窄（不然「在串里讨论」会一个字一行竖着排），长的是状态条自己截断 */}
        {thread && <div className="max-w-[45%] shrink-0 whitespace-nowrap">{thread}</div>}
      </div>
      {expanded && article(false)}
    </div>
  )
}

/** 状态条上状态那一小块的颜色 */
function pillTone(task: ChannelTask, held: boolean): string {
  if (held || task.status === 'waiting' || task.status === 'approval') return 'bg-warn/15 text-warn-fg'
  if (task.status === 'done') return 'bg-success/15 text-success'
  if (task.status === 'failed') return 'bg-danger/15 text-danger'
  if (task.status === 'running') return 'bg-accent-soft text-accent-fg'
  return 'bg-subtle text-fg-muted'
}

/** 牵头按职责分派的（docs/ui/channels-auto-route.md）：谁分的、为什么；没做完前能改派给别人 */
function RoutedLine({
  task,
  membersById,
  memberIds,
  canMove,
  busy,
  onMove,
}: {
  task: ChannelTask
  membersById: ReadonlyMap<string, ChannelMember>
  memberIds: readonly string[]
  canMove: boolean
  busy: boolean
  onMove: (memberId: string) => void
}) {
  const [menu, setMenu] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const routed = task.routedBy!
  const lead = membersById.get(routed.memberId)?.name ?? '?'
  const others = memberIds
    .map(id => membersById.get(id))
    .filter((m): m is ChannelMember => m?.kind === 'agent' && m.id !== task.assigneeId)
  return (
    <div data-task-routed className="mt-1 flex min-w-0 items-center gap-1 text-meta text-fg-muted">
      <Shuffle size={12} strokeWidth={1.75} className="shrink-0 text-accent-fg" />
      <span className="min-w-0 truncate" title={routed.note}>
        {routed.moved
          ? tr('channels.task.routedMoved')
          : routed.note
            ? tr('channels.task.routedWhy', { name: lead, why: routed.note })
            : tr('channels.task.routed', { name: lead })}
      </span>
      {canMove && others.length > 0 && (
        <>
          <button
            ref={anchor}
            type="button"
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(v => !v)}
            className="press shrink-0 rounded px-1 text-accent-fg hover:bg-hover disabled:opacity-40"
          >
            {tr('channels.task.reassign')}
          </button>
          <Popover
            open={menu}
            onClose={() => setMenu(false)}
            anchor={anchor}
            side="bottom"
            align="start"
            className="w-64"
          >
            {others.map(m => (
              <PopoverItem
                key={m.id}
                icon={<MemberAvatar member={m} size={18} />}
                onClick={() => {
                  setMenu(false)
                  onMove(m.id)
                }}
              >
                {m.name}
              </PopoverItem>
            ))}
          </Popover>
        </>
      )}
    </div>
  )
}

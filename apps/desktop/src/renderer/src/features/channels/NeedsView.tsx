import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '../../i18n/core'
import { useState, type ReactNode } from 'react'
import {
  AlarmClock,
  BellRing,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleX,
  Forward,
  UserCog,
  Workflow,
  Hand,
  HelpCircle,
  ListChecks,
  OctagonPause,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button, cn, IconButton, Popover, PopoverItem, Spinner, useToast } from '@/ui'
import { SEGMENT_TRACK, segmentItem } from '@/ui/Segmented'
import { OPEN_SESSION_EVENT, bridge as engineBridge } from '@/features/engine'
import { relativeTime } from '@/features/engine/labels'
import { canAnswerInline } from '@/features/panel/inbox/inboxModel'
import type { ChannelFollow, ChannelNeed, NeedGone, NeedMark } from '../../../../shared/types/channels'
import type { ChannelAlertAction } from '../../../../shared/channels/alerts'
import { alertActions } from '../../../../shared/channels/alerts'
import { canMarkNeed } from '../../../../shared/channels/needs'
import { channelActions, useChannels } from './store'
import { GateActions } from './GateActions'
import { snooze, snoozeTimes, useNeeds } from './needs'
import { STATUS_LABEL, waitingText } from './ChannelTaskCard'
import { TeamInboxList } from './TeamInbox'
import { visibleInbox } from './teamInboxModel'

/** 看哪些（docs/ui/channels-unify.md §1）：全部、只有我的频道、团队的 */
type Scope = 'all' | 'me' | 'team'
const SCOPES: readonly Scope[] = ['all', 'me', 'team']

const ICON: Record<ChannelNeed['kind'], LucideIcon> = {
  approval: Hand,
  proposal: Forward,
  member: UserCog,
  held: OctagonPause,
  decision: HelpCircle,
  checks: ListChecks,
  failed: CircleX,
  alert: BellRing,
  flow: Workflow,
}

const KIND_LABEL: Record<ChannelNeed['kind'], TranslationKey> = {
  approval: 'needs.kind.approval',
  proposal: 'needs.kind.proposal',
  member: 'needs.kind.member',
  held: 'needs.kind.held',
  decision: 'needs.kind.decision',
  checks: 'needs.kind.checks',
  failed: 'needs.kind.failed',
  alert: 'needs.kind.alert',
  flow: 'needs.kind.flow',
}

const ALERT_LABEL: Record<ChannelAlertAction, TranslationKey> = {
  hold: 'alerts.action.hold',
  continue: 'alerts.action.continue',
  open: 'alerts.action.open',
  stop: 'alerts.action.stop',
  reassign: 'alerts.action.reassign',
  cancel: 'alerts.action.cancel',
  dismiss: 'alerts.action.dismiss',
}

const GONE_LABEL: Record<NeedGone, TranslationKey> = {
  session: 'needs.gone.session',
  member: 'needs.gone.member',
  task: 'needs.gone.task',
}

const markOf = ({ channelId, key, sig }: ChannelNeed): NeedMark => ({ channelId, key, sig })

const openSession = (sessionId: string) =>
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }))

/** 跳到频道里那条消息 / 那张卡 */
const show = (channelId: string, id: string | null | undefined) => {
  channelActions.openNeeds(false)
  if (id) void channelActions.focusMessage(channelId, id)
  else channelActions.select(channelId)
}

/** 稍后处理：1 小时后、明天 9 点 */
function Later({ need }: { need: ChannelNeed }) {
  useI18n()
  const [open, setOpen] = useState(false)
  const times = snoozeTimes()
  return (
    <div className="relative">
      <IconButton
        icon={AlarmClock}
        label={tr('needs.later')}
        size={26}
        iconSize={14}
        onClick={() => setOpen(v => !v)}
      />
      <Popover open={open} onClose={() => setOpen(false)} side="bottom" align="end" className="w-44 p-1">
        <PopoverItem
          onClick={() => {
            snooze(need, times.hour)
            setOpen(false)
          }}
        >
          {tr('needs.laterHour')}
        </PopoverItem>
        <PopoverItem
          onClick={() => {
            snooze(need, times.tomorrow)
            setOpen(false)
          }}
        >
          {tr('needs.laterTomorrow')}
        </PopoverItem>
      </Popover>
    </div>
  )
}

function Row({
  icon: Icon,
  where,
  text,
  detail,
  at,
  actions,
  data,
  tag,
}: {
  icon: LucideIcon
  where: string
  text: string
  detail?: ReactNode
  at: number
  actions: ReactNode
  data: string
  /** 找不到目标的原因（§2.1） */
  tag?: string
}) {
  useI18n()
  return (
    <li data-need={data} className="flex min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-hover">
      <Icon size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 text-meta text-fg-faint">
          <span className="min-w-0 truncate">{where}</span>
          <span className="shrink-0 tabular-nums">{relativeTime(at)}</span>
        </div>
        <p className={`mt-0.5 text-list break-words ${tag ? 'text-fg-muted' : 'text-fg'}`}>{text}</p>
        {detail && <p className="mt-0.5 text-meta break-words text-fg-muted">{detail}</p>}
        {tag && (
          <span
            data-need-gone=""
            className="mt-1 inline-flex items-center rounded-md border border-line px-1.5 text-meta text-warn"
          >
            {tag}
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
    </li>
  )
}

/**
 * 「需要你」（docs/ui/channels-collab-v2.md §2）：所有本机频道里等你处理的事，能就地处理的直接处理；
 * 下面是跟进中的活。代替频道页的时间线显示。
 * 团队的收件箱也列在这里（docs/ui/channels-unify.md §1），能按「全部 / 只有我 / 团队」筛
 */
export function NeedsView() {
  useI18n()
  const toast = useToast()
  const { needs, gone, done, snoozed, following } = useNeeds()
  const channels = useChannels(s => s.channels)
  const members = useChannels(s => s.members)
  const [busy, setBusy] = useState<string | null>(null)
  const [goneOpen, setGoneOpen] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [scope, setScope] = useState<Scope>('all')
  const teamUi = useChannels(s => s.inboxSupported)
  const inbox = useChannels(s => s.inbox)
  const now = Date.now()
  const teamCount = teamUi ? visibleInbox(inbox, now).length : 0
  const shown: Scope = teamUi ? scope : 'me'
  const counts: Record<Scope, number> = { all: needs.length + teamCount, me: needs.length, team: teamCount }
  const channelName = (id: string) => channels.find(c => c.id === id)?.name ?? '?'
  // 删掉的成员不写名字（找不到目标的那一行标签里写了「成员已删除」）
  const memberName = (id: string | null) => (id ? (members.find(m => m.id === id)?.name ?? null) : null)
  const where = (n: { channelId: string; memberId: string | null }) =>
    [`# ${channelName(n.channelId)}`, memberName(n.memberId)].filter(Boolean).join(' · ')
  const fail = (e: unknown) => toast(tr('needs.failed', { error: translateMessage((e as Error).message) }))
  const run = (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    fn()
      .catch(fail)
      .finally(() => setBusy(null))
  }
  const small = 'h-7 px-2.5 text-meta'
  /** 标为已处理（§2.1），提示条上能撤销 */
  const mark = (list: ChannelNeed[]) => {
    const items = list.filter(canMarkNeed).map(markOf)
    if (!items.length) return
    channelActions.markNeeds(items, true).then(
      () =>
        toast(items.length === 1 ? tr('needs.marked') : tr('needs.markedMany', { count: items.length }), {
          action: { label: tr('needs.undo'), run: () => void channelActions.markNeeds(items, false).catch(fail) },
        }),
      fail,
    )
  }
  const markable = [...needs, ...gone].filter(canMarkNeed)

  const actionsOf = (n: ChannelNeed): ReactNode => {
    const off = busy === n.key
    const view = (
      <Button variant="ghost" className={small} onClick={() => show(n.channelId, n.taskId ?? n.messageId)}>
        {tr('needs.view')}
      </Button>
    )
    // 找不到目标：只留查看和标为已处理；会话不在的失败还能在新会话重试（重试时会话不在会新开）
    if (n.gone)
      return (
        <>
          {n.kind === 'failed' && n.gone === 'session' && (
            <Button
              className={small}
              disabled={off}
              onClick={() => run(n.key, () => channelActions.task(n.taskId!, 'retry'))}
            >
              {tr('needs.retryNew')}
            </Button>
          )}
          {view}
          <Button variant="primary" className={small} onClick={() => mark([n])}>
            {tr('needs.markDone')}
          </Button>
        </>
      )
    switch (n.kind) {
      case 'approval':
        return canAnswerInline(n.request ?? null) && n.sessionId ? (
          <>
            <Button
              variant="primary"
              className={small}
              disabled={off}
              onClick={() =>
                run(n.key, () => engineBridge!.answer(n.sessionId!, n.request!.requestId, { type: 'allow' }))
              }
            >
              {tr('needs.allow')}
            </Button>
            <Button
              className={small}
              disabled={off}
              onClick={() =>
                run(n.key, () => engineBridge!.answer(n.sessionId!, n.request!.requestId, { type: 'deny' }))
              }
            >
              {tr('needs.deny')}
            </Button>
          </>
        ) : (
          <Button variant="primary" className={small} disabled={!n.sessionId} onClick={() => openSession(n.sessionId!)}>
            {tr('needs.answer')}
          </Button>
        )
      case 'proposal':
        return (
          <>
            <Button
              variant="primary"
              className={small}
              disabled={off}
              onClick={() => run(n.key, () => channelActions.proposal(n.channelId, n.messageId!, true))}
            >
              {tr('channels.proposal.send')}
            </Button>
            <Button
              className={small}
              disabled={off}
              onClick={() => run(n.key, () => channelActions.proposal(n.channelId, n.messageId!, false))}
            >
              {tr('channels.proposal.dismiss')}
            </Button>
          </>
        )
      case 'member':
        return (
          <>
            <Button
              variant="primary"
              className={small}
              disabled={off}
              onClick={() => run(n.key, () => channelActions.memberChange(n.channelId, n.messageId!, 'accept'))}
            >
              {tr('channels.memberChange.agree')}
            </Button>
            <Button
              className={small}
              disabled={off}
              onClick={() => run(n.key, () => channelActions.memberChange(n.channelId, n.messageId!, 'dismiss'))}
            >
              {tr('channels.proposal.dismiss')}
            </Button>
            {view}
          </>
        )
      case 'held':
        return (
          <>
            <Button
              variant="primary"
              className={small}
              disabled={off}
              onClick={() => run(n.key, () => channelActions.task(n.taskId!, 'continue'))}
            >
              {tr('needs.continue')}
            </Button>
            {view}
          </>
        )
      case 'decision':
        return (
          <Button
            variant="primary"
            className={small}
            onClick={() => {
              channelActions.openNeeds(false)
              channelActions.select(n.channelId)
              channelActions.openThread(n.channelId, n.taskId!)
            }}
          >
            {tr('needs.answer')}
          </Button>
        )
      case 'checks':
        return (
          <>
            <Button
              variant="primary"
              className={small}
              disabled={off}
              onClick={() => run(n.key, () => channelActions.task(n.taskId!, 'fix'))}
            >
              {tr('checks.fix')}
            </Button>
            {view}
          </>
        )
      case 'failed':
        return (
          <>
            <Button
              variant="primary"
              className={small}
              disabled={off}
              onClick={() => run(n.key, () => channelActions.task(n.taskId!, 'retry'))}
            >
              {tr('needs.retry')}
            </Button>
            {view}
          </>
        )
      case 'flow':
        return n.pause === 'gate' && n.stepId ? (
          <>
            <GateActions
              disabled={off}
              onApprove={() =>
                run(n.key, () =>
                  channelActions.flow(n.channelId, {
                    type: 'gate',
                    messageId: n.messageId!,
                    stepId: n.stepId!,
                    decision: 'approve',
                  }),
                )
              }
              onReject={note =>
                run(n.key, () =>
                  channelActions.flow(n.channelId, {
                    type: 'gate',
                    messageId: n.messageId!,
                    stepId: n.stepId!,
                    decision: 'reject',
                    note,
                  }),
                )
              }
            />
            {view}
          </>
        ) : (
          view
        )
      case 'alert':
        return (
          <>
            {alertActions(n.rule ?? 'digest').map(action => (
              <Button
                key={action}
                variant={action === alertActions(n.rule ?? 'digest')[0] ? 'primary' : 'outline'}
                className={small}
                disabled={off}
                onClick={() => run(n.key, () => channelActions.alert(n.channelId, n.messageId!, action))}
              >
                {tr(ALERT_LABEL[action])}
              </Button>
            ))}
            {view}
          </>
        )
    }
  }

  const detailOf = (n: ChannelNeed): string | null => {
    if (n.kind === 'approval' && n.request) return waitingText(n.request)
    if (n.kind === 'held') return tr('needs.heldDetail')
    if (n.kind === 'checks')
      return tr('needs.checksDetail', {
        items: [n.detail, n.findings ? tr('checks.findings', { count: n.findings }) : null].filter(Boolean).join(' · '),
      })
    if (n.kind === 'flow' && n.pause === 'gate') return tr('channels.flow.gate.detail')
    if (n.kind === 'flow' && n.pause === 'ask') return tr('channels.flow.needsAsk', { q: n.detail ?? '' })
    if (n.kind === 'flow')
      return tr(
        n.pause === 'limit' && n.limit
          ? `channels.flow.pause.limit.${n.limit}`
          : n.pause && n.pause !== 'gate' && n.pause !== 'ask'
            ? `channels.flow.pause.${n.pause}`
            : 'channels.flow.needsDraft',
      )
    if (n.kind === 'failed' || n.kind === 'decision') return n.detail ? translateMessage(n.detail) : null
    return null
  }

  return (
    <section
      aria-label={tr('needs.title')}
      data-needs-view=""
      className="conversation-view flex min-w-[360px] flex-1 flex-col"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-5">
        <h2 className="min-w-0 flex-1 truncate text-ui font-medium text-fg">{tr('needs.title')}</h2>
        {teamUi && !showDone && (
          <div role="radiogroup" aria-label={tr('unify.needs.filter')} className={SEGMENT_TRACK}>
            {SCOPES.map(s => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={shown === s}
                data-needs-scope={s}
                onClick={() => setScope(s)}
                className={cn(segmentItem(shown === s), 'px-2.5 text-meta')}
              >
                {tr(`unify.needs.filter.${s}`, { count: counts[s] })}
              </button>
            ))}
          </div>
        )}
        {!showDone && shown !== 'team' && markable.length > 0 && (
          <div className="relative">
            <Button variant="ghost" className={small} onClick={() => setConfirmAll(v => !v)}>
              <CheckCheck size={14} strokeWidth={1.6} />
              {tr('needs.markAll')}
            </Button>
            <Popover
              open={confirmAll}
              onClose={() => setConfirmAll(false)}
              side="bottom"
              align="end"
              className="w-72 p-3"
            >
              <p className="text-list text-fg">{tr('needs.markAllConfirm', { count: markable.length })}</p>
              <p className="mt-1 mb-3 text-meta text-fg-muted">{tr('needs.markAllHint')}</p>
              <div className="flex justify-end gap-1.5">
                <Button variant="ghost" className={small} onClick={() => setConfirmAll(false)}>
                  {tr('needs.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className={small}
                  onClick={() => {
                    setConfirmAll(false)
                    mark(markable)
                  }}
                >
                  {tr('needs.markDone')}
                </Button>
              </div>
            </Popover>
          </div>
        )}
        <IconButton
          icon={X}
          label={tr('needs.close')}
          size={28}
          iconSize={15}
          onClick={() => channelActions.openNeeds(false)}
        />
      </div>
      <div className="selectable min-h-0 flex-1 overflow-y-auto px-3 pb-6 [scrollbar-width:thin]">
        {showDone ? (
          <div className="mx-auto flex max-w-3xl flex-col">
            <h3 className="flex items-center gap-1 px-1 pb-1 text-label font-medium text-fg-muted">
              <IconButton
                icon={ChevronLeft}
                label={tr('needs.back')}
                size={24}
                iconSize={14}
                onClick={() => setShowDone(false)}
              />
              {tr('needs.doneTitle', { count: done.length })}
            </h3>
            {done.length === 0 ? (
              <p className="px-3 py-4 text-list text-fg-faint">{tr('needs.doneEmpty')}</p>
            ) : (
              <ul className="flex flex-col">
                {done.map(n => (
                  <Row
                    key={n.key}
                    data="done"
                    icon={ICON[n.kind]}
                    where={`${tr(KIND_LABEL[n.kind])} · ${where(n)}`}
                    text={n.text}
                    detail={detailOf(n)}
                    tag={n.gone ? tr(GONE_LABEL[n.gone]) : undefined}
                    at={n.at}
                    actions={
                      <>
                        <Button
                          className={small}
                          onClick={() => void channelActions.markNeeds([markOf(n)], false).catch(fail)}
                        >
                          {tr('needs.restore')}
                        </Button>
                        <Button
                          variant="ghost"
                          className={small}
                          onClick={() => show(n.channelId, n.taskId ?? n.messageId)}
                        >
                          {tr('needs.view')}
                        </Button>
                      </>
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div hidden={shown === 'team'}>
              <h3 className="flex items-baseline gap-2 px-3 pb-1 text-label font-medium text-fg-muted">
                <span className="min-w-0 flex-1">
                  {tr('needs.todo', { count: needs.length })}
                  {snoozed > 0 && <span className="ml-2 text-fg-faint">{tr('needs.snoozed', { count: snoozed })}</span>}
                </span>
                {done.length > 0 && (
                  <button
                    type="button"
                    data-needs-done-link=""
                    className="inline-flex shrink-0 items-center font-normal text-fg-faint hover:text-fg-muted"
                    onClick={() => setShowDone(true)}
                  >
                    {tr('needs.doneLink', { count: done.length })}
                    <ChevronRight size={12} />
                  </button>
                )}
              </h3>
              {needs.length === 0 ? (
                <p className="px-3 py-4 text-list text-fg-faint">{tr('needs.empty')}</p>
              ) : (
                <ul className="flex flex-col">
                  {needs.map(n => (
                    <Row
                      key={n.key}
                      data={n.kind}
                      icon={ICON[n.kind]}
                      where={`${tr(KIND_LABEL[n.kind])} · ${where(n)}`}
                      text={n.text}
                      detail={detailOf(n)}
                      at={n.at}
                      actions={
                        <>
                          {busy === n.key && <Spinner size={12} />}
                          {actionsOf(n)}
                          {canMarkNeed(n) && (
                            <IconButton
                              icon={Check}
                              label={tr('needs.markDone')}
                              size={26}
                              iconSize={14}
                              onClick={() => mark([n])}
                            />
                          )}
                          <Later need={n} />
                        </>
                      }
                    />
                  ))}
                </ul>
              )}
              {gone.length > 0 && (
                <div data-needs-gone="" className="mt-1 border-t border-line-subtle pt-1.5">
                  <div className="flex items-center gap-2 rounded-lg px-3 py-1 text-meta text-fg-muted hover:bg-hover">
                    <button
                      type="button"
                      aria-expanded={goneOpen}
                      className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                      onClick={() => setGoneOpen(v => !v)}
                    >
                      <ChevronRight
                        size={12}
                        className={`shrink-0 transition-transform ${goneOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="truncate">{tr('needs.goneGroup', { count: gone.length })}</span>
                    </button>
                    <Button variant="ghost" className={small} onClick={() => mark(gone)}>
                      {tr('needs.markAll')}
                    </Button>
                  </div>
                  {goneOpen && (
                    <ul className="flex flex-col">
                      {gone.map(n => (
                        <Row
                          key={n.key}
                          data={n.kind}
                          icon={ICON[n.kind]}
                          where={`${tr(KIND_LABEL[n.kind])} · ${where(n)}`}
                          text={n.text}
                          detail={detailOf(n)}
                          tag={tr(GONE_LABEL[n.gone!])}
                          at={n.at}
                          actions={
                            <>
                              {busy === n.key && <Spinner size={12} />}
                              {actionsOf(n)}
                            </>
                          }
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            {teamUi && shown !== 'me' && (
              <div data-needs-team="">
                <h3 className="px-3 pb-1 text-label font-medium text-fg-muted">
                  {tr('unify.needs.team', { count: teamCount })}
                </h3>
                <div className="px-3">
                  <TeamInboxList now={now} onError={fail} />
                </div>
              </div>
            )}
            <div hidden={shown === 'team'}>
              <h3 className="px-3 pb-1 text-label font-medium text-fg-muted">
                {tr('needs.following', { count: following.length })}
              </h3>
              {following.length === 0 ? (
                <p className="px-3 py-4 text-list text-fg-faint">{tr('needs.followingEmpty')}</p>
              ) : (
                <ul className="flex flex-col">
                  {following.map((f: ChannelFollow) => (
                    <Row
                      key={f.taskId}
                      data="following"
                      icon={CircleDashed}
                      where={where(f)}
                      text={f.title}
                      detail={tr(STATUS_LABEL[f.status])}
                      at={f.at}
                      actions={
                        <>
                          {f.sessionId && (
                            <Button className={small} onClick={() => openSession(f.sessionId!)}>
                              {tr('needs.openSession')}
                            </Button>
                          )}
                          <Button variant="ghost" className={small} onClick={() => show(f.channelId, f.taskId)}>
                            {tr('needs.view')}
                          </Button>
                        </>
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

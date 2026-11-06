import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Hash, Info, UserMinus, UserPlus, Users } from 'lucide-react'
import { Spinner, useToast } from '@/ui'
import type {
  Channel,
  ChannelEvent,
  ChannelMember,
  ChannelMessage,
  ChannelTask,
  ChannelTextMessage,
} from '@/data/types'
import { buildTimeline, tasksWithResult, type FlowPart } from './model'
import { formatClock, formatDay } from './format'
import { isSelfAuthor, MessageGroup, ThreadRow, type Quotable } from './ChannelMessage'
import { threadStats } from '../../../../shared/channels/threads'
import { ChannelTaskCard, type TaskCardActions } from './ChannelTaskCard'
import { ChannelFlowCard } from './ChannelFlowCard'
import { PlannerHandoff, PlannerRow } from './PlannerRow'
import { channelActions, useChannels } from './store'
import { useFollowBottom } from './useFollowBottom'

/** 离底部这么近时，新消息到来自动跟到底部 */
const STICK_PX = 80

function eventText(event: ChannelEvent, name: (id: string | null | undefined) => string, team: boolean): string {
  switch (event.event) {
    case 'joined':
      return tr(team ? 'team.event.joined' : 'channels.event.joined', { name: name(event.actorId) })
    case 'added':
      return tr('channels.event.added', { actor: name(event.actorId), name: name(event.targetId) })
    case 'removed':
      // 团队频道里被移出的是真人：移出了团队；本机频道里是 AI 成员移出频道
      return tr(team ? 'team.event.removed' : 'channels.event.removed', {
        actor: name(event.actorId),
        name: name(event.targetId),
      })
    case 'left':
      return tr('team.event.left', { name: name(event.actorId) })
    case 'agentAdded':
      return tr('team.event.agentAdded', { actor: name(event.actorId), name: name(event.targetId) })
    case 'agentRemoved':
      return tr('team.event.agentRemoved', { actor: name(event.actorId), name: name(event.targetId) })
    case 'renamed':
      return tr('channels.event.renamed', { actor: name(event.actorId), value: event.value ?? '' })
    case 'topic':
      return tr('channels.event.topic', { actor: name(event.actorId), value: event.value ?? '' })
    case 'archived':
      return tr('channels.event.archived', { actor: name(event.actorId) })
    case 'restored':
      return tr('channels.event.restored', { actor: name(event.actorId) })
  }
}

/** 同一天里隔了一阵的时间：居中的一小行字，不画线 */
function TimeMark({ at }: { at: number }) {
  return (
    <div className="conversation-message mt-4 mb-1 flex justify-center">
      <time dateTime={new Date(at).toISOString()} className="text-meta text-fg-faint tabular-nums">
        {formatClock(at)}
      </time>
    </div>
  )
}

function Divider({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <div role="separator" aria-label={label} className="conversation-message my-3 flex items-center gap-3">
      <span className={accent ? 'h-px flex-1 bg-accent' : 'h-px flex-1 bg-line-subtle'} />
      <span className={accent ? 'shrink-0 text-meta font-medium text-accent-fg' : 'shrink-0 text-meta text-fg-faint'}>
        {label}
      </span>
      <span className={accent ? 'h-px flex-1 bg-accent' : 'h-px flex-1 bg-line-subtle'} />
    </div>
  )
}

/** 时间线（docs/ui/channels.md §5）：开头介绍、日期 / 新消息分隔、消息组、任务卡、事件、处理中提示 */
export function ChannelTimeline({
  channel,
  messages,
  members,
  channelMembers,
  newFrom,
  more,
  onLoadOlder,
  onReply,
  taskActions,
  onThread,
}: {
  channel: Channel
  messages: readonly ChannelMessage[]
  members: readonly ChannelMember[]
  channelMembers: readonly ChannelMember[]
  newFrom: number | null
  /** 前面还有更早的消息（正式模式分页） */
  more?: boolean
  onLoadOlder?: () => Promise<void>
  /** 没有时不能回复（归档的频道只读） */
  onReply?: (id: string) => void
  taskActions: TaskCardActions
  /** 打开讨论串（docs/ui/channels-collab-v2.md §3）；团队频道没有 */
  onThread?: (id: string) => void
}) {
  useI18n()
  const scroller = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const follow = useFollowBottom(scroller, nearBottom)
  const [highlight, setHighlight] = useState<string | null>(null)
  const rows = useMemo(() => buildTimeline(messages, { newFrom }), [messages, newFrom])
  const threads = useMemo(() => threadStats(messages), [messages])
  const results = useMemo(() => tasksWithResult(messages), [messages])
  const membersById = useMemo(() => new Map(members.map(m => [m.id, m])), [members])
  const messagesById = useMemo(
    () => new Map(messages.filter((m): m is Quotable => m.kind !== 'event').map(m => [m.id, m])),
    [messages],
  )
  const toast = useToast()
  const [loadingOlder, setLoadingOlder] = useState(false)
  // 组件不按频道重建：读更早消息的请求记下是哪个频道的，换了频道就不再管它
  const channelId = useRef(channel.id)
  channelId.current = channel.id
  const loadOlder = () => {
    const el = scroller.current
    if (!onLoadOlder || !el || loadingOlder) return
    const from = el.scrollHeight - el.scrollTop
    const id = channel.id
    setLoadingOlder(true)
    void onLoadOlder()
      .then(
        () =>
          // 读进更早的消息后保持原来看到的位置
          requestAnimationFrame(() => {
            if (scroller.current && channelId.current === id)
              scroller.current.scrollTop = scroller.current.scrollHeight - from
          }),
        error => {
          if (channelId.current === id)
            toast(
              tr('channels.loadOlderFailed', { error: translateMessage((error as Error)?.message ?? String(error)) }),
            )
        },
      )
      .finally(() => {
        if (channelId.current === id) setLoadingOlder(false)
      })
  }
  const name = (id: string | null | undefined) => (id ? membersById.get(id)?.name : undefined) ?? '?'
  // 正在拟计划的成员：进度写在流程卡里，底部不再说一遍
  const planning = useMemo(() => {
    const list: ChannelTask[] = []
    for (const m of messages)
      if (m.kind === 'task' && m.flow?.stepId === '' && (m.status === 'running' || m.status === 'waiting')) list.push(m)
    return list
  }, [messages])
  const working = channelMembers.filter(
    m =>
      m.kind === 'agent' &&
      m.status === 'running' &&
      !planning.some(
        t => t.assigneeId === m.id && (t.title === m.task || (!!t.sessionId && t.sessionId === m.sessionId)),
      ),
  )
  const now = Date.now()

  // 换频道：有新消息分隔线就停在它附近，否则到底部
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const divider = el.querySelector<HTMLElement>('[data-new-divider]')
    el.scrollTop = divider ? Math.max(0, divider.offsetTop - 24) : el.scrollHeight
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
    setHighlight(null)
    setLoadingOlder(false)
  }, [channel.id])

  // 新消息：原本就在底部附近，或是自己刚发的，就跟到底部。
  // 正式模式进入频道后消息才读进来（0 → N 条）：和换频道一样，停在新消息分隔线或底部
  const lastCount = useRef(messages.length)
  useLayoutEffect(() => {
    const el = scroller.current,
      last = messages[messages.length - 1]
    const first = lastCount.current === 0
    lastCount.current = messages.length
    if (!el) return
    const divider = first ? el.querySelector<HTMLElement>('[data-new-divider]') : null
    if (divider) {
      el.scrollTop = Math.max(0, divider.offsetTop - 24)
      nearBottom.current = false
      return
    }
    const author = last?.kind === 'message' ? membersById.get(last.authorId) : undefined
    const mine = author?.kind === 'human' && !!author.you
    if (first || nearBottom.current || mine) el.scrollTop = el.scrollHeight
  }, [messages.length])

  useEffect(() => {
    if (!highlight) return
    const t = window.setTimeout(() => setHighlight(null), 1600)
    return () => window.clearTimeout(t)
  }, [highlight])

  // 只移动时间线自己的滚动区，不用 scrollIntoView（会连带移动外层）
  const jump = (id: string) => {
    const el = scroller.current,
      target = el?.querySelector<HTMLElement>(`[data-channel-message="${CSS.escape(id)}"]`)
    if (!el || !target) return
    const box = el.getBoundingClientRect(),
      row = target.getBoundingClientRect()
    el.scrollTop += row.top - box.top - (box.height - row.height) / 2
    setHighlight(id)
  }

  // 置顶列表、提醒点进来：跳到那条消息。消息还没读进来时等着；读进来后找不到（太早的消息）也清掉
  const focus = useChannels(s => s.focus)
  useEffect(() => {
    if (!focus || focus.channelId !== channel.id || !messages.length) return
    const frame = requestAnimationFrame(() => {
      jump(focus.messageId)
      channelActions.focusDone()
    })
    return () => cancelAnimationFrame(frame)
  }, [focus, channel.id, messages.length])

  const pinned = useMemo(() => new Set(channel.pinned ?? []), [channel.pinned])
  const selfId = taskActions.selfId ?? null

  /** 任务卡的一行状态条：挂在派活那条消息下面时 attached，自己派的靠右 */
  const taskChip = (task: ChannelTask, attached: boolean) => (
    <ChannelTaskCard
      key={task.id}
      task={task}
      membersById={membersById}
      highlight={highlight === task.id}
      compact
      attached={attached}
      resultShown={results.has(task.id)}
      align={isSelfAuthor(membersById.get(task.authorId), task.authorId, selfId) ? 'end' : 'start'}
      thread={
        onThread && (
          <ThreadRow rootId={task.id} stats={threads} membersById={membersById} onOpen={onThread} idle={!!onReply} />
        )
      }
      {...taskActions}
    />
  )

  const flowCard = (message: ChannelTextMessage, attached: boolean, part: FlowPart = 'whole') => (
    <ChannelFlowCard
      key={message.id}
      message={message}
      part={part}
      membersById={membersById}
      channelMembers={channelMembers}
      readOnly={!!channel.archivedAt || channel.scope !== 'local'}
      highlight={highlight === message.id}
      attached={attached}
      onOpenSession={channel.scope === 'local' ? taskActions.onOpenSession : undefined}
    />
  )

  return (
    <div
      ref={scroller}
      role="log"
      aria-label={`# ${channel.name}`}
      {...follow}
      className="conversation-scroller selectable relative min-h-0 flex-1 overflow-y-auto"
    >
      <div className="conversation-inset conversation-reading flex flex-col pt-6 pb-4">
        <header className="conversation-message mb-2 flex flex-col gap-2">
          <span className="flex size-11 items-center justify-center rounded-xl bg-subtle text-fg-muted">
            {channel.scope === 'team' ? <Users size={20} strokeWidth={1.5} /> : <Hash size={20} strokeWidth={1.5} />}
          </span>
          <h2 className="text-section font-semibold text-fg">{tr('channels.intro.title', { name: channel.name })}</h2>
          {channel.topic && <p className="text-list text-fg-muted">{channel.topic}</p>}
          {messages.length === 0 && <p className="text-list text-fg-faint">{tr('channels.intro.noMessages')}</p>}
        </header>
        {more && (
          <div className="conversation-message mb-2 flex justify-center">
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingOlder}
              className="inline-flex h-7 items-center gap-2 rounded-md px-3 text-meta text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-60"
            >
              {loadingOlder && <Spinner size={11} />}
              {tr('channels.loadOlder')}
            </button>
          </div>
        )}
        {rows.map(row => {
          switch (row.kind) {
            case 'day':
              return <Divider key={row.key} label={`${formatDay(row.at, now)} ${formatClock(row.first)}`} />
            case 'time':
              return <TimeMark key={row.key} at={row.at} />
            case 'new':
              return (
                <div key={row.key} data-new-divider>
                  <Divider label={tr('channels.newMessages')} accent />
                </div>
              )
            case 'event':
              return (
                <div
                  key={row.key}
                  data-channel-message={row.message.id}
                  className="conversation-message mt-3 flex items-center justify-center gap-1.5 text-meta text-fg-faint"
                >
                  {row.message.event === 'joined' ||
                  row.message.event === 'added' ||
                  row.message.event === 'agentAdded' ? (
                    <UserPlus size={13} strokeWidth={1.5} />
                  ) : row.message.event === 'removed' ||
                    row.message.event === 'left' ||
                    row.message.event === 'agentRemoved' ? (
                    <UserMinus size={13} strokeWidth={1.5} />
                  ) : (
                    <Info size={13} strokeWidth={1.5} />
                  )}
                  <span className="min-w-0 truncate">{eventText(row.message, name, channel.scope === 'team')}</span>
                </div>
              )
            case 'task':
              return taskChip(row.message, false)
            case 'flow':
              // 拟计划的流程是拟计划的成员在说话：放在左边它的头像下面；手写的流程照常单独一张卡
              return row.message.flow?.planner ? (
                <PlannerRow key={row.key} message={row.message} part={row.part} raw={row.raw} membersById={membersById}>
                  {flowCard(row.message, true, row.part)}
                </PlannerRow>
              ) : (
                flowCard(row.message, false)
              )
            case 'group':
              return (
                <MessageGroup
                  key={row.key}
                  items={row.items}
                  selfId={selfId}
                  renderBelow={
                    row.tasks || row.flows
                      ? m => (
                          <>
                            {row.tasks?.[m.id]?.map(task => taskChip(task, true))}
                            {row.flows?.[m.id]?.map(flow => (
                              <PlannerHandoff key={flow.id} flow={flow} membersById={membersById} onJump={jump} />
                            ))}
                          </>
                        )
                      : undefined
                  }
                  membersById={membersById}
                  channelMembers={channelMembers}
                  messagesById={messagesById}
                  highlight={highlight}
                  onReply={onReply}
                  onJump={jump}
                  threads={threads}
                  onThread={onThread}
                  pinned={pinned}
                  onPin={
                    channel.scope === 'local' && !channel.archivedAt
                      ? (id, on) => channelActions.pin(channel.id, id, on)
                      : undefined
                  }
                />
              )
          }
        })}
        {working.length > 0 && (
          <div role="status" className="conversation-message mt-4 flex flex-col gap-1 pl-[38px]">
            {working.map(m => (
              <div key={m.id} className="flex min-w-0 items-center gap-2 text-meta text-fg-muted">
                <Spinner size={12} />
                <span className="min-w-0 truncate">
                  {m.kind === 'agent' && m.task
                    ? tr('channels.working', { name: m.name, task: m.task })
                    : tr('channels.workingNoTask', { name: m.name })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

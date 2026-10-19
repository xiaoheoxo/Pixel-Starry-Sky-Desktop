import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive } from 'lucide-react'
import { Button, CollapsibleSlot, useToast } from '@/ui'
import { OPEN_SESSION_EVENT, bridge as engineBridge } from '@/features/engine'
import type { AgentMember, Channel, ChannelTask } from '@/data/types'
import { channelActions, channelsLive, selectedChannel, selfIdIn, useChannels } from './store'
import type { Quotable } from './ChannelMessage'
import type { TaskCardActions } from './ChannelTaskCard'
import { ChannelList } from './ChannelList'
import { ChannelTimeline } from './ChannelTimeline'
import { ChannelComposer } from './ChannelComposer'
import { ChannelMembers } from './ChannelMembers'
import { ChannelsEmpty } from './ChannelsEmpty'
import { myRole } from './teamModel'

const MEMBERS_WIDTH = 300
const NO_MESSAGES: never[] = []

/** 「打开会话」：交给现有的打开请求处理（切机器、打开会话、切回工作台） */
const openSession = (sessionId: string) =>
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }))

/** 归档的频道只读：输入框换成一条说明和「恢复频道」（docs/ui/channels-local-ai.md §3.1 #11） */
function ArchivedBar({ channel }: { channel: Channel }) {
  useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const restore = () => {
    setBusy(true)
    channelActions
      .updateChannel(channel.id, { archived: false })
      .catch(e => toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) })))
      .finally(() => setBusy(false))
  }
  return (
    <div data-channel-archived="" className="conversation-inset conversation-reading shrink-0 pb-4">
      <div className="flex min-h-12 items-center gap-3 rounded-xl border border-line-card bg-surface py-2 pr-2 pl-4 text-ui text-fg-muted">
        <Archive size={15} strokeWidth={1.5} className="shrink-0" />
        <span className="min-w-0 flex-1">{tr('channels.archived.banner')}</span>
        <Button className="h-8 px-3" disabled={busy} onClick={restore}>
          {tr('channels.channel.restore')}
        </Button>
      </div>
    </div>
  )
}

/**
 * 协作频道整页（docs/ui/channels.md）：频道列表 + 时间线 / 输入框 + 成员面板。
 * 叠在工作台上面显示，只在频道页时挂载；状态都在 features/channels/store.ts，切走再回来不丢。
 */
export function ChannelsPage({
  membersShown,
  onToggleMembers,
}: {
  membersShown: boolean
  onToggleMembers: () => void
}) {
  useI18n()
  const composer = useRef<HTMLTextAreaElement>(null)
  const channels = useChannels(s => s.channels)
  const members = useChannels(s => s.members)
  const messageMap = useChannels(s => s.messages)
  const replyMap = useChannels(s => s.replyTo)
  const newFromMap = useChannels(s => s.newFrom)
  const moreMap = useChannels(s => s.more)
  const channel = useChannels(selectedChannel)
  const selfId = useChannels(s => selfIdIn(s, selectedChannel(s)?.memberIds))
  const hasTeams = useChannels(s => s.teams.length > 0 || s.invites.length > 0)
  const connection = useChannels(s => s.teamsConnection)
  const role = useChannels(s => myRole(s.teams, selectedChannel(s)?.teamId))
  const messages = (channel && messageMap[channel.id]) || NO_MESSAGES
  const channelMembers = useMemo(
    () => (channel ? members.filter(m => channel.memberIds.includes(m.id)) : []),
    [members, channel],
  )
  const replyId = channel ? (replyMap[channel.id] ?? null) : null
  const replyTo = useMemo(
    () => (replyId ? (messages.find((m): m is Quotable => m.kind !== 'event' && m.id === replyId) ?? null) : null),
    [messages, replyId],
  )
  const agents = useMemo(() => members.filter((m): m is AgentMember => m.kind === 'agent'), [members])
  // 引用任务卡 / 任务结果 = 给那项活追加要求（docs/ui/channels-phase-b.md §7.1）
  const followUp = useMemo(() => {
    if (!channelsLive || !replyTo) return null
    const taskId = replyTo.kind === 'task' ? replyTo.id : replyTo.taskId
    const task = taskId ? messages.find((m): m is ChannelTask => m.kind === 'task' && m.id === taskId) : undefined
    return task
      ? {
          assigneeId: task.assigneeId,
          assignee: members.find(m => m.id === task.assigneeId)?.name ?? '?',
          title: task.title,
        }
      : null
  }, [replyTo, messages, members])

  // 进入页面或切换频道：标为已读，记下「新消息」位置
  useEffect(() => {
    if (channel) channelActions.select(channel.id)
  }, [channel?.id])

  // 从顶栏 / 命令面板切过来时焦点可能落回 body（工作台变成 inert），交给输入框
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) composer.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  if (!channel)
    return (
      <div className="@container absolute inset-0 flex min-w-0">
        {/* 加入了团队或收到邀请时，列表要留着（团队段、邀请卡） */}
        {hasTeams && <ChannelList channels={channels} selectedId="" onSelect={channelActions.select} agents={agents} />}
        <ChannelsEmpty agents={agents} />
      </div>
    )

  const reply = (id: string) => {
    channelActions.setReplyTo(channel.id, id)
    composer.current?.focus()
  }
  // 归档的频道只读：不能回复、追加要求、重试（docs/ui/channels-local-ai.md §3.1 #11）
  const archived = !!channel.archivedAt
  const taskActions: TaskCardActions = {
    onOpenSession: openSession,
    selfId,
    onApprove: channelActions.approveTask,
    ...(channelsLive && !archived
      ? {
          onAction: channelActions.task,
          onAnswer: async (task: ChannelTask, allow: boolean) => {
            if (!task.sessionId || !task.request || !engineBridge) return
            await engineBridge.answer(task.sessionId, task.request.requestId, { type: allow ? 'allow' : 'deny' })
          },
          onFollowUp: reply,
        }
      : {}),
  }
  const closeMembers = () => {
    onToggleMembers()
    composer.current?.focus()
  }
  return (
    <div className="@container absolute inset-0 flex min-w-0" data-channels-page>
      <ChannelList channels={channels} selectedId={channel.id} onSelect={channelActions.select} agents={agents} />
      <section aria-label={`# ${channel.name}`} className="conversation-view flex min-w-[360px] flex-1 flex-col">
        <ChannelTimeline
          channel={channel}
          messages={messages}
          members={members}
          channelMembers={channelMembers}
          newFrom={newFromMap[channel.id] ?? null}
          more={!!moreMap[channel.id]}
          onLoadOlder={() => channelActions.loadOlder(channel.id)}
          onReply={archived ? undefined : reply}
          taskActions={taskActions}
        />
        {archived ? (
          <ArchivedBar channel={channel} />
        ) : (
          <ChannelComposer
            key={channel.id}
            channel={channel}
            members={channelMembers}
            selfId={selfId}
            replyTo={replyTo}
            replyAuthor={
              replyTo
                ? members.find(m => m.id === (replyTo.kind === 'task' ? replyTo.assigneeId : replyTo.authorId))
                : undefined
            }
            followUp={followUp}
            role={role}
            offline={channel.scope === 'team' && connection === 'offline'}
            onSend={(text, extra) => channelActions.send(channel.id, text, extra)}
            onCancelReply={() => channelActions.setReplyTo(channel.id, null)}
            inputRef={composer}
          />
        )}
      </section>
      <CollapsibleSlot open={membersShown} width={MEMBERS_WIDTH} side="right">
        <ChannelMembers
          channel={channel}
          members={channelMembers}
          allMembers={members}
          onClose={closeMembers}
          onOpenSession={openSession}
        />
      </CollapsibleSlot>
    </div>
  )
}

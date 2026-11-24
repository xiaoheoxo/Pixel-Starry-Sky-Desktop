import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive } from 'lucide-react'
import { ImLinkedHint } from '@/features/im/ImLinkedHint'
import { Button, CollapsibleSlot, Switch, useToast } from '@/ui'
import { OPEN_SESSION_EVENT, bridge as engineBridge } from '@/features/engine'
import type { AgentMember, Channel, ChannelTask } from '@/data/types'
import { channelActions, channelsLive, selectedChannel, selfIdIn, useChannels } from './store'
import type { Quotable } from './ChannelMessage'
import type { TaskCardActions } from './ChannelTaskCard'
import { ChannelList } from './ChannelList'
import { ChannelTimeline } from './ChannelTimeline'
import { ChannelComposer } from './ChannelComposer'
import { LeadHint } from './LeadHint'
import { ChannelMembers } from './ChannelMembers'
import { ChannelsEmpty } from './ChannelsEmpty'
import { ThreadPanel } from './ThreadPanel'
import { NeedsView } from './NeedsView'
import { DoingView } from './DoingView'
import { ChannelBar, type ChannelTab } from './ChannelBar'
import { ChannelTasks } from './ChannelTasks'
import { openTaskCount } from './unifyModel'
import { ShareChannelDialog, UnshareChannelDialog } from './ShareDialogs'
import { canDispatch, hasThreads, myRole, sideHost } from './teamModel'
import { channelDraftKey } from './draftKey'
import { appendComposerInline } from '@/features/engine/drafts'
import { ChannelDialog } from './ChannelDialogs'
import { pinTarget, SLASH_IDS, type SlashId } from './slash'
import { useAppMode } from '@/features/coding/mode'

const MEMBERS_WIDTH = 300
/** 讨论串面板宽一些：放得下任务卡和输入框 */
const THREAD_WIDTH = 380
const NO_MESSAGES: never[] = []

/** 在列表里点频道：关掉「需要你」再进频道 */
const selectChannel = (id: string) => {
  channelActions.openNeeds(false)
  channelActions.select(id)
}

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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sharing, setSharing] = useState<'share' | 'unshare' | null>(null)
  const toast = useToast()
  const appMode = useAppMode()
  const channels = useChannels(s => s.channels)
  const members = useChannels(s => s.members)
  const messageMap = useChannels(s => s.messages)
  const replyMap = useChannels(s => s.replyTo)
  const threadMap = useChannels(s => s.thread)
  const needsOpen = useChannels(s => s.needsOpen)
  const overview = useChannels(s => s.overview)
  const focus = useChannels(s => s.focus)
  // 「消息 / 任务」（docs/ui/channels-unify.md §2）：按频道记，换频道回到消息；要跳到某条消息时也回到消息
  const [tabOf, setTabOf] = useState<{ id: string; tab: ChannelTab } | null>(null)
  useEffect(() => {
    if (focus) setTabOf(null)
  }, [focus])
  const newFromMap = useChannels(s => s.newFrom)
  const moreMap = useChannels(s => s.more)
  const channel = useChannels(selectedChannel)
  const selfId = useChannels(s => selfIdIn(s, selectedChannel(s)?.memberIds))
  const connection = useChannels(s => s.teamsConnection)
  const role = useChannels(s => myRole(s.teams, selectedChannel(s)?.teamId))
  // 「我的协作」（docs/ui/channels-unify.md §7.2）：选中的是挂在团队频道下面的那一页时，标记条、列表都按团队频道显示
  const host = useChannels(s => {
    const c = selectedChannel(s)
    return c ? sideHost(c, s.channels) : null
  })
  const hostRole = useChannels(s => {
    const c = selectedChannel(s)
    return myRole(s.teams, ((c && sideHost(c, s.channels)) ?? c)?.teamId)
  })
  const sideUnread = useChannels(s => {
    const c = selectedChannel(s)
    return c?.scope === 'team' ? (s.channels.find(x => x.sideOf === c.id)?.unread ?? 0) : 0
  })
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

  // 进入页面、切换频道、从「需要你」回到时间线：标为已读，记下「新消息」位置（开着「需要你」时时间线没显示，不算看过）
  useEffect(() => {
    if (channel && !needsOpen) channelActions.select(channel.id)
  }, [channel?.id, needsOpen])

  // 从顶栏 / 命令面板切过来时焦点可能落回 body（工作台变成 inert），交给输入框
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) composer.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  if (!channel)
    return (
      <div className="@container absolute inset-0 flex min-w-0" data-channels-page>
        {/* 团队可用时列表留着：邀请卡、登录提示、新建团队都在列表里（docs/multica-learn.md §13） */}
        {connection !== 'unavailable' && (
          <ChannelList
            channels={channels}
            selectedId=""
            onSelect={selectChannel}
            onOpenSession={openSession}
            agents={agents}
          />
        )}
        <ChannelsEmpty agents={agents} teams={connection !== 'unavailable'} />
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
  // 讨论串（docs/ui/channels-collab-v2.md §3）：团队的频道要云端支持；根消息不在了就不显示
  const threaded = hasThreads(channel)
  const threadRoot = threaded ? (threadMap[channel.id] ?? null) : null
  const thread = threadRoot && messages.some(m => m.id === threadRoot) ? threadRoot : null
  const openThread = threaded ? (id: string) => channelActions.openThread(channel.id, id) : undefined
  const closeThread = () => {
    channelActions.openThread(channel.id, null)
    composer.current?.focus()
  }
  // 斜杠命令（docs/ui/channels-local-rest.md §3.3 a）：只给本机频道的主输入框
  const lead = channel.lead ? channelMembers.find(m => m.id === channel.lead) : undefined
  // 代码模式里频道页没有成员面板：不列 /成员
  const slashAvailable = SLASH_IDS.filter(id => (id !== 'digest' || !!lead) && (id !== 'members' || appMode !== 'code'))
  const runSlash = async (id: SlashId, arg: string): Promise<void> => {
    if (id === 'flow')
      await channelActions.flow(channel.id, { type: 'create', title: arg || tr('channels.slash.flowTitle') })
    else if (id === 'archive') await channelActions.updateChannel(channel.id, { archived: true })
    else if (id === 'pin') {
      const target = pinTarget(messages, replyTo)
      if (!target) throw new Error(tr('channels.slash.nothingToPin'))
      if (channel.pinned?.includes(target)) throw new Error(tr('channels.slash.pinned'))
      await channelActions.pin(channel.id, target, true)
    } else if (id === 'notify') setSettingsOpen(true)
    else if (id === 'members') {
      if (!membersShown) onToggleMembers()
    } else if (id === 'digest' && lead)
      await channelActions.send(channel.id, tr('channels.slash.digestRequest', { name: lead.name }))
  }
  const closeMembers = () => {
    onToggleMembers()
    composer.current?.focus()
  }
  const tab: ChannelTab = tabOf?.id === channel.id && !focus ? tabOf.tab : 'messages'
  // 把 @成员 写进输入框（docs/ui/channels-unify.md §2）：成员行上的 @、消息上的「派给 AI 成员」（name 为空只写一个 @，出成员菜单）
  const mention = (name: string) => {
    setTabOf(null)
    appendComposerInline(channelDraftKey(channel.id), name ? `@${name} ` : '@')
    requestAnimationFrame(() => {
      const el = composer.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
      // 输入框按键盘 / 鼠标事件记光标位置：补一个，刚写进去的 @ 才出成员菜单
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
    })
  }
  const canMention = !archived && canDispatch(role)
  const mentionMember = canMention ? (m: AgentMember) => mention(m.name) : undefined
  const loadOlder = () => channelActions.loadOlder(channel.id)
  return (
    <div className="@container absolute inset-0 flex min-w-0" data-channels-page>
      <ChannelList
        channels={channels}
        selectedId={host?.id ?? channel.id}
        onSelect={selectChannel}
        onOpenSession={openSession}
        agents={agents}
        onMention={mentionMember}
      />
      {needsOpen ? (
        overview === 'doing' ? (
          <DoingView />
        ) : (
          <NeedsView />
        )
      ) : (
        <section aria-label={`# ${channel.name}`} className="conversation-view flex min-w-[360px] flex-1 flex-col">
          <ChannelBar
            channel={host ?? channel}
            tab={host ? 'side' : tab}
            onTab={next => {
              const team = host ?? channel
              if (next === 'side') {
                if (!host)
                  void channelActions
                    .openSide(team.id)
                    .catch(e => toast(tr('unify.side.failed', { error: translateMessage((e as Error).message) })))
                return
              }
              if (host) channelActions.select(host.id)
              setTabOf({ id: team.id, tab: next })
            }}
            openTasks={host ? 0 : openTaskCount(messages)}
            onShare={!host && !archived && connection !== 'unavailable' ? () => setSharing('share') : undefined}
            onUnshare={host ? undefined : () => setSharing('unshare')}
            side={
              (host ?? channel).scope === 'team' && canDispatch(hostRole) && connection !== 'unavailable'
                ? { unread: host ? 0 : sideUnread }
                : null
            }
          />
          {host && (
            <div
              data-side-hint=""
              className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-subtle bg-subtle py-1.5 pr-3 pl-5 text-meta text-fg-muted"
            >
              <p className="min-w-0 flex-1">{tr('unify.side.hint')}</p>
              <label className="flex shrink-0 items-center gap-2" title={tr('unify.side.mirrorHint')}>
                <span>{tr('unify.side.mirror', { name: host.name })}</span>
                <Switch
                  size="sm"
                  checked={channel.sideMirror !== false}
                  label={tr('unify.side.mirror', { name: host.name })}
                  onChange={on =>
                    void channelActions
                      .setSideMirror(channel.id, on)
                      .catch(e =>
                        toast(tr('channels.task.actionFailed', { error: translateMessage((e as Error).message) })),
                      )
                  }
                />
              </label>
            </div>
          )}
          {tab === 'tasks' ? (
            <ChannelTasks
              channel={channel}
              messages={messages}
              members={members}
              more={!!moreMap[channel.id]}
              onLoadOlder={loadOlder}
              taskActions={taskActions}
            />
          ) : (
            <>
              <ChannelTimeline
                channel={channel}
                messages={messages}
                members={members}
                channelMembers={channelMembers}
                newFrom={newFromMap[channel.id] ?? null}
                more={!!moreMap[channel.id]}
                onLoadOlder={loadOlder}
                onReply={archived ? undefined : reply}
                taskActions={taskActions}
                onThread={openThread}
                onAssign={
                  canMention && channelMembers.some(m => m.kind === 'agent')
                    ? id => {
                        channelActions.setReplyTo(channel.id, id)
                        mention('')
                      }
                    : undefined
                }
              />
              {archived ? (
                <ArchivedBar channel={channel} />
              ) : (
                <>
                  {channel.scope === 'local' && <LeadHint channel={channel} members={channelMembers} />}
                  {channel.scope === 'local' && <ImLinkedHint channelId={channel.id} />}
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
                    slash={channel.scope === 'local' ? { available: slashAvailable, run: runSlash } : undefined}
                  />
                </>
              )}
            </>
          )}
        </section>
      )}
      <CollapsibleSlot
        open={!needsOpen && (membersShown || !!thread)}
        width={thread ? THREAD_WIDTH : MEMBERS_WIDTH}
        side="right"
      >
        {thread ? (
          <ThreadPanel
            channel={channel}
            rootId={thread}
            messages={messages}
            members={members}
            channelMembers={channelMembers}
            selfId={selfId}
            taskActions={taskActions}
            readOnly={archived}
            role={role}
            onClose={closeThread}
            width={THREAD_WIDTH}
          />
        ) : (
          <ChannelMembers
            key={channel.id}
            channel={channel}
            members={channelMembers}
            allMembers={members}
            onClose={closeMembers}
            onOpenSession={openSession}
            onMention={mentionMember}
          />
        )}
      </CollapsibleSlot>
      {settingsOpen && <ChannelDialog channel={channel} agents={[]} onClose={() => setSettingsOpen(false)} />}
      {sharing === 'share' && channel.scope === 'local' && (
        <ShareChannelDialog
          channel={channel}
          agents={channelMembers.filter((m): m is AgentMember => m.kind === 'agent')}
          onClose={() => setSharing(null)}
        />
      )}
      {sharing === 'unshare' && channel.scope === 'team' && (
        <UnshareChannelDialog channel={channel} onClose={() => setSharing(null)} />
      )}
    </div>
  )
}

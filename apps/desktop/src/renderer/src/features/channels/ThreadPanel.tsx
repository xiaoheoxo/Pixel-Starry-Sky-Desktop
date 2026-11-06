import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '@/ui'
import type { Channel, ChannelMember, ChannelMessage, ChannelTask } from '@/data/types'
import { threadMessages } from '../../../../shared/channels/threads'
import { MessageGroup, type Quotable } from './ChannelMessage'
import { ChannelTaskCard, type TaskCardActions } from './ChannelTaskCard'
import { ChannelComposer } from './ChannelComposer'
import { channelActions } from './store'
import { useFollowBottom } from './useFollowBottom'

/**
 * 右侧的讨论串（docs/ui/channels-collab-v2.md §3）：和成员面板共用位置。
 * 上面是任务卡（或那条消息），下面是串里的回复和输入框；在串里 @ 同一成员 = 追加要求，不 @ 只是留言
 */
export function ThreadPanel({
  channel,
  rootId,
  messages,
  members,
  channelMembers,
  selfId,
  taskActions,
  readOnly,
  onClose,
  width,
}: {
  channel: Channel
  rootId: string
  messages: readonly ChannelMessage[]
  members: readonly ChannelMember[]
  channelMembers: readonly ChannelMember[]
  selfId: string | null
  taskActions: TaskCardActions
  /** 归档的频道：只能看 */
  readOnly: boolean
  onClose: () => void
  width: number
}) {
  useI18n()
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const membersById = useMemo(() => new Map(members.map(m => [m.id, m])), [members])
  const messagesById = useMemo(
    () => new Map(messages.filter((m): m is Quotable => m.kind !== 'event').map(m => [m.id, m])),
    [messages],
  )
  const root = messagesById.get(rootId)
  const items = useMemo(() => threadMessages(messages, rootId), [messages, rootId])
  const assignee = root?.kind === 'task' ? membersById.get(root.assigneeId) : undefined

  // 打开串、来了新回复：到底部
  const nearBottom = useRef(true)
  const follow = useFollowBottom(scroller, nearBottom)
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    nearBottom.current = true
  }, [rootId, items.length])

  // 串里的引用块点了：在主时间线里跳过去
  const jump = (id: string) => void channelActions.focusMessage(channel.id, id)
  return (
    <aside
      aria-label={tr('channels.thread.title')}
      data-thread-panel={rootId}
      className="flex h-full flex-col border-l border-line-subtle"
      style={{ width }}
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-1 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-ui font-medium text-fg">{tr('channels.thread.title')}</h2>
        <IconButton icon={X} label={tr('channels.thread.close')} size={28} iconSize={15} onClick={onClose} />
      </div>
      <div
        ref={scroller}
        {...follow}
        className="selectable min-h-0 flex-1 overflow-y-auto px-3 pb-3 [scrollbar-width:thin]"
      >
        <div className="flex flex-col">
          {!root ? (
            <p className="px-1 pt-2 text-meta text-fg-faint">{tr('channels.thread.missing')}</p>
          ) : root.kind === 'task' ? (
            // 任务卡在主时间线里左边留了头像的位置，串里不用
            <div className="[&>[data-channel-message]]:mt-1 [&>[data-channel-message]]:pl-0">
              <ChannelTaskCard
                task={root as ChannelTask}
                membersById={membersById}
                highlight={false}
                {...taskActions}
              />
            </div>
          ) : (
            <MessageGroup
              items={[root]}
              membersById={membersById}
              channelMembers={channelMembers}
              messagesById={messagesById}
              highlight={null}
              onJump={jump}
              proposalsReadOnly={readOnly}
              selfId={selfId}
            />
          )}
          <div role="separator" className="my-3 h-px shrink-0 bg-line-subtle" />
          {items.length === 0 ? (
            <p className="px-1 text-meta text-fg-faint">{tr('channels.thread.empty')}</p>
          ) : (
            items.map(m => (
              <MessageGroup
                key={m.id}
                items={[m]}
                membersById={membersById}
                channelMembers={channelMembers}
                messagesById={messagesById}
                highlight={null}
                onJump={jump}
                proposalsReadOnly={readOnly}
                selfId={selfId}
              />
            ))
          )}
        </div>
      </div>
      {!readOnly && root && (
        <ChannelComposer
          key={rootId}
          channel={channel}
          members={channelMembers}
          selfId={selfId}
          replyTo={null}
          replyAuthor={undefined}
          followUp={null}
          threadId={rootId}
          placeholder={
            assignee
              ? tr('channels.thread.placeholder', { name: assignee.name })
              : tr('channels.thread.placeholderPlain')
          }
          onSend={(text, extra) => channelActions.send(channel.id, text, extra, rootId)}
          onCancelReply={() => {}}
          inputRef={input}
        />
      )}
    </aside>
  )
}

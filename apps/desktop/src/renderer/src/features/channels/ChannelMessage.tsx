import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CornerUpLeft, Pin, PinOff } from 'lucide-react'
import { Avatar, cn, CopyButton, EngineIcon, IconButton, useToast } from '@/ui'
import { Markdown } from '@/ui/markdown/Markdown'
import type { ChannelMember, ChannelTask, ChannelTextMessage } from '@/data/types'
import { excerpt, splitMentions } from './model'
import { formatClock } from './format'
import { channelActions } from './store'
import { ImageAttachments } from '@/features/session/attachments/ImageAttachments'
import { FileAttachments } from '@/features/session/attachments/FileAttachments'
import type { ChannelAttachments } from '../../../../shared/types/channels'
import { getProviders } from '@/features/account/providers'
import { channelShort } from '@/features/model-channels/channelLabels'

/** 成员头像：真人是圆形首字头像，AI 成员是圆角方块里的引擎图标 */
export function MemberAvatar({
  member,
  size = 28,
  className,
}: {
  member: ChannelMember | undefined
  size?: number
  className?: string
}) {
  useI18n()
  if (member?.kind === 'agent') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md border border-line-subtle bg-subtle',
          className,
        )}
        style={{ width: size, height: size }}
      >
        <EngineIcon engine={member.engine} size={Math.round(size * 0.55)} />
      </span>
    )
  }
  return <Avatar name={member?.name ?? '?'} size={size} className={className} />
}

/** 机器显示名：本机（主进程不给名字）显示「这台电脑」 */
export function machineLabel(member: ChannelMember | undefined): string {
  if (member?.kind !== 'agent') return ''
  return member.machine || (member.machineId === 'local' ? tr('channels.thisComputer') : member.machineId)
}

/** 额度来源（自有账号不写）· 模型 · 机器（AI 成员）；真人没有 */
export function agentMeta(member: ChannelMember | undefined): string | null {
  if (member?.kind !== 'agent') return null
  const settings = member.config?.settings
  const credit = settings?.platform
    ? channelShort('platform')
    : settings?.provider
      ? (getProviders().providers.find(p => p.id === settings.provider?.id)?.name ?? channelShort('custom'))
      : null
  return [credit, member.model, machineLabel(member)].filter(Boolean).join(' · ')
}

/** 项目 · 机器（任务卡底部） */
export function agentPlace(member: ChannelMember | undefined): string {
  if (member?.kind !== 'agent') return ''
  return [member.project, machineLabel(member)].filter(Boolean).join(' · ')
}

/** 可以被引用的消息：普通消息和任务卡 */
export type Quotable = ChannelTextMessage | ChannelTask

/** AI 的长回复超过 12 行时折叠（docs/ui/channels-phase-b.md §5.2） */
const FOLD_PX = 12 * 26
function Folded({ text }: { text: string }) {
  useI18n()
  const box = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (el) setTall(el.scrollHeight > FOLD_PX + 40)
  }, [text])
  return (
    <div>
      <div
        ref={box}
        className={cn('relative', tall && !open && 'overflow-hidden')}
        style={tall && !open ? { maxHeight: FOLD_PX } : undefined}
      >
        <Markdown text={text} />
        {tall && !open && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface to-transparent"
          />
        )}
      </div>
      {tall && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(v => !v)}
          className="mt-1 text-meta font-medium text-accent-fg hover:underline"
        >
          {tr(open ? 'channels.showLess' : 'channels.showMore')}
        </button>
      )}
    </div>
  )
}

/** 作者行：名字、（你）、AI 标签、模型 · 机器、时间 */
function AuthorLine({ member, at }: { member: ChannelMember | undefined; at: number }) {
  useI18n()
  const meta = agentMeta(member)
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 truncate text-list font-medium text-fg">{member?.name ?? '?'}</span>
      {member?.kind === 'human' && member.you && (
        <span className="shrink-0 text-meta text-fg-muted">{tr('channels.youSuffix')}</span>
      )}
      {member?.kind === 'agent' && (
        <span className="shrink-0 self-center rounded bg-engine-chip px-1 text-[10px] leading-4 font-semibold text-engine-chip-fg">
          {tr('channels.ai')}
        </span>
      )}
      {member?.kind === 'agent' && member.mine === false && member.ownerName && (
        <span className="shrink-0 text-meta text-fg-faint">
          · {tr('team.panel.agentOf', { owner: member.ownerName })}
        </span>
      )}
      {meta && (
        <span title={meta} className="min-w-0 truncate text-meta text-fg-faint">
          {meta}
        </span>
      )}
      <time dateTime={new Date(at).toISOString()} className="shrink-0 text-meta text-fg-faint tabular-nums">
        {formatClock(at)}
      </time>
    </div>
  )
}

/** 真人消息：纯文本，@成员 和 @全体 高亮 */
function MentionText({ text, members }: { text: string; members: readonly ChannelMember[] }) {
  return (
    <p className="text-prose break-words whitespace-pre-wrap text-fg-body">
      {splitMentions(text, members).map((segment, i) =>
        segment.memberId || segment.all ? (
          <span key={i} className="rounded bg-accent-soft px-0.5 text-accent-fg">
            {segment.text}
          </span>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </p>
  )
}

/** 消息带的图片和文件：消息里只有说明，看到时再读全文 */
function MessageAttachments({ message }: { message: ChannelTextMessage }) {
  useI18n()
  const [data, setData] = useState<ChannelAttachments | null>(null),
    [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    channelActions
      .attachments(message.channelId, message.id)
      .then(next => alive && setData(next))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [message.channelId, message.id])
  const meta = message.attached
  if (!meta) return null
  if (failed || (data && !data.images.length && !data.files.length))
    return <p className="mt-1 text-meta text-fg-faint">{tr('channels.attach.missing')}</p>
  if (!data)
    return (
      <div data-channel-attachments="" className="mt-1.5 flex flex-wrap gap-2" aria-busy="true">
        {meta.images.map(image => (
          <div key={image.id} className="h-24 w-24 rounded-lg border border-line-card bg-subtle" />
        ))}
      </div>
    )
  return (
    <div data-channel-attachments="" className="mt-1.5 flex flex-col gap-2">
      {data.images.length > 0 && <ImageAttachments images={data.images} />}
      {data.files.length > 0 && <FileAttachments files={data.files} />}
    </div>
  )
}

/** 引用块：被引用人 + 原文摘要，点击跳到原消息 */
function QuoteBlock({
  quoted,
  author,
  onJump,
}: {
  quoted: Quotable | undefined
  author: ChannelMember | undefined
  onJump: (id: string) => void
}) {
  useI18n()
  if (!quoted)
    return (
      <div className="mb-1 border-l-2 border-line-strong pl-2 text-meta text-fg-faint italic">
        {tr('channels.quoteMissing')}
      </div>
    )
  return (
    <button
      type="button"
      title={tr('channels.jumpToQuote')}
      onClick={() => onJump(quoted.id)}
      className="mb-1 flex w-full min-w-0 items-baseline gap-1.5 border-l-2 border-line-strong pl-2 text-left text-meta text-fg-muted hover:border-accent hover:text-fg"
    >
      <span className="shrink-0 font-medium">{author?.name ?? '?'}</span>
      <span className="min-w-0 truncate">{excerpt(quoted.kind === 'task' ? quoted.title : quoted.text)}</span>
    </button>
  )
}

export interface MessageGroupProps {
  items: ChannelTextMessage[]
  /** 全部成员（作者可能已经离开频道） */
  membersById: ReadonlyMap<string, ChannelMember>
  /** 这个频道的成员，用来高亮 @ */
  channelMembers: readonly ChannelMember[]
  messagesById: ReadonlyMap<string, Quotable>
  highlight: string | null
  /** 没有时不能回复（归档的频道） */
  onReply?: (id: string) => void
  onJump: (id: string) => void
  /** 频道里置顶的消息 */
  pinned?: ReadonlySet<string>
  /** 置顶 / 取消置顶（只有本机频道有，docs/ui/channels-local-ai.md §3.1 #9） */
  onPin?: (id: string, pinned: boolean) => Promise<void>
}

/** 同一作者的连续消息：第一条带头像和作者行，后面的悬停时在头像位置显示时间 */
export function MessageGroup({
  items,
  membersById,
  channelMembers,
  messagesById,
  highlight,
  onReply,
  onJump,
  pinned,
  onPin,
}: MessageGroupProps) {
  useI18n()
  const toast = useToast()
  const author = membersById.get(items[0].authorId)
  const togglePin = (id: string, on: boolean): void =>
    void onPin?.(id, on).catch(e => toast(tr('channels.pinFailed', { error: translateMessage((e as Error).message) })))
  return (
    <div className="conversation-message mt-3 flex flex-col">
      {items.map((m, i) => {
        const quoted = m.replyToId ? messagesById.get(m.replyToId) : undefined
        return (
          <div
            key={m.id}
            data-channel-message={m.id}
            className={cn(
              'group/message relative -mx-2 flex gap-3 rounded-md px-2 py-0.5 hover:bg-hover focus-within:bg-hover',
              highlight === m.id && 'search-hit',
            )}
          >
            <div className="w-7 shrink-0 pt-0.5">
              {i === 0 ? (
                <MemberAvatar member={author} />
              ) : (
                <time
                  dateTime={new Date(m.at).toISOString()}
                  className="invisible block pt-1 text-right text-[10px] leading-4 text-fg-faint tabular-nums group-hover/message:visible"
                >
                  {formatClock(m.at)}
                </time>
              )}
            </div>
            <div className="min-w-0 flex-1">
              {i === 0 && <AuthorLine member={author} at={m.at} />}
              {m.replyToId && (
                <QuoteBlock
                  quoted={quoted}
                  author={
                    quoted ? membersById.get(quoted.kind === 'task' ? quoted.assigneeId : quoted.authorId) : undefined
                  }
                  onJump={onJump}
                />
              )}
              {m.format === 'markdown' ? (
                <Folded text={m.text} />
              ) : (
                m.text && <MentionText text={m.text} members={channelMembers} />
              )}
              {m.attached && <MessageAttachments message={m} />}
              {pinned?.has(m.id) && (
                <span data-pinned className="mt-0.5 inline-flex items-center gap-1 text-meta text-fg-faint">
                  <Pin size={11} strokeWidth={1.75} />
                  {tr('channels.pinned')}
                </span>
              )}
            </div>
            <div
              role="toolbar"
              aria-label={tr('channels.messageActions')}
              className="absolute -top-3 right-2 flex items-center gap-0.5 rounded-md border border-line-card bg-popover p-0.5 opacity-0 shadow-menu transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100"
            >
              {onReply && (
                <IconButton
                  icon={CornerUpLeft}
                  label={tr('channels.reply')}
                  size={24}
                  iconSize={13}
                  onClick={() => onReply(m.id)}
                />
              )}
              <CopyButton text={m.text} label={tr('channels.copy')} iconOnly />
              {onPin && (
                <IconButton
                  icon={pinned?.has(m.id) ? PinOff : Pin}
                  label={tr(pinned?.has(m.id) ? 'channels.unpin' : 'channels.pin')}
                  size={24}
                  iconSize={13}
                  onClick={() => togglePin(m.id, !pinned?.has(m.id))}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

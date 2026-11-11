import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BellRing, CornerUpLeft, Forward, MessageSquareText, Pin, PinOff } from 'lucide-react'
import { Avatar, Button, cn, CopyButton, EngineIcon, IconButton, useToast } from '@/ui'
import { appendComposerDraft } from '@/features/engine/drafts'
import { channelDraftKey } from './draftKey'
import { SYSTEM_AUTHOR } from '../../../../shared/types/channels'
import { alertActions } from '../../../../shared/channels/alerts'
import { Markdown } from '@/ui/markdown/Markdown'
import { PathLinksProvider } from '@/features/files/PathLinksProvider'
import type { ChannelMember, ChannelTask, ChannelTextMessage } from '@/data/types'
import { excerpt, splitMentions } from './model'
import { formatClock, messageWorkspace } from './format'
import { channelActions } from './store'
import { ImageAttachments } from '@/features/session/attachments/ImageAttachments'
import { FileAttachments } from '@/features/session/attachments/FileAttachments'
import type { ChannelAttachments } from '../../../../shared/types/channels'
import { getProviders } from '@/features/account/providers'
import { channelShort } from '@/features/model-channels/channelLabels'
import { effortLabel } from '@/features/engine/labels'

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

/** 额度来源的短名：像素星空平台、自定义接口的名字；自有账号是 null */
export function agentCredit(member: ChannelMember | undefined): string | null {
  const settings = member?.kind === 'agent' ? member.config?.settings : undefined
  return settings?.platform
    ? channelShort('platform')
    : settings?.provider
      ? (getProviders().providers.find(p => p.id === settings.provider?.id)?.name ?? channelShort('custom'))
      : null
}

/** 额度来源（自有账号不写）· 模型 · 自己设过的推理强度 / Fast / Ultracode · 机器（AI 成员）；真人没有 */
export function agentMeta(member: ChannelMember | undefined): string | null {
  if (member?.kind !== 'agent') return null
  const settings = member.config?.settings
  return [
    agentCredit(member),
    member.model,
    settings?.effort && effortLabel(settings.effort),
    settings?.fast && 'Fast',
    settings?.ultracode && 'Ultracode',
    machineLabel(member),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 项目 · 机器（任务卡底部） */
export function agentPlace(member: ChannelMember | undefined): string {
  if (member?.kind !== 'agent') return ''
  return [member.project, machineLabel(member)].filter(Boolean).join(' · ')
}

/** Markdown 气泡里的路径可点（docs/ui/channels-local-rest.md §3.3 b）：按消息对应的会话或成员项目认 */
function MarkdownBubble({
  where,
  text,
  fade,
}: {
  where: { sessionId: string | null; projectId: string | null } | null
  text: string
  fade: string
}) {
  const body = <Folded text={text} fade={fade} />
  return where ? (
    <PathLinksProvider sessionId={where.sessionId} projectId={where.projectId}>
      {body}
    </PathLinksProvider>
  ) : (
    body
  )
}

/** 可以被引用的消息：普通消息和任务卡 */
export type Quotable = ChannelTextMessage | ChannelTask

/** AI 的长回复超过 12 行时折叠（docs/ui/channels-phase-b.md §5.2） */
const FOLD_PX = 12 * 26
function Folded({ text, fade = 'from-surface' }: { text: string; fade?: string }) {
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
            className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t to-transparent', fade)}
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

/** 气泡上方的作者行：名字、（你）、AI 标签、模型 · 机器；时间在分隔线和悬停里 */
export function AuthorLine({ member }: { member: ChannelMember | undefined }) {
  useI18n()
  const meta = agentMeta(member)
  return (
    <div className="flex max-w-full min-w-0 items-baseline gap-1.5 px-1 pb-0.5">
      <span className="shrink-0 truncate text-meta font-medium text-fg-secondary">{member?.name ?? '?'}</span>
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
    </div>
  )
}

/** 真人消息：纯文本，@成员 和 @全体 高亮；mine 时在强调色气泡里，换成气泡上的颜色 */
function MentionText({ text, members, mine }: { text: string; members: readonly ChannelMember[]; mine?: boolean }) {
  return (
    <p className={cn('text-prose break-words whitespace-pre-wrap', mine ? 'text-accent-on' : 'text-fg-body')}>
      {splitMentions(text, members).map((segment, i) =>
        segment.memberId || segment.all ? (
          <span
            key={i}
            className={cn(
              'rounded px-0.5',
              mine ? 'bg-accent-on/20 font-medium text-accent-on' : 'bg-accent-soft text-accent-fg',
            )}
          >
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
      {/* 图片只放缩略图：文件名多是一长串 id，放在悬停提示和 alt 里 */}
      {data.images.length > 0 && <ImageAttachments images={data.images} caption={false} />}
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
      className="mb-1 flex max-w-full min-w-0 items-baseline gap-1.5 border-l-2 border-line-strong pl-2 text-left text-meta text-fg-muted hover:border-accent hover:text-fg"
    >
      <span className="shrink-0 font-medium">{author?.name ?? '?'}</span>
      <span className="min-w-0 truncate">{excerpt(quoted.kind === 'task' ? quoted.title : quoted.text)}</span>
    </button>
  )
}

/** 系统消息（主动提醒、每日简报）的作者：显示成「提醒」 */
const SYSTEM_MEMBER = (): ChannelMember => ({ id: SYSTEM_AUTHOR, kind: 'human', name: tr('alerts.author') })

/** 提醒上的按钮（docs/ui/channels-collab-v2.md §6）；处理过的只写「已处理」 */
function AlertButtons({ message, readOnly }: { message: ChannelTextMessage; readOnly: boolean }) {
  useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const alert = message.alert!
  if (alert.state === 'done') return <span className="mt-0.5 block text-meta text-fg-faint">{tr('alerts.done')}</span>
  if (readOnly) return null
  const actions = alertActions(alert.rule)
  return (
    <div data-alert-actions={alert.rule} className="mt-1.5 flex flex-wrap gap-1.5">
      {actions.map((action, i) => (
        <Button
          key={action}
          variant={i === 0 ? 'primary' : 'outline'}
          className="h-7 px-2.5 text-meta"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            channelActions
              .alert(message.channelId, message.id, action)
              .catch(e => toast(tr('needs.failed', { error: translateMessage((e as Error).message) })))
              .finally(() => setBusy(false))
          }}
        >
          {tr(`alerts.action.${action}`)}
        </Button>
      ))}
    </div>
  )
}

/** 讨论串的回复数和最新一条（docs/ui/channels-collab-v2.md §3） */
export type ThreadStats = ReadonlyMap<string, { count: number; last: ChannelTextMessage }>

/**
 * 卡片 / 消息下面那一行：「3 条回复 · 最新：前端：…」，点开右侧讨论串。
 * 最新一条本来就在主时间线上（任务结果、引用它的回复）时只写「3 条回复」，不再重复内容。
 * 还没有回复时（只给任务卡用）是一个悬停才显示的「在串里讨论」
 */
export function ThreadRow({
  rootId,
  stats,
  membersById,
  onOpen,
  idle,
}: {
  rootId: string
  stats: ThreadStats
  membersById: ReadonlyMap<string, ChannelMember>
  onOpen: (id: string) => void
  /** 没有回复时也显示（悬停可见） */
  idle?: boolean
}) {
  useI18n()
  const s = stats.get(rootId)
  if (!s && !idle) return null
  return (
    <button
      type="button"
      data-thread-row={rootId}
      onClick={() => onOpen(rootId)}
      className={cn(
        'flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-meta hover:bg-hover',
        s ? 'text-fg-muted' : 'text-fg-faint opacity-0 group-hover/thread:opacity-100 focus-visible:opacity-100',
      )}
    >
      <MessageSquareText size={13} strokeWidth={1.5} className="shrink-0" />
      {s ? (
        <>
          <span className="shrink-0 font-medium text-accent-fg">
            {tr('channels.thread.replies', { count: s.count })}
          </span>
          {s.last.threadId && (
            <span className="min-w-0 truncate">
              ·{' '}
              {tr('channels.thread.latest', {
                name: membersById.get(s.last.authorId)?.name ?? '?',
                text: excerpt(s.last.text),
              })}
            </span>
          )}
        </>
      ) : (
        <span>{tr('channels.thread.start')}</span>
      )}
    </button>
  )
}

/** AI 成员用 task_propose 提议的派活：派出去 / 改一下 / 不要（docs/ui/channels-collab-v2.md §1） */
function ProposalCard({
  message,
  membersById,
  readOnly,
}: {
  message: ChannelTextMessage
  membersById: ReadonlyMap<string, ChannelMember>
  readOnly: boolean
}) {
  useI18n()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const p = message.proposal!
  const target = membersById.get(p.assigneeId)?.name ?? '?'
  const decide = (accept: boolean) => {
    setBusy(true)
    channelActions
      .proposal(message.channelId, message.id, accept)
      .catch(e => toast(tr('channels.proposal.failed', { error: translateMessage((e as Error).message) })))
      .finally(() => setBusy(false))
  }
  // 改一下：把「@成员 要求」放进输入框，改好了自己发
  const edit = () => appendComposerDraft(channelDraftKey(message.channelId), `@${target} ${p.request}`)
  return (
    <div
      data-proposal={p.state}
      className="mt-1 flex flex-col gap-1.5 rounded-lg border border-line-card bg-surface px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-meta font-medium text-fg-secondary">
        <Forward size={13} strokeWidth={1.5} className="shrink-0" />
        <span className="min-w-0 truncate">{tr('channels.proposal.title', { name: target })}</span>
      </div>
      <p className="text-prose break-words whitespace-pre-wrap text-fg-body">{p.request}</p>
      {p.state === 'open' && !readOnly ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="primary" className="h-7 px-2.5 text-meta" disabled={busy} onClick={() => decide(true)}>
            {tr('channels.proposal.send')}
          </Button>
          <Button className="h-7 px-2.5 text-meta" disabled={busy} onClick={edit}>
            {tr('channels.proposal.edit')}
          </Button>
          <Button variant="ghost" className="h-7 px-2.5 text-meta" disabled={busy} onClick={() => decide(false)}>
            {tr('channels.proposal.dismiss')}
          </Button>
        </div>
      ) : p.state !== 'open' ? (
        <span className="text-meta text-fg-faint">
          {tr(p.state === 'sent' ? 'channels.proposal.sent' : 'channels.proposal.dismissed')}
        </span>
      ) : null}
    </div>
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
  /** 讨论串：回复数和打开（串面板里的消息不再开串时不传） */
  threads?: ThreadStats
  onThread?: (id: string) => void
  /** 提议卡只读（归档的频道）；不传时按能不能回复判断 */
  proposalsReadOnly?: boolean
  /** 当前用户：自己发的消息靠右、用强调色气泡 */
  selfId?: string | null
  /** 挂在某条消息下面的东西（从它派出去的任务卡状态条） */
  renderBelow?: (message: ChannelTextMessage) => ReactNode
}

/** 自己发的：作者是当前用户（团队频道里是 owner key，本机频道里是 you） */
export function isSelfAuthor(
  member: ChannelMember | undefined,
  authorId: string,
  selfId: string | null | undefined,
): boolean {
  return (!!selfId && authorId === selfId) || (member?.kind === 'human' && !!member.you)
}

/**
 * 同一作者的连续消息（群聊样式）：别人的靠左，第一条上面写名字、左边放头像，气泡是中性色；
 * 自己的靠右，用强调色气泡，不写名字和头像。时间悬停时在气泡旁边显示
 */
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
  threads,
  onThread,
  proposalsReadOnly = !onReply,
  selfId,
  renderBelow,
}: MessageGroupProps) {
  useI18n()
  const toast = useToast()
  const system = items[0].authorId === SYSTEM_AUTHOR
  const author = system ? SYSTEM_MEMBER() : membersById.get(items[0].authorId)
  const mine = !system && isSelfAuthor(author, items[0].authorId, selfId)
  const togglePin = (id: string, on: boolean): void =>
    void onPin?.(id, on).catch(e => toast(tr('channels.pinFailed', { error: translateMessage((e as Error).message) })))
  return (
    <div className="conversation-message mt-3 flex flex-col gap-1" data-mine={mine || undefined}>
      {items.map((m, i) => {
        const quoted = m.replyToId ? messagesById.get(m.replyToId) : undefined
        const first = i === 0
        // 自己的纯文本消息用强调色气泡；Markdown 放强调色的浅底上，免得代码块、链接的颜色看不清
        const strong = mine && m.format !== 'markdown'
        // 全局选中色是 22% 的强调色，叠在强调色 / 强调色浅底的气泡上几乎看不出来，像是选不中：
        // 强调色气泡反色（气泡上的字色当底），浅底气泡加深强调色
        const selection = strong
          ? 'selection:bg-accent-on selection:text-accent'
          : mine
            ? 'selection:bg-accent/40'
            : undefined
        const body = m.proposal ? (
          <ProposalCard message={m} membersById={membersById} readOnly={proposalsReadOnly} />
        ) : m.text ? (
          <div
            data-bubble
            className={cn(
              'max-w-full min-w-0 rounded-2xl px-3 py-1.5',
              mine ? (strong ? 'bg-accent' : 'bg-accent-soft') : 'bg-subtle',
              first && (mine ? 'rounded-tr-md' : 'rounded-tl-md'),
              selection,
            )}
          >
            {m.format === 'markdown' ? (
              <MarkdownBubble
                where={messageWorkspace(m, messagesById, membersById)}
                text={m.text}
                fade={mine ? 'from-accent-soft' : 'from-subtle'}
              />
            ) : (
              <MentionText text={m.text} members={channelMembers} mine={strong} />
            )}
          </div>
        ) : null
        return (
          <div
            key={m.id}
            data-channel-message={m.id}
            className={cn('group/message relative flex gap-2.5', mine && 'flex-row-reverse')}
          >
            {!mine && (
              <div className="w-7 shrink-0 pt-0.5">
                {first &&
                  (system ? (
                    <span className="inline-flex size-7 items-center justify-center rounded-md bg-subtle text-warn">
                      <BellRing size={15} strokeWidth={1.5} />
                    </span>
                  ) : (
                    <MemberAvatar member={author} />
                  ))}
              </div>
            )}
            {/* 右边（自己的在左边）给悬停工具条留 7.5rem，工具条放在气泡列外面，不压字也不被裁掉；
                别人的消息还要扣掉头像那一列（w-7 + gap-2.5） */}
            <div
              className={cn(
                'relative flex min-w-0 flex-col',
                mine ? 'max-w-[min(calc(100%_-_7.5rem),760px)]' : 'max-w-[min(calc(100%_-_7.5rem_-_38px),760px)]',
                mine ? 'items-end' : 'items-start',
                highlight === m.id && 'search-hit rounded-2xl',
              )}
            >
              {first && !mine && <AuthorLine member={author} />}
              {m.replyToId && (
                <QuoteBlock
                  quoted={quoted}
                  author={
                    quoted ? membersById.get(quoted.kind === 'task' ? quoted.assigneeId : quoted.authorId) : undefined
                  }
                  onJump={onJump}
                />
              )}
              {body && (
                <div className={cn('flex max-w-full min-w-0 items-end gap-1.5', mine && 'flex-row-reverse')}>
                  {body}
                  <time
                    dateTime={new Date(m.at).toISOString()}
                    className="invisible shrink-0 pb-1 text-[10px] leading-4 text-fg-faint tabular-nums group-hover/message:visible"
                  >
                    {formatClock(m.at)}
                  </time>
                </div>
              )}
              {m.alert && <AlertButtons message={m} readOnly={proposalsReadOnly} />}
              {m.attached && <MessageAttachments message={m} />}
              {m.chat && !m.flow && (
                <span data-chat-origin className="mt-0.5 px-1 text-meta text-fg-faint">
                  {tr(m.chat.via === 'qq' ? 'im.from.qq' : 'im.from.wechat')}
                </span>
              )}
              {renderBelow?.(m)}
              {threads && onThread && (
                <ThreadRow rootId={m.id} stats={threads} membersById={membersById} onOpen={onThread} />
              )}
              {pinned?.has(m.id) && (
                <span data-pinned className="mt-0.5 inline-flex items-center gap-1 px-1 text-meta text-fg-faint">
                  <Pin size={11} strokeWidth={1.75} />
                  {tr('channels.pinned')}
                </span>
              )}
              {/* 悬停 / 键盘焦点时显示；看不见的时候不挡鼠标 */}
              <div
                role="toolbar"
                aria-label={tr('channels.messageActions')}
                className={cn(
                  'pointer-events-none absolute top-0 z-10 flex w-max items-center gap-0.5 rounded-md border border-line-card bg-popover p-0.5 opacity-0 shadow-menu transition-opacity group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100',
                  mine ? 'right-full mr-1.5' : 'left-full ml-1.5',
                )}
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
                {onThread && (
                  <IconButton
                    icon={MessageSquareText}
                    label={tr('channels.thread.open')}
                    size={24}
                    iconSize={13}
                    onClick={() => onThread(m.id)}
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
          </div>
        )
      })}
    </div>
  )
}

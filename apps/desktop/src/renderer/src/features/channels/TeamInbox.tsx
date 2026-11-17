// 收件箱「通知」页（docs/multica-learn.md §7、§11.5）：一件事一行，点开跳到频道里那张卡；归档、延后、取消订阅
import { useRef, useState, type KeyboardEvent } from 'react'
import {
  Archive,
  AtSign,
  Ban,
  BellOff,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  MessageSquareReply,
  ShieldAlert,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import { cn, IconButton, Popover, PopoverItem } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { relativeTime } from '@/features/engine'
import { setPage } from '@/features/layout/page'
import type { TeamInboxItem, TeamInboxKind, TeamInboxPatch } from '../../../../shared/types/channels'
import { channelActions, useChannels } from './store'
import { INBOX_KIND, inboxId, inboxSnoozeTimes, visibleInbox } from './teamInboxModel'

const ICON: Record<TeamInboxKind, { icon: LucideIcon; tone: string }> = {
  mention: { icon: AtSign, tone: 'text-accent-fg' },
  reply: { icon: MessageSquareReply, tone: 'text-fg-muted' },
  assigned: { icon: UserPlus, tone: 'text-fg-muted' },
  approval: { icon: ShieldAlert, tone: 'text-warn' },
  failed: { icon: CircleX, tone: 'text-danger' },
  done: { icon: CircleCheck, tone: 'text-success' },
  review: { icon: CircleHelp, tone: 'text-warn' },
  rejected: { icon: Ban, tone: 'text-fg-muted' },
}

/** 「通知」标签的内容：onError 把失败交给外面的错误条 */
export function TeamInboxList({ now, onError }: { now: number; onError: (e: unknown) => void }) {
  useI18n()
  const items = visibleInbox(
    useChannels(s => s.inbox),
    now,
  )
  if (items.length === 0) return <p className="py-2 text-center text-meta text-fg-muted">{tr('inbox.empty')}</p>
  return (
    <ul data-team-inbox className="flex flex-col gap-1">
      {items.map(it => (
        <InboxRow key={inboxId(it)} item={it} now={now} onError={onError} />
      ))}
    </ul>
  )
}

function InboxRow({ item, now, onError }: { item: TeamInboxItem; now: number; onError: (e: unknown) => void }) {
  const members = useChannels(s => s.members)
  const channel = useChannels(s => s.channels.find(c => c.id === item.channelId))
  const [menu, setMenu] = useState(false)
  const snoozeBtn = useRef<HTMLButtonElement>(null)
  const patch = (p: TeamInboxPatch) => channelActions.patchInbox(item.teamId, item.key, p).catch(onError)
  const open = () => {
    if (!item.read) void patch({ read: true })
    setPage('channels')
    // at 传 0：只按找没找到、还有没有更早的来停（事件时间比卡新，不能当界线）
    void channelActions.focusMessage(item.channelId, item.key, 0)
  }
  const snooze = (until: number) => {
    setMenu(false)
    void patch({ snoozeUntil: until })
  }
  const keys = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault()
      void patch({ archived: true })
    } else if (e.key === 'h' || e.key === 'H') {
      e.preventDefault()
      setMenu(true)
    }
  }
  const name = members.find(m => m.id === item.actor)?.name ?? tr('inbox.unknown')
  const { icon: Icon, tone } = ICON[item.kind]
  const times = inboxSnoozeTimes(now)
  return (
    <li
      data-inbox-row={item.key}
      className="group relative flex items-start gap-2 rounded-md border border-line-subtle px-2 py-1.5 hover:bg-hover"
    >
      <Icon size={14} strokeWidth={1.75} className={cn('mt-0.5 shrink-0', tone)} />
      <button
        type="button"
        onClick={open}
        onKeyDown={keys}
        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-composer-ring"
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={cn('min-w-0 flex-1 truncate text-list', item.read ? 'text-fg-secondary' : 'font-medium text-fg')}
          >
            {tr(INBOX_KIND[item.kind], { name })}
          </span>
          {item.count > 1 && (
            <span className="shrink-0 text-meta text-fg-muted">{tr('inbox.more', { count: item.count })}</span>
          )}
          <span className="shrink-0 text-meta text-fg-faint tabular-nums">{relativeTime(item.at, now)}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 gap-1 text-meta text-fg-muted">
          {channel && <span className="shrink-0 text-fg-faint"># {channel.name}</span>}
          <span className="min-w-0 truncate" title={item.text}>
            {item.text}
          </span>
        </span>
      </button>
      {!item.read && (
        <span
          aria-label={tr('inbox.unread')}
          className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent group-hover:hidden"
        />
      )}
      <span
        className={cn(
          'shrink-0 items-center gap-0.5',
          menu ? 'flex' : 'hidden group-hover:flex group-focus-within:flex',
        )}
      >
        <IconButton
          icon={Archive}
          iconSize={13}
          size={22}
          label={tr('inbox.archive')}
          onClick={() => void patch({ archived: true })}
        />
        <IconButton
          ref={snoozeBtn}
          icon={Clock}
          iconSize={13}
          size={22}
          label={tr('inbox.snooze')}
          onClick={() => setMenu(m => !m)}
        />
        <IconButton
          icon={BellOff}
          iconSize={13}
          size={22}
          label={tr('inbox.mute')}
          onClick={() => void patch({ muted: true })}
        />
      </span>
      <Popover
        open={menu}
        onClose={() => setMenu(false)}
        anchor={snoozeBtn}
        align="end"
        role="menu"
        aria-label={tr('inbox.snooze')}
      >
        <PopoverItem onClick={() => snooze(times.hour)}>{tr('inbox.snooze.hour')}</PopoverItem>
        <PopoverItem onClick={() => snooze(times.tomorrow)}>{tr('inbox.snooze.tomorrow')}</PopoverItem>
        <PopoverItem onClick={() => snooze(times.nextWeek)}>{tr('inbox.snooze.nextWeek')}</PopoverItem>
      </Popover>
    </li>
  )
}

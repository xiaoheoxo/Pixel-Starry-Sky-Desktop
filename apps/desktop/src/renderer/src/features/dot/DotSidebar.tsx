import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleDot, RefreshCw } from 'lucide-react'
import { IconButton } from '@/ui'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { useEngineState } from '@/features/engine'
import { useRemember } from '@/features/panel/ToolsUi'
import { SidebarRow } from '@/features/sidebar/SidebarSection'
import { refreshDots, useDots } from './store'
import { DotAvatar } from './DotAvatar'
import { dotError } from './errors'

/**
 * 侧栏「频道」下面的 Dot 组（docs/ui/dot-optimize.md §4.1）：只对本机登录着 ChatGPT Pro 的用户显示；
 * 每个 Dot 一行，账号放悬停提示（有多个账号时行尾写账号）。点一行在主窗口打开它的对话标签
 */
export function DotNavGroup({ selectedSessionId }: { selectedSessionId?: string | null }) {
  useI18n()
  const dots = useDots()
  const [open, setOpen] = useRemember<boolean>('pixelsky.dot.sidebarOpen', true)
  const [error, setError] = useState('')
  const selected = useEngineState(s =>
    selectedSessionId ? s.sessions.find(x => x.record.id === selectedSessionId)?.record.dot : undefined,
  )
  // 这一轮回完了、还没点开看的 Dot 会话（会话自己的未读，和别的会话一样由引擎状态记）：不用等主进程下一次查
  const unreadSessions = useEngineState(s =>
    s.sessions
      .filter(x => x.record.dot && s.unread[x.record.id])
      .map(x => `${x.record.dot!.account}\n${x.record.dot!.id}`)
      .join('|'),
  ).split('|')
  if (!dots.eligible) return null
  const accounts = new Set(dots.entries.map(e => e.account))
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div data-dot-group className="group/dot flex flex-col gap-px">
      <div className="relative">
        <SidebarRow onClick={() => setOpen(!open)} aria-expanded={open} title={tr('dot.group')}>
          <CircleDot size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate">{tr('dot.title')}</span>
          <Chevron size={14} className="mr-6 shrink-0 text-fg-faint" />
        </SidebarRow>
        <IconButton
          icon={RefreshCw}
          label={tr('dot.refresh')}
          size={22}
          iconSize={13}
          disabled={dots.loading}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-hover/dot:opacity-100 focus-visible:opacity-100"
          onClick={() => void refreshDots()}
        />
      </div>
      {open &&
        dots.entries.map(entry => (
          <SidebarRow
            key={entry.key}
            className="pl-7"
            selected={!!selected && selected.account === entry.account && selected.id === entry.id}
            title={`${entry.name} · ${entry.accountName}`}
            onClick={() => {
              setError('')
              void window.pixelsky?.dotChat.open(entry.key).catch(e => setError(dotError(e)))
            }}
          >
            <DotAvatar name={entry.name} url={entry.avatarUrl} size={18} status={entry.status} />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {(dots.unread.includes(entry.key) || unreadSessions.includes(`${entry.account}\n${entry.id}`)) && (
              <span
                data-dot-unread
                role="status"
                aria-label={tr('dot.unread')}
                title={tr('dot.unread')}
                className="size-2 shrink-0 rounded-full bg-accent"
              />
            )}
            {accounts.size > 1 && (
              <span className="max-w-[45%] truncate text-meta text-fg-faint">{entry.accountName}</span>
            )}
          </SidebarRow>
        ))}
      {open && !dots.entries.length && (
        <p className="py-1 pr-2.5 pl-7 text-meta text-fg-faint">
          {dots.loading ? tr('dot.loading') : dots.errors.length ? dotError(dots.errors[0]) : tr('dot.empty')}
        </p>
      )}
      {error && (
        <p role="alert" className="pr-2.5 pl-7 text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

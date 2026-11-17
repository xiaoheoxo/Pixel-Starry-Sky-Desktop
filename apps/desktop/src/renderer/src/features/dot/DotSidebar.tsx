import { useState } from 'react'
import { CircleDot, RefreshCw } from 'lucide-react'
import { IconButton } from '@/ui'
import { tr, translateMessage } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { SidebarRow, SidebarSection } from '@/features/sidebar/SidebarSection'
import { refreshDots, useDots } from './store'
import { DotAvatar } from './DotAvatar'

export function DotNavEntry() {
  useI18n()
  const dots = useDots()
  const [error, setError] = useState('')
  if (!dots.eligible) return null
  return (
    <>
      <SidebarRow
        title={tr('dot.open')}
        onClick={() => void window.pixelsky?.dotChat.open().catch(e => setError(String(e)))}
      >
        <CircleDot size={16} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{tr('dot.title')}</span>
      </SidebarRow>
      {error && (
        <p role="alert" className="px-2 text-meta text-danger">
          {translateMessage(error)}
        </p>
      )}
    </>
  )
}

/** 对话列表下面的动态入口，使用账号 + Dot 身份作键，重名 Dot 仍可区分。 */
export function DotSidebarList() {
  useI18n()
  const dots = useDots()
  const [error, setError] = useState('')
  if (!dots.eligible) return null
  return (
    <SidebarSection
      title={tr('dot.chats')}
      count={dots.entries.length}
      action={
        <IconButton
          icon={RefreshCw}
          label={tr('dot.refresh')}
          size={22}
          iconSize={14}
          disabled={dots.loading}
          onClick={() => void refreshDots()}
        />
      }
    >
      {dots.entries.map(entry => (
        <SidebarRow
          key={entry.key}
          title={`${entry.name} · ${entry.accountName}`}
          onClick={() => void window.pixelsky?.dotChat.open(entry.key).catch(e => setError(String(e)))}
        >
          <DotAvatar name={entry.name} url={entry.avatarUrl} size={20} />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          <span className="max-w-[45%] truncate text-meta text-fg-faint">{entry.accountName}</span>
        </SidebarRow>
      ))}
      {!dots.entries.length && (
        <p className="px-2.5 py-1 text-meta text-fg-faint">{tr(dots.loading ? 'dot.loading' : 'dot.empty')}</p>
      )}
      {error && (
        <p role="alert" className="px-2.5 text-meta text-danger">
          {translateMessage(error)}
        </p>
      )}
    </SidebarSection>
  )
}

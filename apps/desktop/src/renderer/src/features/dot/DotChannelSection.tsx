import { useState } from 'react'
import { Button } from '@/ui'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { useDots } from './store'
import { DotAvatar } from './DotAvatar'
import { DotExperimental } from './DotExperimental'
import { dotError } from './errors'

/**
 * 设置 › 模型通道「ChatGPT 授权」卡片里的 Dot 一节（docs/ui/dot-optimize.md §4、样稿「设置 › 模型通道」）：
 * 只对本机登录着 ChatGPT Pro 的用户显示；每个 Dot 一行，带账号和「打开」
 */
export function DotChannelSection() {
  useI18n()
  const dots = useDots()
  const [error, setError] = useState('')
  if (!dots.eligible) return null
  return (
    <div data-dot-channel className="flex flex-col gap-1.5 border-t border-line-subtle px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-ui font-medium text-fg">{tr('modelChannels.channel.dot')}</span>
        <DotExperimental />
        <span className="truncate text-meta text-fg-faint">{tr('dot.proOnly')}</span>
      </div>
      {dots.entries.map(entry => (
        <div key={entry.key} className="flex min-w-0 items-center gap-2.5">
          <DotAvatar name={entry.name} url={entry.avatarUrl} size={22} />
          <span className="min-w-0 truncate text-ui text-fg">{entry.name}</span>
          <span className="min-w-0 flex-1 truncate text-meta text-fg-muted">{entry.accountName}</span>
          <Button
            onClick={() => {
              setError('')
              void window.pixelsky?.dotChat.open(entry.key).catch(e => setError(dotError(e)))
            }}
          >
            {tr('dot.openOne')}
          </Button>
        </div>
      ))}
      {!dots.entries.length && (
        <p className="text-meta text-fg-faint">
          {dots.loading ? tr('dot.loading') : dots.errors.length ? dotError(dots.errors[0]) : tr('dot.empty')}
        </p>
      )}
      <p className="text-meta text-fg-faint">{tr('modelChannels.dot.sharedLogin')}</p>
      {error && (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

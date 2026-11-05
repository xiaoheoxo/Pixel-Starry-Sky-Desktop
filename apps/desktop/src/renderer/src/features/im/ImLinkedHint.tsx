import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { PackBadge } from '@/features/settings/extensions/PackBadge'
import type { ImState } from '../../../../shared/types/im'

/** 频道输入框上方：这个频道接着 QQ、微信发来的消息（设置 › 消息通道） */
export function ImLinkedHint({ channelId }: { channelId: string }) {
  const { t } = useI18n()
  const bridge = window.pixelsky?.im
  const [state, setState] = useState<ImState | null>(null)

  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge
      .state()
      .then(s => {
        if (alive) setState(s)
      })
      .catch(() => undefined)
    const off = bridge.onChange(setState)
    return () => {
      alive = false
      off()
    }
  }, [bridge])

  if (state?.target !== 'channel' || state.channelId !== channelId) return null
  const linked = state.channels.filter(c => c.status === 'online' && c.bound)
  if (!linked.length) return null
  return (
    <div data-im-linked className="conversation-inset conversation-reading flex shrink-0 flex-wrap gap-1.5 pb-1">
      {linked.map(c => (
        <PackBadge key={c.platform} tone="info">
          {t(c.platform === 'qq' ? 'im.linked.qq' : 'im.linked.wechat')}
        </PackBadge>
      ))}
    </div>
  )
}

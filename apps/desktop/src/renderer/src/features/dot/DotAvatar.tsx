import { useEffect, useState } from 'react'
import { CircleDot } from 'lucide-react'
import { cn } from '@/ui'
import { dotPresence, presenceTone } from './status'

/** status：传了就在右下角画状态点（在线 / 暂停 / 不在），悬停写状态 */
export function DotAvatar({
  url,
  name,
  size = 28,
  className,
  status,
}: {
  url?: string
  name: string
  size?: number
  className?: string
  status?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  const dot = Math.max(6, Math.round(size * 0.24))
  return (
    <span className={cn('dot-avatar', className)} style={{ width: size, height: size }}>
      {url && !failed ? (
        <img src={url} alt={name} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <CircleDot size={size * 0.7} strokeWidth={1.5} aria-hidden="true" />
      )}
      {status !== undefined && (
        <span
          className="dot-avatar-status"
          data-tone={presenceTone(status)}
          title={dotPresence(status)}
          style={{ width: dot, height: dot }}
        />
      )}
    </span>
  )
}

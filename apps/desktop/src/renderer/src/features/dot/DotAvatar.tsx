import { useEffect, useState } from 'react'
import { CircleDot } from 'lucide-react'
import { cn } from '@/ui'

export function DotAvatar({
  url,
  name,
  size = 28,
  className,
}: {
  url?: string
  name: string
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  return (
    <span className={cn('dot-avatar', className)} style={{ width: size, height: size }}>
      {url && !failed ? (
        <img src={url} alt={name} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <CircleDot size={size * 0.7} strokeWidth={1.5} aria-hidden="true" />
      )}
    </span>
  )
}

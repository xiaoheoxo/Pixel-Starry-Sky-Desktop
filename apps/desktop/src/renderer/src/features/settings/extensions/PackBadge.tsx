import type { ReactNode } from 'react'
import { cn } from '@/ui'

/** 扩展来源 / 状态小标：h-5、text-meta。ui/Chip 是 h-7 且只有两种色调，这里自己做一个 */
export function PackBadge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'warn' | 'danger' | 'info'
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded px-1.5 text-meta whitespace-nowrap',
        tone === 'neutral' && 'bg-subtle text-fg-muted',
        tone === 'warn' && 'bg-subtle text-warn',
        tone === 'danger' && 'bg-subtle text-danger',
        // 「官方」标：蓝色，和反馈状态「团队已看到」同一个蓝
        tone === 'info' && 'bg-status-seen/12 text-status-seen',
      )}
    >
      {children}
    </span>
  )
}

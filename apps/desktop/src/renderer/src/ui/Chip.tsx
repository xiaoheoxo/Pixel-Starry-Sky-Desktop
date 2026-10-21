import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../i18n/core'
import type { ReactNode } from 'react'
import { X, type LucideIcon } from 'lucide-react'
import { cn } from './cn'

interface ChipProps {
  icon?: LucideIcon
  tone?: 'neutral' | 'accent'
  onRemove?: () => void
  className?: string
  children: ReactNode
}

/** 附件 / 模式标签，例如「Chrome · 127.0.0.1:8330 ×」 */
export function Chip({ icon: Icon, tone = 'neutral', onRemove, className, children }: ChipProps) {
  useI18n()
  return (
    <span
      data-chip
      className={cn(
        'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md pr-1 pl-2.5 text-list',
        tone === 'neutral' ? 'border border-line bg-surface text-fg-secondary' : 'bg-accent-soft text-accent-fg',
        className,
      )}
    >
      {Icon && <Icon size={14} strokeWidth={1.5} className="shrink-0" />}
      <span className="truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={tr('ui.Chip.remove')}
          onClick={onRemove}
          className="inline-flex size-[18px] shrink-0 items-center justify-center rounded text-current opacity-70 hover:bg-hover hover:opacity-100"
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </span>
  )
}

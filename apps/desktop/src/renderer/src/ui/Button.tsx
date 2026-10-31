import { useI18n } from '@/i18n/I18nProvider'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from './cn'

type Variant = 'outline' | 'ghost' | 'primary' | 'subtle'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  icon?: LucideIcon
  /** 圆角胶囊形（如「审查」按钮） */
  pill?: boolean
  children?: ReactNode
}

const VARIANTS: Record<Variant, string> = {
  outline: 'border border-line-strong bg-surface text-fg shadow-sm hover:border-fg-faint',
  ghost: 'text-fg-secondary hover:bg-hover hover:text-fg',
  primary: 'bg-primary text-primary-fg shadow-sm hover:opacity-90',
  subtle: 'bg-subtle text-fg hover:bg-hover',
}

export function Button({ variant = 'outline', icon: Icon, pill, className, children, ...rest }: ButtonProps) {
  useI18n()
  return (
    <button
      type="button"
      className={cn(
        'press no-drag inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-ui font-medium disabled:pointer-events-none disabled:opacity-45',
        pill ? 'rounded-full' : 'rounded-md',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={15} strokeWidth={1.5} />}
      {children}
    </button>
  )
}

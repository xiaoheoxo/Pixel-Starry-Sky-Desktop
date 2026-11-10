import { useI18n } from '@/i18n/I18nProvider'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from './cn'

// 表格、列表里的叶子按钮（例如「上一页」「下一页」）也可以直接用，不只能在外形里
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  /** 无障碍名称，同时作为悬停提示 */
  label: string
  /** 按钮边长，默认 28 */
  size?: number
  iconSize?: number
  active?: boolean
  ref?: Ref<HTMLButtonElement>
  /** 图标后面的小标记（数字、状态点） */
  children?: ReactNode
}

/** 只有图标的方形按钮：悬停变 bg-hover，active 时 bg-selected */
export function IconButton({
  icon: Icon,
  label,
  size = 28,
  iconSize = 16,
  active,
  className,
  style,
  children,
  ...rest
}: IconButtonProps) {
  useI18n()
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'press no-drag inline-flex shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        active && 'bg-selected text-fg hover:bg-selected',
        className,
      )}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      <Icon size={iconSize} strokeWidth={1.5} />
      {children}
    </button>
  )
}

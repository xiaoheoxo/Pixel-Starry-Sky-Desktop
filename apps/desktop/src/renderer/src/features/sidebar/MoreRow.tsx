import { useEffect, useRef } from 'react'
import { Archive, ChevronRight } from 'lucide-react'
import { cn } from '@/ui'
import { tr } from '../../i18n/core'

/** 对话下面的小字行：「还有 N 个对话 ›」/「收起」文字、「已归档 N 个」图标均与会话标题左侧对齐 */
export function MoreRow({
  label,
  open,
  onClick,
  onShowAll,
  icon,
}: {
  label: string
  open: boolean
  onClick: () => void
  onShowAll?: () => void
  icon?: boolean
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      aria-expanded={open}
      title={onShowAll ? tr('sidebar.tree.moreHint') : undefined}
      onClick={event => {
        if (onShowAll && (event.detail >= 2 || event.shiftKey || (event.detail === 1 && timer.current !== null))) {
          cancel()
          onShowAll()
        } else if (!onShowAll || event.detail === 0) {
          cancel()
          onClick()
        } else {
          // Inserting the next page immediately would move the button before the second click can reach it.
          timer.current = setTimeout(() => {
            timer.current = null
            onClick()
          }, 500)
        }
      }}
      className={cn(
        'flex h-7 w-full min-w-0 shrink-0 items-center rounded-md pr-2.5 pl-[28px] text-left text-meta text-fg-muted hover:bg-hover hover:text-fg',
        icon ? 'gap-2.5' : 'gap-1.5',
      )}
    >
      {icon && <Archive size={12} strokeWidth={1.5} className="shrink-0" />}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronRight
        size={12}
        strokeWidth={1.75}
        className={cn('shrink-0 transition-transform duration-150', open && (icon ? 'rotate-90' : '-rotate-90'))}
      />
    </button>
  )
}

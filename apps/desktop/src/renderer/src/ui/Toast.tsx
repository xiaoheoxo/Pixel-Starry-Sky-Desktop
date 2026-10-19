// 一句话提示的外框（docs/ui/ui-polish-2026-10-13.md §2）：「即将推出」、会话操作结果、窗格提示都用它。
// 统一放在窗口顶部中间、标签栏下面——原来贴着底部，正好压在输入框下面那一排（模型、推理强度）上。
import { useLayoutEffect, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'
import { notifyOverlayChange } from './overlayEvents'

export function Toast({
  children,
  scope = 'window',
  className,
  ...rest
}: {
  children: ReactNode
  /** window：相对窗口（fixed）；area：相对窗格区（父元素 relative） */
  scope?: 'window' | 'area'
} & HTMLAttributes<HTMLDivElement>) {
  // 出现、消失时让内置浏览器重新判断会不会挡住它
  useLayoutEffect(() => {
    notifyOverlayChange()
    return notifyOverlayChange
  }, [])
  return (
    <div
      role="status"
      aria-live="polite"
      {...rest}
      className={cn(
        'toast-in left-1/2 z-[90] flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-line-card bg-popover px-4 py-2 text-ui text-fg shadow-menu',
        scope === 'window' ? 'fixed top-[92px]' : 'absolute top-11',
        className,
      )}
    >
      {children}
    </div>
  )
}

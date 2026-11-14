import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../i18n/core'
import { cn } from './cn'

/**
 * 运行中的小图标（只是外观）：2×2 像素方格不动，亮的那块顺时针流过去、后面跟一块半亮的，领头那块是运行中的橙色
 * （样式在 globals.css 的 .pixel-spinner，样稿 docs/ui/pixel-spinner-motion.html）。
 * 方块按整数像素排，不糊边；mono：领头也用文字色（调用方给了别的状态色时，不和橙色混在一起）。
 */
export function Spinner({ size = 14, className, mono }: { size?: number; className?: string; mono?: boolean }) {
  useI18n()
  const cell = Math.max(2, Math.floor((size - 3) / 2))
  const pad = (size - cell * 2 - 1) / 2
  return (
    <span
      role="img"
      className={cn('pixel-spinner inline-grid shrink-0 gap-px text-fg-muted', className)}
      data-mono={mono ? '' : undefined}
      style={{
        width: size,
        height: size,
        padding: pad,
        gridTemplateColumns: `${cell}px ${cell}px`,
        gridAutoRows: cell,
      }}
      aria-label={tr('session.live.agentTrace.running')}
    >
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

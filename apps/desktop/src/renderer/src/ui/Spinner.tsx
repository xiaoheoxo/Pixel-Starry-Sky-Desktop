import { useInsertionEffect, type CSSProperties } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../i18n/core'
import { cn } from './cn'
import { ensureStrip } from './spinnerStrip'

/**
 * 运行中的小图标（只是外观）：2×2 像素方格不动，亮的那块顺时针流过去、后面跟一块半亮的，领头那块是运行中的橙色
 * （样稿 docs/ui/pixel-spinner-motion.html）。方块按整数像素排，不糊边；mono：领头也用文字色（调用方给了别的状态色时，不和橙色混在一起）。
 * 画法是帧条（ui/spinnerStrip.ts、globals.css 的 .pixel-spinner）：灰色、领头两层只挪遮罩位置，不进合成层，分屏过渡不掉帧（docs/ui/multi-pane.md §7.2）。
 */
export function Spinner({ size = 14, className, mono }: { size?: number; className?: string; mono?: boolean }) {
  useI18n()
  const cell = Math.max(2, Math.floor((size - 3) / 2))
  const pad = (size - cell * 2 - 1) / 2
  useInsertionEffect(() => ensureStrip(cell), [cell])
  return (
    <span
      role="img"
      className={cn('pixel-spinner relative inline-grid shrink-0 gap-px text-fg-muted', className)}
      data-mono={mono ? '' : undefined}
      data-cell={cell}
      style={
        {
          width: size,
          height: size,
          padding: pad,
          gridTemplateColumns: `${cell}px ${cell}px`,
          gridAutoRows: cell,
          '--pixel-pad': `${pad}px`,
          '--pixel-w': `${cell * 2 + 1}px`,
        } as CSSProperties
      }
      aria-label={tr('session.live.agentTrace.running')}
    >
      {/* 4 个空格子只占位：排版、基线和原来的 2×2 方格一样（图标常在文字行里） */}
      <i />
      <i />
      <i />
      <i />
      <b className="pixel-gray" />
      <b className="pixel-lead" />
    </span>
  )
}

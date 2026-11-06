import type { CSSProperties } from 'react'
import { tr } from '../../i18n/core'
import type { Palette } from '@/features/appearance/palette'

/** 第三方配色用原名，不翻译；自己的（null）走翻译 */
const NAMES: Record<Palette, string | null> = {
  default: null,
  midnight: null,
  github: 'GitHub',
  solarized: 'Solarized',
  nord: 'Nord',
  catppuccin: 'Catppuccin',
  gruvbox: 'Gruvbox',
  tokyonight: 'Tokyo Night',
  rosepine: 'Rosé Pine',
}
export const paletteName = (value: Palette): string =>
  NAMES[value] ?? (value === 'midnight' ? tr('minimal.paletteMidnight') : tr('settings.PaletteSettings.default'))

/**
 * 缩略界面：侧栏、主区、一张卡片、两行字、主色按钮。颜色全部在预览元素自己身上取：
 * 内置配色靠 tokens.css 的 [data-palette-preview]，自建主题传 vars
 */
export function PalettePreview({ value, vars }: { value?: Palette; vars?: Record<string, string> }) {
  return (
    <div
      aria-hidden
      data-palette-preview={value}
      style={vars as CSSProperties | undefined}
      className="flex h-16 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-app)]"
    >
      <div className="flex w-1/4 flex-col gap-1 bg-[var(--bg-sidebar)] p-1.5">
        <span className="h-1 w-full rounded-full bg-[var(--text-faint)]" />
        <span className="h-1 w-3/4 rounded-full bg-[var(--theme-accent)]" />
        <span className="h-1 w-full rounded-full bg-[var(--text-faint)]" />
      </div>
      <div className="flex flex-1 flex-col justify-end p-1.5">
        <div className="flex items-end justify-between gap-1 rounded border border-[var(--border)] bg-[var(--bg-surface)] p-1.5">
          <div className="flex flex-1 flex-col gap-1">
            <span className="h-1 w-4/5 rounded-full bg-[var(--text)]" />
            <span className="h-1 w-1/2 rounded-full bg-[var(--text-muted)]" />
          </div>
          <span className="size-2.5 shrink-0 rounded-full bg-[var(--theme-accent)]" />
        </div>
      </div>
    </div>
  )
}

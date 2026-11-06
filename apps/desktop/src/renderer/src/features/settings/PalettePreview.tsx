import type { CSSProperties } from 'react'
import { tr } from '../../i18n/core'
import { cn } from '@/ui'
import type { Palette } from '@/features/appearance/palettes'

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
 * 内置配色靠 tokens.css 的 [data-palette-preview]，自建主题传 vars。
 * glass：带玻璃的主题，底下垫一层彩色，侧栏和卡片半透明，一眼看出窗口是透的
 */
export function PalettePreview({
  value,
  vars,
  glass,
}: {
  value?: Palette
  vars?: Record<string, string>
  glass?: boolean
}) {
  return (
    <div
      aria-hidden
      data-palette-preview={value}
      style={
        {
          ...vars,
          ...(glass && {
            backgroundImage: 'linear-gradient(120deg, var(--danger), var(--success) 45%, var(--theme-accent))',
          }),
        } as CSSProperties
      }
      className="flex h-16 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-app)]"
    >
      <div
        className={cn(
          'flex w-1/4 flex-col gap-1 p-1.5',
          glass ? 'bg-[color-mix(in_srgb,var(--bg-sidebar)_45%,transparent)]' : 'bg-[var(--bg-sidebar)]',
        )}
      >
        <span className="h-1 w-full rounded-full bg-[var(--text-faint)]" />
        <span className="h-1 w-3/4 rounded-full bg-[var(--theme-accent)]" />
        <span className="h-1 w-full rounded-full bg-[var(--text-faint)]" />
      </div>
      <div className="flex flex-1 flex-col justify-end p-1.5">
        <div
          className={cn(
            'flex items-end justify-between gap-1 rounded border border-[var(--border)] p-1.5',
            glass ? 'bg-[color-mix(in_srgb,var(--bg-surface)_70%,transparent)]' : 'bg-[var(--bg-surface)]',
          )}
        >
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

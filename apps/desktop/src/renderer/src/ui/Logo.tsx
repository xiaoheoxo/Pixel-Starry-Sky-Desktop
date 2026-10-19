import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../i18n/core'

/**
 * 应用标志：圆角方块里一个单线 P，右上一颗四角星（docs/brand/logo-replacement.md）。
 * 和应用图标是同一套图形（scripts/make-brand-icons.mjs），改图形时两边一起改。颜色跟主题（tokens.css 的 --logo-*）：
 * 浅色主题深色方块 + 米白 P，深色主题浅色方块 + 深色 P
 */
export function Logo({ size = 22 }: { size?: number }) {
  useI18n()
  return (
    <svg width={size} height={size} viewBox="-16 -15 70 70" role="img" aria-label={tr('ui.Logo.pixelStarrySky')}>
      <rect x="-16" y="-15" width="70" height="70" rx="16.5" style={{ fill: 'var(--logo-tile)' }} />
      <path
        d="M0 40V0H11A11.5 11.5 0 0 1 11 23H0"
        fill="none"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ stroke: 'var(--logo-mark)' }}
      />
      <path
        d="M34 -1.75Q35.4 3.85 41 5.25Q35.4 6.65 34 12.25Q32.6 6.65 27 5.25Q32.6 3.85 34 -1.75Z"
        strokeWidth="1.5"
        strokeLinejoin="round"
        style={{ fill: 'var(--logo-star)', stroke: 'var(--logo-star)' }}
      />
    </svg>
  )
}

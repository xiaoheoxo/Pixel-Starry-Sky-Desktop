import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../i18n/core'

/** 字母的单线中线和横向位置（大写高 0–40，线粗 5），和 build/brand/wordmark-dark.svg 同一份 */
const GLYPHS: Array<[number, string]> = [
  [65, 'M0 40V0H10A11 11 0 0 1 10 22H0'],
  [98, 'M0 12V40'],
  [110, 'M0 12L20 40M20 12L0 40'],
  [142, 'M0 26H28A14 14 0 1 0 23.9 35.9'],
  [182, 'M0 0V40'],
  [194, 'M17.89 3.21A9 9 0 1 0 11 18A11 11 0 1 1 2.57 36.07'],
  [228, 'M0 0V40M19 12L0 28M6.5 22.5L19 40'],
  [259, 'M0 12L10.4 36M20 12L4 52'],
]

/**
 * 字标：描边四角星（右上一颗强调色小星）+ 单线 PixelSky（docs/brand/logo-replacement.md）。
 * height 是整个字标的高度；颜色跟主题（tokens.css 的 --logo-word、--logo-word-star）
 */
export function Wordmark({ height = 32 }: { height?: number }) {
  useI18n()
  const ink = { stroke: 'var(--logo-word)' }
  return (
    <svg
      height={height}
      width={(height * 287) / 62}
      viewBox="-3 -5 287 62"
      role="img"
      aria-label={tr('ui.Logo.pixelStarrySky')}
    >
      <path
        d="M20 1Q25.07 15.43 39.5 20.5Q25.07 25.57 20 40Q14.93 25.57 0.5 20.5Q14.93 15.43 20 1Z"
        fill="none"
        strokeWidth="4.5"
        strokeLinejoin="round"
        style={ink}
      />
      <path
        d="M37 -2.5Q38.1 1.9 42.5 3Q38.1 4.1 37 8.5Q35.9 4.1 31.5 3Q35.9 1.9 37 -2.5Z"
        strokeWidth="1.5"
        strokeLinejoin="round"
        style={{ fill: 'var(--logo-word-star)', stroke: 'var(--logo-word-star)' }}
      />
      <g fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" style={ink}>
        {GLYPHS.map(([x, d]) => (
          <path key={x} d={d} transform={`translate(${x} 0)`} />
        ))}
      </g>
      <circle cx="98" cy="2" r="3" style={{ fill: 'var(--logo-word)' }} />
    </svg>
  )
}

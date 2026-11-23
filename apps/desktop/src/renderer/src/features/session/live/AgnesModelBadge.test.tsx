import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { AgnesModelBadge } from './AgnesModelBadge'

it('does not conflate a model match with verified adoption', () => {
  const render = (source: 'agnes' | 'agnes-match' | 'default') =>
    renderToStaticMarkup(
      <I18nProvider>
        <AgnesModelBadge source={source} />
      </I18nProvider>,
    )
  for (const [locale, matched, adopted] of [
    ['zh-CN', '符合 Agnes 建议', '采纳 Agnes 建议'],
    ['en-US', 'Matches Agnes advice', 'Agnes recommendation used'],
  ]) {
    vi.stubGlobal('localStorage', { getItem: () => locale, setItem: () => undefined })
    try {
      expect(render('agnes-match')).toContain(matched)
      expect(render('agnes-match')).not.toContain(adopted)
      expect(render('agnes')).toContain(adopted)
      expect(render('default')).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  }
})

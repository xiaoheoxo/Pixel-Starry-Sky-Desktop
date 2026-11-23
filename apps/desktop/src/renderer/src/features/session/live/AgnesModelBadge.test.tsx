import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { setCurrentLocale } from '@/i18n/core'
import { AgnesModelBadge } from './AgnesModelBadge'

afterEach(() => {
  vi.unstubAllGlobals()
  setCurrentLocale('zh-CN')
})

function renderBadge(source: 'chosen' | 'default' | 'agnes' | 'agnes-match' | undefined): string {
  vi.stubGlobal('localStorage', { getItem: () => 'zh-CN', setItem: () => undefined })
  return renderToStaticMarkup(
    <I18nProvider>
      <AgnesModelBadge source={source} />
    </I18nProvider>,
  )
}

describe('AgnesModelBadge', () => {
  it('distinguishes confirmed Agnes adoption from unconfirmed model match', () => {
    const confirmed = renderBadge('agnes')
    expect(confirmed).toContain('data-agent-source="agnes"')
    expect(confirmed).toContain('采纳 Agnes 建议')
    expect(confirmed).not.toContain('未确认')

    const matched = renderBadge('agnes-match')
    expect(matched).toContain('data-agent-source="agnes-match"')
    expect(matched).toContain('符合 Agnes 建议')
    expect(matched).toContain('未确认是否由主模型采纳')

    expect(renderBadge('chosen')).toBe('')
    expect(renderBadge(undefined)).toBe('')
  })
})

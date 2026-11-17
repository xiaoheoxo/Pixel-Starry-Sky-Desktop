import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { DotNavEntry, DotSidebarList } from './DotSidebar'
const state = vi.hoisted(() => ({
  eligible: true,
  loading: false,
  entries: [
    { key: 'first', name: 'Dot One', accountName: 'one@example.com' },
    { key: 'second', name: 'Dot Two', accountName: 'two@example.com' },
  ],
}))
vi.mock('./store', () => ({ useDots: () => state, refreshDots: vi.fn() }))
const render = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <DotNavEntry />
      <DotSidebarList />
    </I18nProvider>,
  )
describe('Dot sidebar entries', () => {
  it('shows a general entry and dynamic account-specific Dot entries', () => {
    const html = render()
    expect(html).toContain('打开 Dot 聊天')
    expect(html).toContain('Dot 聊天')
    expect(html).toContain('Dot One')
    expect(html).toContain('one@example.com')
    expect(html).toContain('Dot Two')
    expect(html).toContain('two@example.com')
  })
  it('renders neither entry for accounts without Pro', () => {
    state.eligible = false
    expect(render()).toBe('')
    state.eligible = true
  })
})

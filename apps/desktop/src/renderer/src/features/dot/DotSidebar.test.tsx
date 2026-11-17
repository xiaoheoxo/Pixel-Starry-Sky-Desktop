import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { DotNavGroup } from './DotSidebar'
const state = vi.hoisted(() => ({
  eligible: true,
  loading: false,
  errors: [] as string[],
  entries: [
    { key: 'first', account: 'a', name: 'Dot One', accountName: 'one@example.com' },
    { key: 'second', account: 'a', name: 'Dot Two', accountName: 'one@example.com' },
  ],
}))
vi.mock('./store', () => ({ useDots: () => state, refreshDots: vi.fn() }))
vi.mock('@/features/engine', () => ({ useEngineState: () => undefined }))
vi.mock('@/features/panel/ToolsUi', () => ({ useRemember: (_key: string, value: unknown) => [value, vi.fn()] }))
const render = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <DotNavGroup />
    </I18nProvider>,
  )
describe('Dot sidebar group', () => {
  it('lists every Dot in one group; the account stays in the tooltip while there is only one', () => {
    const html = render()
    expect(html).toContain('data-dot-group')
    expect(html).toContain('Dot One')
    expect(html).toContain('Dot Two')
    expect(html).not.toContain('>one@example.com<')
    expect(html).toContain('title="Dot One · one@example.com"')
  })
  it('shows the account at the end of the row when there are several accounts', () => {
    state.entries[1] = { ...state.entries[1], account: 'b', accountName: 'two@example.com' }
    expect(render()).toContain('>two@example.com<')
  })
  it('renders nothing unless this computer is signed in to ChatGPT Pro', () => {
    state.eligible = false
    expect(render()).toBe('')
    state.eligible = true
  })
  it('shows main-process errors in Chinese', () => {
    const entries = state.entries
    state.entries = []
    state.errors = ['Dot paused or unavailable; open ChatGPT']
    expect(render()).toContain('Dot 已暂停或暂不可用，请到 ChatGPT 查看')
    state.entries = entries
    state.errors = []
  })
})

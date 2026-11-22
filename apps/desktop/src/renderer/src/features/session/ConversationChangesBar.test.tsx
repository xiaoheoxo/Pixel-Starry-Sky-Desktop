import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Item } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { ConversationChangesBar } from './ConversationChangesBar'

vi.mock('@/features/panel/artifacts/focus', () => ({ reviewTurn: vi.fn() }))

function render(items: readonly Item[], running: boolean) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ConversationChangesBar items={items} cwd="C:/project" sessionId="branch" running={running} />
    </I18nProvider>,
  )
}

const history = Array.from({ length: 19 }, (_, i): Item[] => [
  { kind: 'user', id: `message-${i}`, text: 'continue', createdAt: i },
  {
    kind: 'file_change',
    id: `edit-${i}`,
    status: 'completed',
    changes: [{ path: `C:/project/readme-${i}.md`, kind: 'update', diff: '', added: 1, removed: 0 }],
  },
]).flat()

it('uses exactly one button and a hover preview for the active turn, even for a long branch conversation', () => {
  const html = render(history, true)
  expect(html.match(/<button\b/g)).toHaveLength(1)
  expect(html.match(/role="tooltip"/g)).toHaveLength(1)
  expect(html).toContain('readme-18.md')
  expect(html).not.toContain('readme-17.md')
  const previewId = html.match(/aria-describedby="([^"]+)"/)?.[1]
  expect(previewId).toBeTruthy()
  expect(html).toContain(`id="${previewId}" role="tooltip"`)
})

it('removes the button and preview as soon as the turn ends', () => {
  expect(render(history, false)).toBe('')
  expect(render([], true)).toBe('')
})

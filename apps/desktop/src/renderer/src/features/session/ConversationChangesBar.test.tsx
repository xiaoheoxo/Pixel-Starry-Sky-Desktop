import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Item } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { ConversationChangesBar } from './ConversationChangesBar'

vi.mock('@/features/panel/artifacts/focus', () => ({ reviewTurn: vi.fn(), reviewTurnFile: vi.fn() }))

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

it('uses one summary button and a separate file button for the active turn, even for a long branch conversation', () => {
  const html = render(history, true)
  expect(html.match(/<button\b/g)).toHaveLength(2)
  expect(html.match(/data-conversation-changes/g)).toHaveLength(1)
  expect(html).toContain('readme-18.md')
  expect(html).not.toContain('readme-17.md')
  const previewId = html.match(/aria-controls="([^"]+)"/)?.[1]
  expect(previewId).toBeTruthy()
  expect(html).toContain(`id="${previewId}" role="group"`)
})

it('makes every changed file selectable, including same-name files and files beyond the former preview limit', () => {
  const changes = Array.from({ length: 11 }, (_, i) => ({
    path: `C:/project/src-${i}/ControlCenterScreen.java`,
    kind: 'update' as const,
    diff: '',
    added: 1,
    removed: 0,
  }))
  const html = render(
    [
      { kind: 'user', id: 'u1', text: 'go', createdAt: 0 },
      { kind: 'file_change', id: 'changes', status: 'completed', changes },
    ],
    true,
  )
  expect(html.match(/<button\b/g)).toHaveLength(12)
  expect(html).toContain('aria-label="src-0/ControlCenterScreen.java"')
  expect(html).toContain('aria-label="src-10/ControlCenterScreen.java"')
})

it('removes the button and preview as soon as the turn ends', () => {
  expect(render(history, false)).toBe('')
  expect(render([], true)).toBe('')
})

it('does not share a reconciliation key with the composer when the streaming footer changes', () => {
  const source = readFileSync(new URL('./SessionView.tsx', import.meta.url), 'utf8')
  const footer =
    [...source.matchAll(/<ComposerArea>([\s\S]*?)<\/ComposerArea>/g)].find(([, body]) =>
      body?.includes('<ConversationChangesBar'),
    )?.[1] ?? ''
  const bar = footer.match(/<ConversationChangesBar\b[^>]*>/)?.[0]
  const composer = footer.match(/<Composer\s[^>]*>/)?.[0]
  expect(bar).toContain('key={`conversation-changes:${sessionId}`}')
  expect(composer).toContain('key={sessionId}')
})

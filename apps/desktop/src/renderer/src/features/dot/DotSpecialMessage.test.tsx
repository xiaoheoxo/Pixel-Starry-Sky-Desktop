import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { DotChatMessage } from '@pixelsky/engine'
import { setCurrentLocale } from '@/i18n/core'
import { DotSpecialMessage } from './DotSpecialMessage'
import { dotEventHasNewMessage, dotTranscript, mergeDotCardUpdates } from './conversation'

const pending: DotChatMessage = {
  id: 'm',
  role: 'assistant',
  text: '',
  attachments: [],
  createdAt: 1,
  card: { kind: 'signIn', status: 'pending' },
}
const submitted: DotChatMessage = { ...pending, card: { kind: 'signIn', status: 'submitted' } }

it('renders a read-only sign-in receipt, not a claim that the website accepted the login', () => {
  setCurrentLocale('zh-CN')
  try {
    const html = renderToStaticMarkup(
      <DotSpecialMessage card={submitted.card!} web="https://chatgpt.com/dots/example" />,
    )
    expect(html).toContain('已输入登录信息')
    expect(html).toContain('https://chatgpt.com/dots/example')
    expect(html).not.toMatch(/登录成功|<button|<input|<form/)
  } finally {
    setCurrentLocale('en-US')
  }
})

it('replaces the same pending card without adding a transcript row or restoring an older pending state', () => {
  const initial = [pending]
  const updated = mergeDotCardUpdates(initial, [submitted, { ...submitted, id: 'other' }])
  expect(updated).toEqual([submitted])
  expect(mergeDotCardUpdates(updated, [pending])).toBe(updated)
  expect(mergeDotCardUpdates(initial, [{ ...submitted, card: { kind: 'input', status: 'resolved' } }])).toBe(initial)
})

it('refreshes on a local card notification but hides that fallback when native history has the same card', () => {
  const notice = { id: 'dot-approval-m', kind: 'notice', level: 'info', text: 'safe fallback' } as const
  expect(dotEventHasNewMessage({ type: 'item_completed', item: notice })).toBe(true)
  expect(dotTranscript([], [notice]).map(row => row.id)).toEqual([notice.id])
  expect(dotTranscript([submitted], [notice]).map(row => row.id)).toEqual(['dot-m'])
})

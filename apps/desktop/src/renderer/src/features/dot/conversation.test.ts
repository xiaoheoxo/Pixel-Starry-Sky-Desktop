import { describe, expect, it } from 'vitest'
import { dotTranscript, mergeDotHistory } from './conversation'
describe('Dot native conversation', () => {
  it('deduplicates native request echoes and local Dot responses while preserving history order', () => {
    const history = [
      { id: 'old', role: 'assistant' as const, text: 'Earlier', createdAt: 1, attachments: [] },
      {
        id: 'user-native',
        requestId: 'local-user',
        role: 'user' as const,
        text: 'Hello',
        createdAt: 20,
        attachments: [],
      },
      { id: 'reply', role: 'assistant' as const, text: 'World', createdAt: 30, attachments: [] },
    ]
    const rows = dotTranscript(history, [
      { kind: 'user', id: 'local-user', text: 'Hello', createdAt: 19 },
      { kind: 'assistant', id: 'dot-reply', text: 'World', status: 'completed' },
      { kind: 'notice', id: 'notice', text: 'Status', level: 'info' },
    ])
    expect(rows).toHaveLength(4)
    expect(rows.filter(r => r.role !== 'notice').map(r => r.text)).toEqual(['Earlier', 'Hello', 'World'])
  })
  it('merges older pages and message edits without losing already loaded items', () => {
    const item = { id: 'one', role: 'assistant' as const, text: 'Original', createdAt: 2, attachments: [] }
    expect(
      mergeDotHistory(
        [item],
        [
          { ...item, text: 'Edited' },
          { ...item, id: 'earlier', createdAt: 1 },
        ],
      ).map(m => m.text),
    ).toEqual(['Original', 'Edited'])
  })
})

import { describe, expect, it } from 'vitest'
import { dotSessionIds, listedSessions } from './visibility'

const s = (id: string, engine: string, dot?: boolean) =>
  ({ record: { id, engine, ...(dot ? { dot: { account: 'a', id: 'd', threadId: 't' } } : {}) } }) as never

describe('Dot session visibility', () => {
  const all = [s('c', 'claude'), s('menu', 'dot'), s('group', 'dot', true)]
  it('never lists sessions opened from the Dot group; hides model-menu Dot sessions when signed out', () => {
    expect(listedSessions(all, true).map((x: { record: { id: string } }) => x.record.id)).toEqual(['c', 'menu'])
    expect(listedSessions(all, false).map((x: { record: { id: string } }) => x.record.id)).toEqual(['c'])
  })
  it('collects every Dot session to close', () => {
    expect([...dotSessionIds(all)]).toEqual(['menu', 'group'])
  })
})

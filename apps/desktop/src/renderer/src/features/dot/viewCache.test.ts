import { expect, it } from 'vitest'
import type { DotChatMessage, DotOverview } from '@pixelsky/engine'
import { createDotViewCache, dotRoomKey } from './viewCache'

const entry = { account: 'alice', id: 'same-dot', threadId: 'room-one' }
const room = dotRoomKey(entry)
const otherRoom = dotRoomKey({ ...entry, threadId: 'room-two' })
const otherAccount = dotRoomKey({ ...entry, account: 'bob' })
const item: DotChatMessage = { id: 'm2', role: 'assistant', text: 'reply', createdAt: 1, attachments: [] }
const history = { items: [item], latest: 'm2', before: 'older-page' }

it('restores the exact cached history window and both cursors only in its account and room', () => {
  const cache = createDotViewCache()
  cache.putHistory(room, history)
  expect(cache.read(room).history).toEqual(history)
  expect(cache.read(otherRoom).history).toBeUndefined()
  expect(cache.read(otherAccount).history).toBeUndefined()
  cache.retain(new Set([otherRoom]))
  expect(cache.read(room).history).toBeUndefined()
})

it('does not serve older data after its own expiry or trim away messages behind an existing cursor', () => {
  let now = 0
  const cache = createDotViewCache(() => now)
  const overview = { profile: { id: entry.id } } as DotOverview
  cache.putOverview(room, overview)
  expect(cache.shouldRefreshOverview(otherRoom)).toBe(true)
  expect(cache.shouldRefreshOverview(room)).toBe(false)
  now = 60_000
  expect(cache.shouldRefreshOverview(room)).toBe(true)
  expect(cache.read(room).overview).toEqual(overview)
  now = 9 * 60_000
  cache.putHistory(room, history)
  now = 11 * 60_000
  expect(cache.read(room)).toEqual({ history, overview: undefined })
  cache.putHistory(room, { ...history, items: Array.from({ length: 501 }, () => item) })
  expect(cache.read(room).history).toBeUndefined()
})

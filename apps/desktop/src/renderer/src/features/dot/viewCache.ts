import type { DotChatMessage, DotOverview } from '@pixelsky/engine'
import type { DotEntry } from '../../../../shared/types/dot-chat'

const VIEW_TTL = 10 * 60_000
const OVERVIEW_REFRESH_MS = 60_000
const MAX_ROOMS = 6
const MAX_HISTORY_ROWS = 500
const MAX_HISTORY_CHARS = 2_000_000

export const dotRoomKey = (entry: Pick<DotEntry, 'account' | 'id' | 'threadId'>): string =>
  JSON.stringify([entry.account, entry.id, entry.threadId])

interface CachedHistory {
  items: DotChatMessage[]
  before: string | null
  latest: string | undefined
}
type Updated<T> = { value: T; expiresAt: number }
interface RoomCache {
  history?: Updated<CachedHistory>
  overview?: Updated<DotOverview>
}

// Never write private transcript or attachment data to disk.
export function createDotViewCache(now = Date.now) {
  const rooms = new Map<string, RoomCache>()
  const fresh = <T>(cached?: Updated<T>): T | undefined =>
    cached && cached.expiresAt > now() ? cached.value : undefined
  const put = (key: string, update: Partial<RoomCache>) => {
    const existing = rooms.get(key)
    rooms.delete(key)
    rooms.set(key, { ...existing, ...update })
    if (rooms.size > MAX_ROOMS) rooms.delete(rooms.keys().next().value!)
  }
  return {
    read(key: string) {
      const room = rooms.get(key)
      return { history: fresh(room?.history), overview: fresh(room?.overview) }
    },
    shouldRefreshOverview(key: string) {
      const cached = rooms.get(key)?.overview
      return !cached || now() >= cached.expiresAt - VIEW_TTL + OVERVIEW_REFRESH_MS
    },
    putHistory(key: string, history: CachedHistory) {
      // Keep cursor and its exact message window together. Oversized histories re-open from a fresh page.
      const fits =
        history.items.length <= MAX_HISTORY_ROWS &&
        history.items.reduce((chars, item) => chars + item.text.length, 0) <= MAX_HISTORY_CHARS
      put(key, { history: fits ? { value: history, expiresAt: now() + VIEW_TTL } : undefined })
    },
    putOverview(key: string, overview: DotOverview) {
      put(key, { overview: { value: overview, expiresAt: now() + VIEW_TTL } })
    },
    retain(keys: ReadonlySet<string>) {
      for (const key of rooms.keys()) if (!keys.has(key)) rooms.delete(key)
    },
  }
}
export const dotViewCache = createDotViewCache()

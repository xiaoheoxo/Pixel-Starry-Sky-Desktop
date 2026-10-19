import { beforeEach, describe, expect, it, vi } from 'vitest'

// 缓存的列表走 desktopLists：先显示本机缓存（cached），连上取到新的替换；忘掉电脑时缓存删掉
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  get length() {
    return store.size
  },
  key: (i: number) => [...store.keys()][i] ?? null,
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})

const mock = vi.hoisted(() => {
  const m = {
    pairings: [] as { deviceId: string }[],
    listeners: new Set<() => void>(),
    states: new Map<string, string>(),
    calls: [] as string[],
    reply: {} as Record<string, unknown>,
    eventListeners: new Set<(id: string, data: unknown) => void>(),
  }
  return m
})
vi.mock('@/connection', () => ({
  connections: {
    list: () => mock.pairings,
    state: (id: string) => mock.states.get(id),
    link: () => ({
      call: async (name: string) => {
        mock.calls.push(name)
        return mock.reply[name]
      },
    }),
    subscribe: (l: () => void) => {
      mock.listeners.add(l)
      return () => mock.listeners.delete(l)
    },
    eventListeners: mock.eventListeners,
  },
}))

const session = (id: string) => ({
  record: { id, projectId: 'p1', title: id, updatedAt: 1, engine: 'claude' },
  state: 'idle',
})
const KEY = 'pixelsky.mobile.lists.d1'
const flush = () => new Promise(r => setTimeout(r, 0))

describe('desktopLists with the local cache', () => {
  beforeEach(() => {
    vi.resetModules()
    store.clear()
    mock.pairings = [{ deviceId: 'd1' }]
    mock.listeners.clear()
    mock.states.clear()
    mock.calls = []
    mock.eventListeners.clear()
    mock.reply = {
      'engine:sessions': [session('new')],
      'engine:projects': [{ id: 'p1', name: 'P', path: 'C:/p', addedAt: 1 }],
    }
  })

  it('shows the cached lists first, then replaces them once the computer answers', async () => {
    store.set(KEY, JSON.stringify({ v: 1, sessions: [session('old')], projects: [] }))
    const { desktopLists } = await import('./desktop')
    const first = desktopLists.get('d1')
    expect(first).toMatchObject({ loaded: true, cached: true })
    expect(first.sessions.map(s => s.record.id)).toEqual(['old'])
    expect(desktopLists.get('d1')).toBe(first) // 引用稳定

    desktopLists.subscribe(() => {})
    mock.states.set('d1', 'ready')
    mock.listeners.forEach(l => l())
    await flush()
    const now = desktopLists.get('d1')
    expect(now).toMatchObject({ loaded: true, cached: false })
    expect(now.sessions.map(s => s.record.id)).toEqual(['new'])
  })

  it('has nothing for a computer without a cache, and for one that is not paired', async () => {
    const { desktopLists, NO_LISTS } = await import('./desktop')
    expect(desktopLists.get('d1')).toBe(NO_LISTS)
    store.set('pixelsky.mobile.lists.zz', JSON.stringify({ v: 1, sessions: [session('x')], projects: [] }))
    expect(desktopLists.get('zz')).toBe(NO_LISTS)
  })

  it('saves what it fetched, and deletes the cache when the computer is forgotten', async () => {
    const { desktopLists } = await import('./desktop')
    desktopLists.subscribe(() => {})
    mock.states.set('d1', 'ready')
    mock.listeners.forEach(l => l())
    await flush()
    expect(JSON.parse(store.get(KEY)!).sessions[0].record.id).toBe('new')

    mock.pairings = []
    mock.listeners.forEach(l => l())
    expect(store.has(KEY)).toBe(false)
    expect(desktopLists.get('d1').loaded).toBe(false)
  })
})

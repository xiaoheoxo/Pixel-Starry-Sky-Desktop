import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import {
  ListCache,
  MAX_CACHED,
  WRITE_INTERVAL,
  slimSession,
  trimProjects,
  trimSessions,
  type CacheStorage,
} from './listCache'

function memory(): CacheStorage & { map: Map<string, string>; writes: number } {
  const map = new Map<string, string>()
  const s = {
    map,
    writes: 0,
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem(k: string, v: string) {
      s.writes++
      map.set(k, v)
    },
    removeItem: (k: string) => void map.delete(k),
  }
  return s
}

const session = (id: string, updatedAt = 1, extra: Record<string, unknown> = {}): SessionSummary =>
  ({
    record: {
      id,
      projectId: 'p1',
      cwd: 'C:/x',
      engine: 'claude',
      engineSessionId: null,
      title: id,
      createdAt: 0,
      updatedAt,
      lastOutcome: null,
      model: null,
      effort: null,
      permissionMode: 'default',
      ultracode: false,
      fast: false,
      thinkingSummaries: false,
      ...extra,
    },
    state: 'idle',
  }) as unknown as SessionSummary
const project = (id: string, addedAt = 1): ProjectRecord => ({ id, name: id, path: `C:/${id}`, addedAt })

describe('trimming', () => {
  it('keeps the list fields and drops the heavy ones', () => {
    const slim = slimSession(
      session('a', 5, { engineSessions: { claude: { id: 'x', seen: 'y' } }, imported: { turns: 3 }, extraDirs: ['d'] }),
    )
    expect(slim.record.id).toBe('a')
    expect(slim.record.updatedAt).toBe(5)
    expect(slim.state).toBe('idle')
    expect('engineSessions' in slim.record).toBe(false)
    expect('imported' in slim.record).toBe(false)
    expect('extraDirs' in slim.record).toBe(false)
  })
  it('keeps the newest 200 of each', () => {
    const many = Array.from({ length: 250 }, (_, i) => session(`s${i}`, i))
    const kept = trimSessions(many)
    expect(kept).toHaveLength(MAX_CACHED)
    expect(kept[0]!.record.id).toBe('s249')
    expect(kept.at(-1)!.record.id).toBe('s50')
    expect(trimProjects(Array.from({ length: 250 }, (_, i) => project(`p${i}`, i)))).toHaveLength(MAX_CACHED)
  })
})

describe('ListCache', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const make = (storage = memory()) => ({ storage, cache: new ListCache(storage, () => Date.now()) })
  const lists = (n: number) => ({ sessions: [session(`s${n}`, n)], projects: [project('p1')] })

  it('round-trips and ignores junk', () => {
    const { storage, cache } = make()
    expect(cache.load('d1')).toBeNull()
    cache.save('d1', lists(1))
    const got = cache.load('d1')!
    expect(got.sessions.map(s => s.record.id)).toEqual(['s1'])
    expect(got.projects.map(p => p.id)).toEqual(['p1'])
    storage.setItem('pixelsky.mobile.lists.d1', '{oops')
    expect(cache.load('d1')).toBeNull()
    storage.setItem('pixelsky.mobile.lists.d1', JSON.stringify({ v: 99, sessions: [], projects: [] }))
    expect(cache.load('d1')).toBeNull()
    storage.setItem(
      'pixelsky.mobile.lists.d1',
      JSON.stringify({ v: 1, sessions: [null, { record: {} }], projects: [1] }),
    )
    expect(cache.load('d1')).toEqual({ sessions: [], projects: [] })
  })

  it('writes at most once a second per computer and keeps the latest', () => {
    const { storage, cache } = make()
    cache.save('d1', lists(1))
    expect(storage.writes).toBe(1)
    cache.save('d1', lists(2))
    cache.save('d1', lists(3))
    expect(storage.writes).toBe(1) // 节流中
    vi.advanceTimersByTime(WRITE_INTERVAL - 1)
    expect(storage.writes).toBe(1)
    vi.advanceTimersByTime(1)
    expect(storage.writes).toBe(2)
    expect(cache.load('d1')!.sessions[0]!.record.id).toBe('s3')
    vi.advanceTimersByTime(WRITE_INTERVAL * 5)
    expect(storage.writes).toBe(2)
    cache.save('d2', lists(4)) // 别的电脑不受影响
    expect(storage.writes).toBe(3)
  })

  it('flush writes what is waiting right away', () => {
    const { storage, cache } = make()
    cache.save('d1', lists(1))
    cache.save('d1', lists(2))
    cache.flush()
    expect(cache.load('d1')!.sessions[0]!.record.id).toBe('s2')
    vi.advanceTimersByTime(WRITE_INTERVAL * 2)
    expect(storage.writes).toBe(2)
  })

  it('drop removes the cache and cancels a waiting write', () => {
    const { storage, cache } = make()
    cache.save('d1', lists(1))
    cache.save('d1', lists(2))
    cache.drop('d1')
    vi.advanceTimersByTime(WRITE_INTERVAL * 2)
    expect(storage.map.size).toBe(0)
  })

  it('pruneExcept removes computers that are gone and leaves other keys alone', () => {
    const { storage, cache } = make()
    cache.save('keep', lists(1))
    cache.save('gone', lists(2))
    storage.setItem('pixelsky.mobile.pairings', '[]')
    cache.pruneExcept(new Set(['keep']))
    expect([...storage.map.keys()].sort()).toEqual(['pixelsky.mobile.lists.keep', 'pixelsky.mobile.pairings'])
  })

  it('survives a storage that throws, and a missing storage', () => {
    const bad = memory()
    bad.setItem = () => {
      throw new Error('quota')
    }
    expect(() => make(bad).cache.save('d1', lists(1))).not.toThrow()
    const none = new ListCache(null)
    none.save('d1', lists(1))
    expect(none.load('d1')).toBeNull()
    expect(() => none.pruneExcept(new Set())).not.toThrow()
  })
})

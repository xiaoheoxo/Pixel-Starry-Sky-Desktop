import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@pixelsky/protocol'
import { PushScheduler, emptyPush, pushChanges, pushPayload, waitingCount, type PushSessions } from './push'

const s = (id: string, state: string, lastOutcome: string | null = null, archivedAt: number | null = null) =>
  ({ record: { id, title: id, updatedAt: 1, archivedAt, lastOutcome }, state }) as unknown as SessionSummary

/** 方便写断言：把集合换成数组 */
const ids = (p: PushSessions) => ({
  waiting: [...p.waiting],
  failed: [...p.failed],
  completed: [...p.completed],
})
const of = (parts: Partial<Record<'waiting' | 'failed' | 'completed', string[]>>): PushSessions => ({
  ...emptyPush(),
  ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, new Set(v)])),
})
const none = { waiting: [], failed: [], completed: [] }

describe('pushChanges', () => {
  it('collects sessions that start waiting, and running ones that finish or fail', () => {
    const prev = [
      s('a', 'running'),
      s('b', 'running'),
      s('c', 'idle'),
      s('d', 'starting'),
      s('e', 'waiting'),
      s('f', 'running'),
    ]
    const next = [
      s('a', 'idle', 'completed'),
      s('b', 'idle', 'failed'),
      s('c', 'waiting'),
      s('d', 'idle', 'completed'),
      s('e', 'waiting'),
      s('f', 'waiting'),
    ]
    expect(ids(pushChanges(prev, next))).toEqual({ waiting: ['c', 'f'], failed: ['b'], completed: ['a', 'd'] })
  })

  it('does not count sessions that show up already waiting (a remote machine reconnecting)', () => {
    expect(ids(pushChanges([s('a', 'running')], [s('a', 'running'), s('r', 'waiting')]))).toEqual(none)
  })

  it('ignores the first list, archived sessions and sessions that were already idle', () => {
    expect(ids(pushChanges(null, [s('a', 'waiting')]))).toEqual(none)
    expect(ids(pushChanges([s('a', 'running')], [s('a', 'waiting', null, 5)]))).toEqual(none)
    expect(ids(pushChanges([s('a', 'idle')], [s('a', 'idle', 'completed')]))).toEqual(none)
  })
})

describe('waitingCount', () => {
  it('counts the sessions waiting for the user, not archived ones', () => {
    expect(waitingCount(null)).toBe(0)
    expect(waitingCount([s('a', 'waiting'), s('b', 'waiting', null, 5), s('c', 'running'), s('d', 'waiting')])).toBe(2)
  })
})

describe('pushPayload', () => {
  it('picks the most urgent kind, caps the count and the badge, and names the session only when there is one', () => {
    expect(pushPayload(emptyPush())).toBeNull()
    expect(pushPayload(of({ failed: ['f'], completed: ['a', 'b', 'c'] }), 4)).toEqual({
      kind: 'failed',
      count: 1,
      session: 'f',
      badge: 4,
    })
    expect(pushPayload(of({ completed: ['a', 'b'] }))).toEqual({ kind: 'completed', count: 2, badge: 0 })
    // 远程机器的会话 id 带机器前缀和 ~；不合规的只是不带 session，推送照发
    const ssh = 'ssh-0b7e2f4c-1d2a-4c3b-9e8f-123456789abc~5d1c0a2b-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
    expect(pushPayload(of({ waiting: [ssh] }))?.session).toBe(ssh)
    expect(pushPayload(of({ waiting: ['a/b'] }))).toEqual({ kind: 'waiting', count: 1, badge: 0 })
    const many = Array.from({ length: 200 }, (_, i) => 's' + i)
    expect(pushPayload(of({ waiting: many, failed: ['f'] }), 150)).toEqual({ kind: 'waiting', count: 99, badge: 99 })
  })
})

describe('PushScheduler', () => {
  afterEach(() => vi.useRealTimers())

  it('adds up what arrives within the delay into one push per phone, and can be cancelled', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const scheduler = new PushScheduler(
      async (phone, p) => void sent.push(`${phone} ${p.kind} ${p.count} ${p.session ?? '-'} ${p.badge}`),
      2000,
      5500,
      Date.now,
      () => 7,
    )
    scheduler.add('p1', of({ completed: ['a'] }))
    scheduler.add('p1', of({ completed: ['b', 'c'] }))
    scheduler.add('p2', of({ waiting: ['w'] }))
    scheduler.add('p3', emptyPush())
    scheduler.add('p4', of({ waiting: ['x'] }))
    scheduler.cancel('p4')
    await vi.advanceTimersByTimeAsync(1999)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent.sort()).toEqual(['p1 completed 3 - 7', 'p2 waiting 1 w 7'])
  })

  it('counts a session once however many times it comes in, and drops the session id once there are several', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const scheduler = new PushScheduler(
      async (_phone, p) => void sent.push(`${p.kind} ${p.count} ${p.session ?? '-'}`),
      2000,
    )
    scheduler.add('p1', of({ waiting: ['a'] }))
    scheduler.add('p1', of({ waiting: ['a'] }))
    scheduler.add('p2', of({ waiting: ['a'] }))
    scheduler.add('p2', of({ waiting: ['b'] }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent).toEqual(['waiting 1 a', 'waiting 2 -'])
  })

  it('reads the badge when the push goes out, not when it was queued', async () => {
    vi.useFakeTimers()
    let badge = 1
    const sent: number[] = []
    const scheduler = new PushScheduler(
      async (_phone, p) => void sent.push(p.badge),
      2000,
      5500,
      Date.now,
      () => badge,
    )
    scheduler.add('p1', of({ waiting: ['a'] }))
    badge = 3
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent).toEqual([3])
  })

  it('keeps pushes to one phone at least the gap apart, folding what arrives meanwhile into the next one', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const scheduler = new PushScheduler(async (_phone, p) => void sent.push(p.kind + ' ' + p.count), 2000, 5500)
    scheduler.add('p1', of({ completed: ['a'] }))
    await vi.advanceTimersByTimeAsync(2000)
    scheduler.add('p1', of({ waiting: ['b'] }))
    await vi.advanceTimersByTimeAsync(2000)
    scheduler.add('p1', of({ waiting: ['c'] }))
    // 上一条在 2000 发出，下一条最早 7500
    await vi.advanceTimersByTimeAsync(3499)
    expect(sent).toEqual(['completed 1'])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual(['completed 1', 'waiting 2'])
  })
})

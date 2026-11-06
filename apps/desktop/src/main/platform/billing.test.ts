import { afterEach, describe, expect, it, vi } from 'vitest'

const fetched: string[] = []
let reply: (path: string) => unknown = () => ({})
vi.mock('../account/account', () => ({
  signedInEmail: () => 'a@b.c',
  platformFetch: async (path: string) => {
    fetched.push(path)
    return new Response(JSON.stringify(reply(path)), { status: 200 })
  },
}))

const { accountSummary } = await import('./billing')

const stat = (requests: number) => ({ requests, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 })
const now = new Date(2026, 9, 12, 15, 30).getTime()

afterEach(() => {
  fetched.length = 0
  reply = () => ({})
})

describe('accountSummary', () => {
  it('reads this period by bucket and the previous period for the comparison', async () => {
    reply = path =>
      path.includes('granularity=hour')
        ? { buckets: [{ ...stat(2), start: now - 3600000 }], models: [{ ...stat(2), model: 'm' }], total: stat(2) }
        : { buckets: [], models: [], total: stat(5) }
    const s = await accountSummary({ range: 'today', model: 'm', now })
    expect(s.total.requests).toBe(2)
    expect(s.prevTotal.requests).toBe(5)
    expect(s.buckets).toHaveLength(1)
    const [cur, prev] = fetched.map(p => new URLSearchParams(p.split('?')[1]))
    expect(fetched.every(p => p.startsWith('/v1/oauth/usage/summary?'))).toBe(true)
    expect(cur.get('start_date')).toBe('2026-10-12')
    expect(cur.get('end_date')).toBe('2026-10-12')
    expect(cur.get('model')).toBe('m')
    expect(prev.get('start_date')).toBe('2026-10-11')
    expect(prev.get('end_date')).toBe('2026-10-11')
    expect(prev.get('granularity')).toBe('day')
  })

  it('year（热力图）只读一次，按天，从 52 周前的周一开始', async () => {
    reply = () => ({ buckets: [], models: [], total: stat(1) })
    await accountSummary({ range: 'year', model: null, now })
    expect(fetched).toHaveLength(1)
    const params = new URLSearchParams(String(fetched[0]).split('?')[1])
    expect(params.get('granularity')).toBe('day')
    const days = (now - new Date(`${params.get('start_date')}T00:00:00`).getTime()) / 86400000
    expect(days).toBeGreaterThan(52 * 7 - 1)
    expect(days).toBeLessThan(53 * 7 + 1)
    fetched.length = 0
  })

  it('rejects bad queries and malformed replies', async () => {
    await expect(accountSummary({ range: 'forever', model: null, now })).rejects.toThrow('无效')
    expect(fetched).toEqual([])
    reply = () => ({ buckets: [{ requests: 'x' }], models: [], total: stat(1) })
    await expect(accountSummary({ range: '7d', model: null, now })).rejects.toThrow('不可用')
  })
})

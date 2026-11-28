import { describe, expect, it } from 'vitest'
import type { UsageRecord, WeeklyApiQuery } from '@pixelsky/protocol'
import { subscriptionUsageKey, weeklyApiSample } from './weekly-api'

const q: WeeklyApiQuery = { account: 'TEST@example.org', plan: 'plus', resetsAt: 100, from: 10, to: 50 }
const key = subscriptionUsageKey(' test@example.org ')
const row = (patch: Partial<UsageRecord> = {}): UsageRecord => ({
  v: 1,
  id: 'a',
  turnId: 't',
  sessionId: 's',
  startedAt: 10,
  endedAt: 49,
  durationMs: 39,
  sessionTitle: '',
  project: null,
  engine: 'codex',
  route: 'cli',
  model: 'gpt-5.3-codex',
  input: 1_000_000,
  output: 1_000_000,
  cacheRead: 1_000_000,
  cacheWrite: 1_000_000,
  costUsd: 999,
  outcome: 'completed',
  subscriptionUsageKey: key,
  ...patch,
})

describe('weekly API usage sample', () => {
  it('prices each token type at its own API price, not the recorded settlement', () => {
    const sample = weeklyApiSample([row()], q)
    expect(sample).toMatchObject({ records: 1, incomplete: false })
    expect(sample.usd).toBeCloseTo(17.675)
  })
  it('does not mix accounts, engines, custom API or out-of-range usage', () => {
    const rows = [
      row({ subscriptionUsageKey: subscriptionUsageKey('other@example.org') }),
      row({ engine: 'claude' }),
      row({ route: 'api-key' }),
      row({ route: 'pixelsky' }),
      row({ startedAt: 0, endedAt: 9 }),
      row({ startedAt: 50, endedAt: 51 }),
    ]
    expect(weeklyApiSample(rows, q)).toEqual({ usd: 0, records: 0, incomplete: false })
  })
  it.each([{ startedAt: 9 }, { endedAt: 50 }, { subscriptionUsageKey: undefined }, { model: 'unknown-astra-7' }])(
    'flags a comparison as incomplete instead of scaling a partial subtotal: %j',
    patch => {
      expect(weeklyApiSample([row(patch)], q)).toEqual({ usd: 0, records: 0, incomplete: true })
    },
  )
})

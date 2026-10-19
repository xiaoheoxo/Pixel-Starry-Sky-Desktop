import { describe, expect, it } from 'vitest'
import { computeLive } from './live'

const base = { enabled: true, status: 'ok' as const }

describe('computeLive', () => {
  it('is true when enabled, no error, not blocked and not shadowed', () => {
    expect(computeLive(base)).toBe(true)
    expect(computeLive({ ...base, status: 'warning' })).toBe(true)
  })
  it('is false when any one condition is off', () => {
    expect(computeLive({ ...base, enabled: false })).toBe(false)
    expect(computeLive({ ...base, status: 'error' })).toBe(false)
    expect(computeLive({ ...base, blocked: { reason: 'bad', at: '2026-10-16T00:00:00Z' } })).toBe(false)
    expect(computeLive({ ...base, shadowedBy: 'folder' })).toBe(false)
  })
})

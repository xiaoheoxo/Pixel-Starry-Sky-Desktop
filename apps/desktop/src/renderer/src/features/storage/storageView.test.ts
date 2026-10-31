import { describe, expect, it } from 'vitest'
import type { StorageSession, StorageUsage } from '../../../../shared/types/storage'
import {
  archivedSessions,
  formatBytes,
  oldSessions,
  percentLabel,
  segments,
  totalBytes,
  withRestored,
  withoutSessions,
} from './storageView'

const DAY = 86_400_000
const NOW = 100 * DAY

const session = (id: string, patch: Partial<StorageSession> = {}): StorageSession => ({
  id,
  title: id,
  projectName: 'p',
  updatedAt: NOW - 40 * DAY,
  archivedAt: null,
  pinned: false,
  busy: false,
  bytes: 100,
  ...patch,
})

const usage = (sessions: StorageSession[]): StorageUsage => ({
  root: 'C:\\data',
  scannedAt: NOW,
  parts: { sessions: 300, archived: 200, copies: 0, cache: 400, logs: 100, other: 0 },
  sessions,
  copies: [],
})

describe('formatBytes', () => {
  it('picks a unit and fewer decimals for bigger numbers', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.50 KB')
    expect(formatBytes(12.34 * 1024 * 1024)).toBe('12.3 MB')
    expect(formatBytes(345 * 1024 * 1024)).toBe('345 MB')
    expect(formatBytes(3.4 * 1024 ** 3)).toBe('3.40 GB')
  })
})

describe('segments', () => {
  it('drops empty parts and computes percentages', () => {
    const u = usage([])
    expect(totalBytes(u)).toBe(1000)
    expect(segments(u).map(s => [s.key, s.percent])).toEqual([
      ['sessions', 30],
      ['archived', 20],
      ['cache', 40],
      ['logs', 10],
    ])
  })
  it('has no segments when nothing is used', () => {
    expect(
      segments({ ...usage([]), parts: { sessions: 0, archived: 0, copies: 0, cache: 0, logs: 0, other: 0 } }),
    ).toEqual([])
  })
  it('labels tiny percentages', () => {
    expect(percentLabel(0.2)).toBe('<1')
    expect(percentLabel(0)).toBe('0')
    expect(percentLabel(12.6)).toBe('13')
  })
})

describe('oldSessions', () => {
  const list = [
    session('old-big', { bytes: 900 }),
    session('old-small', { bytes: 10, updatedAt: NOW - 80 * DAY }),
    session('recent', { updatedAt: NOW - 3 * DAY }),
    session('pinned', { pinned: true }),
    session('busy', { busy: true }),
    session('archived', { archivedAt: NOW - DAY }),
  ]
  it('skips recent, pinned, running and (by default) archived sessions', () => {
    const ids = oldSessions(list, { days: 30, includeArchived: false, sort: 'size', now: NOW }).map(s => s.id)
    expect(ids).toEqual(['old-big', 'old-small'])
  })
  it('can include archived ones and sort oldest first', () => {
    const ids = oldSessions(list, { days: 30, includeArchived: true, sort: 'time', now: NOW }).map(s => s.id)
    expect(ids).toEqual(['old-small', 'archived', 'old-big'])
  })
  it('respects the idle threshold', () => {
    expect(oldSessions(list, { days: 60, includeArchived: false, sort: 'size', now: NOW }).map(s => s.id)).toEqual([
      'old-small',
    ])
  })
})

describe('local updates after cleaning', () => {
  const list = [
    session('a', { bytes: 120 }),
    session('b', { archivedAt: NOW - 2 * DAY, bytes: 50 }),
    session('c', { archivedAt: NOW - DAY, bytes: 70 }),
  ]
  it('lists archived sessions newest first', () => {
    expect(archivedSessions(list).map(s => s.id)).toEqual(['c', 'b'])
  })
  it('subtracts deleted sessions from their part', () => {
    const next = withoutSessions(usage(list), ['a', 'b', 'missing'])
    expect(next.parts.sessions).toBe(180)
    expect(next.parts.archived).toBe(150)
    expect(next.sessions.map(s => s.id)).toEqual(['c'])
  })
  it('moves a restored session from archived to sessions', () => {
    const next = withRestored(usage(list), 'c')
    expect(next.parts.archived).toBe(130)
    expect(next.parts.sessions).toBe(370)
    expect(next.sessions.find(s => s.id === 'c')?.archivedAt).toBeNull()
    expect(withRestored(usage(list), 'a')).toEqual(usage(list))
  })
})

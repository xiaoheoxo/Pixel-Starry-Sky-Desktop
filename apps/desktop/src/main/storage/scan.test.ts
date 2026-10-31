import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheSize, dirSize, scanUsage } from './scan'

let base: string
const write = (path: string, bytes: number): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(bytes))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pixelsky-storage-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('dirSize', () => {
  it('adds up nested files and honours skip', async () => {
    write(join(base, 'a.bin'), 10)
    write(join(base, 'x', 'b.bin'), 20)
    write(join(base, 'x', 'y', 'c.bin'), 30)
    expect(await dirSize(base)).toBe(60)
    expect(await dirSize(base, p => p.endsWith('y'))).toBe(30)
    expect(await dirSize(join(base, 'missing'))).toBe(0)
    expect(await dirSize(join(base, 'a.bin'))).toBe(10)
  })

  it('does not follow directory links', async () => {
    write(join(base, 'real', 'big.bin'), 500)
    try {
      symlinkSync(join(base, 'real'), join(base, 'link'), 'junction')
    } catch {
      return // 没有建链接的权限：跳过
    }
    expect(await dirSize(base)).toBe(500)
  })
})

describe('scanUsage', () => {
  it('splits the data folder into sessions, archived, cache, logs, copies and other', async () => {
    const root = join(base, 'data')
    const sessionsDir = join(root, 'engine', 'sessions')
    write(join(sessionsDir, 's1', 'items.jsonl'), 100)
    write(join(sessionsDir, 's2', 'items.jsonl'), 40)
    write(join(sessionsDir, 'orphan', 'items.jsonl'), 7)
    write(join(root, 'engine', 'projects.json'), 3)
    write(join(root, 'Cache', 'data_0'), 200)
    write(join(root, 'GPUCache', 'index'), 50)
    write(join(root, 'logs', 'main.log'), 25)
    write(join(root, 'account.json'), 5)
    const copy = join(base, 'repo-copy')
    write(join(copy, 'src', 'x.ts'), 1000)

    const usage = await scanUsage({
      root,
      sessionsDir,
      logsDir: join(root, 'logs'),
      sessions: [
        { id: 's1', title: 'one', projectName: 'p', updatedAt: 1, archivedAt: null, pinned: false, busy: false },
        { id: 's2', title: 'two', projectName: null, updatedAt: 2, archivedAt: 5, pinned: false, busy: false },
        { id: 's3', title: 'no dir', projectName: null, updatedAt: 3, archivedAt: null, pinned: false, busy: false },
      ],
      copies: [
        { id: 'c1', name: 'copy', path: copy, projectName: 'p', branch: 'b', dirty: false },
        { id: 'c2', name: 'gone', path: join(base, 'nope'), projectName: 'p', branch: 'b', dirty: true },
      ],
      now: () => 42,
    })

    expect(usage.scannedAt).toBe(42)
    expect(usage.parts).toEqual({ sessions: 100, archived: 40, copies: 1000, cache: 250, logs: 25, other: 7 + 3 + 5 })
    expect(usage.sessions.map(s => [s.id, s.bytes])).toEqual([
      ['s1', 100],
      ['s2', 40],
      ['s3', 0],
    ])
    expect(usage.copies.map(c => [c.id, c.bytes, c.missing])).toEqual([
      ['c1', 1000, false],
      ['c2', 0, true],
    ])
    expect(await cacheSize(root)).toBe(250)
  })

  it('adds the chat folder of a chat without a project to its session', async () => {
    const root = join(base, 'data')
    const sessionsDir = join(root, 'engine', 'sessions')
    const chatsDir = join(root, 'engine', 'chats')
    write(join(sessionsDir, 'c1', 'items.jsonl'), 10)
    write(join(chatsDir, 'c1', 'notes.md'), 300)
    write(join(chatsDir, 'c2', 'out.txt'), 20)
    write(join(chatsDir, 'orphan', 'x.txt'), 4)

    const usage = await scanUsage({
      root,
      sessionsDir,
      chatsDir,
      logsDir: null,
      sessions: [
        { id: 'c1', title: 'chat', projectName: null, updatedAt: 1, archivedAt: null, pinned: false, busy: false },
        { id: 'c2', title: 'old', projectName: null, updatedAt: 2, archivedAt: 3, pinned: false, busy: false },
      ],
      copies: [],
    })

    expect(usage.sessions.map(s => [s.id, s.bytes])).toEqual([
      ['c1', 310],
      ['c2', 20],
    ])
    expect(usage.parts).toEqual({ sessions: 310, archived: 20, copies: 0, cache: 0, logs: 0, other: 4 })
  })

  it('works before anything exists', async () => {
    const root = join(base, 'empty')
    const usage = await scanUsage({
      root,
      sessionsDir: join(root, 'engine', 'sessions'),
      logsDir: null,
      sessions: [],
      copies: [],
    })
    expect(usage.parts).toEqual({ sessions: 0, archived: 0, copies: 0, cache: 0, logs: 0, other: 0 })
  })
})

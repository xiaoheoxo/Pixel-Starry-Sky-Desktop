import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EngineHost } from '@pixelsky/engine'
import type { SessionRecord } from '@pixelsky/protocol'
import { DotChatSessions } from './dot-chat-sessions'

describe('multi-account Dot chats', () => {
  it('filters Plus before network access, keeps same-name Dots separate, and reopens the saved session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dot-chats-'))
    const records: SessionRecord[] = []
    const host = {
      accounts: async () => ({
        accounts: [
          { id: 'plus', plan: 'plus', email: 'plus@example.com' },
          { id: 'pro1', plan: 'prolite', email: 'one@example.com' },
          { id: 'pro2', plan: 'promax', email: 'two@example.com' },
        ],
      }),
      dotCatalog: vi.fn(async (id: string) => [
        { id: 'same-id', name: 'Dot', threadId: `${id}-thread`, status: 'active' },
        { id: 'second-id', name: 'Dot', threadId: `${id}-second`, status: 'active' },
      ]),
      sessions: () => records.map(record => ({ record })),
      addProject: () => ({ id: 'project' }),
      createSession: vi.fn((opts: Partial<SessionRecord>) => {
        const record = { ...opts, id: `local-${records.length}` } as SessionRecord
        records.push(record)
        return record
      }),
      renameSession: vi.fn(),
      open: (id: string) => ({ record: records.find(r => r.id === id), items: [] }),
      send: vi.fn(),
      readDot: vi.fn(async () => ({
        history: { items: [{ attachments: [{ type: 'file', fileId: 'remote-file' }] }], before: null },
      })),
      downloadDotFile: vi.fn(async () => ({ name: 'file.txt', mime: 'text/plain', data: new Uint8Array([65]) })),
      dotComputerOffer: vi.fn(async () => 'v=0\r\nanswer'),
    }
    try {
      const service = new DotChatSessions(host as unknown as EngineHost, root)
      const catalog = await service.catalog(true)
      expect(catalog.eligible).toBe(true)
      expect(catalog.entries).toHaveLength(4)
      expect(new Set(catalog.entries.map(e => e.key)).size).toBe(4)
      expect(host.dotCatalog).not.toHaveBeenCalledWith('plus')
      const entry = catalog.entries[2]
      const snapshot = service.snapshot(entry.key)
      expect(snapshot.record.dot).toEqual({ account: 'pro2', id: 'same-id', threadId: 'pro2-thread' })
      const reopened = new DotChatSessions(host as unknown as EngineHost, root)
      expect(reopened.snapshot(entry.key).record.id).toBe(snapshot.record.id)
      expect(host.createSession).toHaveBeenCalledTimes(1)
      await expect(reopened.send(entry.key, 'other-session', 'hello')).rejects.toThrow(/changed/)
      expect(host.send).not.toHaveBeenCalled()
      await reopened.send(entry.key, snapshot.record.id, 'hello')
      expect(host.send).toHaveBeenCalledWith(snapshot.record.id, 'hello')
      await expect(reopened.download(entry.key, 'remote-file')).rejects.toThrow(/not in this conversation/)
      await reopened.read(entry.key, {})
      await reopened.download(entry.key, 'remote-file')
      expect(host.downloadDotFile).toHaveBeenCalledWith('pro2', entry, 'remote-file', undefined)
      await expect(reopened.download(catalog.entries[0].key, 'remote-file')).rejects.toThrow(/not in this conversation/)
      await reopened.computerOffer(entry.key, 'v=0\r\noffer')
      expect(host.dotComputerOffer).toHaveBeenCalledWith('pro2', entry, 'v=0\r\noffer', undefined)
      reopened.release(entry.key)
      await expect(reopened.download(entry.key, 'remote-file')).rejects.toThrow(/not in this conversation/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('hides entries when only Plus accounts remain, including previously cached Dots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dot-plus-'))
    const host = { accounts: async () => ({ accounts: [{ id: 'a', plan: 'plus' }] }), dotCatalog: vi.fn() }
    try {
      const catalog = await new DotChatSessions(host as unknown as EngineHost, root).catalog(true)
      expect(catalog).toEqual({ eligible: false, entries: [], errors: [] })
      expect(host.dotCatalog).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

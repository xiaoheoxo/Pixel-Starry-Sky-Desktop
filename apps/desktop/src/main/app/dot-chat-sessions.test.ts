import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
      dotSignedIn: vi.fn(async () => true),
      sessions: () => records.map(record => ({ record })),
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
      // 不建假项目：挂在「对话」下面
      expect(snapshot.record.projectId).toBe('chat')
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
    const host = {
      accounts: async () => ({ accounts: [{ id: 'a', plan: 'plus' }] }),
      dotCatalog: vi.fn(),
      dotSignedIn: vi.fn(async () => true),
    }
    try {
      const catalog = await new DotChatSessions(host as unknown as EngineHost, root).catalog(true)
      expect(catalog).toEqual({ eligible: false, entries: [], errors: [], unread: [] })
      expect(host.dotCatalog).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('lists only Pro accounts that are still signed in, and keys do not depend on the email', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dot-signed-'))
    let email = 'old@example.com'
    const host = {
      accounts: async () => ({
        accounts: [
          { id: 'expired', plan: 'pro', email: 'x@example.com', status: 'expired' },
          { id: 'gone', plan: 'pro', email: 'y@example.com', status: 'ok' },
          { id: 'pro', plan: 'pro', email, status: 'ok' },
        ],
      }),
      dotSignedIn: vi.fn(async (id: string) => id !== 'gone'),
      dotCatalog: vi.fn(async () => [{ id: 'dot', name: 'Nova', threadId: 't', status: 'active' }]),
    }
    try {
      const service = new DotChatSessions(host as unknown as EngineHost, root)
      const first = await service.catalog(true)
      expect(first.eligible).toBe(true)
      expect(first.entries.map(e => e.account)).toEqual(['pro'])
      expect(host.dotSignedIn).not.toHaveBeenCalledWith('expired')
      expect(host.dotCatalog).toHaveBeenCalledTimes(1)
      email = 'new@example.com'
      expect((await service.catalog(true)).entries[0].key).toBe(first.entries[0].key)
      host.dotSignedIn.mockResolvedValue(false)
      expect(await service.catalog(true)).toEqual({ eligible: false, entries: [], errors: [], unread: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// docs/ui/dot-optimize.md §7 #3、#5
describe('Dot unread messages and dropped files', () => {
  const setup = async () => {
    const root = mkdtempSync(join(tmpdir(), 'dot-unread-'))
    const records: SessionRecord[] = []
    let state = 'idle'
    let clock = 1_000_000
    const delivered = new Set<string>()
    let items = [{ id: 'm1', role: 'assistant', text: 'first', createdAt: 100, attachments: [] }]
    const host = {
      accounts: async () => ({ accounts: [{ id: 'pro', plan: 'pro', email: 'pro@example.com' }] }),
      dotCatalog: async () => [{ id: 'dot', name: 'Nova', threadId: 'thread', status: 'active' }],
      dotSignedIn: async () => true,
      sessions: () => records.map(record => ({ record, state })),
      createSession: (opts: Partial<SessionRecord>) => {
        const record = { ...opts, id: 'local-0' } as SessionRecord
        records.push(record)
        return record
      },
      renameSession: vi.fn(),
      open: (id: string) => ({ record: records.find(r => r.id === id), items: [] }),
      item: (_id: string, itemId: string) => (delivered.has(itemId) ? { id: itemId } : null),
      readDot: vi.fn(async () => ({ history: { items, before: null } })),
    }
    const service = new DotChatSessions(host as unknown as EngineHost, root, () => clock)
    const changes: unknown[] = []
    service.onChange = change => changes.push(change)
    const key = (await service.catalog(true)).entries[0].key
    return {
      root,
      host,
      service,
      changes,
      key,
      delivered,
      arrive: (id: string, createdAt: number, text = id) => {
        items = [...items, { id, role: 'assistant', text, createdAt, attachments: [] }]
      },
      later: (ms: number) => (clock += ms),
      busy: (on: boolean) => (state = on ? 'running' : 'idle'),
    }
  }

  it('background check: only Dots opened here, not while replying or just read; a newer Dot message becomes unread once', async () => {
    const t = await setup()
    try {
      // 没在应用里打开过：不查
      await t.service.poll()
      expect(t.host.readDot).not.toHaveBeenCalled()
      t.service.snapshot(t.key)
      // 第一次读是基线：不算未读
      await t.service.poll()
      expect(t.host.readDot).toHaveBeenCalledTimes(1)
      expect(t.changes).toEqual([])
      // 刚读过、正在回复：跳过
      t.arrive('m2', 200, 'second message')
      await t.service.poll()
      t.later(60_000)
      t.busy(true)
      await t.service.poll()
      expect(t.host.readDot).toHaveBeenCalledTimes(1)
      t.busy(false)
      await t.service.poll()
      expect(t.changes).toEqual([
        {
          unread: [t.key],
          notice: { key: t.key, sessionId: 'local-0', name: 'Nova', messageId: 'm2', preview: 'second message' },
        },
      ])
      expect((await t.service.catalog()).unread).toEqual([t.key])
      // 同一条不重复报
      t.later(60_000)
      await t.service.poll()
      expect(t.changes).toHaveLength(1)
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  it('a reply already delivered in a turn only marks unread (no notice); reading while looking clears it and is remembered', async () => {
    const t = await setup()
    try {
      t.service.snapshot(t.key)
      await t.service.read(t.key, {})
      t.arrive('m2', 200)
      t.delivered.add('dot-m2')
      await t.service.read(t.key, {})
      expect(t.changes).toEqual([{ unread: [t.key] }])
      await t.service.read(t.key, { seen: true })
      expect(t.changes.at(-1)).toEqual({ unread: [] })
      // 存了盘：重启后同一条不算未读，更新的才算
      const reopened = new DotChatSessions(t.host as unknown as EngineHost, t.root)
      const again: unknown[] = []
      reopened.onChange = change => again.push(change)
      await reopened.catalog(true)
      await reopened.read(t.key, {})
      expect(again).toEqual([])
      t.arrive('m3', 300)
      await reopened.read(t.key, {})
      expect(again).toMatchObject([{ unread: [t.key], notice: { messageId: 'm3' } }])
      // 翻更早的记录不动未读
      await reopened.read(t.key, { before: 'cursor' })
      expect(again).toHaveLength(1)
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })

  it('dropped files: paths are registered as is, pasted content is written under dot-uploads and removed on release', async () => {
    const t = await setup()
    try {
      const real = join(t.root, 'note.txt')
      writeFileSync(real, 'hello')
      const added = await t.service.addFiles(t.key, [
        { path: real },
        { name: '..\\..\\evil:name.png', dataBase64: Buffer.from('png').toString('base64') },
      ])
      expect(added.map(f => [f.name, f.bytes])).toEqual([
        ['note.txt', 5],
        ['evil name.png', 3],
      ])
      const uploads = join(t.root, 'dot-uploads')
      expect(readdirSync(uploads)).toHaveLength(1)
      await expect(t.service.addFiles(t.key, [{ path: 'relative.txt' }])).rejects.toThrow('Invalid Dot file drop')
      await expect(t.service.addFiles(t.key, [{ nope: 1 }])).rejects.toThrow('Invalid Dot file drop')
      await expect(t.service.addFiles(t.key, [])).rejects.toThrow('Invalid Dot file drop')
      t.service.release(t.key)
      await vi.waitFor(() => expect(readdirSync(uploads)).toHaveLength(0))
      // Dot 忙时发的消息还排着（docs/ui/dot-optimize.md §9）：关窗口不删它带的粘贴文件，别的照删
      const sessionId = t.service.snapshot(t.key).record.id
      await t.service.addFiles(t.key, [{ name: 'queued.png', dataBase64: Buffer.from('q').toString('base64') }])
      const queuedPath = join(uploads, readdirSync(uploads)[0]!, 'queued.png')
      await t.service.addFiles(t.key, [{ name: 'other.png', dataBase64: Buffer.from('o').toString('base64') }])
      expect(readdirSync(uploads)).toHaveLength(2)
      const open = t.host.open
      t.host.open = (id: string) => ({
        ...open(id),
        queue: id === sessionId ? [{ id: 'q1', status: 'queued', files: [{ path: queuedPath }] }] : [],
      })
      t.service.release(t.key)
      await vi.waitFor(() => expect(readdirSync(uploads)).toHaveLength(1))
      expect(existsSync(queuedPath)).toBe(true)
      // 下次启动：留下的临时文件夹整个删掉
      writeFileSync(join(uploads, 'left.txt'), 'x')
      new DotChatSessions(t.host as unknown as EngineHost, t.root)
      expect(existsSync(uploads)).toBe(false)
    } finally {
      rmSync(t.root, { recursive: true, force: true })
    }
  })
})

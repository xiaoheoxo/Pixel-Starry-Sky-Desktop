import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DotAdapter, EngineHost } from '../src'

describe('Dot through EngineHost', () => {
  it('checks a pinned account even when the global current account is signed out', async () => {
    const credentials = vi.fn((_signal?: AbortSignal, account?: string) =>
      account === 'saved-pro' ? { accessToken: 'token', accountId: 'pro', accountUserId: 'member' } : null,
    )
    const adapter = new DotAdapter({ credentials })
    expect((await adapter.info()).status).toBe('unauthenticated')
    expect(
      (await adapter.infoForSession({ dot: { account: 'saved-pro', id: 'dot', threadId: 'root' } } as never)).status,
    ).toBe('ready')
    expect(credentials).toHaveBeenLastCalledWith(undefined, 'saved-pro')
  })
  it('reports expired credentials on explicit detection without exposing the provider body', async () => {
    const adapter = new DotAdapter({
      credentials: () => ({ accessToken: 'private-token', accountId: 'account', accountUserId: 'human' }),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('private-token', { status: 401 })),
    })
    expect(await adapter.info(true)).toMatchObject({ status: 'unauthenticated', message: 'Dot HTTP 401' })
  })
  it('delivers a selected file through the queue, stores replies, and keeps credentials out of sync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dot-host-'))
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      const path = url.pathname
      const json = (data: unknown) => Response.json(data)
      if (path.endsWith('/tbo/primary'))
        return json({
          selection: {
            available: true,
            aeon_id: 'dot',
            thread_id: 'root',
            messaging_room_id: 'room',
          },
        })
      if (path.endsWith('/tbo/by-thread/root'))
        return json({
          id: 'dot',
          status: 'active',
          messaging_room_id: 'room',
          active_root_thread_id: 'root',
        })
      if (path.endsWith('/messaging/rooms/room'))
        return json({
          id: 'room',
          type: 'DM',
          app_source: 'chatgpt:messaging',
          aeon_id: 'dot',
          members: [{ account_user_id: 'human' }, { account_user_id: 'bot', aeon_id: 'dot' }],
        })
      if (path.endsWith('/files') && init?.method === 'POST') return json({ id: 'file-uploaded' })
      if (path.endsWith('/messages') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body)).content).toEqual({
          text: 'hello',
          attachments: [{ type: 'file', file_id: 'file-uploaded' }],
        })
        const body = JSON.parse(String(init.body)) as { request_id: string }
        return json({
          id: 'sent',
          request_id: body.request_id,
          account_user_id: 'human',
          created_at: '2026-11-17T00:00:00Z',
          content: { text: 'hello' },
        })
      }
      if (path.endsWith('/messages'))
        return json({
          items: [
            {
              id: 'reply',
              account_user_id: 'bot',
              created_at: '2026-11-17T00:00:01Z',
              content: { text: 'Hello from Dot' },
            },
          ],
        })
      if (path.endsWith('/v1/threads/root')) return json({ thread: { id: 'root', status: { type: 'idle' } } })
      throw new Error(`Unexpected Dot request: ${path}`)
    })
    const host = new EngineHost({
      dataDir: join(root, 'data'),
      emit: () => {},
      adapters: {
        dot: new DotAdapter({
          fetch: request,
          credentials: () => ({
            accessToken: 'private-token',
            accountId: 'account',
            accountUserId: 'human',
          }),
        }),
      },
    })
    try {
      const project = host.addProject(root)
      const record = host.createSession({ projectId: project.id, engine: 'dot' })
      const path = join(root, 'selected.txt')
      writeFileSync(path, 'safe test')
      await host.send(record.id, {
        text: 'hello',
        clientMessageId: 'file-test',
        files: [
          {
            id: 'local-file',
            name: 'selected.txt',
            bytes: 9,
            path,
            pathOnly: true,
            text: '',
            lines: 0,
            encoding: 'utf-8',
          },
        ],
      })
      await vi.waitFor(() => {
        const snapshot = host.open(record.id)
        expect(snapshot.items).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'Hello from Dot' }))
        expect(snapshot.state).toBe('idle')
        expect(snapshot.queue).toHaveLength(0)
        expect(snapshot.record.engineSessionId).toBe('root')
      })
      expect(JSON.stringify(host.syncableSettings())).not.toContain('private-token')
      expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
    } finally {
      await host.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['send', 502, 'uncertain'],
    ['send', 429, 'uncertain'],
    ['read', 502, 'failed'],
    ['read', 429, 'failed'],
  ] as const)('does not resend after a %s HTTP %i failure', async (stage, status, queueStatus) => {
    const root = mkdtempSync(join(tmpdir(), 'dot-host-failure-'))
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/tbo/primary'))
        return Response.json({
          selection: { available: true, aeon_id: 'dot', thread_id: 'root', messaging_room_id: 'room' },
        })
      if (path.endsWith('/tbo/by-thread/root'))
        return Response.json({
          id: 'dot',
          status: 'active',
          messaging_room_id: 'room',
          active_root_thread_id: 'root',
        })
      if (path.endsWith('/messaging/rooms/room'))
        return Response.json({
          id: 'room',
          type: 'DM',
          app_source: 'chatgpt:messaging',
          aeon_id: 'dot',
          members: [{ account_user_id: 'human' }, { account_user_id: 'bot', aeon_id: 'dot' }],
        })
      if (path.endsWith('/messages') && init?.method === 'POST') {
        if (stage === 'send') return new Response('', { status })
        return Response.json({
          id: 'sent',
          request_id: JSON.parse(String(init.body)).request_id,
          account_user_id: 'human',
          created_at: '2026-11-17T00:00:00Z',
          content: { text: 'hello' },
        })
      }
      if (path.endsWith('/messages')) return new Response('', { status })
      throw new Error(`Unexpected Dot request: ${path}`)
    })
    const host = new EngineHost({
      dataDir: join(root, 'data'),
      emit: () => {},
      reconnectDelays: [1],
      limitDelays: [1],
      adapters: {
        dot: new DotAdapter({
          fetch: request,
          credentials: () => ({ accessToken: 'token', accountId: 'account', accountUserId: 'human' }),
          // 读取出错会重试（docs/ui/dot-optimize.md §7 #2）：试完还不行才报失败，发送始终只发一次
          retryMs: [1, 1],
        }),
      },
    })
    try {
      const project = host.addProject(root)
      const record = host.createSession({ projectId: project.id, engine: 'dot' })
      await host.send(record.id, { text: 'hello', clientMessageId: 'failure-test' })
      await vi.waitFor(() => {
        const snapshot = host.open(record.id)
        expect(snapshot.state).toBe('idle')
        expect(snapshot.queuePaused).toBe(true)
        expect(snapshot.queue).toHaveLength(1)
        expect(snapshot.queue[0]).toMatchObject({ status: queueStatus, error: `Dot HTTP ${status}` })
        expect(snapshot.queue[0].reconnect).toBeUndefined()
      })
      expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    } finally {
      await host.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not advertise remote cancellation or accept a model gateway connection', () => {
    const adapter = new DotAdapter({ credentials: () => ({ accessToken: '', accountId: '', accountUserId: '' }) })
    expect(() => adapter.createSession({ record: () => ({ provider: { id: 'api' } }) } as never)).toThrow(
      /not a model API/,
    )
  })
})

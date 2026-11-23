import { describe, expect, it, vi } from 'vitest'
import { DotClient } from '../src/dot/client'
import { DotAdapter } from '../src/dot'

const identity = {
  accountId: 'account',
  accountUserId: 'human',
  accessToken: 'private-token',
}
const selection = { available: true, thread_id: 'root', aeon_id: 'dot', messaging_room_id: 'room' }
const profile = { id: 'dot', status: 'active', messaging_room_id: 'room', active_root_thread_id: 'root' }
const room = {
  id: 'room',
  type: 'DM',
  app_source: 'chatgpt:messaging',
  aeon_id: 'dot',
  members: [{ account_user_id: 'human' }, { account_user_id: 'bot', aeon_id: 'dot' }],
}
const message = (id: string, text = 'hello') => ({
  id,
  account_user_id: 'bot',
  created_at: '2026-11-17T00:00:00Z',
  content: { text, attachments: [] },
})

function setup(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/backend-api/tbo/primary': { selection },
    '/backend-api/tbo/by-thread/root': profile,
    '/backend-api/messaging/rooms/room': room,
    ...overrides,
  }
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname + new URL(String(input)).search
    const value = routes[path]
    if (value instanceof Response) return value.clone()
    if (value === undefined) throw new Error(`Unexpected request: ${init?.method} ${path}`)
    return Response.json(value)
  })
  return { client: new DotClient({ credentials: () => identity, fetch: request }), request, routes }
}

describe('native Dot client', () => {
  it('recovers an unavailable thread lookup through the same Dot ID and verifies its current room', async () => {
    const { request } = setup({
      '/backend-api/tbo/by-thread/old-root': new Response('', { status: 404 }),
      '/backend-api/tbo/dot': profile,
    })
    const client = new DotClient({
      credentials: () => identity,
      fetch: request,
      target: { id: 'dot', threadId: 'old-root' },
    })
    await expect(client.discover()).resolves.toMatchObject({ id: 'dot', threadId: 'root', roomId: 'room' })
    expect(request.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/backend-api/tbo/by-thread/old-root',
      '/backend-api/tbo/dot',
      '/backend-api/messaging/rooms/room',
    ])
    for (const [, init] of request.mock.calls) {
      expect(init?.cache).toBe('no-store')
      expect(init?.credentials).toBe('omit')
    }
  })

  it('reads only the verified Dot participant’s receipt and keeps the native timestamp', async () => {
    const path = '/backend-api/messaging/rooms/room'
    const { client, request, routes } = setup()
    const dot = await client.discover()
    const through = '2026-11-17T07:35:00Z'
    const updated = '2026-11-17T07:36:00Z'
    routes[path] = {
      ...room,
      read_receipts: [
        { account_user_id: 'human', last_read_at: '2026-11-17T08:00:00Z' },
        { account_user_id: 'other', last_read_at: '2026-11-17T09:00:00Z' },
        { account_user_id: 'bot', last_read_at: 'invalid' },
        { account_user_id: 'bot', last_read_at: through, read_cursor_updated_at: updated },
        { account_user_id: 'bot', last_read_at: '2026-11-17T07:34:00Z' },
      ],
    }
    await expect(client.readReceipt(dot)).resolves.toEqual({
      readThroughAt: Date.parse(through),
      updatedAt: Date.parse(updated),
    })
    expect(request.mock.calls.at(-1)?.[1]?.method).toBe('GET')
    routes[path] = { ...room, read_receipts: [{ account_user_id: 'bot', last_read_at: through }] }
    await expect(client.readReceipt(dot)).resolves.toEqual({ readThroughAt: Date.parse(through) })
    routes[path] = { ...room, read_receipts: [{ account_user_id: 'human', last_read_at: through }] }
    await expect(client.readReceipt(dot)).resolves.toBeUndefined()
    routes[path] = { ...room, members: [{ account_user_id: 'human' }, { account_user_id: 'other', aeon_id: 'dot' }] }
    await expect(client.readReceipt(dot)).rejects.toThrow('identity')
  })

  it('refreshes receipt separately: a slow receipt never holds or fails message history', async () => {
    const roomPath = '/backend-api/messaging/rooms/room'
    const after = roomPath + '/messages?limit=32&after=sent'
    const { request } = setup({ [after]: { items: [] } })
    const adapter = new DotAdapter({ credentials: () => identity, fetch: request })
    const target = { id: 'dot', threadId: 'root' }
    await adapter.readDot('account', target, { after: 'sent' })
    const original = request.getMockImplementation()!
    let release!: (response: Response) => void
    const delayed = new Promise<Response>(resolve => (release = resolve))
    request.mockImplementation(async (input, init) =>
      new URL(String(input)).pathname === roomPath ? delayed : original(input, init),
    )
    const pending = adapter.readDotReceipt('account', target)
    await expect(adapter.readDot('account', target, { after: 'sent' })).resolves.toEqual({
      history: { items: [], before: null, latest: 'sent' },
    })
    const cursor = '2026-11-17T07:35:00Z'
    release(Response.json({ ...room, read_receipts: [{ account_user_id: 'bot', last_read_at: cursor }] }))
    await expect(pending).resolves.toEqual({ readThroughAt: Date.parse(cursor) })
  })

  it('never replaces a missing Dot with the primary Dot or an unrelated profile', async () => {
    const { request, routes } = setup({
      '/backend-api/tbo/by-thread/root': new Response('', { status: 404 }),
      '/backend-api/tbo/dot': { ...profile, id: 'other' },
    })
    const client = new DotClient({
      credentials: () => identity,
      fetch: request,
      target: { id: 'dot', threadId: 'root' },
    })
    await expect(client.discover()).rejects.toThrow('identity')
    routes['/backend-api/tbo/dot'] = new Response('', { status: 404 })
    await expect(client.discover()).rejects.toThrow('Dot HTTP 404')
    expect(
      request.mock.calls.every(([url]) => !String(url).includes('/primary') && !String(url).includes('/rooms/')),
    ).toBe(true)
  })

  it('uploads files to the verified room and sends their references together with the message', async () => {
    const { client, request } = setup({
      '/backend-api/messaging/rooms/room/files': { id: 'uploaded' },
      '/backend-api/messaging/rooms/room/messages': {
        ...message('sent'),
        account_user_id: 'human',
        request_id: 'request',
      },
    })
    const dot = await client.discover()
    const file = await client.upload(dot, { name: 'example.txt', mime: 'text/plain', data: new Uint8Array([65]) })
    expect(file).toBe('uploaded')
    const upload = request.mock.calls.at(-1)![1]!
    expect(upload.body).toBeInstanceOf(FormData)
    expect(new Headers(upload.headers).get('content-type')).toBeNull()
    await client.send(dot, 'read this', 'request', undefined, [file])
    expect(JSON.parse(String(request.mock.calls.at(-1)![1]!.body)).content.attachments).toEqual([
      { type: 'file', file_id: 'uploaded' },
    ])
  })

  it('refreshes a file URL through its verified room and never sends OAuth to storage', async () => {
    const { client, request } = setup({
      '/backend-api/messaging/rooms/room/files/file': {
        id: 'file',
        name: 'result.png',
        mime_type: 'image/png',
        download_url: 'https://storage.oaiusercontent.com/current',
      },
      '/current': new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }),
    })
    const dot = await client.discover()
    const file = await client.download(dot, 'file')
    expect(file.mime).toBe('image/png')
    expect(file.data.length).toBe(4)
    expect(new Headers(request.mock.calls.at(-1)![1]?.headers).has('authorization')).toBe(false)
    expect(request.mock.calls.at(-1)![1]?.redirect).toBe('error')
  })

  it('rejects mismatched file identities, unsafe storage and oversized uploads', async () => {
    const { client, routes, request } = setup({
      '/backend-api/messaging/rooms/room/files/file': {
        id: 'other',
        download_url: 'https://storage.oaiusercontent.com/image',
      },
    })
    const dot = await client.discover()
    await expect(client.download(dot, 'file')).rejects.toThrow('identity')
    routes['/backend-api/messaging/rooms/room/files/file'] = {
      id: 'file',
      download_url: 'https://attacker.example/image',
    }
    await expect(client.download(dot, 'file')).rejects.toThrow('storage')
    const count = request.mock.calls.length
    await expect(client.upload(dot, { name: 'large', data: new Uint8Array(20 * 1024 * 1024 + 1) })).rejects.toThrow(
      '20 MiB',
    )
    expect(request.mock.calls.length).toBe(count)
  })

  it('negotiates a computer stream for the bound Dot using SDP without exposing the token', async () => {
    const { client, request } = setup({
      '/v1/cua?source=aeon&thread_id=root&aeon_id=dot': new Response('v=0\r\nanswer'),
    })
    const dot = await client.discover()
    await expect(client.computerOffer(dot, 'v=0\r\noffer')).resolves.toBe('v=0\r\nanswer')
    const [url, init] = request.mock.calls.at(-1)!
    expect(String(url)).toBe('https://realtime.chatgpt.com/v1/cua?source=aeon&thread_id=root&aeon_id=dot')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/sdp')
    expect(init?.body).toBe('v=0\r\noffer')
    await expect(client.computerOffer({ ...dot }, 'v=0\r\noffer')).rejects.toThrow()
  })

  it('reads a native older history page and keeps partial overview failures separate', async () => {
    const { client } = setup({
      '/backend-api/messaging/rooms/room/messages?limit=32&before=older': {
        items: [
          {
            ...message('history'),
            content: {
              text: 'Saved reply',
              attachments: [{ type: 'file', file_id: 'file', file: { name: 'result.mp4', mime_type: 'video/mp4' } }],
            },
          },
        ],
        prev_cursor: 'previous',
      },
      '/backend-api/tbo/dot/environment/status': {
        status: 'connected',
        capabilities: [{ type: 'remote_desktop', status: 'ready' }],
      },
      '/backend-api/tbo/dot/activity?limit=5': { data: [] },
      '/backend-api/tbo/dot/tasks?limit=25': new Response('', { status: 503 }),
    })
    const dot = await client.discover()
    expect(await client.history(dot, 'older')).toMatchObject({
      before: 'previous',
      items: [{ role: 'assistant', attachments: [{ name: 'result.mp4', mime: 'video/mp4' }] }],
    })
    const overview = await client.overview(dot)
    expect(overview.environment?.capabilities[0].status).toBe('ready')
    expect(overview.activity).toEqual([])
    expect(overview.tasks).toBeNull()
    expect(overview.errors).toEqual(['Dot HTTP 503'])
  })

  it('loads every incremental page, preserves the room cursor, and excludes deleted or unrelated messages', async () => {
    const { client } = setup({
      '/backend-api/messaging/rooms/room/messages?limit=32&after=known': {
        items: [message('m1'), { ...message('deleted'), deleted_at: '2026-11-17T00:00:01Z' }],
        next_cursor: 'next',
      },
      '/backend-api/messaging/rooms/room/messages?limit=32&after=next': {
        items: [{ ...message('other'), account_user_id: 'other' }, message('m2')],
      },
      '/backend-api/messaging/rooms/room/messages?limit=32&after=m2': { items: [] },
    })
    const dot = await client.discover()
    expect(await client.historyAfter(dot, 'known')).toMatchObject({
      items: [{ id: 'm1' }, { id: 'm2' }],
      latest: 'm2',
      before: null,
    })
    expect(await client.historyAfter(dot, 'm2')).toEqual({ items: [], latest: 'm2', before: null })
  })

  it('recovers an invalid cursor in the same room and keeps optional 404s out of conversation errors', async () => {
    const { client } = setup({
      '/backend-api/messaging/rooms/room/messages?limit=32&after=gone': new Response('', { status: 404 }),
      '/backend-api/messaging/rooms/room/messages?limit=32': {
        items: Array.from({ length: 32 }, (_, i) => message(`msg-${i + 9}`)),
        prev_cursor: 'missing-eight',
      },
      '/backend-api/messaging/rooms/room/messages?limit=32&before=missing-eight': {
        items: Array.from({ length: 8 }, (_, i) => message(`msg-${i + 1}`)),
      },
      '/backend-api/tbo/dot/environment/status': { status: 'connected' },
      '/backend-api/tbo/dot/activity?limit=5': new Response('', { status: 404 }),
      '/backend-api/tbo/dot/tasks?limit=25': new Response('', { status: 404 }),
    })
    const dot = await client.discover()
    const repaired = await client.historyAfter(dot, 'gone')
    expect(repaired).toMatchObject({ reset: true, before: 'missing-eight', latest: 'msg-40' })
    expect(repaired.items).toHaveLength(32)
    const recovered = await client.history(dot, repaired.before!)
    expect(recovered.items.map(row => row.id)).toEqual(Array.from({ length: 8 }, (_, i) => `msg-${i + 1}`))
    expect(await client.overview(dot)).toMatchObject({
      activity: null,
      tasks: null,
      errors: [],
      environment: { status: 'connected' },
    })
  })

  it('recovers sidebar files and work cards beyond the visible page without changing message cursors', async () => {
    const { request } = setup({
      '/backend-api/tbo/dot/environment/status': { status: 'connected' },
      '/backend-api/tbo/dot/activity?limit=5': new Response('', { status: 404 }),
      '/backend-api/tbo/dot/tasks?limit=25': { data: [] },
      '/backend-api/tbo/dot/automations': {
        automations: [
          { id: 'schedule-a', title: 'Check build', is_enabled: false, prompt: 'must not be exposed' },
          { id: 'schedule-b', title: 'Follow up', status: 'completed', is_enabled: false },
          { id: 'schedule-c', title: 'Read CI', enabled: true },
        ],
      },
      '/backend-api/messaging/rooms/room/messages?limit=32': { items: [message('recent')], prev_cursor: 'older' },
      '/backend-api/messaging/rooms/room/messages?limit=32&before=older': {
        items: [
          {
            ...message('old'),
            content: {
              attachments: [
                { type: 'file', file_id: 'output', file: { name: 'result.png' } },
                { type: 'thread', thread_id: 'work-1' },
              ],
            },
          },
          {
            ...message('other-user'),
            account_user_id: 'human',
            content: {
              attachments: [
                { type: 'thread', thread_id: 'not-ours' },
                { type: 'file', file_id: 'user-upload' },
              ],
            },
          },
        ],
      },
      '/v1/threads/work-1': { thread: { id: 'work-1', name: 'Build result', status: { type: 'idle' } } },
      '/v2/threads/work-1/turns?limit=1&sortDirection=desc&itemsView=notLoaded': { data: [{ status: 'completed' }] },
    })
    const adapter = new DotAdapter({ credentials: () => identity, fetch: request })
    const target = { id: 'dot', threadId: 'root' }
    expect(await adapter.readDot('account', target, { overviewOnly: true })).toMatchObject({
      history: { items: [], before: null },
      overview: {
        activity: null,
        tasks: [],
        errors: [],
        roomOutputs: [{ fileId: 'output', name: 'result.png' }],
        roomTasks: [{ id: 'work-1', title: 'Build result', status: 'completed' }],
        roomContentPartial: false,
        scheduledActivity: [
          { id: 'schedule-a', title: 'Check build', status: 'paused' },
          { id: 'schedule-b', title: 'Follow up', status: 'completed' },
          { id: 'schedule-c', title: 'Read CI', status: 'active' },
        ],
      },
    })
    expect(request.mock.calls.some(([input]) => String(input).includes('not-ours'))).toBe(false)
  })

  it('does not confuse a failed or wrong-owner schedule request with an empty list', async () => {
    const { client, routes } = setup({
      '/backend-api/tbo/dot/environment/status': { status: 'connected' },
      '/backend-api/tbo/dot/activity?limit=5': { data: [] },
      '/backend-api/tbo/dot/tasks?limit=25': { data: [] },
      '/backend-api/messaging/rooms/room/messages?limit=32': { items: [] },
      '/backend-api/tbo/dot/automations': new Response('', { status: 403 }),
    })
    const dot = await client.discover()
    expect(await client.overview(dot, undefined, true)).toMatchObject({
      scheduledActivity: null,
      scheduledActivityError: 'Dot HTTP 403',
      errors: [],
      roomOutputs: [],
    })
    const route = '/backend-api/tbo/dot/automations'
    routes[route] = { data: { automations: [{ id: 'foreign', title: 'Foreign', aeon_id: 'another-dot' }] } }
    expect(await client.overview(dot, undefined, true)).toMatchObject({
      scheduledActivity: null,
      scheduledActivityError: 'Dot schedule response unavailable',
    })
    routes[route] = []
    expect(await client.overview(dot, undefined, true)).toMatchObject({ scheduledActivity: [] })
  })

  it('accepts the canonical ChatGPT user as the room member when account-user and user claims differ', async () => {
    const { request } = setup({
      '/backend-api/messaging/rooms/room/messages': {
        ...message('sent'),
        account_user_id: 'human',
        request_id: 'request-1',
      },
    })
    const client = new DotClient({
      credentials: () => ({ ...identity, accountUserId: 'workspace-member', userId: 'human' }),
      fetch: request,
    })
    const dot = await client.discover()
    await expect(client.send(dot, 'hello', 'request-1')).resolves.toMatchObject({ account_user_id: 'human' })
  })

  it('lists multiple Dots with catalog pagination and resolves a fixed target without using primary', async () => {
    const { request } = setup({
      '/backend-api/tbo?limit=25&include_room_preview=false': {
        items: [{ id: 'dot', display_name: 'First', active_root_thread_id: 'root', status: 'active' }],
        cursor: 'next',
      },
      '/backend-api/tbo?limit=25&include_room_preview=false&cursor=next': {
        items: [{ id: 'second', display_name: 'Second', active_root_thread_id: 'other', status: 'active' }],
        cursor: null,
      },
    })
    const client = new DotClient({
      credentials: async () => identity,
      fetch: request,
      target: { id: 'dot', threadId: 'root' },
    })
    expect((await client.catalog()).map(p => p.id)).toEqual(['dot', 'second'])
    expect(await client.discover()).toMatchObject({ id: 'dot', threadId: 'root', roomId: 'room' })
    expect(request.mock.calls.some(([url]) => String(url).endsWith('/tbo/primary'))).toBe(false)
  })

  it('verifies the primary Dot, account and room before sending an idempotent message', async () => {
    const { client, request } = setup({
      '/backend-api/messaging/rooms/room/messages': {
        ...message('sent'),
        account_user_id: 'human',
        request_id: 'request-1',
      },
    })
    const dot = await client.discover()
    await client.send(dot, 'hello', 'request-1')
    const [url, init] = request.mock.calls.at(-1)!
    expect(String(url)).toBe('https://chatgpt.com/backend-api/messaging/rooms/room/messages')
    expect(JSON.parse(String(init?.body))).toEqual({
      content: { text: 'hello' },
      request_id: 'request-1',
      idempotency_token: 'request-1',
    })
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-token')
    expect(new Headers(init?.headers).get('ChatGPT-Account-Id')).toBe('account')
  })

  it.each([
    { ...room, aeon_id: 'another-dot' },
    { ...room, members: [{ account_user_id: 'bot', aeon_id: 'dot' }] },
    { ...room, type: 'GROUP' },
  ])('refuses a mismatched room before any POST', async invalid => {
    const { client, request } = setup({ '/backend-api/messaging/rooms/room': invalid })
    await expect(client.discover()).rejects.toThrow(/identity/i)
    expect(request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
  })

  it('reads all message pages and sorts them chronologically', async () => {
    const { client } = setup({
      '/backend-api/messaging/rooms/room/messages?limit=32&after=sent': {
        items: [{ ...message('b'), created_at: '2026-11-17T00:00:02Z' }],
        next_cursor: 'cursor',
      },
      '/backend-api/messaging/rooms/room/messages?limit=32&after=cursor': { items: [message('a')] },
    })
    const dot = await client.discover()
    expect((await client.messages(dot, 'sent')).map(m => m.id)).toEqual(['a', 'b'])
  })

  it('rejects a pagination loop instead of silently losing messages', async () => {
    const { client } = setup({
      '/backend-api/messaging/rooms/room/messages?limit=32&after=sent': {
        items: [message('a')],
        next_cursor: 'sent',
      },
    })
    await expect(client.messages(await client.discover(), 'sent')).rejects.toThrow(/pagination/i)
  })

  it('never retries an ambiguous write and never includes a provider body or token in errors', async () => {
    const { client, request } = setup({
      '/backend-api/messaging/rooms/room/messages': new Response('private-token', { status: 502 }),
    })
    const dot = await client.discover()
    await expect(client.send(dot, 'hello', 'request-1')).rejects.toThrow('Dot HTTP 502')
    expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it('invalidates a verified Dot after the configured account changes', async () => {
    let credentials = identity
    const { request } = setup()
    const client = new DotClient({ credentials: () => credentials, fetch: request })
    const dot = await client.discover()
    credentials = { ...identity, accountId: 'other' }
    await expect(client.send(dot, 'hello', 'request-1')).rejects.toThrow(/account changed/i)
  })

  it('主对话在忙但带等待标记时报 waiting，其余照原样（docs/ui/dot-optimize.md §9）', async () => {
    const status = (value: unknown) => setup({ '/v1/threads/root': { thread: { id: 'root', status: value } } }).client
    for (const [value, expected] of [
      [{ type: 'idle' }, 'idle'],
      [{ type: 'notLoaded' }, 'notLoaded'],
      [{ type: 'active', activeFlags: [] }, 'active'],
      [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, 'waiting'],
    ] as const) {
      const client = status(value)
      expect(await client.activity(await client.discover())).toBe(expected)
    }
  })

  it('only loads workflow threads attached by the verified Dot', async () => {
    const { client, request } = setup({
      '/v1/threads/task': { thread: { id: 'task', name: 'Build', updatedAt: 10, status: { type: 'idle' } } },
      '/v2/threads/task/turns?limit=1&sortDirection=desc&itemsView=notLoaded': {
        data: [{ id: 'turn', status: 'completed', startedAt: 5 }],
      },
    })
    const dot = await client.discover()
    await expect(client.workflow(dot, message('a'), 'task')).rejects.toThrow(/attachment/i)
    const card = { ...message('a'), content: { text: '', attachments: [{ type: 'thread', thread_id: 'task' }] } }
    expect(await client.workflow(dot, card, 'task')).toMatchObject({ id: 'task', title: 'Build', status: 'completed' })
    expect(String(request.mock.calls.at(-1)![0])).toMatch(/^https:\/\/codex-cloud-backend.chatgpt.com\//)
  })
})

it('keeps only the safe state of native cards in Dot history, not secure form data or handoff links', async () => {
  const candidate = {
    ...message('native'),
    content: {
      text: 'never show secure text',
      attachments: [{ type: 'file', file_id: 'hidden' }],
      elicitation: {
        status: 'submitted',
        params: { _meta: { codex_approval_kind: 'browser_auth' }, requestedSchema: { fields: ['placeholder'] } },
        result: { password: 'fixture-not-a-credential' },
      },
    },
  }
  const { client } = setup({
    '/backend-api/messaging/rooms/room/messages?limit=32': {
      items: [
        candidate,
        { ...candidate, id: 'human', account_user_id: 'human', content: { elicitation: {} } },
        { ...candidate, id: 'foreign', account_user_id: 'foreign' },
        { ...candidate, id: 'deleted', deleted_at: '2026-11-17T00:00:00Z' },
        {
          ...message('handoff', ''),
          message_metadata: { cloud_browser_handoff: { internal: 'never mirror this' } },
        },
      ],
    },
  })
  const items = (await client.history(await client.discover())).items
  expect(items.map(item => item.id)).toEqual(['native', 'human', 'handoff'])
  expect(items[0]).toMatchObject({ card: { kind: 'signIn', status: 'submitted' }, text: '', attachments: [] })
  expect(items[1]).not.toHaveProperty('card')
  expect(items[2].card).toEqual({ kind: 'browserHandoff' })
  expect(JSON.stringify(items)).not.toMatch(/credential|placeholder|never show|never mirror/)
})

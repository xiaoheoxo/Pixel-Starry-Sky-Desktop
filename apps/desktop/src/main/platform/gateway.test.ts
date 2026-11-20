import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { SessionRecord } from '@pixelsky/protocol'
import { CLAUDE_COMPACT_MARKER, setLogSink, type CompactionRequestReport } from '@pixelsky/engine'
import { BODY_LIMIT, eventEnd, platformGateway, reservationConflict } from './gateway'
import type { ResolvedProvider } from '../core/providers/store'
import type { Fetch } from '../core/providers/upstream'
let server: Server
afterEach(() => {
  server?.closeAllConnections()
  server?.close()
})
describe('平台代理按引擎隔离 Responses 与 Messages', () => {
  it.each([
    { engine: 'claude', model: 'gpt-6.1-sol', requestModel: 'gpt-6.1-sol', path: '/v1/messages' },
    { engine: 'claude', model: 'gpt-6-astra', requestModel: 'claude-sonnet-5-5', path: '/v1/messages' },
    { engine: 'claude', model: 'claude-opus-5-5', requestModel: 'gpt-6-astra', path: '/v1/messages' },
    { engine: 'codex', model: 'claude-opus-5-5', requestModel: 'claude-opus-5-5', path: '/v1/responses' },
    { engine: 'pixel', model: 'gpt-6.1-sol', requestModel: 'gpt-6.1-sol', path: '/v1/messages' },
  ] as const)(
    '平台 $engine 的 $model / $requestModel 请求协议不匹配时，不记费、不转发',
    async ({ engine, model, requestModel, path }) => {
      const upstream = vi.fn(async () => new Response('ok'))
      const tracked = vi.fn()
      server = platformGateway({
        sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
        record: () => ({ id: 's', engine, model, platform: { groupId: '2', account: 'user' } }) as SessionRecord,
        account: () => 'user',
        fetch: upstream,
        requestContext: () => tracked,
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer local-secret' },
        body: JSON.stringify({ model: requestModel }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: { message: '线路协议与当前引擎不兼容' } })
      expect(upstream).not.toHaveBeenCalled()
      expect(tracked).not.toHaveBeenCalled()
    },
  )

  it.each(['codex', 'pixel'] as const)('请求体超过上限：%s 不转发，Codex 收到上下文超限', async engine => {
    const upstream = vi.fn(async () => new Response('ok'))
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => ({ id: 's', engine, model: 'gpt-5', platform: { groupId: '2', account: 'user' } }) as SessionRecord,
      account: () => 'user',
      fetch: upstream,
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret' },
      body: JSON.stringify({ model: 'gpt-5', input: 'x'.repeat(BODY_LIMIT) }),
    })
    const text = await res.text()
    if (engine === 'codex') {
      expect(res.status).toBe(200)
      const event = JSON.parse(text.split('data: ')[1])
      expect(event).toMatchObject({ type: 'response.failed', response: { error: { code: 'context_length_exceeded' } } })
    } else {
      expect(res.status).toBe(413)
      expect(JSON.parse(text)).toMatchObject({ error: { type: 'request_too_large' } })
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each(['codex', 'pixel'] as const)('上游回 413：%s 只有 Codex 改成上下文超限', async engine => {
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => ({ id: 's', engine, model: 'gpt-5', platform: { groupId: '2', account: 'user' } }) as SessionRecord,
      account: () => 'user',
      fetch: async () => new Response('{"error":{"message":"too large"}}', { status: 413 }),
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret' },
      body: JSON.stringify({ model: 'gpt-5' }),
    })
    const text = await res.text()
    expect(res.status).toBe(engine === 'codex' ? 200 : 413)
    if (engine === 'codex') expect(text).toContain('"code":"context_length_exceeded"')
  })

  it('压缩请求也不能把 Claude 模型改成 GPT', async () => {
    const upstream = vi.fn(async () => new Response('ok'))
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () =>
        ({
          id: 's',
          engine: 'claude',
          model: 'claude-opus-5-5',
          platform: { groupId: '2', account: 'user' },
        }) as SessionRecord,
      account: () => 'user',
      fetch: upstream,
      rewrite: async () => JSON.stringify({ model: 'gpt-6.1-sol' }),
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret' },
      body: JSON.stringify({ model: 'claude-opus-5-5' }),
    })
    expect(res.status).toBe(403)
    await res.text()
    expect(upstream).not.toHaveBeenCalled()
  })

  it('DeepSeek 这类没有 Claude 模型的线路：claude-* 请求换成会话模型，haiku 换小模型，线路里有的模型不动', async () => {
    const bodies: string[] = []
    const upstream = vi.fn(async (_path: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return new Response('ok')
    })
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () =>
        ({
          id: 's',
          engine: 'claude',
          model: 'deepseek-v4.1-pro',
          platform: { groupId: '49', account: 'user' },
        }) as SessionRecord,
      account: () => 'user',
      fetch: upstream,
      routeModels: async () => ['deepseek-v4.1-pro', 'deepseek-v4.1-flash'],
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    for (const model of ['claude-sonnet-4-5', 'claude-haiku-4-5', 'deepseek-v4.1-flash']) {
      const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer local-secret' },
        body: JSON.stringify({ model, max_tokens: 1 }),
      })
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(bodies.map(b => JSON.parse(b))).toEqual([
      { model: 'deepseek-v4.1-pro', max_tokens: 1 },
      { model: 'deepseek-v4.1-flash', max_tokens: 1 },
      { model: 'deepseek-v4.1-flash', max_tokens: 1 },
    ])
  })

  it('选定账号 / 模型 / 线路才转发，退出或改回自有立即失效', async () => {
    let record = {
      id: 'session',
      engine: 'codex',
      model: 'gpt-6.1-sol',
      platform: { groupId: '7', account: 'user' },
    } as SessionRecord
    let account: string | null = 'user'
    const tracked: string[] = []
    const charged: Array<[string, string | undefined]> = []
    const calls: Array<{ path: string; group: string | null; body: unknown }> = []
    server = platformGateway({
      sessions: new Map([['session', { recordId: 'session', secret: 'local-secret' }]]),
      record: () => record,
      account: () => account,
      requestContext: () => (id, _model, chargeId) => {
        if (chargeId) charged.push([id, chargeId])
        else tracked.push(id)
      },
      fetch: async (path, init) => {
        expect(new Headers(init.headers).get('X-Client-Request-ID')).toBe(tracked.at(-1))
        calls.push({
          path,
          group: new Headers(init.headers).get('X-PixelSky-Group'),
          body: JSON.parse(String(init.body)),
        })
        return new Response('event: response.completed\ndata: {}\n\n', {
          // 云端回传 Sub2api 生成的请求 ID（docs/cloud-service.md §4.9）
          headers: {
            'Content-Type': 'text/event-stream',
            'Retry-After': '5',
            'X-Client-Request-ID': '0b8f6d1e-4c3a-4e7b-9d2f-5a6b7c8d9e0f',
          },
        })
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const send = (path = '/v1/responses', model = 'gpt-6.1-sol', token = 'local-secret') =>
      fetch(base + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: JSON.stringify({ model, stream: true }),
      })
    const good = await send()
    expect(good.status).toBe(200)
    expect(good.headers.get('retry-after')).toBe('5')
    expect(await good.text()).toContain('response.completed')
    expect(calls).toEqual([
      { path: '/v1/platform/responses', group: '7', body: { model: 'gpt-6.1-sol', stream: true } },
    ])
    expect((await send('/v1/messages')).status).toBe(403)
    expect((await send('/v1/responses', 'other')).status).toBe(403)
    expect((await send('/v1/responses', 'gpt-6.1-sol', 'invalid')).status).toBe(401)
    account = null
    expect((await send()).status).toBe(401)
    account = 'user'
    record = { ...record, platform: null }
    expect((await send()).status).toBe(401)
    expect(calls).toHaveLength(1)
    expect(tracked).toHaveLength(1)
    expect(tracked[0]).toMatch(/^pixelsky-[a-f0-9-]{36}$/)
    // 收到响应后把 Sub2api 的 ID 补到同一条上
    expect(charged).toEqual([[tracked[0], '0b8f6d1e-4c3a-4e7b-9d2f-5a6b7c8d9e0f']])
  })

  it('Messages 把 Claude Code 的身份头带给云端（Sub2api「仅限 Claude Code」分组靠它认终端）', async () => {
    let forwarded: Headers | null = null
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => ({ id: 's', engine: 'claude', platform: { groupId: '2', account: 'user' } }) as SessionRecord,
      account: () => 'user',
      fetch: async (_path, init) => {
        forwarded = new Headers(init.headers)
        return new Response('event: message_stop\ndata: {}\n\n')
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const identity = {
      'user-agent': 'claude-cli/2.1.0 (external, cli)',
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }
    const res = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret', ...identity },
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(Object.fromEntries(forwarded!)).toMatchObject(identity)
    expect(forwarded!.get('authorization')).toBeNull()
  })

  it('平台账号登录失效（过期或被吊销）：回 401 和原因，不是 502', async () => {
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => ({ id: 's', engine: 'claude', platform: { groupId: '2', account: 'user' } }) as SessionRecord,
      account: () => 'user',
      fetch: async () => {
        throw Object.assign(new Error('登录已失效（已过期或被吊销），请重新登录'), { code: 'AUTH_EXPIRED' })
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret' },
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { message: expect.stringContaining('请重新登录') } })
  })
})

it('上游输出到一半断开：记一条日志，带请求 ID、状态码、已转发字节和错误码链（docs/ui/logging.md §4.5）', async () => {
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = []
  setLogSink({ enabled: () => true, write: (level, _scope, message, fields) => logs.push({ level, message, fields }) })
  try {
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => ({ id: 's', engine: 'claude', platform: { groupId: '2', account: 'user' } }) as SessionRecord,
      account: () => 'user',
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: message_start\n\n'))
              setTimeout(
                () =>
                  controller.error(
                    new TypeError('terminated', {
                      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
                    }),
                  ),
                20,
              )
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret' },
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    })
    expect(res.status).toBe(200)
    // 不掐断连接：已转发的完整事件之后接一个 error 事件正常结束（Claude Code 不会反复重试）
    const text = await res.text()
    expect(text.startsWith('event: message_start\n\nevent: error\n')).toBe(true)
    expect(JSON.parse(text.split('data: ')[1])).toMatchObject({ type: 'error', error: { type: 'api_error' } })
    const broken = logs.find(l => l.message === '上游连接中途断开')
    expect(broken?.level).toBe('warn')
    expect(broken?.fields).toMatchObject({
      path: '/v1/messages',
      sessionId: 's',
      requestId: expect.stringMatching(/^pixelsky-/),
      status: 200,
      bytes: 22,
      error: 'TypeError terminated ← UND_ERR_SOCKET other side closed',
    })
    expect(broken?.fields?.streamMs).toEqual(expect.any(Number))
  } finally {
    setLogSink(null)
  }
})

it('中途断开时丢掉不完整的事件再接 error 事件；完整结束时原样转发（含不完整的结尾）', async () => {
  const broken = (parts: string[], fail: boolean) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          for (const part of parts) {
            controller.enqueue(new TextEncoder().encode(part))
            await new Promise(r => setTimeout(r, 5))
          }
          if (fail) controller.error(new TypeError('terminated'))
          else controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  let next: () => Response = () => broken([], false)
  server = platformGateway({
    sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
    record: () => ({ id: 's', engine: 'claude', platform: { groupId: '2', account: 'user' } }) as SessionRecord,
    account: () => 'user',
    fetch: async () => next(),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const post = () =>
    fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret' },
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    })
  next = () => broken(['event: a\ndata: {}\n\nevent: b\nda', 'ta: {"x":1}\n\nevent: c\ndata: {"half'], true)
  const cut = await (await post()).text()
  expect(cut.startsWith('event: a\ndata: {}\n\nevent: b\ndata: {"x":1}\n\nevent: error\n')).toBe(true)
  expect(cut).not.toContain('half')
  next = () => broken(['event: a\r\ndata: {}\r\n\r\nevent: b\ndata: {"tail', '":1}'], false)
  expect(await (await post()).text()).toBe('event: a\r\ndata: {}\r\n\r\nevent: b\ndata: {"tail":1}')
  expect(eventEnd(Buffer.from('no boundary'))).toBe(0)
})

it('waits for remote billing correlation before forwarding and fails closed on disconnect', async () => {
  let correlated = false,
    available = true,
    forwarded = 0
  const record = {
    id: 'remote',
    engine: 'codex',
    model: 'test-model',
    platform: { groupId: '7', account: 'test' },
  } as SessionRecord
  server = platformGateway({
    sessions: new Map([['remote', { recordId: 'remote', secret: 'secret' }]]),
    record: async () => record,
    account: () => 'test',
    requestContext: () => async () => {
      await new Promise(r => setTimeout(r, 10))
      if (!available) throw new Error('SSH_CONNECTION_CLOSED')
      correlated = true
    },
    fetch: async () => {
      expect(correlated).toBe(true)
      forwarded++
      return new Response('data: done\n\n')
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const send = () =>
    fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
      body: JSON.stringify({ model: 'test-model' }),
    })
  expect((await send()).status).toBe(200)
  available = false
  correlated = false
  expect((await send()).status).toBe(502)
  expect(forwarded).toBe(1)
})

describe('自定义 API 经本机网关（docs/ui/custom-api.md §4.1）', () => {
  const provider = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({
    id: 'p1',
    name: 'Relay',
    template: 'custom',
    protocol: 'anthropic',
    baseUrl: 'https://relay.example.com/anthropic',
    auth: 'x-api-key',
    models: [{ id: 'deepseek-chat' }, { id: 'deepseek-lite' }],
    smallModel: 'deepseek-lite',
    modelFallback: true,
    headerNames: ['X-Org'],
    createdAt: 0,
    updatedAt: 0,
    apiKey: 'sk-real-key',
    headers: { 'X-Org': 'org-1' },
    ...over,
  })

  it('换上真实 Key 和附加请求头、不跟随跳转；不认识的模型换成后台小模型或当前模型；平台的云端不经手', async () => {
    let record = {
      id: 's',
      engine: 'claude',
      model: 'deepseek-chat',
      platform: null,
      provider: { id: 'p1' },
    } as SessionRecord
    let current: ResolvedProvider | null = provider()
    const calls: { url: string; init: RequestInit }[] = []
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => record,
      account: () => null,
      fetch: async () => {
        throw new Error('platform fetch must not be used')
      },
      provider: () => current,
      upstream: async (url, init) => {
        calls.push({ url, init })
        if (url.includes('fail'))
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        return new Response('event: message_stop\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const send = (model: string, path = '/v1/messages', token = 'local-secret') =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'b1',
          'user-agent': 'claude-cli/2.1.0 (external, cli)',
          'x-app': 'cli',
        },
        body: JSON.stringify({ model, max_tokens: 5 }),
      })

    const ok = await send('deepseek-chat')
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('message_stop')
    const first = calls[0]
    const headers = first.init.headers as Record<string, string>
    expect(first.url).toBe('https://relay.example.com/anthropic/v1/messages')
    expect(first.init.redirect).toBe('error')
    expect(headers).toMatchObject({
      'x-api-key': 'sk-real-key',
      'X-Org': 'org-1',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'b1',
      'user-agent': 'claude-cli/2.1.0 (external, cli)',
      'x-app': 'cli',
    })
    expect(JSON.stringify(headers)).not.toContain('local-secret')
    expect(JSON.parse(String(first.init.body)).model).toBe('deepseek-chat')

    await send('claude-haiku-4-5')
    expect(JSON.parse(String(calls[1].init.body)).model).toBe('deepseek-lite')
    await send('claude-sonnet-4-5')
    expect(JSON.parse(String(calls[2].init.body)).model).toBe('deepseek-chat')
    expect((await send('deepseek-chat', '/v1/messages/count_tokens')).status).toBe(200)
    expect(calls[3].url).toBe('https://relay.example.com/anthropic/v1/messages/count_tokens')

    // 后台小模型已经从列表里删掉（旧配置）：兜底换成列表里的模型，不再转发给删掉的那个
    current = provider({ models: [{ id: 'review-main' }], smallModel: 'claude-haiku-retired' })
    record = { ...record, model: 'review-main' }
    await send('claude-haiku-retired')
    await send('claude-haiku-4-5')
    const stale = calls.splice(4) // 后面的断言按下标数，拿走这两次
    expect(stale.map(c => JSON.parse(String(c.init.body)).model)).toEqual(['review-main', 'review-main'])
    record = { ...record, model: 'deepseek-chat' }

    // 兜底关掉：原样转发
    current = provider({ modelFallback: false })
    await send('claude-sonnet-4-5')
    expect(JSON.parse(String(calls[4].init.body)).model).toBe('claude-sonnet-4-5')

    // 连不上：502 + 人话；错的会话密钥 401；协议不对 403；没 Key 401；接口删了 401
    current = provider({ baseUrl: 'https://fail.example.com' })
    const down = await send('deepseek-chat')
    expect(down.status).toBe(502)
    expect(await down.text()).toContain('连接被拒绝')
    current = provider()
    expect((await send('deepseek-chat', '/v1/messages', 'wrong')).status).toBe(401)
    expect((await send('deepseek-chat', '/v1/responses')).status).toBe(403)
    current = provider({ apiKey: null })
    expect((await send('deepseek-chat')).status).toBe(401)
    current = null
    const gone = await send('deepseek-chat')
    expect(gone.status).toBe(401)
    expect(await gone.text()).toContain('已删除')
    // 会话改回自有：旧进程的请求一律拒绝
    current = provider()
    record = { ...record, provider: null }
    expect((await send('deepseek-chat')).status).toBe(401)
    expect(calls).toHaveLength(6)
  })

  it('接口没有计数接口：记一次 INFO，之后同一个地址在本机直接回 404、不再发出去也不记警告；换地址重新试', async () => {
    const record = {
      id: 's',
      engine: 'claude',
      model: 'deepseek-chat',
      platform: null,
      provider: { id: 'p1' },
    } as SessionRecord
    let current: ResolvedProvider = provider()
    const calls: string[] = []
    const logs: { level: string; message: string }[] = []
    setLogSink({ enabled: () => true, write: (level, _scope, message) => logs.push({ level, message }) })
    try {
      server = platformGateway({
        sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
        record: () => record,
        account: () => null,
        fetch: async () => {
          throw new Error('platform fetch must not be used')
        },
        provider: () => current,
        upstream: async url => {
          calls.push(url)
          if (url.endsWith('/count_tokens'))
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            })
          return new Response('event: message_stop\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        },
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
      const count = () =>
        fetch(base + '/v1/messages/count_tokens', {
          method: 'POST',
          headers: { 'x-api-key': 'local-secret' },
          body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
        })
      expect((await count()).status).toBe(404)
      const local = await count()
      expect(local.status).toBe(404)
      expect(await local.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error' } })
      await count()
      expect(calls).toEqual(['https://relay.example.com/anthropic/v1/messages/count_tokens'])
      expect(logs.filter(l => l.level === 'warn')).toEqual([])
      expect(logs.filter(l => l.message.includes('没有计数接口'))).toHaveLength(1)
      // 正常的消息请求不受影响
      await fetch(base + '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'local-secret' },
        body: JSON.stringify({ model: 'deepseek-chat' }),
      })
      expect(calls).toHaveLength(2)
      // 换了接口地址：重新问一次
      current = provider({ baseUrl: 'https://other.example.com/anthropic' })
      await count()
      expect(calls.at(-1)).toBe('https://other.example.com/anthropic/v1/messages/count_tokens')
    } finally {
      setLogSink(null)
    }
  })

  it('Codex + Responses 接口：Bearer 认证，网关的 /v1/responses 拼到带 /v1 的地址上', async () => {
    const record = { id: 's', engine: 'codex', model: 'gpt-5', platform: null, provider: { id: 'p2' } } as SessionRecord
    const calls: { url: string; init: RequestInit }[] = []
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => record,
      account: () => null,
      fetch: async () => {
        throw new Error('platform fetch must not be used')
      },
      provider: () =>
        provider({
          protocol: 'responses',
          baseUrl: 'https://api.openai.com/v1',
          auth: 'bearer',
          models: [{ id: 'gpt-5' }],
          smallModel: null,
          headerNames: [],
          headers: {},
        }),
      upstream: async (url, init) => {
        calls.push({ url, init })
        return new Response('data: {}\n\n')
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const res = await fetch(base + '/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret', session_id: 'abc' },
      body: JSON.stringify({ model: 'gpt-5', stream: true }),
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses')
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer sk-real-key', session_id: 'abc' })
  })
})

it('上游 input_tokens 含缓存时，平台线路和自定义 API 转发出去的都是标准口径；标准口径逐字原样（GitHub #34）', async () => {
  const sse = (input: number, read: number) =>
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: 1 } } })}\n\n` +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'
  let reply: () => Response = () => new Response('')
  let record = { id: 's', engine: 'claude', model: 'm', platform: { groupId: '2', account: 'user' } } as SessionRecord
  server = platformGateway({
    sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
    record: () => record,
    account: () => 'user',
    fetch: async () => reply(),
    upstream: async () => reply(),
    provider: () =>
      ({
        id: 'p1',
        name: 'Relay',
        protocol: 'anthropic',
        baseUrl: 'https://relay.example.com',
        auth: 'x-api-key',
        models: [{ id: 'm' }],
        modelFallback: true,
        apiKey: 'sk',
        headers: {},
      }) as unknown as ResolvedProvider,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const post = async (model: string) =>
    (
      await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer local-secret' },
        body: JSON.stringify({ model }),
      })
    ).text()
  const inputOf = (text: string) => JSON.parse(text.split('\n')[1].slice(6)).message.usage.input_tokens
  const stream = (body: string) => () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })

  // 平台线路：含缓存的模型连续两个请求认定后改成标准口径，内容事件不动
  reply = stream(sse(155_000, 154_000))
  expect(inputOf(await post('anthropic/claude-v4.1flash'))).toBe(155_000)
  const fixed = await post('anthropic/claude-v4.1flash')
  expect(inputOf(fixed)).toBe(1_000)
  expect(fixed).toContain('"text":"hi"')
  // 同一条线路的另一个模型是标准口径：逐字原样
  reply = stream(sse(120, 150_000))
  expect(await post('claude-sonnet-5')).toBe(sse(120, 150_000))
  // 非流式响应同样校正
  reply = () =>
    new Response(
      JSON.stringify({ type: 'message', usage: { input_tokens: 20_000, cache_read_input_tokens: 19_500 } }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    )
  expect(JSON.parse(await post('anthropic/claude-v4.1flash')).usage.input_tokens).toBe(500)

  // 自定义 API 单独判断
  record = { id: 's', engine: 'claude', model: 'm', platform: null, provider: { id: 'p1' } } as SessionRecord
  reply = stream(sse(50_000, 49_000))
  expect(inputOf(await post('m'))).toBe(50_000)
  expect(inputOf(await post('m'))).toBe(1_000)
})

it('压缩请求：转发时报出接通、首字、输出的 token 和结束；其它请求不报，转发内容不变', async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"summary"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":321}}\n\n'
  const reports: Array<{ record: string; report: CompactionRequestReport }> = []
  server = platformGateway({
    sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
    record: () =>
      ({
        id: 's',
        engine: 'claude',
        model: 'claude-opus-5-5',
        platform: { groupId: '2', account: 'user' },
      }) as SessionRecord,
    account: () => 'user',
    fetch: async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
    rewrite: async body => body.replace('claude-opus-5-5', 'claude-haiku-4-5'),
    compaction: (record, report) => reports.push({ record: record.id, report }),
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const post = (body: unknown) =>
    fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer local-secret' },
      body: JSON.stringify(body),
    }).then(r => r.text())
  expect(await post({ model: 'claude-opus-5-5', system: 'You are Claude Code' })).toBe(sse)
  expect(reports).toEqual([])
  const text = await post({ model: 'claude-opus-5-5', system: [{ type: 'text', text: CLAUDE_COMPACT_MARKER }] })
  expect(text).toBe(sse)
  const last = reports.at(-1)!
  expect(last.record).toBe('s')
  expect(last.report).toMatchObject({
    model: 'claude-haiku-4-5',
    requestedModel: 'claude-opus-5-5',
    status: 200,
    outputTokens: 321,
    outputExact: true,
    done: true,
    error: null,
  })
  expect(last.report.connectedAt).not.toBeNull()
  expect(last.report.firstTokenAt).not.toBeNull()
  expect(new Set(reports.map(r => r.report.requestId)).size).toBe(1)
})

describe('像素星空子智能体单独的站点（docs/ui/subagent-routing.md）', () => {
  it('子智能体的密钥按设置的站点转发：主会话走平台线路，子智能体走自定义接口的 Chat Completions', async () => {
    const record = {
      id: 's',
      engine: 'pixel',
      model: 'claude-sonnet-5-5',
      platform: { groupId: '7', account: 'a@b.c' },
      provider: null,
    } as SessionRecord
    const relay: ResolvedProvider = {
      id: 'ds',
      name: 'DeepSeek',
      template: 'custom',
      protocol: 'chat',
      baseUrl: 'https://api.deepseek.com/v1',
      auth: 'bearer',
      models: [{ id: 'deepseek-chat' }],
      smallModel: null,
      modelFallback: false,
      headerNames: [],
      createdAt: 0,
      updatedAt: 0,
      apiKey: 'sk-ds',
      headers: {},
    }
    let current: ResolvedProvider | null = relay
    const custom: string[] = []
    const platform: string[] = []
    server = platformGateway({
      sessions: new Map([
        ['s', { recordId: 's', secret: 'main-secret' }],
        [
          's#subagent',
          {
            recordId: 's',
            secret: 'sub-secret',
            target: { kind: 'custom', providerId: 'ds', model: 'deepseek-chat' },
          },
        ],
      ]),
      record: () => record,
      account: () => 'a@b.c',
      fetch: async path => {
        platform.push(path)
        return new Response('event: message_stop\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      },
      provider: id => (id === 'ds' ? current : null),
      upstream: async url => {
        custom.push(url)
        return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const post = (path: string, token: string, model: string) =>
      fetch(base + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model, max_tokens: 5 }),
      })
    expect((await post('/v1/chat/completions', 'sub-secret', 'deepseek-chat')).status).toBe(200)
    expect(custom).toEqual(['https://api.deepseek.com/v1/chat/completions'])
    expect((await post('/v1/messages', 'main-secret', 'claude-sonnet-5-5')).status).toBe(200)
    expect(platform).toEqual(['/v1/platform/messages'])
    // 子智能体的密钥不能拿来走主会话的线路（协议对不上），接口删了时 401
    expect((await post('/v1/messages', 'sub-secret', 'claude-sonnet-5-5')).status).toBe(403)
    current = null
    expect((await post('/v1/chat/completions', 'sub-secret', 'deepseek-chat')).status).toBe(401)
    expect(platform).toHaveLength(1)
  })
})

describe('平台的在途预留冲突：刚断开过请求就被拒的，等一下重发一次（docs/ui/queue-jump-balance-403.md）', () => {
  const CONFLICT = JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'insufficient balance' } })
  const conflict = () => new Response(CONFLICT, { status: 403 })
  const RETRY_LOG = '平台的在途预留还没释放，稍后重发一次'
  afterEach(() => setLogSink(null))

  it('认得出：只认 403 + 「insufficient balance」，余额真的用完（Insufficient account balance）不算', () => {
    expect(reservationConflict(403, CONFLICT)).toBe(true)
    // Responses 的错误体
    expect(reservationConflict(403, JSON.stringify({ error: { message: 'insufficient balance' } }))).toBe(true)
    expect(
      reservationConflict(
        403,
        JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'Insufficient account balance' } }),
      ),
    ).toBe(false)
    expect(reservationConflict(429, CONFLICT)).toBe(false)
    expect(reservationConflict(403, 'insufficient balance')).toBe(false)
  })

  /**
   * 起网关：上游按 queue 排好的回复依次回；没排的回一个一直在输出的流（引擎断开时报错，像真实的 fetch）。
   * interrupt() 像插队那样发一个请求再断开它，等网关记下断开
   */
  async function setup(delayMs = 10, windowMs = 5_000) {
    const logs: string[] = []
    setLogSink({ enabled: () => true, write: (_level, _scope, message) => logs.push(message) })
    const replies: Array<() => Response> = []
    let calls = 0
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () => ({ id: 's', engine: 'claude', platform: { groupId: '2', account: 'user' } }) as SessionRecord,
      account: () => 'user',
      fetch: async (_path, init) => {
        calls++
        const next = replies.shift()
        if (next) return next()
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: message_start\n\n'))
              init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      },
      reservationRetry: { windowMs, delayMs },
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1/messages'
    const post = (signal?: AbortSignal) =>
      fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer local-secret' },
        body: JSON.stringify({ model: 'claude-sonnet-5' }),
        signal,
      })
    const until = async (message: string) => {
      for (let i = 0; i < 200 && !logs.includes(message); i++) await new Promise(r => setTimeout(r, 5))
    }
    const interrupt = async () => {
      const ctl = new AbortController()
      const res = await post(ctl.signal)
      await res.body!.getReader().read()
      ctl.abort()
      await until('引擎先断开了连接')
    }
    return {
      post,
      interrupt,
      until,
      logs,
      calls: () => calls,
      queue: (...next: Array<() => Response>) => void replies.push(...next),
    }
  }

  it('插队：断开 A 后 B 被预留拒了，网关等一下重发，引擎拿到正常的回复', async () => {
    const gw = await setup()
    await gw.interrupt()
    gw.queue(conflict, () => new Response('ok'))
    const res = await gw.post()
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(gw.calls()).toBe(3)
    expect(gw.logs).toContain(RETRY_LOG)
  })

  it('最近没断开过请求：同样的 403 照常转给引擎，不重发', async () => {
    const gw = await setup()
    gw.queue(conflict)
    const res = await gw.post()
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { message: 'insufficient balance' } })
    expect(gw.calls()).toBe(1)
    expect(gw.logs).not.toContain(RETRY_LOG)
  })

  it('只重发一次：重发还被拒就照常转给引擎；别的 403 不重发、原样转发', async () => {
    const gw = await setup()
    await gw.interrupt()
    gw.queue(conflict, conflict)
    const res = await gw.post()
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { message: 'insufficient balance' } })
    expect(gw.calls()).toBe(3)

    const other = JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'forbidden' } })
    gw.queue(() => new Response(other, { status: 403 }))
    const res2 = await gw.post()
    expect(res2.status).toBe(403)
    expect(await res2.text()).toBe(other)
    expect(gw.calls()).toBe(4)
  })

  it('断开已经过了时间窗口：同样的 403 照常转给引擎，不重发', async () => {
    const gw = await setup(10, 30)
    await gw.interrupt()
    await new Promise(r => setTimeout(r, 80))
    gw.queue(conflict)
    const res = await gw.post()
    expect(res.status).toBe(403)
    expect(gw.calls()).toBe(2)
    expect(gw.logs).not.toContain(RETRY_LOG)
  })

  it('等重发时引擎断开：不再重发', async () => {
    const gw = await setup(300)
    await gw.interrupt()
    gw.queue(conflict, () => new Response('ok'))
    const ctl = new AbortController()
    const pending = gw.post(ctl.signal).catch(() => null)
    await gw.until(RETRY_LOG)
    expect(gw.logs).toContain(RETRY_LOG)
    ctl.abort()
    await pending
    await new Promise(r => setTimeout(r, 400))
    expect(gw.calls()).toBe(2)
  })
})

describe('Antigravity 的 Gemini 请求（docs/antigravity-engine.md §13）', () => {
  const start = (engine: string, upstream: (path: string, init: RequestInit) => Promise<Response>) => {
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () =>
        ({ id: 's', engine, model: 'gemini-3.8-flash', platform: { groupId: '32', account: 'user' } }) as SessionRecord,
      account: () => 'user',
      fetch: upstream,
    })
    server.listen(0, '127.0.0.1')
    return once(server, 'listening').then(() => 'http://127.0.0.1:' + (server.address() as { port: number }).port)
  }

  it('会话密钥放在 x-goog-api-key：转到云端同名接口，带分组头和 alt=sse，原样回传', async () => {
    const upstream = vi.fn(
      async (_path: string, _init: RequestInit) =>
        new Response('data: {"candidates":[]}\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    )
    const base = await start('antigravity', upstream)
    const res = await fetch(base + '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'x-goog-api-key': 'local-secret' },
      body: '{"contents":[]}',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('data: {"candidates":[]}\r\n\r\n')
    const [path, init] = upstream.mock.calls[0]!
    expect(path).toBe('/v1/platform/gemini/models/gemini-3.8-flash:streamGenerateContent?alt=sse')
    expect(new Headers(init.headers).get('X-PixelSky-Group')).toBe('32')
  })

  it('密钥不对 401、别的引擎 403、不认识的方法 404，都不转发', async () => {
    const upstream = vi.fn(async () => new Response('{}'))
    let base = await start('antigravity', upstream)
    const post = (path: string, key = 'local-secret') =>
      fetch(base + path, { method: 'POST', headers: { 'x-goog-api-key': key }, body: '{}' })
    expect((await post('/v1beta/models/gemini-3.8-flash:generateContent', 'nope')).status).toBe(401)
    expect((await post('/v1beta/models/gemini-3.8-flash:deleteAll')).status).toBe(404)
    server.close()
    base = await start('claude', upstream)
    const res = await post('/v1beta/models/gemini-3.8-flash:generateContent')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 403 } })
    expect(upstream).not.toHaveBeenCalled()
  })
})

describe('自定义 Gemini 接口给 Antigravity（docs/ui/custom-api.md §15）', () => {
  const gemini = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({
    id: 'g1',
    name: 'Studio',
    template: 'google',
    protocol: 'gemini',
    baseUrl: 'https://gemini.example.com',
    auth: 'x-api-key',
    models: [{ id: 'gemini-3.1-pro' }, { id: 'gemini-3.8-flash' }],
    smallModel: null,
    modelFallback: true,
    headerNames: [],
    createdAt: 0,
    updatedAt: 0,
    apiKey: 'AIza-real-key',
    headers: {},
    ...over,
  })
  const start = (opts: { engine?: string; provider?: ResolvedProvider | null; upstream: Fetch }) => {
    const cloud = vi.fn(async () => new Response('{}'))
    server = platformGateway({
      sessions: new Map([['s', { recordId: 's', secret: 'local-secret' }]]),
      record: () =>
        ({
          id: 's',
          engine: opts.engine ?? 'antigravity',
          model: 'gemini-3.1-pro',
          platform: null,
          provider: { id: 'g1' },
        }) as SessionRecord,
      account: () => null,
      fetch: cloud,
      provider: () => (opts.provider === undefined ? gemini() : opts.provider),
      upstream: opts.upstream,
    })
    server.listen(0, '127.0.0.1')
    return once(server, 'listening').then(() => ({
      cloud,
      post: (path: string, key = 'local-secret') =>
        fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + path, {
          method: 'POST',
          headers: { 'x-goog-api-key': key },
          body: '{"contents":[]}',
        }),
    }))
  }

  it('换上真实 Key（x-goog-api-key，不进 URL）发往接口地址，带 alt=sse、不跟随跳转，原样回传', async () => {
    const upstream = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response('data: {"candidates":[]}\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    )
    const gw = await start({ upstream })
    const res = await gw.post('/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('data: {"candidates":[]}\r\n\r\n')
    const [url, init] = upstream.mock.calls[0]!
    expect(url).toBe('https://gemini.example.com/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse')
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('AIza-real-key')
    expect(init.redirect).toBe('error')
    expect(init.body?.toString()).toBe('{"contents":[]}')
    expect(gw.cloud).not.toHaveBeenCalled()
  })

  it('接口没列的模型（-preview 改名、后台 flash-lite）都换成会话当前模型；关掉兜底原样发', async () => {
    const urls: string[] = []
    const upstream: Fetch = async url => {
      urls.push(url)
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    }
    let gw = await start({ upstream })
    await gw.post('/v1beta/models/gemini-3.1-pro-preview:generateContent')
    await gw.post('/v1beta/models/gemini-3.1-flash-lite-preview:generateContent')
    server.close()
    // 列表第一个不是会话模型：后台 lite 请求也跟会话模型走，不被换成列表第一个
    gw = await start({ upstream, provider: gemini({ models: [{ id: 'gemini-3.8-flash' }, { id: 'gemini-3.1-pro' }] }) })
    await gw.post('/v1beta/models/gemini-3.1-flash-lite-preview:generateContent')
    server.close()
    gw = await start({ upstream, provider: gemini({ modelFallback: false }) })
    await gw.post('/v1beta/models/gemini-3.1-pro-preview:generateContent')
    expect(urls).toEqual([
      'https://gemini.example.com/v1beta/models/gemini-3.1-pro:generateContent',
      'https://gemini.example.com/v1beta/models/gemini-3.1-pro:generateContent',
      'https://gemini.example.com/v1beta/models/gemini-3.1-pro:generateContent',
      'https://gemini.example.com/v1beta/models/gemini-3.1-pro-preview:generateContent',
    ])
  })

  it('接口删了 / 没 Key 401，协议不是 Gemini、引擎不是 Antigravity 403，回 Google 格式、都不转发', async () => {
    const upstream = vi.fn(async () => new Response('{}'))
    const cases: [Parameters<typeof start>[0], number][] = [
      [{ upstream, provider: null }, 401],
      [{ upstream, provider: gemini({ apiKey: null }) }, 401],
      [{ upstream, provider: gemini({ protocol: 'anthropic' }) }, 403],
      [{ upstream, engine: 'claude' }, 403],
    ]
    for (const [opts, status] of cases) {
      const gw = await start(opts)
      const res = await gw.post('/v1beta/models/gemini-3.1-pro:generateContent')
      expect(res.status).toBe(status)
      expect(await res.json()).toMatchObject({ error: { code: status } })
      server.close()
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it('连不上接口：回 502 和人话说明', async () => {
    const gw = await start({
      upstream: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      },
    })
    const res = await gw.post('/v1beta/models/gemini-3.1-pro:generateContent')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('连接被拒绝')
  })
})

describe('Codex 自动审核用的模型（docs/ui/codex-auto-review-model.md）', () => {
  const start = async (opts: {
    review: string | null
    models: string[]
    upstream: (body: { model: string }) => Response
    record?: Partial<SessionRecord>
    provider?: ResolvedProvider
  }) => {
    const record = {
      id: 'session',
      engine: 'codex',
      model: 'gpt-6.2-astra',
      platform: { groupId: '35', account: 'user' },
      ...opts.record,
    } as SessionRecord
    const sent: string[] = []
    const tracked: Array<[string, string]> = []
    const reply = async (init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string }
      sent.push(body.model)
      return opts.upstream(body)
    }
    server = platformGateway({
      sessions: new Map([['session', { recordId: 'session', secret: 's' }]]),
      record: () => record,
      account: () => 'user',
      reviewModel: () => opts.review,
      routeModels: async () => opts.models,
      requestContext: () => (id, model, chargeId) => {
        if (!chargeId) tracked.push([id, model])
      },
      provider: () => opts.provider ?? null,
      fetch: (_path, init) => reply(init),
      upstream: ((_url: string, init: RequestInit) => reply(init)) as unknown as Fetch,
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    const send = (model: string) =>
      fetch(base + '/v1/responses', {
        method: 'POST',
        headers: { Authorization: 'Bearer s' },
        body: JSON.stringify({ model, stream: true }),
      })
    return { send, sent, tracked }
  }
  const ok = () =>
    new Response('event: response.completed\ndata: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })

  it('分组里有设置的审核模型：放行；别的模型照旧 403', async () => {
    const t = await start({ review: 'codex-auto-review', models: ['gpt-6.2-astra', 'codex-auto-review'], upstream: ok })
    expect((await t.send('codex-auto-review')).status).toBe(200)
    expect((await t.send('gpt-6-luna')).status).toBe(403)
    expect(t.sent).toEqual(['codex-auto-review'])
  })

  it('没设审核模型：审核请求不是对话模型就照旧拒绝（Codex 不该再发别的模型）', async () => {
    const t = await start({ review: null, models: ['gpt-6.2-astra', 'codex-auto-review'], upstream: ok })
    expect((await t.send('codex-auto-review')).status).toBe(403)
    expect(t.sent).toEqual([])
  })

  it('分组里没有审核模型：直接换成对话模型发出去', async () => {
    const t = await start({ review: 'gpt-6-luna', models: ['gpt-6.2-astra'], upstream: ok })
    expect((await t.send('gpt-6-luna')).status).toBe(200)
    expect(t.sent).toEqual(['gpt-6.2-astra'])
  })

  it('审核模型被上游拒绝（渠道没配价格的 503）：换成对话模型、换个请求 ID 重发一次，引擎看到的是成功', async () => {
    const t = await start({
      review: 'codex-auto-review',
      models: ['gpt-6.2-astra', 'codex-auto-review'],
      upstream: body =>
        body.model === 'codex-auto-review'
          ? new Response('{"error":{"message":"Service temporarily unavailable"}}', { status: 503 })
          : ok(),
    })
    const res = await t.send('codex-auto-review')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('response.completed')
    expect(t.sent).toEqual(['codex-auto-review', 'gpt-6.2-astra'])
    expect(t.tracked.map(([, m]) => m)).toEqual(['codex-auto-review', 'gpt-6.2-astra'])
    expect(t.tracked[0][0]).not.toBe(t.tracked[1][0])
  })

  it('对话模型自己的请求被拒绝：不重发，原样交给引擎', async () => {
    const t = await start({
      review: 'codex-auto-review',
      models: ['gpt-6.2-astra', 'codex-auto-review'],
      upstream: () => new Response('{"error":{"message":"busy"}}', { status: 429 }),
    })
    expect((await t.send('gpt-6.2-astra')).status).toBe(429)
    expect(t.sent).toEqual(['gpt-6.2-astra'])
  })

  it('自定义接口：审核模型调不通时换成对话模型重发一次', async () => {
    const t = await start({
      review: 'review-model',
      models: [],
      record: { platform: null, provider: { id: 'p1' }, model: 'my-model' } as Partial<SessionRecord>,
      provider: {
        id: 'p1',
        name: 'P',
        baseUrl: 'https://example.test/v1',
        protocol: 'responses',
        apiKey: 'k',
        models: [],
      } as unknown as ResolvedProvider,
      upstream: body => (body.model === 'review-model' ? new Response('no such model', { status: 404 }) : ok()),
    })
    expect((await t.send('review-model')).status).toBe(200)
    expect(t.sent).toEqual(['review-model', 'my-model'])
  })

  it('自定义接口：审核模型已按接口的模型列表换成对话模型，那次失败不再重发（不重复扣费）', async () => {
    const t = await start({
      review: 'review-model',
      models: [],
      record: { platform: null, provider: { id: 'p1' }, model: 'my-model' } as Partial<SessionRecord>,
      provider: {
        id: 'p1',
        name: 'P',
        baseUrl: 'https://example.test/v1',
        protocol: 'responses',
        apiKey: 'k',
        modelFallback: true,
        models: [{ id: 'my-model' }],
      } as unknown as ResolvedProvider,
      upstream: () => new Response('boom', { status: 500 }),
    })
    expect((await t.send('review-model')).status).toBe(500)
    expect(t.sent).toEqual(['my-model'])
  })
})

describe('引擎的 User-Agent 原样带给上游（Codex 的 Responses、像素星空的 Chat）', () => {
  const UA = 'codex_cli_rs/0.169.0 (Windows 10.0.26300; x86_64) pixelsky'
  const run = async (record: Partial<SessionRecord>, path: string, provider?: ResolvedProvider) => {
    const seen: Headers[] = []
    const ok = () => new Response('data: {}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    server = platformGateway({
      sessions: new Map([['session', { recordId: 'session', secret: 's' }]]),
      record: () => ({ id: 'session', ...record }) as SessionRecord,
      account: () => 'user',
      provider: () => provider ?? null,
      fetch: async (_path, init) => {
        seen.push(new Headers(init.headers))
        return ok()
      },
      upstream: (async (_url: string, init: RequestInit) => {
        seen.push(new Headers(init.headers as Record<string, string>))
        return ok()
      }) as unknown as Fetch,
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer s', 'User-Agent': UA, originator: 'codex_cli_rs' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', stream: true, messages: [] }),
    })
    expect(res.status).toBe(200)
    await res.text()
    return seen
  }
  const custom = (protocol: string) =>
    ({
      id: 'p1',
      name: 'P',
      baseUrl: 'https://example.test/v1',
      protocol,
      apiKey: 'k',
      models: [],
    }) as unknown as ResolvedProvider

  it('平台线路：Codex 的 UA 和 originator 一起带给云端', async () => {
    const [h] = await run(
      { engine: 'codex', model: 'gpt-6.1-sol', platform: { groupId: '7', account: 'user' } },
      '/v1/responses',
    )
    expect(h.get('user-agent')).toBe(UA)
    expect(h.get('originator')).toBe('codex_cli_rs')
  })

  it('自定义 Responses 接口：同样带上 UA', async () => {
    const [h] = await run(
      { engine: 'codex', model: 'gpt-6.1-sol', platform: null, provider: { id: 'p1' } } as Partial<SessionRecord>,
      '/v1/responses',
      custom('responses'),
    )
    expect(h.get('user-agent')).toBe(UA)
  })

  it('自定义 Chat 接口（像素星空）：带上 UA', async () => {
    const [h] = await run(
      { engine: 'pixel', model: 'gpt-6.1-sol', platform: null, provider: { id: 'p1' } } as Partial<SessionRecord>,
      '/v1/chat/completions',
      custom('chat'),
    )
    expect(h.get('user-agent')).toBe(UA)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImInbound } from './bridge'
import { QQ_API, QQ_TOKEN_URL, QqLink, type SocketLike } from './qq'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  sent: Array<{ op: number; d: Record<string, unknown> }> = []
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.onclose?.({ code: 1000 })
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function setup(over: { token?: unknown; send?: (body: Record<string, unknown>) => Response } = {}) {
  const sockets: FakeSocket[] = []
  const posts: Array<Record<string, unknown>> = []
  const statuses: Array<[string, string | null, string | null | undefined]> = []
  const messages: ImInbound[] = []
  let now = 1_000_000
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u === QQ_TOKEN_URL) return json(over.token ?? { access_token: 'tok', expires_in: '7200' })
    if (u === `${QQ_API}/gateway`) return json({ url: 'wss://fake' })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    posts.push(body)
    return over.send ? over.send(body) : json({ id: 'x' })
  })
  const link = new QqLink({
    appId: 'a',
    appSecret: 's',
    onMessage: m => messages.push(m),
    onStatus: (status, error, detail) => statuses.push([status, error, detail]),
    fetch: fetchMock as unknown as typeof fetch,
    socket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    publicIp: async () => '1.2.3.4',
    now: () => now,
    retryBase: 1,
  })
  return { link, sockets, posts, statuses, messages, tick: (ms: number) => (now += ms), fetchMock }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 2))
  expect(check()).toBe(true)
}

async function online(s: ReturnType<typeof setup>) {
  s.link.start()
  await until(() => s.sockets.length > 0)
  const ws = s.sockets[0]
  ws.push({ op: 10, d: { heartbeat_interval: 100_000 } })
  ws.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess' } })
  return ws
}

const inbound = (ws: FakeSocket, id = 'm1') =>
  ws.push({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { id, author: { user_openid: 'u1' }, content: '你好' } })

describe('QqLink', () => {
  let active: QqLink | null = null
  afterEach(() => active?.stop())

  it('Identify 只订阅单聊，令牌带 QQBot 前缀；收到单聊消息转给上层', async () => {
    const s = setup()
    active = s.link
    const ws = await online(s)
    expect(ws.sent[0]).toEqual({ op: 2, d: { token: 'QQBot tok', intents: 1 << 25, shard: [0, 1] } })
    expect(s.statuses.at(-1)?.[0]).toBe('online')
    inbound(ws)
    expect(s.messages).toEqual([{ id: 'm1', from: 'u1', text: '你好', reply: 'm1' }])
  })

  it('其他事件不转', async () => {
    const s = setup()
    active = s.link
    const ws = await online(s)
    ws.push({ op: 0, s: 3, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'g', author: { member_openid: 'x' }, content: 'x' } })
    expect(s.messages).toEqual([])
  })

  it('被动回复带 msg_id，msg_seq 递增，4 次后试一次互动召回，再之后留到下一条', async () => {
    const s = setup()
    active = s.link
    inbound(await online(s))
    for (let i = 0; i < 4; i++) expect(await s.link.send('u1', `r${i}`)).toBe('sent')
    expect(s.posts.map(p => p.msg_seq)).toEqual([1, 2, 3, 4])
    expect(s.posts.every(p => p.msg_id === 'm1')).toBe(true)
    expect(await s.link.send('u1', 'r5')).toBe('sent')
    expect(s.posts.at(-1)).toMatchObject({ is_wakeup: true, content: 'r5' })
    expect(s.posts.at(-1)).not.toHaveProperty('msg_id')
    expect(await s.link.send('u1', 'r6')).toBe('window')
    expect(s.posts.length).toBe(5)
  })

  it('过了 60 分钟不再带 msg_id；新消息带来新额度', async () => {
    const s = setup()
    active = s.link
    const ws = await online(s)
    inbound(ws)
    s.tick(60 * 60_000 + 1)
    await s.link.send('u1', 'late')
    expect(s.posts[0]).toHaveProperty('is_wakeup', true)
    inbound(ws, 'm2')
    await s.link.send('u1', 'again')
    expect(s.posts[1]).toMatchObject({ msg_id: 'm2', msg_seq: 1 })
  })

  it('平台说过期就当过期（文档 60 分钟和 5 分钟不一致）', async () => {
    const s = setup({
      send: body =>
        body.msg_id
          ? json({ code: 40034128, message: 'expired' }, 400)
          : json({ code: 40034122, message: 'full' }, 400),
    })
    active = s.link
    inbound(await online(s))
    expect(await s.link.send('u1', 'x')).toBe('window')
    expect(s.posts.length).toBe(2)
  })

  it('其他错误抛出去', async () => {
    const s = setup({ send: () => json({ code: 500, message: '内容不允许' }, 400) })
    active = s.link
    inbound(await online(s))
    await expect(s.link.send('u1', 'x')).rejects.toThrow('内容不允许')
  })

  it('白名单错误：报原因和当前公网 IP', async () => {
    const s = setup({ token: { code: 11298, message: '接口访问源IP不在白名单' } })
    active = s.link
    s.link.start()
    await until(() => s.statuses.some(x => x[0] === 'error'))
    expect(s.statuses.at(-1)).toEqual(['error', 'qqIp', '1.2.3.4'])
  })

  it('凭据不对：报错且不重试（实测：机器人不存在时回 200 + code）', async () => {
    const s = setup({ token: { code: 10004, message: '机器人不存在' } })
    active = s.link
    s.link.start()
    await until(() => s.statuses.some(x => x[0] === 'error'))
    expect(s.statuses.at(-1)?.[1]).toBe('qqAuth')
    const calls = s.fetchMock.mock.calls.length
    await new Promise(r => setTimeout(r, 20))
    expect(s.fetchMock.mock.calls.length).toBe(calls)
  })

  it('断线重连后用 Resume 接着收', async () => {
    const s = setup()
    active = s.link
    const ws = await online(s)
    ws.close()
    await until(() => s.sockets.length > 1)
    s.sockets[1].push({ op: 10, d: { heartbeat_interval: 100_000 } })
    expect(s.sockets[1].sent[0]).toMatchObject({ op: 6, d: { session_id: 'sess', seq: 1 } })
  })

  it('stop 之后不再连', async () => {
    const s = setup()
    const ws = await online(s)
    s.link.stop()
    ws.close()
    await new Promise(r => setTimeout(r, 10))
    expect(s.sockets.length).toBe(1)
  })
})

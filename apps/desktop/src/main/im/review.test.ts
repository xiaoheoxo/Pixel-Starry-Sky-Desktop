// 审查（2026-11-05）确认的问题的回归测试
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent, SessionRecord } from '@pixelsky/protocol'
import { emptyMemory, ImBridge, ImRejected, PAIR_TTL, type BridgeMemory, type ImSender } from './bridge'
import { QQ_API, QQ_TOKEN_URL, QqLink, type SocketLike } from './qq'
import { WechatLink } from './wechat'

function setup(over: { mode?: string } = {}) {
  let memory: BridgeMemory = { ...emptyMemory(), bound: 'me' }
  const sent: string[] = []
  const box = { mode: over.mode ?? 'ask' }
  const record = (id: string) => ({ id, title: 'T', permissionMode: box.mode }) as unknown as SessionRecord
  let created = 0
  const engine = {
    create: vi.fn(() => record(`s${++created}`)),
    record: vi.fn((id: string) => record(id)),
    send: vi.fn(async () => {}),
    answer: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    reconnecting: () => false,
  }
  const sender = {
    maxChars: 100,
    send: vi.fn<ImSender['send']>(async (_to, text) => {
      sent.push(text)
      return 'sent'
    }),
  }
  const changed = vi.fn()
  const bridge = new ImBridge({
    sender,
    engine,
    projectId: () => 'p1',
    memory: () => memory,
    save: patch => {
      memory = { ...memory, ...patch }
    },
    say: key => key,
    changed,
    warn: () => {},
  })
  let id = 0
  return {
    bridge,
    engine,
    sender,
    sent,
    changed,
    box,
    memory: () => memory,
    from: (text: string) => bridge.receive({ id: `m${++id}`, from: 'me', text, reply: 'r' }),
    event: (e: EngineEvent, session?: string) => bridge.onEvent(session ?? memory.sessionId ?? 's1', e),
  }
}

const finishFailed: EngineEvent = { type: 'turn_completed', turnId: 't', outcome: 'failed', error: '额度用完' }
const failedQueue = { type: 'queue', paused: true, items: [{ id: 'q', status: 'failed', error: '额度用完' }] } as never
const approval = (requestId: string): EngineEvent =>
  ({
    type: 'approval_request',
    request: { requestId, itemId: null, kind: 'command', title: 'x', command: 'c', alwaysScopes: [] },
  }) as never

describe('消息不能悄悄丢', () => {
  it('断网时再多事件也不丢内容，恢复后发出', async () => {
    const s = setup()
    await s.from('开始')
    s.sender.send.mockRejectedValue(new Error('fetch failed'))
    await s.event(approval('req1'))
    await s.event(approval('req2'))
    for (let i = 0; i < 5; i++) await s.bridge.retry()
    expect(s.memory().outbox.length).toBe(2)
    s.sender.send.mockReset()
    s.sender.send.mockImplementation(async (_to, text) => {
      s.sent.push(text)
      return 'sent'
    })
    await s.bridge.retry()
    expect(s.memory().outbox).toEqual([])
    expect(s.sent.length).toBe(2)
  })

  it('平台拒收：换成提示告诉用户，不堵后面的；提示也被拒就丢', async () => {
    const s = setup()
    await s.from('开始')
    s.sender.send.mockRejectedValueOnce(new ImRejected('不让发网址'))
    await s.event({
      type: 'item_completed',
      item: { kind: 'assistant', id: 'a', text: 'https://x', status: 'completed' },
    } as never)
    await s.event({ type: 'turn_completed', turnId: 't', outcome: 'completed', error: null })
    expect(s.sent).toEqual(['im.chat.rejected'])
    expect(s.memory().outbox).toEqual([])

    s.sender.send.mockRejectedValue(new ImRejected('都不收'))
    await s.event(approval('req1'))
    expect(s.memory().outbox).toEqual([])
  })
})

describe('切换对话和解绑', () => {
  it('轮还没结束就开新对话：新对话的启动失败照样要说，/停止也有回应', async () => {
    const s = setup()
    await s.from('开始')
    await s.event({ type: 'turn_started', turnId: 't' })
    await s.from('/新对话')
    await s.from('第二个对话')
    s.sent.length = 0
    await s.event(failedQueue)
    expect(s.sent).toEqual(['im.chat.failed'])
    s.sent.length = 0
    await s.from('/停止')
    expect(s.sent).toEqual(['im.chat.stopped'])
  })

  it('旧对话的审批在电脑上处理后，编号也失效', async () => {
    const s = setup()
    await s.from('开始')
    const old = s.memory().sessionId!
    await s.event(approval('req1'))
    await s.from('/新对话')
    await s.event({ type: 'approval_resolved', requestId: 'req1' }, old)
    await s.from('同意 1')
    expect(s.engine.answer).not.toHaveBeenCalled()
  })

  it('一轮结束后这一轮没答的审批作废', async () => {
    const s = setup()
    await s.from('开始')
    await s.event(approval('req1'))
    await s.event({ type: 'turn_completed', turnId: 't', outcome: 'interrupted', error: null })
    await s.from('同意 1')
    expect(s.engine.answer).not.toHaveBeenCalled()
    expect(s.sent.at(-1)).toBe('im.chat.expired')
  })

  it('等补发期间解绑了：这条不再转给 AI', async () => {
    const s = setup()
    s.sender.send.mockResolvedValueOnce('window')
    await s.from('/状态')
    s.sender.send.mockImplementationOnce(async () => {
      s.bridge.unbind()
      return 'sent'
    })
    await s.from('删库')
    expect(s.engine.send).not.toHaveBeenCalled()
    expect(s.engine.create).not.toHaveBeenCalled()
  })
})

describe('其他', () => {
  it('轮失败说过一次，下一条消息时队列里的同一条不再说', async () => {
    const s = setup()
    await s.from('开始')
    await s.event({ type: 'turn_started', turnId: 't' })
    await s.event(failedQueue)
    await s.event(finishFailed)
    expect(s.sent.filter(t => t === 'im.chat.failed').length).toBe(1)
    await s.from('再来')
    await s.event(failedQueue)
    expect(s.sent.filter(t => t === 'im.chat.failed').length).toBe(1)
  })

  it('AI 自己进了计划模式：还能接着发（计划模式比询问更严）；放宽的模式不行', async () => {
    const s = setup({ mode: 'plan' })
    await s.from('继续')
    expect(s.engine.send).toHaveBeenCalledTimes(1)
    s.box.mode = 'edits'
    await s.from('继续')
    expect(s.engine.send).toHaveBeenCalledTimes(1)
    expect(s.sent.at(-1)).toBe('im.chat.modeChanged')
  })

  it('配对码到期时通知界面', () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      s.bridge.startPairing()
      s.changed.mockClear()
      vi.advanceTimersByTime(PAIR_TTL + 1000)
      expect(s.changed).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---- QQ ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  sent: Array<{ op: number; d: unknown }> = []
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

function qq(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const sockets: FakeSocket[] = []
  const statuses: Array<[string, string | null, string | null | undefined]> = []
  const link = new QqLink({
    appId: 'a',
    appSecret: 's',
    onMessage: () => {},
    onStatus: (status, error, detail) => statuses.push([status, error, detail]),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as typeof fetch,
    socket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    retryBase: 1,
  })
  return { link, sockets, statuses }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 2))
  expect(check()).toBe(true)
}

const normal = (url: string): Response =>
  url === QQ_TOKEN_URL
    ? json({ access_token: 't', expires_in: '7200' })
    : url === `${QQ_API}/gateway`
      ? json({ url: 'wss://fake' })
      : json({ id: 'x' })

describe('QQ', () => {
  let active: QqLink | null = null
  afterEach(() => active?.stop())

  it('取令牌遇到 502：是网络问题，要重试，不说凭据不对', async () => {
    let tries = 0
    const s = qq(url => {
      if (url === QQ_TOKEN_URL && ++tries === 1) return new Response('<html>bad gateway</html>', { status: 502 })
      return normal(url)
    })
    active = s.link
    s.link.start()
    await until(() => s.sockets.length > 0)
    expect(s.statuses.some(x => x[1] === 'network')).toBe(true)
    expect(s.statuses.some(x => x[1] === 'qqAuth')).toBe(false)
  })

  it('gateway 说令牌无效：换新令牌，不一直用旧的', async () => {
    let tokens = 0
    let gateways = 0
    const s = qq(url => {
      if (url === QQ_TOKEN_URL) return json({ access_token: `t${++tokens}`, expires_in: '7200' })
      if (url === `${QQ_API}/gateway` && ++gateways === 1) return json({ code: 11244 }, 401)
      return normal(url)
    })
    active = s.link
    s.link.start()
    await until(() => s.sockets.length > 0)
    expect(tokens).toBe(2)
  })

  it('还没 READY 就被断开（没开单聊权限、机器人下架）：说明原因和代码，继续重试', async () => {
    const s = qq(normal)
    active = s.link
    s.link.start()
    await until(() => s.sockets.length > 0)
    s.sockets[0].onclose?.({ code: 4014 })
    expect(s.statuses.at(-1)).toEqual(['error', 'qqClosed', '4014'])
    await until(() => s.sockets.length > 1)
  })

  it('还没 READY 时的普通断线（1006）不说成配置问题', async () => {
    const s = qq(normal)
    active = s.link
    s.link.start()
    await until(() => s.sockets.length > 0)
    s.sockets[0].onclose?.({ code: 1006 })
    expect(s.statuses.at(-1)?.[0]).toBe('connecting')
  })

  it('已经连上过的普通断线不算错误', async () => {
    const s = qq(normal)
    active = s.link
    s.link.start()
    await until(() => s.sockets.length > 0)
    s.sockets[0].push({ op: 10, d: { heartbeat_interval: 100000 } })
    s.sockets[0].push({ op: 0, s: 1, t: 'READY', d: { session_id: 'x' } })
    s.sockets[0].onclose?.({ code: 1006 })
    expect(s.statuses.at(-1)?.[0]).toBe('connecting')
  })

  it('心跳没有回应（电脑睡眠后的死连接）：断开重连，不一直显示已连接', async () => {
    const s = qq(normal)
    active = s.link
    s.link.start()
    await until(() => s.sockets.length > 0)
    s.sockets[0].push({ op: 10, d: { heartbeat_interval: 5 } })
    s.sockets[0].push({ op: 0, s: 1, t: 'READY', d: { session_id: 'x' } })
    await until(() => s.sockets.length > 1)
  })

  it('有心跳回应就不重连', async () => {
    const s = qq(normal)
    active = s.link
    s.link.start()
    await until(() => s.sockets.length > 0)
    const ws = s.sockets[0]
    const send = ws.send.bind(ws)
    ws.send = data => {
      send(data)
      if (JSON.parse(data).op === 1) ws.push({ op: 11 })
    }
    ws.push({ op: 10, d: { heartbeat_interval: 3 } })
    await new Promise(r => setTimeout(r, 30))
    expect(s.sockets.length).toBe(1)
  })

  const online = async (s: ReturnType<typeof qq>) => {
    active = s.link
    s.link.start()
    await until(() => s.sockets.length > 0)
    s.sockets[0].push({
      op: 0,
      s: 2,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', author: { user_openid: 'u' }, content: 'x' },
    })
  }

  it('发送网络失败不占额度，msg_seq 不跳', async () => {
    const seqs: unknown[] = []
    let fail = true
    const s = qq((url, init) => {
      if (!url.includes('/v2/users/')) return normal(url)
      if (fail) {
        fail = false
        throw new Error('fetch failed')
      }
      seqs.push(JSON.parse(String(init?.body)).msg_seq)
      return json({ id: 'x' })
    })
    await online(s)
    await expect(s.link.send('u', 'a')).rejects.toThrow('fetch failed')
    await s.link.send('u', 'a')
    expect(seqs).toEqual([1])
  })

  it('错误分类：内容被拒是平台拒收；401、5xx 是可以重试的', async () => {
    let response = json({ code: 304003, message: 'url not allowed' }, 400)
    const s = qq(url => (url.includes('/v2/users/') ? response : normal(url)))
    await online(s)
    await expect(s.link.send('u', 'a')).rejects.toBeInstanceOf(ImRejected)
    response = json({ code: 1 }, 500)
    await expect(s.link.send('u', 'a')).rejects.not.toBeInstanceOf(ImRejected)
    response = json({ code: 11244 }, 401)
    await expect(s.link.send('u', 'a')).rejects.not.toBeInstanceOf(ImRejected)
  })
})

describe('微信', () => {
  const wechat = (response: () => Response) =>
    new WechatLink({
      token: 't',
      baseUrl: null,
      cursor: '',
      onMessage: () => {},
      onStatus: () => {},
      onQr: () => {},
      onLogin: () => {},
      onExpired: () => {},
      onCursor: () => {},
      fetch: (async () => response()) as unknown as typeof fetch,
    })

  it('服务器回 502：不能当发送成功', async () => {
    const link = wechat(() => new Response('<html>bad gateway</html>', { status: 502 }))
    const error = await link.send('u', 'x', 'ctx').catch(e => e)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ImRejected)
  })

  it('平台返回错误码算拒收', async () => {
    const link = wechat(() => json({ ret: -2, errmsg: 'bad' }))
    await expect(link.send('u', 'x', 'ctx')).rejects.toBeInstanceOf(ImRejected)
  })
})

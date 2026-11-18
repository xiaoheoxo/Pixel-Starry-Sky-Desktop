import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEAD_AFTER,
  HANDSHAKE_TIMEOUT,
  TeamRealtime,
  parseFrame,
  teamsWsUrl,
  type RealtimeStatus,
  type RealtimeStop,
  type SocketLike,
  type TeamFrame,
} from './realtime'
import { RECOVER_MS, type WsTarget } from '../../ws-tiers'

class FakeSocket implements SocketLike {
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  closed = false
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  close(): void {
    this.closed = true
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  send(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
  drop(code = 1006): void {
    this.onclose?.({ code })
  }
}

function setup(
  token: (force: boolean) => Promise<string | null> = async () => 'tok',
  url: string | (() => string) = 'wss://cloud.example/v1/teams/ws',
) {
  const sockets: FakeSocket[] = []
  const frames: TeamFrame[] = []
  const statuses: RealtimeStatus[] = []
  const stops: RealtimeStop[] = []
  const tokens: boolean[] = []
  const rt = new TeamRealtime({
    url,
    token: force => {
      tokens.push(force)
      return token(force)
    },
    onFrame: f => frames.push(f),
    onStatus: (s, stop) => {
      statuses.push(s)
      if (stop) stops.push(stop)
    },
    socket: (url, protocols) => {
      const s = new FakeSocket(url, protocols)
      sockets.push(s)
      return s
    },
  })
  return { rt, sockets, frames, statuses, stops, tokens }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('TeamRealtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('用子协议带令牌连接，收下业务帧，tick 不往外传', async () => {
    const t = setup()
    t.rt.start()
    await flush()
    expect(t.sockets).toHaveLength(1)
    expect(t.sockets[0].url).toBe('wss://cloud.example/v1/teams/ws')
    expect(t.sockets[0].protocols).toEqual(['pixelsky.v1', 'bearer.tok'])
    expect(t.statuses).toEqual(['connecting'])
    t.sockets[0].open()
    expect(t.statuses.at(-1)).toBe('online')
    t.sockets[0].send({ type: 'tick' })
    t.sockets[0].send({ type: 'hello', online: { tm_1: ['u:1'] } })
    t.sockets[0].send({ type: 'presence', team: 'tm_1', user: 'u:2', online: true })
    t.sockets[0].send({ type: 'invites' })
    t.sockets[0].send({ type: 'removed', team: 'tm_1' })
    t.sockets[0].send({ type: 'team', team: 'tm_1', seq: 3 })
    t.sockets[0].send({ type: '未知' })
    t.sockets[0].send('不是 JSON')
    expect(t.frames.map(f => f.type)).toEqual(['hello', 'presence', 'invites', 'removed', 'team'])
    t.rt.stop()
  })

  it('断线按 1s → 2s → 4s 退避重连，连上稳定 10 秒后清零', async () => {
    const t = setup()
    t.rt.start()
    await flush()
    t.sockets[0].open()
    t.sockets[0].drop()
    expect(t.statuses.at(-1)).toBe('offline')
    await vi.advanceTimersByTimeAsync(999)
    expect(t.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(t.sockets).toHaveLength(2)
    // 没连上就又断：等 2 秒
    t.sockets[1].drop()
    await vi.advanceTimersByTimeAsync(1999)
    expect(t.sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2)
    expect(t.sockets).toHaveLength(3)
    // 连上并稳定 10 秒：退避清零
    t.sockets[2].open()
    await vi.advanceTimersByTimeAsync(10_001)
    t.sockets[2].drop()
    await vi.advanceTimersByTimeAsync(1001)
    expect(t.sockets).toHaveLength(4)
    t.rt.stop()
  })

  it('60 秒什么都没收到：当作连接已死，马上重连', async () => {
    const t = setup()
    t.rt.start()
    await flush()
    t.sockets[0].open()
    await vi.advanceTimersByTimeAsync(DEAD_AFTER - 1000)
    t.sockets[0].send({ type: 'tick' })
    await vi.advanceTimersByTimeAsync(DEAD_AFTER - 1000)
    expect(t.sockets[0].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(DEAD_AFTER)
    expect(t.sockets[0].closed).toBe(true)
    expect(t.statuses).toContain('offline')
    await vi.advanceTimersByTimeAsync(1100)
    // 新连接一直没握手完时还会按握手超时继续重试，这里只看重连过
    expect(t.sockets.length).toBeGreaterThanOrEqual(2)
    t.rt.stop()
  })

  it('地址给函数时每次连接都重新取：线路换了，重连就用新的', async () => {
    let base = 'wss://cdn.example'
    const t = setup(undefined, () => base + '/v1/teams/ws')
    t.rt.start()
    await flush()
    expect(t.sockets[0].url).toBe('wss://cdn.example/v1/teams/ws')
    base = 'wss://direct.example'
    t.sockets[0].drop()
    await vi.advanceTimersByTimeAsync(1500)
    expect(t.sockets.at(-1)!.url).toBe('wss://direct.example/v1/teams/ws')
    t.rt.stop()
  })

  it('4001：换一个新令牌马上重连', async () => {
    const t = setup()
    t.rt.start()
    await flush()
    t.sockets[0].open()
    t.sockets[0].drop(4001)
    await flush()
    expect(t.sockets).toHaveLength(2)
    expect(t.tokens).toEqual([false, true])
    expect(t.statuses.at(-1)).toBe('connecting')
    t.rt.stop()
  })

  it('4010（执行机台数超过席位）：停下不再重连，带上原因；start 才再连', async () => {
    const t = setup()
    t.rt.start()
    await flush()
    t.sockets[0].open()
    t.sockets[0].drop(4010)
    expect(t.statuses.at(-1)).toBe('offline')
    expect(t.stops).toEqual(['seats'])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(t.sockets).toHaveLength(1)
    t.rt.start()
    await flush()
    expect(t.sockets).toHaveLength(2)
    t.rt.stop()
  })

  it('没登录（拿不到令牌）：不连，稍后再试', async () => {
    let token: string | null = null
    const t = setup(async () => token)
    t.rt.start()
    await flush()
    expect(t.sockets).toHaveLength(0)
    expect(t.statuses.at(-1)).toBe('offline')
    token = 'later'
    await vi.advanceTimersByTimeAsync(1100)
    await flush()
    expect(t.sockets).toHaveLength(1)
    expect(t.sockets[0].protocols[1]).toBe('bearer.later')
    t.rt.stop()
  })

  it('stop 后不再重连；restart 马上重连', async () => {
    const t = setup()
    t.rt.start()
    await flush()
    t.sockets[0].open()
    t.rt.stop()
    expect(t.sockets[0].closed).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.sockets).toHaveLength(1)
    t.rt.restart()
    await flush()
    expect(t.sockets).toHaveLength(2)
    t.rt.stop()
  })

  it('等令牌期间 stop 又 start：只连一条，旧的那次作废', async () => {
    const pending: ((t: string) => void)[] = []
    const t = setup(() => new Promise<string>(resolve => pending.push(resolve)))
    t.rt.start()
    t.rt.stop()
    t.rt.start()
    expect(pending).toHaveLength(2)
    // 新的那次先拿到令牌，旧的后到
    pending[1]('new')
    await flush()
    pending[0]('old')
    await flush()
    expect(t.sockets).toHaveLength(1)
    expect(t.sockets[0].protocols[1]).toBe('bearer.new')
    t.sockets[0].open()
    t.sockets[0].send({ type: 'invites' })
    expect(t.frames).toHaveLength(1)
    t.rt.stop()
  })

  it('restart 换掉的旧连接：迟到的帧不往外传', async () => {
    const t = setup()
    t.rt.start()
    await flush()
    const old = t.sockets[0]
    const onmessage = old.onmessage
    old.open()
    t.rt.restart()
    await flush()
    expect(old.closed).toBe(true)
    expect(t.sockets).toHaveLength(2)
    onmessage?.({ data: JSON.stringify({ type: 'invites' }) })
    expect(t.frames).toHaveLength(0)
    t.rt.stop()
  })

  it('teamsWsUrl：登录服务的地址换成 ws，去掉结尾的斜杠', () => {
    expect(teamsWsUrl('https://cloud.example/')).toBe('wss://cloud.example/v1/teams/ws')
    expect(teamsWsUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/v1/teams/ws')
  })

  it('parseFrame 逐字段防御', () => {
    expect(parseFrame(null)).toBeNull()
    expect(parseFrame({ type: 'message', team: 'tm_1', channel: 'tc_1', message: { id: 'tg_1', n: 1 } })).toMatchObject(
      {
        type: 'message',
        channel: 'tc_1',
      },
    )
    expect(parseFrame({ type: 'message', team: 'tm_1' })).toBeNull()
    expect(parseFrame({ type: 'hello', online: { a: ['u:1', 5] } })).toEqual({ type: 'hello', online: { a: ['u:1'] } })
  })
})

describe('TeamRealtime 候选线路', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const tiers: WsTarget[] = [
    { tier: 'cdn', url: 'wss://cdn.example/v1/teams/ws' },
    { tier: 'direct', url: 'wss://direct.example/v1/teams/ws' },
    { tier: 'ip', url: 'wss://direct.example/v1/teams/ws', ip: '192.0.2.1' },
  ]
  const tierSetup = () => {
    const sockets: { s: FakeSocket; target: WsTarget }[] = []
    const statuses: RealtimeStatus[] = []
    const logs: string[] = []
    const probe = vi.fn(async (_t: WsTarget): Promise<number | null> => 426)
    const rt = new TeamRealtime({
      targets: () => tiers,
      token: async () => 'tok',
      onFrame: () => {},
      onStatus: s => statuses.push(s),
      log: message => logs.push(message),
      probe: t => probe(t),
      socket: (url, protocols, target) => {
        const s = new FakeSocket(url, protocols)
        sockets.push({ s, target })
        return s
      },
    })
    return { rt, sockets, statuses, logs, probe }
  }

  it('握手没成功马上换下一档；4010 没连上也照样停下不重连', async () => {
    const t = tierSetup()
    t.rt.start()
    await flush()
    t.sockets[0].s.drop(1006)
    await flush()
    expect(t.sockets.map(x => x.target.tier)).toEqual(['cdn', 'direct'])
    expect(t.statuses).not.toContain('offline')
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT)
    expect(t.sockets.map(x => x.target.tier)).toEqual(['cdn', 'direct', 'ip'])
    t.sockets[2].s.drop(4010)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.sockets).toHaveLength(3)
    expect(t.statuses.at(-1)).toBe('offline')
  })

  it('连在直连上：CDN 恢复（101）后切回 CDN', async () => {
    const t = tierSetup()
    t.rt.start()
    await flush()
    t.sockets[0].s.drop(1006)
    await flush()
    t.sockets[1].s.open()
    // 云端每 20 秒一个 tick，不然 60 秒没消息会被当成死连接
    const alive = async (ms: number): Promise<void> => {
      for (let left = ms; left > 0; left -= 20_000) {
        await vi.advanceTimersByTimeAsync(Math.min(20_000, left))
        t.sockets[1].s.send({ type: 'tick' })
      }
    }
    await alive(RECOVER_MS)
    expect(t.sockets[1].s.closed).toBe(false)
    t.probe.mockImplementation(async x => (x.tier === 'cdn' ? 101 : 426))
    await alive(RECOVER_MS)
    await flush()
    expect(t.sockets[1].s.closed).toBe(true)
    expect(t.sockets.at(-1)?.target.tier).toBe('cdn')
    expect(t.logs).toContain('团队实时通道换回更好的线路')
    t.rt.stop()
  })
})

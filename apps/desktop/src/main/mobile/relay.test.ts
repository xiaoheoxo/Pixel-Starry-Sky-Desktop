import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HANDSHAKE_TIMEOUT, RelayLink, logFailure, relayHost, relayUrl, type RelayNotice } from './relay'
import { RECOVER_MS, type WsTarget } from '../core/ws-tiers'

class FakeSocket {
  readyState = 1
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason?: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  send(): void {}
  text(data: string): void {
    this.onmessage?.({ data })
  }
}

function setup(url: string | WsTarget[] = 'wss://relay.example/v1/bridge/ws', failFirst = false) {
  const sockets: FakeSocket[] = [],
    statuses: string[] = [],
    notices: RelayNotice[] = [],
    logs: { level: string; message: string; fields: Record<string, unknown> }[] = [],
    urls: string[] = []
  let attempts = 0
  // 问状态码默认都回 426；测试里可以换
  const probe = vi.fn(async (_t: WsTarget): Promise<number | null> => 426)
  const link = new RelayLink({
    targets: () => (typeof url === 'string' ? [{ tier: 'only', url }] : url),
    desktopId: 'desk-1',
    onFrame: () => {},
    onNotice: n => notices.push(n),
    onStatus: s => statuses.push(s),
    token: async () => 'token',
    log: (level, message, fields) => logs.push({ level, message, fields }),
    probe: t => probe(t),
    socket: u => {
      urls.push(u)
      // 和 new WebSocket 一样同步抛 SyntaxError
      if (failFirst && attempts++ === 0) throw new SyntaxError('bad url')
      const s = new FakeSocket()
      sockets.push(s)
      return s as unknown as WebSocket
    },
  })
  return { link, sockets, statuses, notices, logs, urls, probe }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('RelayLink heartbeat', () => {
  it('收到过 tick 后 60 秒没有消息：不等 onclose，直接断开重连；tick 不当作通知', async () => {
    const { link, sockets, statuses, notices } = setup()
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].onopen?.()
    sockets[0].text('{"type":"tick"}')
    sockets[0].text('{"type":"phone_joined","phone":"p1"}')
    expect(notices).toEqual([{ type: 'phone_joined', phone: 'p1' }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sockets[0].closed).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(sockets[0].closed).toBe(true)
    expect(statuses.at(-1)).toBe('error')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sockets).toHaveLength(2)
    link.stop()
  })

  it('老版本云端不发 tick：不按心跳断开', async () => {
    const { link, sockets } = setup()
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].onopen?.()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sockets[0].closed).toBe(false)
    link.stop()
  })
})

describe('RelayLink 地址', () => {
  it('带 # 片段的中转地址：报地址不对，不去连', async () => {
    expect(() => relayUrl('wss://relay.example/ws#x', 'd')).toThrow('MOBILE_BAD_RELAY')
    expect(() => relayUrl('wss://relay.example/ws#', 'd')).toThrow('MOBILE_BAD_RELAY')
    const { link, sockets, statuses } = setup('wss://relay.example/ws#x')
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(0)
    expect(statuses.at(-1)).toBe('error')
    link.stop()
  })

  it('建连接时同步抛错：当作没连上，按退避重试', async () => {
    const { link, sockets, statuses } = setup(undefined, true)
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(0)
    expect(statuses.at(-1)).toBe('error')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sockets).toHaveLength(1)
    link.stop()
  })
})

describe('RelayLink 日志', () => {
  it('地址只留主机和路径，不带电脑 ID', () => {
    expect(relayHost('wss://relay.example/v1/bridge/ws?role=desktop&id=desk-1')).toBe(
      'wss://relay.example/v1/bridge/ws',
    )
    expect(relayHost('nope')).toBe('(地址不对)')
  })

  it('一直连不上：前 3 次、每 10 次、原因变了才记', () => {
    expect([1, 2, 3, 4, 9, 10, 11, 20].map(n => logFailure(n, false))).toEqual([
      true,
      true,
      true,
      false,
      false,
      true,
      false,
      true,
    ])
    expect(logFailure(7, true)).toBe(true)
  })

  it('握手没成功：记下关闭码和 HTTP 状态码；连上后记一条并清零', async () => {
    const { link, sockets, logs } = setup()
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)
    const fail = logs.find(l => l.message === '手机中转连不上')
    expect(fail?.fields).toMatchObject({
      relay: 'wss://relay.example/v1/bridge/ws',
      stage: 'handshake',
      code: 1006,
      httpStatus: 426,
      attempt: 1,
    })
    await vi.advanceTimersByTimeAsync(2_000)
    sockets[1].onopen?.()
    expect(logs.at(-1)).toMatchObject({ message: '手机中转已连上', fields: { afterFailures: 1 } })
    sockets[1].onclose?.({ code: 1001, reason: 'going away' })
    await vi.advanceTimersByTimeAsync(0)
    expect(logs.at(-1)?.fields).toMatchObject({ stage: 'closed', code: 1001, reason: 'going away', attempt: 1 })
    expect(logs.at(-1)?.fields).not.toHaveProperty('httpStatus')
    link.stop()
    expect(logs.at(-1)?.message).toBe('手机中转停止')
  })
})

describe('RelayLink 候选线路', () => {
  const tiers: WsTarget[] = [
    { tier: 'cdn', url: 'wss://cdn.example/v1/bridge/ws' },
    { tier: 'direct', url: 'wss://direct.example/v1/bridge/ws' },
    { tier: 'ip', url: 'wss://direct.example/v1/bridge/ws', ip: '192.0.2.1' },
  ]

  it('握手没成功马上换下一档，不等退避；断开后从连上的那档重连', async () => {
    const { link, sockets, urls, statuses, logs } = setup(tiers)
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(urls[0]).toMatch(/^wss:\/\/cdn\.example\/v1\/bridge\/ws\?role=desktop/)
    sockets[0].onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)
    expect(urls[1]).toMatch(/^wss:\/\/direct\.example/)
    expect(statuses).not.toContain('error')
    expect(logs.find(l => l.message === '手机中转换线路')?.fields).toMatchObject({
      tier: 'cdn',
      to: 'direct',
      httpStatus: 426,
    })
    sockets[1].onopen?.()
    expect(statuses.at(-1)).toBe('online')
    // 断开后重连从连上的那档（直连）开始，不再先试 CDN
    sockets[1].onclose?.({ code: 1001 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(urls[2]).toMatch(/^wss:\/\/direct\.example/)
    link.stop()
  })

  it('连在后面的档：每 5 分钟看前面的档，恢复了（101）就断开、切回去', async () => {
    const { link, sockets, urls, probe, logs } = setup(tiers)
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)
    sockets[1].onopen?.()
    await vi.advanceTimersByTimeAsync(RECOVER_MS)
    expect(sockets[1].closed).toBe(false)
    probe.mockImplementation(async t => (t.tier === 'cdn' ? 101 : 426))
    await vi.advanceTimersByTimeAsync(RECOVER_MS)
    expect(sockets[1].closed).toBe(true)
    expect(urls.at(-1)).toMatch(/^wss:\/\/cdn\.example/)
    expect(logs.some(l => l.message === '手机中转换回更好的线路' && l.fields.to === 'cdn')).toBe(true)
    // 连在第一档：不再检查
    sockets.at(-1)!.onopen?.()
    probe.mockClear()
    await vi.advanceTimersByTimeAsync(2 * RECOVER_MS)
    expect(probe).not.toHaveBeenCalled()
    link.stop()
  })

  it('一直没握手完：超时当作这一档失败；三档都不行才报错、按退避重试', async () => {
    const { link, sockets, statuses } = setup(tiers)
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT)
    expect(sockets[1].closed).toBe(true)
    expect(sockets).toHaveLength(3)
    sockets[2].onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses.at(-1)).toBe('error')
    expect(sockets).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sockets).toHaveLength(4)
    link.stop()
  })

  it('连上之后断开不换档，按原来的退避重连同一档', async () => {
    const { link, sockets, urls } = setup(tiers)
    link.start()
    await vi.advanceTimersByTimeAsync(0)
    sockets[0].onopen?.()
    sockets[0].onclose?.({ code: 1001 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(urls).toHaveLength(2)
    expect(urls[1]).toMatch(/^wss:\/\/cdn\.example/)
    link.stop()
  })
})

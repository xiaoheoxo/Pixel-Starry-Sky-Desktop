import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FrameType,
  LINK_VERSION,
  PROLOGUE,
  Responder,
  decodeFrame,
  encodeFrame,
  encodeJson,
  generateKeypair,
  toBase64Url,
} from '@pixelsky/link'
import { DesktopLink, unbatch, type LinkState } from './link'
import type { Pairing } from './storage'

vi.mock('@/platform', () => ({ inApp: false }))

class FakeSocket {
  static OPEN = 1
  static CLOSED = 3
  static all: FakeSocket[] = []
  readyState = FakeSocket.OPEN
  binaryType = ''
  sent: Uint8Array[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  constructor() {
    FakeSocket.all.push(this)
  }
  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  close(code = 1000): void {
    if (this.readyState === FakeSocket.CLOSED) return
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code })
  }
  text(data: string): void {
    this.onmessage?.({ data })
  }
  result(body: object): void {
    const frame = encodeFrame(FrameType.PairResult, encodeJson(body))
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) })
  }
  frame(type: (typeof FrameType)[keyof typeof FrameType], body: Uint8Array): void {
    const frame = encodeFrame(type, body)
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) })
  }
  types(): number[] {
    return this.sent.map(f => decodeFrame(f).type)
  }
}

const pairing = (status: Pairing['status'] = 'paired'): Pairing => ({
  deviceId: 'phone-1',
  token: 'token',
  desktopId: 'desk-1',
  desktopName: '电脑',
  desktopKey: toBase64Url(generateKeypair().publicKey),
  fingerprint: 'fp',
  phoneKey: toBase64Url(generateKeypair().privateKey),
  pairedAt: 1,
  status,
  ...(status === 'pending' ? { request: { v: LINK_VERSION } as unknown as Pairing['request'] } : {}),
})

function setup(status: Pairing['status'] = 'paired') {
  const states: LinkState[] = [],
    saved: Pairing[] = []
  const link = new DesktopLink(pairing(status), {
    onState: s => states.push(s),
    onEvent: () => {},
    onPairing: p => saved.push(p),
  })
  link.start()
  const ws = FakeSocket.all.at(-1)!
  ws.onopen?.()
  return { link, ws, states, saved }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.all = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DesktopLink', () => {
  it('明文的 rejected 不会让已配好的电脑变成「已移除」', () => {
    const { link, ws, saved } = setup()
    ws.text('{"type":"desktop_online"}')
    expect(link.state).toBe('handshaking')
    ws.result({ status: 'rejected' })
    expect(link.state).toBe('handshaking')
    expect(saved).toEqual([])
    link.stop()
  })

  it('还在等确认时 rejected 就是电脑上点了拒绝', () => {
    const { link, ws } = setup('pending')
    ws.result({ status: 'rejected' })
    expect(link.state).toBe('removed')
    expect(link.pairing.status).toBe('removed')
  })

  it('电脑不认识这部手机：提示并过一会儿再握手，不删配对', () => {
    const { link, ws } = setup()
    ws.text('{"type":"desktop_online"}')
    ws.result({ status: 'unknown' })
    expect(link.state).toBe('unrecognized')
    expect(link.pairing.status).toBe('paired')
    vi.advanceTimersByTime(60_000)
    expect(link.state).toBe('handshaking')
    expect(ws.types().filter(t => t === FrameType.Handshake1)).toHaveLength(2)
    link.stop()
  })

  it('握手失败且电脑的连接协议版本不同：显示版本不一致', () => {
    const { link, ws } = setup()
    ws.text('{"type":"desktop_online"}')
    ws.result({ status: 'handshake_failed', v: LINK_VERSION + 1 })
    expect(link.state).toBe('incompatible')
    link.stop()
  })

  it('握手 10 秒没回音：断开按退避重连', () => {
    const { link, ws } = setup()
    ws.text('{"type":"desktop_online"}')
    vi.advanceTimersByTime(10_000)
    expect(ws.readyState).toBe(FakeSocket.CLOSED)
    expect(link.state).toBe('offline')
    vi.advanceTimersByTime(2_000)
    expect(FakeSocket.all).toHaveLength(2)
    link.stop()
  })

  it('收到过心跳后 60 秒什么都没收到：当作断开，不等 onclose', () => {
    const { link, ws } = setup()
    ws.text('{"type":"tick"}')
    vi.advanceTimersByTime(45_000)
    expect(link.state).toBe('connecting')
    ws.text('{"type":"tick"}')
    vi.advanceTimersByTime(45_000)
    expect(link.state).toBe('connecting')
    vi.advanceTimersByTime(30_000)
    expect(link.state).toBe('offline')
    link.stop()
  })

  it('没收到过心跳（老版本云端）不按心跳判断', () => {
    const { link } = setup()
    vi.advanceTimersByTime(300_000)
    expect(link.state).toBe('connecting')
    link.stop()
  })

  it('电脑下线：排着的重试握手作废，不再去握手', () => {
    const { link, ws } = setup()
    ws.text('{"type":"desktop_online"}')
    ws.result({ status: 'unavailable' })
    ws.text('{"type":"desktop_offline"}')
    expect(link.state).toBe('desktop_offline')
    vi.advanceTimersByTime(60_000)
    expect(link.state).toBe('desktop_offline')
    expect(ws.types().filter(t => t === FrameType.Handshake1)).toHaveLength(1)
    link.stop()
  })

  it('电脑下线：握手超时也作废，不断开重连', () => {
    const { link, ws, states } = setup()
    ws.text('{"type":"desktop_online"}')
    ws.text('{"type":"desktop_offline"}')
    vi.advanceTimersByTime(30_000)
    expect(ws.readyState).toBe(FakeSocket.OPEN)
    expect(link.state).toBe('desktop_offline')
    expect(states).not.toContain('offline')
    link.stop()
  })

  it('握手后 hello 还没回就重新握手：旧 rpc 的失败不关掉正在新握手的连接', async () => {
    const desktop = generateKeypair(),
      phone = generateKeypair()
    const link = new DesktopLink(
      {
        ...pairing(),
        desktopKey: toBase64Url(desktop.publicKey),
        phoneKey: toBase64Url(phone.privateKey),
      },
      { onState: () => {}, onEvent: () => {}, onPairing: () => {} },
    )
    link.start()
    const ws = FakeSocket.all.at(-1)!
    ws.text('{"type":"desktop_online"}')
    const responder = new Responder({ local: desktop, remote: phone.publicKey, prologue: PROLOGUE })
    responder.readMessage1(decodeFrame(ws.sent.at(-1)!).body)
    ws.frame(FrameType.Handshake2, responder.writeMessage2().message)
    // hello 还在等回音时电脑重新上线：重新握手，旧 rpc 被关掉、hello 失败
    ws.text('{"type":"desktop_online"}')
    await vi.advanceTimersByTimeAsync(0)
    expect(ws.readyState).toBe(FakeSocket.OPEN)
    expect(link.state).toBe('handshaking')
    link.stop()
  })

  it('云端 4001 关连接才算被移除', () => {
    const { link, ws } = setup()
    ws.close(4001)
    expect(link.state).toBe('removed')
    expect(link.pairing.status).toBe('removed')
  })
})

describe('unbatch', () => {
  it('电脑打包成一帧的多个事件按顺序拆开，别的原样', () => {
    const a = { kind: 'session', seq: 2 },
      b = { kind: 'session', seq: 3 }
    expect(unbatch({ kind: 'batch', events: [a, b] })).toEqual([a, b])
    expect(unbatch(a)).toEqual([a])
    expect(unbatch({ kind: 'batch' })).toEqual([{ kind: 'batch' }])
    expect(unbatch(null)).toEqual([null])
  })
})

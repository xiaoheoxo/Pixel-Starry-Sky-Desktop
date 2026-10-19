// 到一台电脑的连接（docs/mobile-remote.md §13.3）：连云端中转 → （没配对完时）发配对请求 → Noise 握手 → 加密通道 + RPC。
// 网页版和中转同源：中转地址取当前页面的地址（线上是云端服务的 /m/，本机开发由 Vite 转给本机云端）。
import {
  FrameType,
  Initiator,
  LINK_VERSION,
  PROLOGUE,
  RpcCore,
  SecureChannel,
  bridgeProtocols,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  fromBase64Url,
  keypairFrom,
  type HandshakeResult,
} from '@pixelsky/link'
import { inApp } from '@/platform'
import { browserCodec } from './codec'
import type { Pairing } from './storage'

export type LinkState =
  /** 正在连中转 */
  | 'connecting'
  /** 中转连上了，电脑不在线（关机、睡眠、没开手机连接） */
  | 'desktop_offline'
  /** 扫码后等电脑上确认 */
  | 'waiting_confirm'
  | 'handshaking'
  | 'ready'
  /** 被电脑移除，或令牌作废：不再重连，要重新扫码 */
  | 'removed'
  /** 电脑说没有这部手机的配对（可能已移除或电脑重装）；结果帧不可信，不删配对，过一会儿再试 */
  | 'unrecognized'
  /** 电脑版和手机版的连接协议版本不一致，要更新其中一边 */
  | 'incompatible'
  /** 连不上中转（没网），稍后自动重试 */
  | 'offline'

export interface Hello {
  version: number
  name: string
  access: 'view' | 'act'
  /** 电脑能给手机用 Git / 文件 / 产物 / 任务工具、加项目（docs/mobile-remote.md §18.4）；旧版电脑没有 */
  tools?: boolean
  /** 电脑认得队列调序的 { before: 消息 id | null }；旧版电脑把它当成第 0 位，手机要退回数字下标 */
  queueMoveBefore?: boolean
}

export interface LinkHooks {
  onState(state: LinkState): void
  /** 电脑推来的事件（engine:event 的内容） */
  onEvent(event: unknown): void
  /** 配对状态变了（确认 / 移除），要存下来 */
  onPairing(pairing: Pairing): void
}

/** 握手时告诉电脑：能拆开打包成一帧的多个事件（旧版电脑不认，照旧一条一帧） */
const HELLO = { batch: true }

/** 电脑把流式增量打包成一帧发来的样子（apps/desktop/src/main/mobile/gateway.ts 的 flush） */
export function unbatch(data: unknown): unknown[] {
  const batch = data as { kind?: unknown; events?: unknown } | null
  return batch?.kind === 'batch' && Array.isArray(batch.events) ? batch.events : [data]
}

/** 中转关闭码（services/cloud/internal/bridge）：令牌失效 */
const CLOSE_UNAUTHORIZED = 4001
/** 发出握手后这么久还没到 ready：断开重连 */
const HANDSHAKE_TIMEOUT = 10_000
/** 电脑暂时不能握手 / 握手失败后多久再试 */
const RETRY_SOON = 10_000
/** 电脑说不认识这部手机后多久再试（真被移除时云端会 4001） */
const RETRY_LATER = 60_000
/** 云端每 20 秒发一条文本心跳 tick；收到过之后这么久什么都没收到，就当连接已经死了 */
const DEAD_AFTER = 60_000

/** 网页版：和页面同源；App 里：配对时二维码给的中转地址 */
export function relayUrl(pairing: Pairing): string {
  if (inApp && pairing.relay) {
    const url = new URL(pairing.relay)
    url.searchParams.set('role', 'phone')
    return url.toString()
  }
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/v1/bridge/ws?role=phone'
}

export class DesktopLink {
  state: LinkState = 'connecting'
  hello: Hello | null = null
  private ws: WebSocket | null = null
  private rpc: RpcCore | null = null
  private channel: SecureChannel | null = null
  private initiator: Initiator | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 握手超时、稍后重试握手：换连接、停止、到 ready 时清掉 */
  private guard: ReturnType<typeof setTimeout> | null = null
  private delay = 1000
  private stopped = true

  constructor(
    public pairing: Pairing,
    private readonly hooks: LinkHooks,
  ) {}

  start(): void {
    if (!this.stopped || this.pairing.status === 'removed') return
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.unguard()
    this.reset()
    this.ws?.close()
    this.ws = null
  }

  /** 页面回到前台：连接可能早被系统断了，没连着就马上重连，连着就探一下 */
  wake(): void {
    if (this.stopped) return
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      if (this.timer) clearTimeout(this.timer)
      this.delay = 1000
      this.open()
    } else if (this.state === 'ready') this.call('hello', HELLO).catch(() => this.ws?.close())
  }

  /** 页面切到后台 / 回到前台：告诉电脑，后台时它照样推送提醒（旧版电脑不认，不管报错） */
  away(hidden: boolean): void {
    if (this.state === 'ready') this.call('away', hidden).catch(() => undefined)
  }

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.rpc || this.state !== 'ready') return Promise.reject(new Error('MOBILE_NOT_READY'))
    return this.rpc.call<T>(method, args, 20_000)
  }

  private unguard(): void {
    if (this.guard) clearTimeout(this.guard)
    this.guard = null
  }

  /** 在当前连接上过一会儿重新握手（连接换了就作废） */
  private retryHandshake(ms: number): void {
    this.unguard()
    const ws = this.ws
    this.guard = setTimeout(() => {
      this.guard = null
      if (this.ws === ws && !this.stopped) this.handshake()
    }, ms)
  }

  private set(state: LinkState): void {
    if (this.state === state) return
    this.state = state
    this.hooks.onState(state)
  }

  private reset(): void {
    this.rpc?.close()
    this.rpc = null
    this.channel = null
    this.initiator = null
    this.hello = null
  }

  private open(): void {
    this.unguard()
    this.reset()
    this.set('connecting')
    const ws = new WebSocket(relayUrl(this.pairing), bridgeProtocols(this.pairing.token))
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    // 老版本云端不发 tick：没收到过就不判断。后台被挂起回来时也靠它发现连接早断了
    let lastSeen = 0
    const watchdog = setInterval(() => {
      if (this.ws !== ws) return clearInterval(watchdog)
      if (lastSeen && Date.now() - lastSeen > DEAD_AFTER) this.lost(ws, 0)
    }, DEAD_AFTER / 4)
    ws.onopen = () => (this.delay = 1000)
    ws.onmessage = e => {
      if (this.ws !== ws) return
      if (lastSeen) lastSeen = Date.now()
      if (typeof e.data === 'string') {
        if (e.data === '{"type":"tick"}') lastSeen = Date.now()
        else this.onNotice(e.data)
      } else this.onFrame(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = e => {
      clearInterval(watchdog)
      this.lost(ws, e.code)
    }
  }

  /** 连接断了（或心跳超时当作断了；死连接上 close 可能很久才回调，不等它） */
  private lost(ws: WebSocket, code: number): void {
    if (this.ws !== ws) return
    this.ws = null
    ws.close()
    this.unguard()
    this.reset()
    if (code === CLOSE_UNAUTHORIZED) return this.removed()
    if (this.stopped) return
    this.set('offline')
    this.timer = setTimeout(() => this.open(), this.delay * (0.8 + Math.random() * 0.4))
    this.delay = Math.min(30_000, this.delay * 2)
  }

  private removed(): void {
    this.stopped = true
    this.reset()
    this.ws?.close()
    this.pairing = { ...this.pairing, status: 'removed' }
    this.hooks.onPairing(this.pairing)
    this.set('removed')
  }

  private send(type: (typeof FrameType)[keyof typeof FrameType], body: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(type, body) as Uint8Array<ArrayBuffer>)
  }

  private onNotice(text: string): void {
    let type = ''
    try {
      type = JSON.parse(text).type
    } catch {}
    if (type === 'desktop_offline') {
      this.reset()
      this.set('desktop_offline')
    } else if (type === 'desktop_online') {
      // 电脑（重新）上线：它那边的加密会话没了，重新握手；还没确认的再发一次配对请求
      if (this.pairing.status === 'pending') this.sendPair()
      else this.handshake()
    }
  }

  private sendPair(): void {
    if (!this.pairing.request) return
    this.send(FrameType.Pair, encodeJson(this.pairing.request))
    this.set('waiting_confirm')
  }

  private handshake(): void {
    this.reset()
    this.initiator = new Initiator({
      local: keypairFrom(fromBase64Url(this.pairing.phoneKey)),
      remote: fromBase64Url(this.pairing.desktopKey),
      prologue: PROLOGUE,
    })
    this.send(FrameType.Handshake1, this.initiator.writeMessage1())
    this.set('handshaking')
    // 电脑没回（丢帧、电脑卡住）：不停在「正在建立加密连接」，断开按退避重连
    this.unguard()
    const ws = this.ws
    this.guard = setTimeout(() => {
      this.guard = null
      if (this.ws === ws && this.state !== 'ready') ws?.close()
    }, HANDSHAKE_TIMEOUT)
  }

  private onFrame(frame: Uint8Array): void {
    let f: ReturnType<typeof decodeFrame>
    try {
      f = decodeFrame(frame)
    } catch {
      return
    }
    if (f.type === FrameType.PairResult) {
      // 结果帧不加密、经云端：已配好的电脑不因它被删，只更新提示、决定何时重试；真被移除时云端以 4001 关连接
      let result: { status?: string; v?: number } = {}
      try {
        result = decodeJson(f.body) as typeof result
      } catch {
        return
      }
      const { status } = result,
        pending = this.pairing.status === 'pending'
      if (pending) {
        // 还在等确认：rejected 就是电脑上点了「拒绝」
        if (status === 'pending') this.set('waiting_confirm')
        else if (status === 'rejected') this.removed()
        else if (status === 'accepted') {
          this.pairing = { ...this.pairing, status: 'paired', request: undefined }
          this.hooks.onPairing(this.pairing)
          this.handshake()
        }
      } else if (status === 'unknown') {
        this.reset()
        this.set('unrecognized')
        this.retryHandshake(RETRY_LATER)
      } else if (status === 'handshake_failed' && result.v !== undefined && result.v !== LINK_VERSION) {
        this.reset()
        this.unguard()
        this.set('incompatible')
      } else if (status === 'unavailable' || status === 'handshake_failed') this.retryHandshake(RETRY_SOON)
    } else if (f.type === FrameType.Handshake2 && this.initiator) {
      try {
        this.finish(this.initiator.readMessage2(f.body).result)
      } catch {
        this.ws?.close()
      }
    } else if (f.type === FrameType.Data) this.channel?.receive(f.body)
  }

  private finish(keys: HandshakeResult): void {
    this.initiator = null
    const ws = this.ws
    const rpc = new RpcCore(m => void channel.send(m).catch(() => {}))
    const channel = new SecureChannel(
      keys,
      f => ws?.readyState === WebSocket.OPEN && ws.send(f as Uint8Array<ArrayBuffer>),
      v => rpc.receive(v),
      // 解不开：这条加密会话作废，重新握手
      () => this.handshake(),
      browserCodec,
    )
    rpc.onEvent = (_channel, data) => {
      for (const event of unbatch(data)) this.hooks.onEvent(event)
    }
    this.rpc = rpc
    this.channel = channel
    void rpc.call<Hello>('hello', [HELLO], 10_000).then(
      hello => {
        if (this.rpc !== rpc) return
        this.unguard()
        if (hello.version !== LINK_VERSION) {
          this.reset()
          this.set('incompatible')
          return
        }
        this.hello = hello
        this.set('ready')
        // 在后台时连上的（系统短暂唤醒）：电脑要知道
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.away(true)
      },
      () => this.ws?.close(),
    )
  }
}

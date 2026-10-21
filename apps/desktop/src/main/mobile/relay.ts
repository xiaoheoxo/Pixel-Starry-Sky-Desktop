// 电脑到中转的 WebSocket（docs/mobile-remote.md §3.2、§11.3）。中转只按「电脑 ID ↔ 手机 ID」转发不透明的帧：
// 电脑这一侧每帧前面带「1 字节长度 + 手机 ID」，上下线用文本帧（JSON）通知。断线按指数退避重连。
// 云端中转（M2）：握手时把访问令牌放在子协议里（bearer.<令牌>）；中转每分钟复查一次，令牌失效时用 4001 关闭，
// 这里换一个新令牌马上重连。没登录时不连，登录后由 ipc.ts 重新启动。
import { bridgeProtocols } from '@pixelsky/link'
import type { MobileLinkStatus } from '../../shared/types/mobile'

export type RelayNotice =
  | { type: 'phone_joined'; phone: string }
  | { type: 'phone_left'; phone: string }
  | { type: 'desktop_online' | 'desktop_offline' }

export interface RelayOptions {
  url: string
  desktopId: string
  onFrame(phone: string, frame: Uint8Array): void
  onNotice(notice: RelayNotice): void
  /** 连上 / 断开 / 出错；断开时手机的加密会话都要作废 */
  onStatus(status: MobileLinkStatus, error: string | null): void
  /** 连中转用的访问令牌；force 为 true 时先刷新。没登录返回 null */
  token(force: boolean): Promise<string | null>
  /** 测试注入 */
  socket?: (url: string, protocols: string[]) => WebSocket
}

/** 中转的关闭码（services/cloud/internal/bridge） */
const CLOSE_UNAUTHORIZED = 4001

const MIN_DELAY = 1000
const MAX_DELAY = 30_000
/** 云端每 20 秒发一条文本心跳 tick；收到过之后这么久什么都没收到，就当连接已经死了（睡眠唤醒、NAT 丢连接） */
export const DEAD_AFTER = 60_000

export function relayUrl(base: string, desktopId: string): string {
  const url = new URL(base)
  // WebSocket 地址不能带 # 片段（new WebSocket 会同步抛 SyntaxError）；旧版本存下的这种地址按地址不对处理
  if (base.includes('#')) throw new Error('MOBILE_BAD_RELAY')
  url.searchParams.set('role', 'desktop')
  url.searchParams.set('id', desktopId)
  return url.toString()
}

/** 电脑发出的帧：1 字节长度 + 手机 ID + 内容 */
export function addressed(phone: string, frame: Uint8Array): Uint8Array {
  const id = Buffer.from(phone, 'utf8')
  if (id.length < 1 || id.length > 64) throw new Error('MOBILE_BAD_PHONE_ID')
  return Buffer.concat([Buffer.of(id.length), id, frame])
}

/** 收到的帧：拆出手机 ID；格式不对返回 null */
export function unaddress(data: Uint8Array): { phone: string; frame: Uint8Array } | null {
  const n = data[0]
  if (!n || data.length < 1 + n + 1) return null
  return { phone: Buffer.from(data.subarray(1, 1 + n)).toString('utf8'), frame: data.subarray(1 + n) }
}

export class RelayLink {
  private ws: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private delay = MIN_DELAY
  private stopped = true
  /** 上次被中转以「令牌失效」关闭：下次连之前先刷新令牌 */
  private refresh = false

  constructor(private readonly o: RelayOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.delay = MIN_DELAY
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
    }
    this.o.onStatus('off', null)
  }

  send(phone: string, frame: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('MOBILE_RELAY_OFFLINE')
    this.ws.send(addressed(phone, frame))
  }

  private retry(): void {
    // 退避加一点随机，很多电脑同时断线时不会同一刻一起重连
    const wait = this.delay * (0.8 + Math.random() * 0.4)
    this.delay = Math.min(MAX_DELAY, this.delay * 2)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.stopped) void this.connect()
    }, wait)
  }

  private async connect(): Promise<void> {
    let url: string
    try {
      url = relayUrl(this.o.url, this.o.desktopId)
    } catch {
      this.stopped = true
      this.o.onStatus('error', 'MOBILE_BAD_RELAY')
      return
    }
    this.o.onStatus('connecting', null)
    const force = this.refresh
    this.refresh = false
    const token = await this.o.token(force).catch(() => null)
    if (this.stopped) return
    if (!token) {
      this.o.onStatus('error', 'MOBILE_NEED_LOGIN')
      this.retry()
      return
    }
    const protocols = bridgeProtocols(token)
    let ws: WebSocket
    try {
      ws = this.o.socket ? this.o.socket(url, protocols) : new WebSocket(url, protocols)
    } catch {
      // 地址、协议名不合要求时同步抛错：当作这次没连上，按退避重试（不然 void connect() 的异常没人接）
      this.o.onStatus('error', 'MOBILE_RELAY_OFFLINE')
      this.retry()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    // 中转先接受连接再核对令牌：连上 10 秒没被关才算稳定，才把退避清零（不然令牌一直不对时会飞快重连）
    let stable: ReturnType<typeof setTimeout> | null = null
    // 老版本云端不发 tick：没收到过就不判断
    let lastSeen = 0
    const watchdog = setInterval(() => {
      // stop() 换掉了这条连接（它会清掉 onclose）：这里自己停
      if (this.ws !== ws) return clearInterval(watchdog)
      if (!lastSeen || Date.now() - lastSeen <= DEAD_AFTER) return
      // 死连接上 close 可能要等很久才触发 onclose：先当作断开，马上按退避重连
      clearInterval(watchdog)
      if (stable) clearTimeout(stable)
      this.ws = null
      ws.close()
      if (this.stopped) return
      this.o.onStatus('error', 'MOBILE_RELAY_OFFLINE')
      this.retry()
    }, DEAD_AFTER / 4)
    ws.onopen = () => {
      stable = setTimeout(() => (this.delay = MIN_DELAY), 10_000)
      this.o.onStatus('online', null)
    }
    ws.onmessage = event => {
      if (lastSeen) lastSeen = Date.now()
      if (typeof event.data === 'string') {
        try {
          const notice = JSON.parse(event.data) as RelayNotice | { type: 'tick' }
          if (notice?.type === 'tick') lastSeen = Date.now()
          else if (notice && typeof notice.type === 'string') this.o.onNotice(notice)
        } catch {}
        return
      }
      const parsed = unaddress(new Uint8Array(event.data as ArrayBuffer))
      if (parsed) this.o.onFrame(parsed.phone, parsed.frame)
    }
    ws.onerror = () => {}
    ws.onclose = event => {
      clearInterval(watchdog)
      if (stable) clearTimeout(stable)
      if (this.ws !== ws) return
      this.ws = null
      if (this.stopped) return
      if (event.code === CLOSE_UNAUTHORIZED) {
        // 访问令牌过期或被吊销：换个令牌马上重连（第二次还不行再按退避来）
        this.refresh = true
        this.o.onStatus('connecting', null)
        if (this.delay === MIN_DELAY) {
          this.delay *= 2
          void this.connect()
          return
        }
      } else this.o.onStatus('error', event.code === 1008 ? 'MOBILE_RELAY_REJECTED' : 'MOBILE_RELAY_OFFLINE')
      this.retry()
    }
  }
}

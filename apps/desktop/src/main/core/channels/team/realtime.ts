// 团队实时通道的 WebSocket 客户端（docs/ui/channels-phase-c.md §8.3）。重连、看门狗照 mobile/relay.ts：
// 断线指数退避加随机、60 秒没收到任何帧（含云端每 20 秒一次的 tick）就当连接已死、4001 换令牌马上重连。
// socket 工厂和令牌都由应用层注入，这里不碰 Electron。客户端不发业务帧，只收。
import { isObj, parseMessage, type TeamMessage } from './api'

export type TeamFrame =
  | { type: 'hello'; online: Record<string, string[]> }
  | { type: 'message'; team: string; channel: string; seq: number; message: TeamMessage }
  | { type: 'team'; team: string; seq: number }
  | { type: 'presence'; team: string; user: string; online: boolean }
  | { type: 'invites' }
  | { type: 'removed'; team: string }

export type RealtimeStatus = 'connecting' | 'online' | 'offline'

/** WebSocket 的最小子集（测试里用假的） */
export interface SocketLike {
  readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  close(code?: number): void
}

export interface RealtimeOptions {
  url: string
  /** 访问令牌；force 为 true 时先刷新。没登录返回 null */
  token(force: boolean): Promise<string | null>
  onFrame(frame: TeamFrame): void
  onStatus(status: RealtimeStatus): void
  socket?: (url: string, protocols: string[]) => SocketLike
}

const CLOSE_UNAUTHORIZED = 4001
const MIN_DELAY = 1000
const MAX_DELAY = 30_000
export const DEAD_AFTER = 60_000
const PROTOCOL = 'pixelsky.v1'

/** 云端推来的 JSON 文本帧 → 帧；不认识的返回 null（tick 由调用方先处理） */
export function parseFrame(raw: unknown): TeamFrame | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null
  const team = typeof raw.team === 'string' ? raw.team : ''
  switch (raw.type) {
    case 'hello': {
      const online: Record<string, string[]> = {}
      if (isObj(raw.online))
        for (const [tid, users] of Object.entries(raw.online))
          online[tid] = Array.isArray(users) ? users.filter((u): u is string => typeof u === 'string') : []
      return { type: 'hello', online }
    }
    case 'message': {
      const message = parseMessage(raw.message)
      const channel = typeof raw.channel === 'string' ? raw.channel : (message?.channelId ?? '')
      if (!team || !channel || !message) return null
      return { type: 'message', team, channel, seq: typeof raw.seq === 'number' ? raw.seq : message.seq, message }
    }
    case 'team':
      return team ? { type: 'team', team, seq: typeof raw.seq === 'number' ? raw.seq : 0 } : null
    case 'presence':
      return team && typeof raw.user === 'string'
        ? { type: 'presence', team, user: raw.user, online: raw.online === true }
        : null
    case 'invites':
      return { type: 'invites' }
    case 'removed':
      return team ? { type: 'removed', team } : null
    default:
      return null
  }
}

export class TeamRealtime {
  private ws: SocketLike | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private delay = MIN_DELAY
  private stopped = true
  /** 上次被云端以「令牌失效」关闭：下次连之前先刷新令牌 */
  private refresh = false
  /** 连接代号：stop() / restart() 时加一，等令牌期间被换掉的 connect() 回来后自己放弃 */
  private gen = 0

  constructor(private readonly o: RealtimeOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.delay = MIN_DELAY
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    this.drop()
  }

  /** 手动重试：丢掉现在的连接（或退避中的等待），马上重连 */
  restart(): void {
    this.stopped = false
    this.delay = MIN_DELAY
    this.drop()
    void this.connect()
  }

  private drop(): void {
    this.gen++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
    }
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
    const gen = this.gen
    this.o.onStatus('connecting')
    const force = this.refresh
    this.refresh = false
    const token = await this.o.token(force).catch(() => null)
    // 等令牌期间 stop() 了，或 stop() 后又 start() / restart() 开了新的一次：这次作废
    if (this.stopped || gen !== this.gen) return
    if (!token) {
      this.o.onStatus('offline')
      this.retry()
      return
    }
    const protocols = [PROTOCOL, `bearer.${token}`]
    let ws: SocketLike
    try {
      ws = this.o.socket
        ? this.o.socket(this.o.url, protocols)
        : (new WebSocket(this.o.url, protocols) as unknown as SocketLike)
    } catch {
      this.o.onStatus('offline')
      this.retry()
      return
    }
    // 兜底：万一还挂着别的连接，先关掉，免得两条同时收帧
    if (this.ws && this.ws !== ws) {
      const old = this.ws
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      old.close()
    }
    this.ws = ws
    // 云端先接受连接再核对令牌：连上 10 秒没被关才算稳定，才把退避清零
    let stable: ReturnType<typeof setTimeout> | null = null
    let lastSeen = Date.now()
    const watchdog = setInterval(() => {
      // stop() / restart() 换掉了这条连接（它们会清掉 onclose）：这里自己停
      if (this.ws !== ws) return clearInterval(watchdog)
      if (Date.now() - lastSeen <= DEAD_AFTER) return
      // 死连接上 close 可能要等很久才触发 onclose：先当作断开，马上按退避重连
      clearInterval(watchdog)
      if (stable) clearTimeout(stable)
      this.ws = null
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
      if (this.stopped) return
      this.o.onStatus('offline')
      this.retry()
    }, DEAD_AFTER / 4)
    ws.onopen = () => {
      if (this.ws !== ws) return
      lastSeen = Date.now()
      stable = setTimeout(() => (this.delay = MIN_DELAY), 10_000)
      this.o.onStatus('online')
    }
    ws.onmessage = event => {
      // 已被换掉的旧连接上迟到的帧不再往外传
      if (this.ws !== ws) return
      lastSeen = Date.now()
      if (typeof event.data !== 'string') return
      let raw: unknown
      try {
        raw = JSON.parse(event.data)
      } catch {
        return
      }
      if (isObj(raw) && raw.type === 'tick') return
      const frame = parseFrame(raw)
      if (frame) this.o.onFrame(frame)
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
        this.o.onStatus('connecting')
        if (this.delay === MIN_DELAY) {
          this.delay *= 2
          void this.connect()
          return
        }
      } else this.o.onStatus('offline')
      this.retry()
    }
  }
}

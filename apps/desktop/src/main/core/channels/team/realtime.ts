// 团队实时通道的 WebSocket 客户端（docs/ui/channels-phase-c.md §8.3）。重连、看门狗照 mobile/relay.ts：
// 断线指数退避加随机、60 秒没收到任何帧（含云端每 20 秒一次的 tick）就当连接已死、4001 换令牌马上重连、
// 4010（执行机台数超过席位，docs/multica-learn.md §11.7）停下不再重连。
// socket 工厂和令牌都由应用层注入，这里不碰 Electron（执行机进程也用它）。客户端不发业务帧，只收。
// 候选线路（docs/network-direct.md §10）：给了 targets 时按 CDN → 直连 → IP 依次试，握手没成功马上换下一档，
// 三档都不行再退避；连在后面的档时每 5 分钟看前面的档，恢复了就切回去。
import { isObj, parseInboxItem, parseMessage, type TeamMessage } from './api'
import { TierCursor, handshakeStatus, logFailure, watchRecovery, type WsTarget } from '../../ws-tiers'
import type { TeamInboxItem } from '../../../../shared/types/channels'

export type TeamFrame =
  | { type: 'hello'; online: Record<string, string[]> }
  | { type: 'message'; team: string; channel: string; seq: number; message: TeamMessage }
  | { type: 'team'; team: string; seq: number }
  | { type: 'presence'; team: string; user: string; online: boolean }
  | { type: 'invites' }
  | { type: 'removed'; team: string }
  | { type: 'inbox'; team: string; item: TeamInboxItem }

export type RealtimeStatus = 'connecting' | 'online' | 'offline'
/** 云端让客户端别再连的原因（随 offline 一起给）：seats 是执行机台数超过席位（关闭码 4010） */
export type RealtimeStop = 'seats'

/** 团队实时通道的地址：登录服务的同一个地址（https → wss） */
export function teamsWsUrl(base: string): string {
  return base.replace(/^http/, 'ws').replace(/\/+$/, '') + '/v1/teams/ws'
}

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
  /** 地址；给函数时每次连接（含重连）都重新取：线路择优换了线路，下次重连就用新的。给了 targets 时不用 */
  url?: string | (() => string)
  /** 候选线路，按顺序试（每一轮开始时重新取）；优先于 url */
  targets?: () => WsTarget[]
  /** 访问令牌；force 为 true 时先刷新。没登录返回 null */
  token(force: boolean): Promise<string | null>
  onFrame(frame: TeamFrame): void
  /** stop：云端让别再连（之后不自动重连，start() / restart() 才再连） */
  onStatus(status: RealtimeStatus, stop?: RealtimeStop): void
  /** 建连接；target 是这次试的那一档（ip 那档要按固定 IP 连，应用层用 ws 包） */
  socket?: (url: string, protocols: string[], target: WsTarget) => SocketLike
  /** 换线路、切回更好的线路时写日志 */
  log?: (message: string, fields: Record<string, unknown>) => void
  /** 问一次 HTTP 升级的状态码（恢复检查、日志）；测试注入 */
  probe?: (target: WsTarget) => Promise<number | null>
}

/** 发出 WebSocket 请求后这么久没握手完，当作这一档没连上、换下一档 */
export const HANDSHAKE_TIMEOUT = 10_000

const CLOSE_UNAUTHORIZED = 4001
/** 收到就停、不重连的关闭码 */
const NO_RETRY: Record<number, RealtimeStop> = { 4010: 'seats' }
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
    case 'inbox': {
      const item = parseInboxItem(raw.item)
      return item ? { type: 'inbox', team: item.teamId, item } : null
    }
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
  private readonly cursor: TierCursor
  /** 正在连 / 连着的那一档 */
  private target: WsTarget | null = null
  /** 连在后面的档时的恢复检查 */
  private unwatch: (() => void) | null = null
  /** 上次连上之后换过几次档（日志限频用） */
  private switches = 0

  constructor(private readonly o: RealtimeOptions) {
    this.cursor = new TierCursor(
      o.targets ?? (() => [{ tier: 'default', url: typeof o.url === 'function' ? o.url() : (o.url ?? '') }]),
    )
  }

  private stopWatch(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  /** 这一档握手没成功：还有下一档就马上换，这一轮试完了才按退避重连 */
  private handshakeFailed(reason: string): void {
    const from = this.target
    const next = this.cursor.fail()
    if (!next) {
      this.o.onStatus('offline')
      return this.retry()
    }
    // 一直连不上时（断网）每轮都会换档：前 3 次、之后每 10 次才记（记的时候还要多发一个检查请求）
    this.switches++
    if (from && logFailure(this.switches, false)) {
      const fields = { from: from.tier, to: next.tier, reason }
      void (this.o.probe ?? handshakeStatus)(from)
        .catch(() => null)
        .then(httpStatus => this.o.log?.('团队实时通道换线路', { ...fields, httpStatus }))
    }
    void this.connect()
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.delay = MIN_DELAY
    this.cursor.reset()
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
    this.stopWatch()
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
    const target = this.cursor.current()
    this.target = target
    if (!target) {
      this.o.onStatus('offline')
      return this.retry()
    }
    let ws: SocketLike
    try {
      ws = this.o.socket
        ? this.o.socket(target.url, protocols, target)
        : (new WebSocket(target.url, protocols) as unknown as SocketLike)
    } catch {
      // 地址不合要求时同步抛错：当作这一档没连上
      this.handshakeFailed('socket')
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
    let opened = false
    // 一直没握手完（IP 被墙时系统要等很久才报错）：当作这一档没连上
    const handshake = setTimeout(() => {
      if (this.ws !== ws || opened) return
      clearInterval(watchdog)
      this.ws = null
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
      if (!this.stopped) this.handshakeFailed('timeout')
    }, HANDSHAKE_TIMEOUT)
    const watchdog = setInterval(() => {
      // stop() / restart() 换掉了这条连接（它们会清掉 onclose）：这里自己停
      if (this.ws !== ws) return clearInterval(watchdog)
      if (Date.now() - lastSeen <= DEAD_AFTER) return
      // 死连接上 close 可能要等很久才触发 onclose：先当作断开，马上按退避重连
      clearInterval(watchdog)
      if (stable) clearTimeout(stable)
      this.stopWatch()
      this.ws = null
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
      if (this.stopped) return
      this.o.onStatus('offline')
      this.retry()
    }, DEAD_AFTER / 4)
    ws.onopen = () => {
      if (this.ws !== ws) return
      clearTimeout(handshake)
      opened = true
      this.switches = 0
      lastSeen = Date.now()
      stable = setTimeout(() => (this.delay = MIN_DELAY), 10_000)
      this.cursor.connected()
      this.unwatch = watchRecovery(
        this.cursor,
        (to, index) => {
          if (this.stopped || this.ws !== ws) return
          this.o.log?.('团队实时通道换回更好的线路', { from: target.tier, to: to.tier })
          this.stopWatch()
          this.cursor.promote(index)
          this.ws = null
          ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
          ws.close()
          void this.connect()
        },
        this.o.probe ?? handshakeStatus,
      )
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
      clearTimeout(handshake)
      if (stable) clearTimeout(stable)
      if (this.ws !== ws) return
      this.ws = null
      this.stopWatch()
      if (this.stopped) return
      const stop = NO_RETRY[event.code]
      if (stop) {
        // 重连也一样会被关：停下，等调用方 start() / restart()
        this.stopped = true
        this.o.onStatus('offline', stop)
        return
      }
      if (event.code === CLOSE_UNAUTHORIZED) {
        // 访问令牌过期或被吊销：换个令牌马上重连（第二次还不行再按退避来）
        this.refresh = true
        this.o.onStatus('connecting')
        if (this.delay === MIN_DELAY) {
          this.delay *= 2
          void this.connect()
          return
        }
      } else {
        // 没握手成功就关了（426、连不上）：换下一档
        if (!opened) return this.handshakeFailed(`close ${event.code}`)
        this.o.onStatus('offline')
      }
      this.retry()
    }
  }
}

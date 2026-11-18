// 电脑到中转的 WebSocket（docs/mobile-remote.md §3.2、§11.3）。中转只按「电脑 ID ↔ 手机 ID」转发不透明的帧：
// 电脑这一侧每帧前面带「1 字节长度 + 手机 ID」，上下线用文本帧（JSON）通知。断线按指数退避重连。
// 云端中转（M2）：握手时把访问令牌放在子协议里（bearer.<令牌>）；中转每分钟复查一次，令牌失效时用 4001 关闭，
// 这里换一个新令牌马上重连。没登录时不连，登录后由 ipc.ts 重新启动。
// 候选线路（docs/network-direct.md §10）：默认中转按 CDN → 直连 → IP 依次试，握手没成功马上换下一个，都不行再退避；
// 连在后面的档时每 5 分钟看前面的档，恢复了就切回去。
import { describeError, logger, type LogFields } from '@pixelsky/engine'
import { bridgeProtocols } from '@pixelsky/link'
import type { MobileLinkStatus } from '../../shared/types/mobile'
import { openWs } from '../account/ws-open'
import { TierCursor, handshakeStatus, logFailure, watchRecovery, type WsTarget } from '../core/ws-tiers'

export { logFailure }

export type RelayLog = (level: 'info' | 'warn', message: string, fields: LogFields) => void
const mobileLog = logger('mobile')
const defaultLog: RelayLog = (level, message, fields) => mobileLog[level](message, fields)

export type RelayNotice =
  | { type: 'phone_joined'; phone: string }
  | { type: 'phone_left'; phone: string }
  | { type: 'desktop_online' | 'desktop_offline' }

export interface RelayOptions {
  /** 候选的中转地址，按顺序试；每一轮开始时重新取（手填、优质节点只有一个） */
  targets(): WsTarget[]
  desktopId: string
  onFrame(phone: string, frame: Uint8Array): void
  onNotice(notice: RelayNotice): void
  /** 连上 / 断开 / 出错；断开时手机的加密会话都要作废 */
  onStatus(status: MobileLinkStatus, error: string | null): void
  /** 连中转用的访问令牌；force 为 true 时先刷新。没登录返回 null */
  token(force: boolean): Promise<string | null>
  /** 测试注入 */
  socket?: (url: string, protocols: string[], target: WsTarget) => WebSocket
  /** 写日志（默认 logger('mobile')）；测试注入 */
  log?: RelayLog
  /** 问一次 HTTP 升级的状态码：握手没成功时写日志（WebSocket 接口拿不到，426 / 403 / 502 要靠它分清），恢复检查也用；测试注入 */
  probe?: (target: WsTarget) => Promise<number | null>
}

/** 发出 WebSocket 请求后这么久没握手完，当作这一档没连上、换下一档（连不上的 IP 系统要等 20 多秒才报错） */
export const HANDSHAKE_TIMEOUT = 10_000

/** 日志里的中转地址：只留协议、主机和路径，不带电脑 ID */
export function relayHost(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '(地址不对)'
  }
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
  /** 连续失败几次了（连上后清零），日志用 */
  private failures = 0
  /** 上一次失败的原因，原因变了就记一条 */
  private lastFail = ''
  private readonly log: RelayLog
  private readonly cursor: TierCursor
  /** 正在连 / 连着的那一档 */
  private target: WsTarget | null = null
  /** 连在后面的档时的恢复检查；断开、停止时停掉 */
  private unwatch: (() => void) | null = null

  constructor(private readonly o: RelayOptions) {
    this.log = o.log ?? defaultLog
    this.cursor = new TierCursor(() => o.targets())
  }

  /** 日志里的地址和档：只留主机和路径 */
  private where(target = this.target): LogFields {
    return target ? { relay: relayHost(target.url), tier: target.tier } : {}
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.delay = MIN_DELAY
    this.failures = 0
    this.lastFail = ''
    this.cursor.reset()
    this.log('info', '手机中转开始连接', {
      targets: this.o
        .targets()
        .map(t => t.tier)
        .join(' → '),
    })
    void this.connect()
  }

  stop(): void {
    if (!this.stopped) this.log('info', '手机中转停止', this.where())
    this.stopped = true
    this.stopWatch()
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

  private stopWatch(): void {
    this.unwatch?.()
    this.unwatch = null
  }

  /** 前面的档恢复了：断开现在这条，从那一档重连 */
  private recover(ws: WebSocket, to: WsTarget, index: number): void {
    if (this.stopped || this.ws !== ws) return
    this.log('info', '手机中转换回更好的线路', { ...this.where(), to: to.tier })
    this.stopWatch()
    this.cursor.promote(index)
    this.ws = null
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    ws.close()
    this.o.onStatus('connecting', null)
    void this.connect()
  }

  /** 这次没连上（或断了）：记日志，按退避重连。stage 是在哪一步失败的 */
  private retry(stage: string, fields: LogFields = {}): void {
    // 退避加一点随机，很多电脑同时断线时不会同一刻一起重连
    const wait = this.delay * (0.8 + Math.random() * 0.4)
    this.delay = Math.min(MAX_DELAY, this.delay * 2)
    this.failures++
    const key = stage + ':' + String(fields.code ?? '')
    if (logFailure(this.failures, key !== this.lastFail)) {
      this.logFail('手机中转连不上', stage, { ...fields, attempt: this.failures, retryMs: Math.round(wait) })
    }
    this.lastFail = key
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.stopped) void this.connect()
    }, wait)
  }

  /** 握手阶段没成功：WebSocket 不给状态码，另外问一次再记（426 = CDN 去掉了升级头） */
  private logFail(message: string, stage: string, fields: LogFields, target = this.target): void {
    const entry = { ...this.where(target), stage, ...fields }
    if (stage !== 'handshake' || !target) return this.log('warn', message, entry)
    void (this.o.probe ?? handshakeStatus)(target)
      .catch(() => null)
      .then(status => this.log('warn', message, { ...entry, httpStatus: status }))
  }

  /** 这一档握手没成功：还有下一档就马上换（不退避），这一轮试完了才按退避重连 */
  private handshakeFailed(stage: string, fields: LogFields): void {
    const from = this.target
    const next = this.cursor.fail()
    if (!next) {
      this.o.onStatus('error', 'MOBILE_RELAY_OFFLINE')
      return this.retry(stage, fields)
    }
    // 一直连不上时（断网）每轮都会换档：和「连不上」一样限频
    if (logFailure(this.failures + 1, false)) this.logFail('手机中转换线路', stage, { ...fields, to: next.tier }, from)
    void this.connect()
  }

  private async connect(): Promise<void> {
    const target = this.cursor.current()
    this.target = target
    let url: string
    try {
      if (!target) throw new Error('MOBILE_BAD_RELAY')
      url = relayUrl(target.url, this.o.desktopId)
    } catch {
      this.stopped = true
      this.log('warn', '手机中转地址不对', this.where())
      this.o.onStatus('error', 'MOBILE_BAD_RELAY')
      return
    }
    this.o.onStatus('connecting', null)
    const force = this.refresh
    this.refresh = false
    const token = await this.o.token(force).catch(() => null)
    if (this.stopped || this.target !== target || !target) return
    if (!token) {
      this.o.onStatus('error', 'MOBILE_NEED_LOGIN')
      this.retry('token')
      return
    }
    const protocols = bridgeProtocols(token)
    let ws: WebSocket
    try {
      const t = { ...target, url }
      ws = this.o.socket ? this.o.socket(url, protocols, t) : openWs(t, protocols)
    } catch (e) {
      // 地址、协议名不合要求时同步抛错：当作这一档没连上（不然 void connect() 的异常没人接）
      this.handshakeFailed('socket', { error: describeError(e) })
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    // 中转先接受连接再核对令牌：连上 10 秒没被关才算稳定，才把退避清零（不然令牌一直不对时会飞快重连）
    let stable: ReturnType<typeof setTimeout> | null = null
    // 老版本云端不发 tick：没收到过就不判断
    let lastSeen = 0
    // 连上的时刻（没连上过为 0）、最近一次 error 事件的说明：断开时写进日志
    let openedAt = 0
    let lastError: string | null = null
    const started = Date.now()
    // 一直没握手完（IP 被墙时系统要等很久才报错）：当作这一档没连上
    const handshake = setTimeout(() => {
      if (this.ws !== ws || openedAt) return
      clearInterval(watchdog)
      this.ws = null
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
      if (!this.stopped) this.handshakeFailed('handshake', { error: 'timeout', ms: Date.now() - started })
    }, HANDSHAKE_TIMEOUT)
    const watchdog = setInterval(() => {
      // stop() 换掉了这条连接（它会清掉 onclose）：这里自己停
      if (this.ws !== ws) return clearInterval(watchdog)
      if (!lastSeen || Date.now() - lastSeen <= DEAD_AFTER) return
      // 死连接上 close 可能要等很久才触发 onclose：先当作断开，马上按退避重连
      clearInterval(watchdog)
      if (stable) clearTimeout(stable)
      this.stopWatch()
      this.ws = null
      ws.close()
      if (this.stopped) return
      this.o.onStatus('error', 'MOBILE_RELAY_OFFLINE')
      this.retry('heartbeat', { silentMs: Date.now() - lastSeen, onlineMs: Date.now() - openedAt })
    }, DEAD_AFTER / 4)
    ws.onopen = () => {
      clearTimeout(handshake)
      openedAt = Date.now()
      stable = setTimeout(() => (this.delay = MIN_DELAY), 10_000)
      this.log('info', '手机中转已连上', { ...this.where(), ms: openedAt - started, afterFailures: this.failures })
      this.failures = 0
      this.lastFail = ''
      this.cursor.connected()
      this.unwatch = watchRecovery(
        this.cursor,
        (to, index) => this.recover(ws, to, index),
        this.o.probe ?? handshakeStatus,
      )
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
    ws.onerror = event => {
      // undici 的 ErrorEvent：error / message 里是「Received network error or non-101 status code」这类说明
      const e = event as Event & { message?: string; error?: unknown }
      lastError = e.error ? describeError(e.error) : (e.message ?? null)
    }
    ws.onclose = event => {
      clearInterval(watchdog)
      clearTimeout(handshake)
      if (stable) clearTimeout(stable)
      if (this.ws !== ws) return
      this.stopWatch()
      this.ws = null
      if (this.stopped) return
      const fields: LogFields = {
        code: event.code,
        ...(event.reason ? { reason: String(event.reason).slice(0, 200) } : {}),
        ...(lastError ? { error: lastError } : {}),
        ...(openedAt ? { onlineMs: Date.now() - openedAt } : {}),
      }
      if (event.code === CLOSE_UNAUTHORIZED) {
        // 访问令牌过期或被吊销：换个令牌马上重连（第二次还不行再按退避来）
        this.refresh = true
        this.o.onStatus('connecting', null)
        if (this.delay === MIN_DELAY) {
          this.log('info', '手机中转令牌失效，换令牌重连', this.where())
          this.delay *= 2
          void this.connect()
          return
        }
        this.retry('closed', fields)
        return
      }
      // 没握手成功就关了（426、连不上）：换下一档
      if (!openedAt) return this.handshakeFailed('handshake', fields)
      this.o.onStatus('error', event.code === 1008 ? 'MOBILE_RELAY_REJECTED' : 'MOBILE_RELAY_OFFLINE')
      this.retry('closed', fields)
    }
  }
}

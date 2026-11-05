// QQ 机器人（官方开放平台）：AppID + AppSecret 换令牌，WebSocket 收单聊消息，HTTP 回复。
// 回复规则见 docs/ui/one-click-connectors.md：一条用户消息 60 分钟内最多回 4 次，主动消息不可靠
import { ImRejected, type ImInbound, type ImSender, type SendResult } from './bridge'

export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
export const QQ_API = 'https://api.sgroup.qq.com'
/** GROUP_AND_C2C_EVENT：单聊消息在这一组 */
const INTENTS = 1 << 25
const REPLY_WINDOW = 60 * 60_000
const REPLY_MAX = 4
const CODE_IP = 11298
/** 窗口过了、额度用完、用户拒收、不是好友：这条现在发不了，不算错误 */
const WINDOW_CODES = new Set([40034128, 40034100, 40034122, 40054013, 40054004])
const RETRY_MAX = 60_000
const REQUEST_TIMEOUT = 20_000

export type LinkStatus = 'connecting' | 'online' | 'error'

export interface SocketLike {
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(): void
}

export interface QqOptions {
  appId: string
  appSecret: string
  onMessage(message: ImInbound): void
  /** error 是错误代码（im.error.* 的后半段）；detail 给界面显示（当前公网 IP） */
  onStatus(status: LinkStatus, error: string | null, detail?: string | null): void
  fetch?: typeof fetch
  socket?(url: string): SocketLike
  /** 查这台电脑的公网 IP：只在报白名单错误时查一次，给用户看要加哪个 */
  publicIp?(): Promise<string | null>
  now?(): number
  retryBase?: number
}

class QqAuthError extends Error {
  constructor(readonly reason: 'qqIp' | 'qqAuth') {
    super(reason)
  }
}

interface Current {
  id: string
  from: string
  at: number
  used: number
}

export class QqLink implements ImSender {
  readonly maxChars = 1800
  private token: { value: string; expiresAt: number } | null = null
  private ws: SocketLike | null = null
  private heart: ReturnType<typeof setInterval> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private failures = 0
  private seq: number | null = null
  private session: string | null = null
  /** 最近一条用户消息：被动回复要带它的 id */
  private current: Current | null = null
  /** 互动召回每个周期只有一条，一条用户消息之后只试一次 */
  private wakeupTried = false
  /** 上次心跳有回应；没回应说明连接已经死了（电脑睡眠后常见），close 事件可能很久都不来 */
  private acked = true
  private ready = false

  constructor(private readonly o: QqOptions) {}

  private get http(): typeof fetch {
    return this.o.fetch ?? fetch
  }

  private now(): number {
    return this.o.now?.() ?? Date.now()
  }

  start(): void {
    this.stopped = false
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dropSocket()
  }

  private dropSocket(): void {
    if (this.heart) clearInterval(this.heart)
    this.heart = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close()
      } catch {
        // 已经断了
      }
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value
    const res = await this.http(QQ_TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.o.appId, clientSecret: this.o.appSecret }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string
      expires_in?: string | number
      code?: number
    }
    if (!data.access_token) {
      if (data.code === undefined) throw new Error(`token ${res.status}`)
      throw new QqAuthError(data.code === CODE_IP ? 'qqIp' : 'qqAuth')
    }
    this.token = { value: data.access_token, expiresAt: this.now() + Number(data.expires_in ?? 7200) * 1000 }
    return this.token.value
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    this.o.onStatus('connecting', null)
    try {
      const token = await this.accessToken()
      const res = await this.http(`${QQ_API}/gateway`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: { Authorization: `QQBot ${token}` },
      })
      const data = (await res.json().catch(() => ({}))) as { url?: string; code?: number }
      if (data.code === CODE_IP) throw new QqAuthError('qqIp')
      if (res.status === 401) this.token = null
      if (!data.url) throw new Error(`gateway ${res.status}`)
      if (this.stopped) return
      this.open(data.url)
    } catch (e) {
      if (this.stopped) return
      if (e instanceof QqAuthError) {
        const ip = e.reason === 'qqIp' ? await this.o.publicIp?.().catch(() => null) : null
        if (this.stopped) return
        this.o.onStatus('error', e.reason, ip ?? null)
        // 凭据不对重试也没用；白名单是用户去改的，改完要接着连上
        if (e.reason === 'qqIp') this.schedule(RETRY_MAX)
        return
      }
      this.o.onStatus('error', 'network')
      this.schedule()
    }
  }

  private schedule(delay?: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const wait = delay ?? Math.min(RETRY_MAX, (this.o.retryBase ?? 1000) * 2 ** this.failures++)
    this.timer = setTimeout(() => void this.connect(), wait)
  }

  private open(url: string): void {
    this.dropSocket()
    const ws = this.o.socket ? this.o.socket(url) : (new WebSocket(url) as unknown as SocketLike)
    this.ws = ws
    ws.onmessage = event => this.onFrame(String(event.data))
    ws.onerror = () => {}
    this.ready = false
    ws.onclose = event => {
      // 4004：令牌无效；4006、4007、4009 之类恢复不了的，下次走全新连接
      if (event.code === 4004) this.token = null
      if (event.code && event.code >= 4006 && event.code <= 4009) this.session = null
      this.lost(event.code)
    }
  }

  /** 连接没了：重连。还没 READY 就被断开多半是配置问题（没开单聊权限、机器人下架），要让用户看到代码 */
  private lost(code?: number): void {
    const ready = this.ready
    this.dropSocket()
    if (ready || !code || code < 4000) this.o.onStatus('connecting', null)
    else this.o.onStatus('error', 'qqClosed', String(code))
    this.schedule()
  }

  private frame(op: number, d: unknown): void {
    this.ws?.send(JSON.stringify({ op, d }))
  }

  private onFrame(raw: string): void {
    let m: { op?: number; s?: number; t?: string; d?: Record<string, unknown> }
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof m.s === 'number') this.seq = m.s
    switch (m.op) {
      case 10: {
        const interval = Number(m.d?.heartbeat_interval) || 30_000
        if (this.heart) clearInterval(this.heart)
        this.acked = true
        this.heart = setInterval(() => {
          if (!this.acked) return this.lost()
          this.acked = false
          this.frame(1, this.seq)
        }, interval)
        const token = `QQBot ${this.token?.value ?? ''}`
        if (this.session && this.seq !== null) this.frame(6, { token, session_id: this.session, seq: this.seq })
        else this.frame(2, { token, intents: INTENTS, shard: [0, 1] })
        return
      }
      case 11:
        this.acked = true
        return
      case 7:
        this.ws?.close()
        return
      case 9:
        this.session = null
        this.seq = null
        this.ws?.close()
        return
      case 0:
        this.onDispatch(m.t, m.d ?? {})
        return
    }
  }

  private onDispatch(type: string | undefined, d: Record<string, unknown>): void {
    if (type === 'READY' || type === 'RESUMED') {
      if (typeof d.session_id === 'string') this.session = d.session_id
      this.ready = true
      this.failures = 0
      this.o.onStatus('online', null)
      return
    }
    if (type !== 'C2C_MESSAGE_CREATE') return
    const from = (d.author as { user_openid?: unknown } | undefined)?.user_openid
    if (typeof d.id !== 'string' || typeof from !== 'string') return
    this.current = { id: d.id, from, at: this.now(), used: 0 }
    this.wakeupTried = false
    this.o.onMessage({ id: d.id, from, text: typeof d.content === 'string' ? d.content : '', reply: d.id })
  }

  private async post(to: string, body: Record<string, unknown>): Promise<SendResult> {
    const token = await this.accessToken()
    const res = await this.http(`${QQ_API}/v2/users/${encodeURIComponent(to)}/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) return 'sent'
    const data = (await res.json().catch(() => ({}))) as { code?: number; err_code?: number; message?: string }
    if (WINDOW_CODES.has(data.code ?? 0) || WINDOW_CODES.has(data.err_code ?? 0)) return 'window'
    if (res.status === 401) this.token = null
    const detail = `QQ ${data.err_code ?? data.code ?? res.status}: ${data.message ?? ''}`
    // 401、限流、服务器问题：等一下还能发。其他 4xx 是平台不收这一条
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) throw new ImRejected(detail)
    throw new Error(detail)
  }

  async send(to: string, text: string): Promise<SendResult> {
    const c = this.current
    if (c && c.from === to && this.now() - c.at < REPLY_WINDOW && c.used < REPLY_MAX) {
      const result = await this.post(to, { msg_type: 0, content: text, msg_id: c.id, msg_seq: c.used + 1 })
      if (result === 'sent') {
        c.used++
        return result
      }
      // 官方两处说法不一致（60 分钟 / 5 分钟）：平台说过期就算过期
      c.used = REPLY_MAX
    }
    if (this.wakeupTried) return 'window'
    this.wakeupTried = true
    return this.post(to, { msg_type: 0, content: text, is_wakeup: true })
  }
}

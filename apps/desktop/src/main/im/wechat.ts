// 微信 ClawBot 通道（实验性）：扫码登录，getupdates 长轮询收消息，sendmessage 回复时带上收到的 context_token。
// 腾讯没有公开文档，接口来自社区对官方插件的分析，错误格式是 2026-11-05 实测的（docs/ui/one-click-connectors.md）
import { randomUUID } from 'node:crypto'
import { ImRejected, type ImInbound, type ImSender, type SendResult } from './bridge'
import type { LinkStatus } from './qq'

export const WECHAT_API = 'https://ilinkai.weixin.qq.com'
const POLL_TIMEOUT = 40_000
const RETRY_MAX = 60_000
const CODE_EXPIRED = -14
const CHANNEL_VERSION = '1.0.2'

export interface WechatOptions {
  token: string | null
  baseUrl: string | null
  cursor: string
  onMessage(message: ImInbound): void
  onStatus(status: LinkStatus | 'scan', error: string | null): void
  /** 要显示的二维码内容；null 收起 */
  onQr(url: string | null): void
  onLogin(token: string, baseUrl: string): void
  /** 登录失效：清掉令牌，要重新扫码 */
  onExpired(): void
  onCursor(cursor: string): void
  fetch?: typeof fetch
  retryBase?: number
}

interface ApiReply {
  ret?: number
  errcode?: number
  errmsg?: string
  get_updates_buf?: string
  msgs?: Array<{
    message_id?: number | string
    seq?: number
    client_id?: string
    from_user_id?: string
    message_type?: number
    context_token?: string
    item_list?: Array<{ type?: number; text_item?: { text?: string } }>
  }>
}

const failed = (r: ApiReply): number => r.errcode || r.ret || 0

/** 随机 uint32 的十进制字符串再 base64，每次请求一个 */
const uin = (): string => Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64')

export class WechatLink implements ImSender {
  readonly maxChars = 1800
  private token: string | null
  private base: string
  private cursor: string
  private stopped = true
  private failures = 0
  private aborter: AbortController | null = null

  constructor(private readonly o: WechatOptions) {
    this.token = o.token
    this.base = o.baseUrl || WECHAT_API
    this.cursor = o.cursor
  }

  private get http(): typeof fetch {
    return this.o.fetch ?? fetch
  }

  start(): void {
    this.stopped = false
    this.aborter = new AbortController()
    void (this.token ? this.poll() : this.login())
  }

  stop(): void {
    this.stopped = true
    this.aborter?.abort()
    this.aborter = null
  }

  private signal(): AbortSignal {
    const timeout = AbortSignal.timeout(POLL_TIMEOUT)
    return this.aborter ? AbortSignal.any([this.aborter.signal, timeout]) : timeout
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': uin(),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    }
  }

  private sleep(): Promise<void> {
    const wait = Math.min(RETRY_MAX, (this.o.retryBase ?? 1000) * 2 ** this.failures++)
    return new Promise(resolve => setTimeout(resolve, wait))
  }

  private async login(): Promise<void> {
    this.o.onStatus('connecting', null)
    try {
      const res = await this.http(`${WECHAT_API}/ilink/bot/get_bot_qrcode?bot_type=3`, { signal: this.signal() })
      const qr = (await res.json()) as { qrcode?: string; qrcode_img_content?: string }
      if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('no qrcode')
      if (this.stopped) return
      this.o.onQr(qr.qrcode_img_content)
      this.o.onStatus('scan', null)
      await this.waitScan(qr.qrcode)
    } catch {
      if (this.stopped) return
      this.o.onQr(null)
      this.o.onStatus('error', 'network')
      await this.sleep()
      if (!this.stopped) return this.login()
    }
  }

  private async waitScan(qrcode: string): Promise<void> {
    while (!this.stopped) {
      let r: { status?: string; bot_token?: string; baseurl?: string }
      try {
        const res = await this.http(`${WECHAT_API}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
          signal: this.signal(),
          headers: { 'iLink-App-ClientVersion': '1' },
        })
        r = (await res.json()) as typeof r
      } catch (e) {
        if (this.stopped) return
        // 长轮询到时没结果：接着等；别的错交给外层
        if ((e as Error).name === 'TimeoutError') continue
        throw e
      }
      if (r.status === 'confirmed' && r.bot_token) {
        this.token = r.bot_token
        // 令牌会发给这个地址：只接受 https
        this.base = r.baseurl?.startsWith('https://') ? r.baseurl : WECHAT_API
        this.o.onQr(null)
        this.o.onLogin(this.token, this.base)
        return this.poll()
      }
      if (r.status === 'expired') {
        this.o.onQr(null)
        this.o.onStatus('error', 'wechatQr')
        return
      }
    }
  }

  private async poll(): Promise<void> {
    this.o.onStatus('connecting', null)
    let online = false
    while (!this.stopped) {
      let r: ApiReply
      try {
        const res = await this.http(`${this.base}/ilink/bot/getupdates`, {
          method: 'POST',
          signal: this.signal(),
          headers: this.headers(),
          body: JSON.stringify({ get_updates_buf: this.cursor, base_info: { channel_version: CHANNEL_VERSION } }),
        })
        r = (await res.json()) as ApiReply
      } catch (e) {
        if (this.stopped) return
        // 长轮询到时没新消息是常态
        if ((e as Error).name === 'TimeoutError') continue
        online = false
        this.o.onStatus('error', 'network')
        await this.sleep()
        continue
      }
      if (this.stopped) return
      const code = failed(r)
      if (code === CODE_EXPIRED) return this.expire()
      if (code) {
        online = false
        this.o.onStatus('error', 'network')
        await this.sleep()
        continue
      }
      this.failures = 0
      if (!online) {
        online = true
        this.o.onStatus('online', null)
      }
      if (r.get_updates_buf && r.get_updates_buf !== this.cursor) {
        this.cursor = r.get_updates_buf
        this.o.onCursor(this.cursor)
      }
      for (const m of r.msgs ?? []) this.deliver(m)
    }
  }

  private expire(): void {
    this.token = null
    this.o.onExpired()
    this.o.onStatus('error', 'wechatExpired')
  }

  private deliver(m: NonNullable<ApiReply['msgs']>[number]): void {
    // message_type 1 是用户发的，2 是机器人自己发的
    if (m.message_type !== 1 || !m.from_user_id || !m.context_token) return
    const id = String(m.message_id ?? m.seq ?? m.client_id ?? randomUUID())
    const text = (m.item_list ?? [])
      .filter(i => i.type === 1)
      .map(i => i.text_item?.text ?? '')
      .join('\n')
    this.o.onMessage({ id, from: m.from_user_id, text, reply: m.context_token })
  }

  async send(to: string, text: string, reply: string | null): Promise<SendResult> {
    if (!reply || !this.token) return 'window'
    const res = await this.http(`${this.base}/ilink/bot/sendmessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(POLL_TIMEOUT),
      headers: this.headers(),
      body: JSON.stringify({
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: reply,
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
    })
    // 502 之类的网页解析不出错误码，不能当发送成功
    if (!res.ok) throw new Error(`WeChat HTTP ${res.status}`)
    const r = (await res.json().catch(() => ({}))) as ApiReply
    const code = failed(r)
    if (!code) return 'sent'
    if (code === CODE_EXPIRED) {
      this.expire()
      return 'window'
    }
    throw new ImRejected(`WeChat ${code}: ${r.errmsg ?? ''}`)
  }
}

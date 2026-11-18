// 长连接的候选线路（docs/network-direct.md §10）：一直自动，CDN → 直连 → IP 依次试，握手没成功就马上换下一档，
// 三档都不行再按退避；落到后面的档时定时看前面的档恢复了没有，恢复了就切回去。
// 团队实时通道（执行机进程也用）和手机中转共用；这里不碰 Electron
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface WsTarget {
  /** 日志用的名字：cdn / direct / ip，手填、云端分配的地址等 */
  tier: string
  url: string
  /** 固定连这个 IP（跳过 DNS），TLS 的 SNI、Host 和证书仍按 url 里的域名 */
  ip?: string
}

/** 连在后面的档时，多久看一次前面的档恢复了没有 */
export const RECOVER_MS = 5 * 60_000

/**
 * 轮到哪一档：一轮从上次连上的那档开始（前面的档不通时不用每次重连都先白跑一趟），往后试、试到头再从第一档补上；
 * 一轮全失败后下一轮从第一档重新开始
 */
export class TierCursor {
  private list: WsTarget[] = []
  /** 这一轮从第几档开始 */
  private start = 0
  /** 这一轮已经换过几档 */
  private tried = 0
  /** 刚切回去的那一档（连上或没连上后清掉） */
  private promoted: number | null = null
  /** 切回去又没连上的次数：CDN 时好时坏（个别节点放行）时，恢复检查的间隔跟着翻倍，免得每 5 分钟断一次 */
  private bounces = 0

  constructor(private readonly targets: () => WsTarget[]) {}

  /** 这次连哪个：一轮的开头重新取候选（地址可能变了） */
  current(): WsTarget | null {
    if (this.tried === 0) {
      this.list = this.targets()
      if (this.start >= this.list.length) this.start = 0
    }
    return this.list[this.index()] ?? null
  }

  /** 当前这档在候选里排第几（0 = 最优先） */
  index(): number {
    return this.list.length ? (this.start + this.tried) % this.list.length : 0
  }

  /** 当前这档握手没成功：还有没试的就返回它（马上试），这一轮试完了返回 null（按退避，下一轮从第一档开始） */
  fail(): WsTarget | null {
    if (this.promoted !== null && this.tried === 0) {
      this.bounces++
      this.promoted = null
    }
    this.tried++
    if (this.tried < this.list.length) return this.list[this.index()]
    this.tried = 0
    this.start = 0
    return null
  }

  /** 连上了：下次重连从这一档开始 */
  connected(): void {
    this.start = this.index()
    this.tried = 0
    if (this.promoted !== null && this.start === this.promoted) this.bounces = 0
    this.promoted = null
  }

  /** 恢复检查的间隔：切回去失败过几次就翻几倍（最多 16 倍，5 分钟 → 80 分钟） */
  recoverEvery(base = RECOVER_MS): number {
    return base * 2 ** Math.min(this.bounces, 4)
  }

  /** 比当前这档优先的那些（恢复检查用），按优先顺序 */
  better(): { target: WsTarget; index: number }[] {
    return this.list.slice(0, this.index()).map((target, index) => ({ target, index }))
  }

  /** 前面的某档恢复了：下次从它开始 */
  promote(index: number): void {
    this.start = index
    this.tried = 0
    this.promoted = index
  }

  reset(): void {
    this.start = 0
    this.tried = 0
    this.promoted = null
    this.bounces = 0
  }
}

/** 一直连不上时日志别刷屏：前 3 次、之后每 10 次、原因变了时记 */
export const logFailure = (attempt: number, changed: boolean): boolean => changed || attempt <= 3 || attempt % 10 === 0

/** 固定解析结果的 lookup（net.connect 的格式） */
export const pinnedLookup =
  (ip: string) =>
  (_host: string, opts: { all?: boolean } | undefined, cb: (...args: unknown[]) => void): void =>
    opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)

/**
 * 用 HTTP 发一次 WebSocket 升级请求，看回什么状态码：101 是能升级（令牌之类的在后面才核对），426 一般是 CDN 去掉了升级头。
 * 不带令牌，写日志和恢复检查用；超时、连不上返回 null
 */
export function handshakeStatus(target: WsTarget, timeoutMs = 8000): Promise<number | null> {
  return new Promise(resolve => {
    let u: URL
    try {
      u = new URL(target.url.replace(/^ws/, 'http'))
    } catch {
      return resolve(null)
    }
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(u, {
      timeout: timeoutMs,
      ...(target.ip ? { lookup: pinnedLookup(target.ip) as never } : {}),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64'),
      },
    })
    const done = (code: number | null): void => {
      resolve(code)
      req.destroy()
    }
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      done(101)
    })
    req.on('response', res => {
      res.resume()
      done(res.statusCode ?? null)
    })
    req.on('timeout', () => done(null))
    req.on('error', () => done(null))
    req.end()
  })
}

/**
 * 连在后面的档时定时看前面的档：哪一档能升级（101）就回调它（调用方断开现在的、从那档重连）。
 * 返回停止函数；连在第一档、或只有一档时什么都不做
 */
export function watchRecovery(
  cursor: TierCursor,
  onRecovered: (target: WsTarget, index: number) => void,
  probe: (target: WsTarget) => Promise<number | null> = handshakeStatus,
  every = cursor.recoverEvery(),
): () => void {
  if (!cursor.better().length) return () => {}
  let busy = false,
    stopped = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        for (const { target, index } of cursor.better()) {
          const status = await probe(target).catch(() => null)
          if (stopped) return
          if (status === 101) return onRecovered(target, index)
        }
      } finally {
        busy = false
      }
    })()
  }, every)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

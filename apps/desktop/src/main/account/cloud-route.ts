// 云端线路择优（docs/network-direct.md §3）：正式站有两条路，CDN 域名和源站直连（都是 HTTPS），各发一次 /healthz 测速，
// 走快的那条；相差不到 SWITCH_MARGIN_MS 不换，免得来回抖。只换之后新发的请求，正在跑的流和 WebSocket 不断。
// 纯函数部分不依赖 electron，方便单测
export interface CloudRoute {
  id: 'cdn' | 'direct'
  base: string
}

/** 正式站的两条路（PIXELSKY_AUTH_URL 指到别处时不择优） */
export const CLOUD_ROUTES: readonly CloudRoute[] = [
  { id: 'cdn', base: 'https://pixelstarrysky.xyz' },
  { id: 'direct', base: 'https://direct.pixelstarrysky.xyz' },
]
/** 快不过这么多就不换 */
export const SWITCH_MARGIN_MS = 100
/** 每条路的测速超时 */
export const PROBE_TIMEOUT_MS = 5_000
/** 多久重测一次 */
export const RECHECK_MS = 10 * 60_000

export interface ProbeResult {
  id: CloudRoute['id']
  /** 毫秒；连不上、非 2xx、不是云端的 /healthz 时为 null */
  ms: number | null
}

/** 一次 /healthz：2xx 且 body 里 ok 为 true 才算通 */
export async function probeRoute(
  route: CloudRoute,
  fetchImpl: typeof fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<ProbeResult> {
  const started = now()
  try {
    const res = await fetchImpl(`${route.base}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      cache: 'no-store',
    })
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null
    return { id: route.id, ms: res.ok && body?.ok === true ? now() - started : null }
  } catch {
    return { id: route.id, ms: null }
  }
}

/**
 * 选哪条：都通取快的，但快不过 SWITCH_MARGIN_MS 就保持现状；只有一条通用它；都不通保持现状。
 * current 为 null（第一次）时取通的里最快的
 */
export function pickRoute(current: CloudRoute['id'] | null, results: readonly ProbeResult[]): CloudRoute['id'] | null {
  const alive = results.filter((r): r is ProbeResult & { ms: number } => r.ms !== null).sort((a, b) => a.ms - b.ms)
  if (!alive.length) return current
  const best = alive[0]
  if (current === null) return best.id
  if (best.id === current) return current
  const mine = alive.find(r => r.id === current)
  if (!mine) return best.id
  return mine.ms - best.ms >= SWITCH_MARGIN_MS ? best.id : current
}

export const routeOf = (id: CloudRoute['id']): CloudRoute => CLOUD_ROUTES.find(r => r.id === id)!

/** 登录前测速的结果在这么久内算新的，不用再测 */
export const LOGIN_PROBE_FRESH_MS = 60_000
/** 请求连不上触发的重测，最多这么久一次 */
export const FAILURE_PROBE_GAP_MS = 15_000

/**
 * 自动模式下开始登录前要不要先测一轮（docs/network-direct.md §8）：授权页在浏览器里打开，开在连不上的线路上
 * 用户只能干等。还没测过、上次测速太旧、或上次测到当前这条不通时先测
 */
export function probeBeforeLogin(
  current: CloudRoute['id'] | null,
  probe: readonly ProbeResult[],
  probedAt: number,
  now: number,
): boolean {
  if (!probe.length || now - probedAt >= LOGIN_PROBE_FRESH_MS) return true
  return current !== null && probe.some(r => r.id === current && r.ms === null)
}

/** 用户在账号页选的：auto 按测速择优；cdn / direct 固定走那条，不通也不换（docs/network-direct.md §7） */
export type RouteMode = 'auto' | CloudRoute['id']

const isRouteId = (v: unknown): v is CloudRoute['id'] => v === 'cdn' || v === 'direct'

/** 存盘的格式 {route, mode}：上次选的那条和用户的选择；读不出来按 null / auto（旧文件没有 mode） */
export function parseSavedRoute(raw: unknown): { route: CloudRoute['id'] | null; mode: RouteMode } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { route?: unknown; mode?: unknown }
  return { route: isRouteId(o.route) ? o.route : null, mode: isRouteId(o.mode) ? o.mode : 'auto' }
}

/**
 * 长连接（团队频道、手机中转、执行机的 WebSocket）走哪条（docs/network-direct.md §9）：CDN 节点大多把 WebSocket 的升级头
 * 去掉（云端回 426，连不上），所以自动模式下固定走直连，只有上次测到直连不通才走 CDN。长连接只握手一次，慢一点不要紧。
 * 用户在账号页指定了线路就按指定的
 */
export function wsRoute(mode: RouteMode, probe: readonly ProbeResult[]): CloudRoute['id'] {
  if (mode !== 'auto') return mode
  return probe.some(r => r.id === 'direct' && r.ms === null) ? 'cdn' : 'direct'
}

/** 长连接的候选档（docs/network-direct.md §10）：ip = 直连域名，但固定连源站 IP（跳过 DNS，SNI、证书仍按域名） */
export type WsTier = CloudRoute['id'] | 'ip'
/** 源站 IP，direct.pixelstarrysky.xyz 的 A 记录 */
export const ORIGIN_IP = '51.81.246.245'

/** 长连接依次试的几档：一直自动，不跟账号页选的线路（用户 2026-11-18：默认 CDN，不行直连，再不行 IP，恢复了切回去） */
export const WS_TIERS: readonly WsTier[] = ['cdn', 'direct', 'ip']

export const isRouteMode = (v: unknown): v is RouteMode => v === 'auto' || isRouteId(v)

/** 请求体这么大以上（多半带图）算大请求：选线路看上传，不看 /healthz 的延迟（docs/ui/pixel-request-size.md §7） */
export const BIG_REQUEST_BYTES = 5 * 1024 * 1024
/** 大请求发出去这么久还没等到响应头就断开，算这条路传不动（Pixel 等 5 分钟）；更短的多半是用户停的 */
export const BIG_REQUEST_SLOW_MS = 4 * 60_000
/** 传不动的那条，这么久内大请求不走 */
export const BIG_REQUEST_AVOID_MS = 30 * 60_000

/** 大请求走哪条：先直连（CDN 回源经常几分钟传不完），直连传不动时换 CDN。只记在内存里 */
export class BigRoute {
  private avoid: { id: CloudRoute['id']; until: number } | null = null

  /** current 是自动选中的线路；直连上次测速不通时就用它 */
  pick(current: CloudRoute['id'], probe: readonly ProbeResult[], now: number): CloudRoute['id'] {
    if (probe.some(r => r.id === 'direct' && r.ms === null)) return current
    const avoid = this.avoid && now < this.avoid.until ? this.avoid.id : null
    return avoid === 'direct' ? 'cdn' : 'direct'
  }

  /**
   * 发一次大请求（send 按线路发）：没连上（notConnected：请求肯定没发出去）就换另一条重发；
   * 连上了但很久没等到响应头就断开的，之后的大请求换一条
   */
  async send(
    current: CloudRoute['id'],
    probe: readonly ProbeResult[],
    send: (id: CloudRoute['id']) => Promise<Response>,
    notConnected: (e: unknown) => boolean,
    now: () => number = Date.now,
  ): Promise<Response> {
    let id = this.pick(current, probe, now())
    const once = async (): Promise<Response> => {
      const started = now()
      try {
        return await send(id)
      } catch (e) {
        if (now() - started >= BIG_REQUEST_SLOW_MS) this.avoid = { id, until: now() + BIG_REQUEST_AVOID_MS }
        throw e
      }
    }
    try {
      return await once()
    } catch (e) {
      if (!notConnected(e)) throw e
      id = id === 'direct' ? 'cdn' : 'direct'
      return once()
    }
  }
}

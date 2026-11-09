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

/** 存盘的格式：上次选的那条；读不出来按 null */
export function parseSavedRoute(raw: unknown): CloudRoute['id'] | null {
  const id = raw && typeof raw === 'object' ? (raw as { route?: unknown }).route : null
  return id === 'cdn' || id === 'direct' ? id : null
}

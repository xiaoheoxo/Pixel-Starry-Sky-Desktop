import { net } from 'electron'
import { codedError } from '@pixelsky/protocol'
import { baseUrl } from '../../account/account'

// 扩展商店的公开请求（docs/ui/extension-store-client.md §3.2）：不带登录令牌，走 Electron 的 net.fetch（认系统代理）。
// 带登录的请求（我的发布、举报）走 account.ts 的 extensionsFetch，不在这里。

const PUBLIC_PATH = /^\/cloud\/(api\/)?extensions(\/|\?|$)/
/** 普通请求（目录、详情、名单）的超时 */
const REQUEST_TIMEOUT_MS = 20_000
/** 下载：这么久没收到新数据就算失败 */
export const IDLE_TIMEOUT_MS = 30_000
/** 下载：总共最多这么久 */
export const TOTAL_TIMEOUT_MS = 10 * 60_000
/** 进度回调的最小间隔 */
export const PROGRESS_INTERVAL_MS = 250

/** fetch 的 cache 取值（主进程的类型里没有 DOM 的 RequestCache） */
export type FetchCache = 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached'

export interface PublicFetchInit {
  method?: 'GET' | 'POST'
  /** 每个调用点明确传：zip 下载 no-store，名单和安装前、更新检查的详情 no-cache，浏览用默认 */
  cache?: FetchCache
  signal?: AbortSignal
  timeoutMs?: number
}

function checkPath(path: string): void {
  if (!PUBLIC_PATH.test(path) || /\.\.|%2e/i.test(path)) throw codedError('extstore.badRequest')
}

/** 请求公开接口（/cloud/api/extensions*、/cloud/extensions/*）。不带 Authorization，不跟随重定向 */
export async function publicFetch(path: string, init: PublicFetchInit = {}): Promise<Response> {
  checkPath(path)
  const signals = [AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS)]
  if (init.signal) signals.push(init.signal)
  return net.fetch(`${baseUrl()}${path}`, {
    method: init.method ?? 'GET',
    credentials: 'omit',
    redirect: 'error',
    ...(init.cache && { cache: init.cache }),
    signal: AbortSignal.any(signals),
  })
}

export interface DownloadOptions {
  maxBytes: number
  /** 详情里写的大小；下载超过它就中止 */
  expectSize?: number
  signal?: AbortSignal
  onProgress?: (received: number, total: number | null) => void
  cache?: FetchCache
  /** 测试用：覆盖两个时限 */
  idleMs?: number
  totalMs?: number
}

export interface Downloaded {
  bytes: Buffer
  headers: Headers
}

/**
 * 限大小的下载：Content-Length 超限直接取消；边读边数，超过 maxBytes 或 expectSize 就中止；
 * idleMs（30 秒）没收到新数据、totalMs（10 分钟）总时限；能取消；进度最多每 250 ms 一次。
 * 失败抛 codedError：extstore.cancelled / timeout / tooLarge / notFound / offline。
 */
export async function downloadCapped(path: string, opts: DownloadOptions): Promise<Downloaded> {
  checkPath(path)
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS
  const totalMs = opts.totalMs ?? TOTAL_TIMEOUT_MS
  const limit = Math.min(opts.maxBytes, opts.expectSize ?? Infinity)
  const ctrl = new AbortController()
  let reason: 'cancelled' | 'timeout' | null = null
  const stop = (why: 'cancelled' | 'timeout'): void => {
    reason ??= why
    ctrl.abort()
  }
  const aborted = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => reject(codedError(`extstore.${reason ?? 'cancelled'}`)), { once: true })
  })
  aborted.catch(() => undefined)
  const onExternalAbort = (): void => stop('cancelled')
  if (opts.signal?.aborted) throw codedError('extstore.cancelled')
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const total = setTimeout(() => stop('timeout'), totalMs)
  let idle = setTimeout(() => stop('timeout'), idleMs)
  const touch = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => stop('timeout'), idleMs)
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let res: Response
    try {
      res = await Promise.race([
        net.fetch(`${baseUrl()}${path}`, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'error',
          cache: opts.cache ?? 'no-store',
          signal: ctrl.signal,
        }),
        aborted,
      ])
    } catch (e) {
      if (reason || isCoded(e)) throw reason ? codedError(`extstore.${reason}`) : e
      throw codedError('extstore.offline')
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw codedError(res.status === 404 ? 'extstore.notFound' : 'extstore.offline')
    }
    const length = Number(res.headers.get('content-length'))
    const declared = Number.isFinite(length) && length > 0 ? length : null
    if (declared !== null && declared > limit) {
      await res.body?.cancel().catch(() => undefined)
      throw codedError('extstore.tooLarge')
    }
    if (!res.body) throw codedError('extstore.offline')
    reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    let lastEmit = Number.NEGATIVE_INFINITY
    let lastEmitted = -1
    const emit = (force: boolean): void => {
      if (!opts.onProgress || received === lastEmitted) return
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
      lastEmit = now
      lastEmitted = received
      opts.onProgress(received, declared)
    }
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>
      try {
        step = await Promise.race([reader.read(), aborted])
      } catch (e) {
        if (isCoded(e)) throw e
        throw codedError(reason ? `extstore.${reason}` : 'extstore.offline')
      }
      if (step.done) break
      touch()
      received += step.value.byteLength
      if (received > limit) throw codedError('extstore.tooLarge')
      chunks.push(step.value)
      emit(false)
    }
    emit(true)
    return { bytes: Buffer.concat(chunks), headers: res.headers }
  } finally {
    clearTimeout(total)
    clearTimeout(idle)
    opts.signal?.removeEventListener('abort', onExternalAbort)
    if (reader) void reader.cancel().catch(() => undefined)
  }
}

function isCoded(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('PIXELSKY_ERR:')
}

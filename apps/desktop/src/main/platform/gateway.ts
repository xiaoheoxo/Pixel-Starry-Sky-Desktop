import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { describeError, logger, type CompactionRequestReport } from '@pixelsky/engine'
import type { SessionRecord } from '@pixelsky/protocol'
import type { ResolvedProvider } from '../core/providers/store'
import { classifyError, providerHeaders, smallModelOf, upstreamUrl, type Fetch } from '../core/providers/upstream'
import { chatUsage, withUsageOption } from './chat-usage'
import { CacheUsageFix } from './usageFix'
import { compactionTap, type CompactionTap } from './compaction-tap'
import { platformModelApi } from '../../shared/platform-models'

const log = logger('gateway')

/** buf 里最后一个完整 SSE 事件结束的位置（事件以空行结尾，\n\n 或 \r\n\r\n）；一个都没有时是 0 */
export function eventEnd(buf: Buffer): number {
  const lf = buf.lastIndexOf('\n\n'),
    crlf = buf.lastIndexOf('\r\n\r\n')
  return Math.max(lf < 0 ? 0 : lf + 2, crlf < 0 ? 0 : crlf + 4)
}

const midStreamError = `event: error\ndata: ${JSON.stringify({
  type: 'error',
  error: { type: 'api_error', message: '上游连接中途断开，这次请求已停止（不自动反复重试，避免重复计费）' },
})}\n\n`

/** 计数接口这些状态码当作「没有这个接口」 */
const COUNT_TOKENS_MISSING = new Set([404, 405, 501])
const COUNT_TOKENS_RECHECK_MS = 60 * 60_000

export interface GatewaySession {
  secret: string
  recordId: string
}

/**
 * 本机网关：平台和自定义 API 的会话都经过它（docs/ui/custom-api.md §4.1）。引擎只拿到本机地址和会话密钥，
 * 每个请求按会话的当前记录选上游：平台发往云端服务，自定义 API 换上真实 Key 发往用户填的地址。
 */
export function platformGateway(options: {
  sessions: Map<string, GatewaySession>
  record: (id: string) => SessionRecord | null | Promise<SessionRecord | null>
  account: () => string | null
  fetch: (path: string, init: RequestInit) => Promise<Response>
  /** Claude Code 压缩请求换模型；models 是这条线路 / 这个接口可用的模型 */
  rewrite?: (body: string, models: () => Promise<string[]>) => Promise<string>
  /** 平台线路的模型，压缩换模型时核对 */
  routeModels?: (groupId: string) => Promise<string[]>
  /** 自定义 API：按 id 取接口配置（带真实 Key） */
  provider?: (id: string) => ResolvedProvider | null
  /** 直接发往自定义接口的 fetch（测试时替换） */
  upstream?: Fetch
  /** 发请求前用本机 ID 记一次；收到响应后带上 Sub2api 回传的 chargeId 再记一次（docs/cloud-service.md §4.9） */
  requestContext?: (
    record: SessionRecord,
  ) => ((requestId: string, model: string, chargeId?: string) => void | Promise<void>) | undefined
  /** Claude Code 压缩请求的实时进度（接通、首字、已输出多少、上游报错），按会话报给宿主 */
  compaction?: (record: SessionRecord, report: CompactionRequestReport) => void
}): Server {
  /** 没有计数接口的自定义接口地址 → 发现的时间；过一小时再试一次（接口可能补上了） */
  const noCountTokens = new Map<string, number>()
  /** 上游的缓存用量口径（GitHub #34）：按线路 / 接口 + 模型记住，含缓存的改回标准口径 */
  const usageFix = new CacheUsageFix()
  return createServer(async (req, res) => {
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const path = req.url?.split('?')[0] ?? ''
    // 日志（docs/ui/logging.md §4.5）：断在哪一段、什么时候、转发了多少
    const started = Date.now()
    let headersAt: number | null = null
    let status: number | null = null
    let bytes = 0
    let requestId: string | null = null
    let sessionId: string | null = null
    /** 已知的、不用每次记警告的失败（自定义接口没有计数接口） */
    let quiet = false
    /** 是压缩请求时读出进度报给会话 */
    let tap: CompactionTap | null = null
    const startTap = (record: SessionRecord, body: string, requested: unknown): CompactionTap | null => {
      const report = options.compaction
      return report && !responses && !chat && !countTokens
        ? compactionTap(r => report(record, r), body, requested)
        : null
    }
    const trace = (error?: unknown) => ({
      path,
      ...(sessionId ? { sessionId } : {}),
      ...(requestId ? { requestId } : {}),
      status,
      elapsedMs: Date.now() - started,
      streamMs: headersAt === null ? null : Date.now() - headersAt,
      bytes,
      ...(error === undefined ? {} : { error: describeError(error) }),
    })
    const responses = path === '/v1/responses'
    const chat = path === '/v1/chat/completions'
    const countTokens = path === '/v1/messages/count_tokens'
    const fail = (status: number, message: string): void => {
      res
        .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(
          JSON.stringify(
            responses || chat
              ? { error: { type: 'invalid_request_error', message } }
              : { type: 'error', error: { type: 'authentication_error', message } },
          ),
        )
    }
    /** usageKey：Messages 请求的「线路或接口 + 模型」，转发时按它校正缓存用量的口径；计数接口、Responses 不传 */
    const pipe = async (upstream: Response, usageKey: string | null = null): Promise<void> => {
      const output: Record<string, string> = {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'no-store',
      }
      for (const name of ['retry-after', 'x-request-id', 'request-id']) {
        const value = upstream.headers.get(name)
        if (value) output[name] = value
      }
      status = upstream.status
      headersAt = Date.now()
      tap?.response(upstream.status)
      res.writeHead(upstream.status, output)
      // Messages 的 SSE 只按完整事件转发：上游中途断开时能接一个 error 事件收尾，而不是掐断连接
      const sse = !responses && !chat && output['Content-Type'].includes('text/event-stream')
      // 非流式的成功响应（Claude Code 流式失败后会改用非流式再试）整个收齐再校正用量，响应体不大
      const rewriter = usageKey === null ? null : usageFix.request(usageKey)
      const whole = rewriter !== null && !sse && upstream.ok && output['Content-Type'].includes('json')
      const held: Buffer[] = []
      // Chat Completions：留下末尾一段，收尾时读最后一个 usage chunk 记进日志
      let chatTail = ''
      let tail: Buffer = Buffer.alloc(0)
      try {
        if (upstream.body)
          for await (const chunk of upstream.body) {
            if (abort.signal.aborted) break
            bytes += chunk.length
            tap?.touch()
            let out = Buffer.from(chunk)
            if (chat) chatTail = (chatTail + out.toString('utf8')).slice(-256 * 1024)
            if (whole) {
              held.push(out)
              continue
            }
            if (sse) {
              const all = tail.length ? Buffer.concat([tail, out]) : out
              const end = eventEnd(all)
              out = all.subarray(0, end)
              tail = all.subarray(end)
              if ((rewriter || tap) && out.length) {
                const text = out.toString('utf8')
                tap?.sse(text)
                const fixed = rewriter ? rewriter.sse(text) : text
                if (fixed !== text) out = Buffer.from(fixed, 'utf8')
              }
            } else if (tap && !upstream.ok) tap.body(out.toString('utf8'))
            if (out.length && !res.write(out)) await once(res, 'drain', { signal: abort.signal })
          }
      } catch (error) {
        if (!sse || abort.signal.aborted) throw error
        // 掐断连接的话 Claude Code 当成网络抖动，最多重试十几次，每次都重发整段上下文、重新计费（压缩时尤其贵）；
        // 回 error 事件：普通请求它只改用非流式再试一次，压缩直接失败
        log.warn('上游连接中途断开', trace(error))
        tap?.fail('上游连接中途断开')
        res.end(midStreamError)
        return
      }
      if (whole && held.length) res.write(rewriter!.json(Buffer.concat(held).toString('utf8')))
      if (tail.length) res.write(tail)
      res.end()
      tap?.end()
      if (abort.signal.aborted) log.info('引擎先断开了连接', trace())
      else if (upstream.status >= 400 && !quiet) log.warn('上游返回错误', trace())
      else {
        const usage = chat && upstream.ok ? chatUsage(chatTail) : null
        log.debug('请求完成', { ...trace(), ...(usage ? { usage } : {}) })
      }
    }
    const passthrough = (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const name of chat
        ? []
        : responses
          ? ['session_id', 'conversation_id', 'originator', 'openai-beta']
          : // Claude Code 的身份头：Sub2api「仅限 Claude Code」的分组靠 User-Agent / X-App / anthropic-beta 认终端
            [
              'anthropic-version',
              'anthropic-beta',
              'user-agent',
              'x-app',
              'anthropic-dangerous-direct-browser-access',
            ]) {
        const value = req.headers[name]
        if (typeof value === 'string') out[name] = value
      }
      return out
    }

    /**
     * 自定义 API：换上真实 Key 发往配置里的地址，不跟随跳转。请求的模型不在接口的模型列表里时（开关默认开），
     * Haiku 这类后台小任务换成后台小模型，其他换成会话当前的模型。
     */
    const forwardCustom = async (
      p: ResolvedProvider,
      record: SessionRecord,
      parsed: { model?: unknown },
      raw: string,
    ) => {
      // Chat Completions：流式请求补 include_usage，没有最后那个 usage chunk 就记不上用量
      if (chat) parsed = withUsageOption(parsed as { model?: unknown; stream?: unknown; stream_options?: unknown })
      let body = chat ? JSON.stringify(parsed) : raw
      const ids = p.models.map(m => m.id)
      const requested = typeof parsed.model === 'string' ? parsed.model : null
      if (p.modelFallback && ids.length && (!requested || !ids.includes(requested))) {
        // 后台小模型只用还在列表里的，保证兜底换成的一定是列表里有的模型
        const small = requested && /haiku/i.test(requested) ? smallModelOf(p) : null
        const current = record.model && ids.includes(record.model) ? record.model : ids[0]
        body = JSON.stringify({ ...parsed, model: small ?? current })
      }
      if (!responses && !chat && !countTokens && options.rewrite) body = await options.rewrite(body, async () => ids)
      tap = startTap(record, body, requested)
      const headers = providerHeaders(p, {
        'content-type': 'application/json',
        accept: countTokens ? 'application/json' : 'text/event-stream',
        ...passthrough(),
      })
      const url = upstreamUrl(p, path)
      // 很多第三方接口没有计数接口：Claude Code 一次连发好几个，每次都 404。记住这个地址，之后在本机直接回 404
      // （它照样改用估算），不再发出去，也不再每次记警告（docs/ui/custom-api.md §8）
      if (countTokens) {
        const since = noCountTokens.get(url)
        if (since !== undefined && Date.now() - since < COUNT_TOKENS_RECHECK_MS) {
          status = 404
          res
            .writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            .end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not Found' } }))
          log.debug('计数接口不可用，本机直接回复', trace())
          return
        }
      }
      let upstream: Response
      try {
        upstream = await (options.upstream ?? fetch)(url, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          signal: abort.signal,
        })
      } catch (error) {
        if (abort.signal.aborted) throw error
        log.warn('连不上自定义接口', trace(error))
        const message = classifyError(error, url).message
        tap?.fail(message)
        fail(502, message)
        return
      }
      if (countTokens && COUNT_TOKENS_MISSING.has(upstream.status)) {
        quiet = true
        if (!noCountTokens.has(url) || Date.now() - noCountTokens.get(url)! >= COUNT_TOKENS_RECHECK_MS)
          log.info('自定义接口没有计数接口，之后在本机直接回复', {
            ...trace(),
            status: upstream.status,
            provider: p.name,
          })
        noCountTokens.set(url, Date.now())
      }
      const model = (JSON.parse(body) as { model?: unknown }).model
      await pipe(
        upstream,
        responses || chat || countTokens ? null : `custom:${p.id}|${String(model ?? record.model ?? '')}`,
      )
    }

    try {
      if (req.method !== 'POST' || (!responses && !chat && !countTokens && path !== '/v1/messages')) {
        fail(404, 'Unsupported gateway endpoint')
        return
      }
      const token = req.headers.authorization?.replace(/^Bearer /i, '') ?? req.headers['x-api-key']
      const session = [...options.sessions.values()].find(entry => entry.secret === token)
      const record = session ? await options.record(session.recordId) : null
      sessionId = record?.id ?? null
      let provider: ResolvedProvider | null = null
      if (record?.provider && !record.platform) {
        provider = options.provider?.(record.provider.id) ?? null
        if (!provider) {
          fail(401, '这个会话用的自定义接口已删除，请换一个接口')
          return
        }
        if (provider.protocol !== (responses ? 'responses' : chat ? 'chat' : 'anthropic')) {
          fail(403, '接口协议与当前引擎不兼容')
          return
        }
        if (!provider.apiKey) {
          fail(401, `自定义接口「${provider.name}」还没有 Key，请在设置里填写`)
          return
        }
      } else if (!record?.platform || options.account() !== record.platform.account) {
        fail(401, '平台账号已退出或切换，请重新登录原账号')
        return
      } else if (countTokens || chat) {
        // 平台线路没有 Chat Completions 入口（云端目录里没有这个协议）
        fail(404, 'Unsupported gateway endpoint')
        return
      }
      // 像素星空三种协议都能走：Messages（与 Claude Code 共用）、Responses（与 Codex 共用）、Chat Completions（只有它）
      const engineOk = chat
        ? record.engine === 'pixel'
        : responses
          ? record.engine === 'codex' || record.engine === 'pixel'
          : record.engine === 'claude' || record.engine === 'pixel'
      if (!engineOk) {
        fail(403, '线路协议与当前引擎不兼容')
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 32 * 1024 * 1024) {
          fail(413, 'Request exceeds size limit')
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      let body = Buffer.concat(chunks).toString('utf8')
      let parsed: { model?: unknown }
      try {
        parsed = JSON.parse(body)
      } catch {
        fail(400, 'Invalid JSON request')
        return
      }
      if (provider) {
        await forwardCustom(provider, record, parsed, body)
        return
      }

      const platform = record.platform!
      const api = responses ? 'responses' : 'messages'
      const recordApi = platformModelApi(record.model)
      if (recordApi && recordApi !== api) {
        fail(403, '线路协议与当前引擎不兼容')
        return
      }
      const trackRequest = options.requestContext?.(record)
      if (responses && (!parsed.model || (record.model && parsed.model !== record.model))) {
        fail(403, '请求模型与当前平台会话不一致')
        return
      }
      const headers = new Headers({
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-PixelSky-Group': platform.groupId,
      })
      for (const [name, value] of Object.entries(passthrough())) headers.set(name, value)
      if (!responses && options.rewrite)
        body = await options.rewrite(body, () => options.routeModels?.(platform.groupId) ?? Promise.resolve([]))
      requestId = `pixelsky-${randomUUID()}`
      const model = String((JSON.parse(body) as { model?: string }).model ?? record.model ?? 'unknown')
      const modelApi = platformModelApi(model)
      if (modelApi && modelApi !== api) {
        fail(403, '线路协议与当前引擎不兼容')
        return
      }
      headers.set('X-Client-Request-ID', requestId)
      tap = startTap(record, body, parsed.model)
      // 先记下再发：记不上（SSH 断了）就不发，免得扣了费却对不上这一轮
      await trackRequest?.(requestId, model)
      const upstream = await options.fetch(responses ? '/v1/platform/responses' : '/v1/platform/messages', {
        method: 'POST',
        headers,
        body,
        signal: abort.signal,
      })
      // Sub2api 不认我们的 ID，调用记录按它自己生成、回在响应头里的 ID 记（docs/cloud-service.md §4.9）
      const chargeId = upstream.headers.get('x-client-request-id')
      if (chargeId && chargeId !== requestId && /^[a-f0-9-]{36}$/.test(chargeId))
        await Promise.resolve(trackRequest?.(requestId, model, chargeId)).catch(error =>
          log.warn('记不上平台请求的计费 ID', { ...trace(error), chargeId }),
        )
      await pipe(upstream, responses ? null : `platform:${platform.groupId}|${model}`)
    } catch (error) {
      if (abort.signal.aborted) tap?.end()
      else tap?.fail((error as Error).message || '上游请求失败')
      if (abort.signal.aborted) log.info('引擎先断开了连接', trace(error))
      else if (res.headersSent) log.warn('上游连接中途断开', trace(error))
      else if ((error as { code?: unknown }).code !== 'AUTH_EXPIRED') log.warn('上游请求失败', trace(error))
      // 平台账号的登录失效（过期或被吊销）：401 加上原因，引擎不会当成暂时故障反复重试
      if (!res.headersSent)
        fail((error as { code?: unknown }).code === 'AUTH_EXPIRED' ? 401 : 502, (error as Error).message)
      else res.destroy()
    }
  })
}

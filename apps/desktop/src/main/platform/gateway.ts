import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { describeError, logger, type CompactionRequestReport } from '@pixelsky/engine'
import type { SessionRecord } from '@pixelsky/protocol'
import type { ResolvedProvider } from '../core/providers/store'
import {
  balanceProblem,
  classifyError,
  providerHeaders,
  redact,
  smallModelOf,
  upstreamMessage,
  upstreamUrl,
  type Fetch,
} from '../core/providers/upstream'
import { stripLongContextSuffix } from './pixel-env'
import { chatUsage, withUsageOption } from './chat-usage'
import { CacheUsageFix } from './usageFix'
import { compactionTap, type CompactionTap } from './compaction-tap'
import { platformModelApi } from '../../shared/platform-models'
import { vendorFallbackModel } from './vendor-models'
import type { SubagentTarget } from '../../shared/types/subagents'
import { SUBAGENT_OPTIONS_PATH } from './subagent-options'

const log = logger('gateway')

/** buf 里最后一个完整 SSE 事件结束的位置（事件以空行结尾，\n\n 或 \r\n\r\n）；一个都没有时是 0 */
export function eventEnd(buf: Buffer): number {
  const lf = buf.lastIndexOf('\n\n'),
    crlf = buf.lastIndexOf('\r\n\r\n')
  return Math.max(lf < 0 ? 0 : lf + 2, crlf < 0 ? 0 : crlf + 4)
}

/**
 * 上游中途断开时的说明。只用中文：Pi 按错误原文里的英文关键词（terminated、connection、timeout、stream ended、5xx 状态码……）
 * 决定要不要自动重试，重试会重发整段上下文、重新计费（pi-ai utils/retry.js）
 */
export const MID_STREAM_TEXT = '上游连接中途断开，这次请求已停止（不自动反复重试，避免重复计费）'

const midStreamError = `event: error\ndata: ${JSON.stringify({
  type: 'error',
  error: { type: 'api_error', message: MID_STREAM_TEXT },
})}\n\n`

/** Responses 中途断开：收尾用 response.failed（Pi 和 OpenAI SDK 都认这个终止事件；错误代码避开 server_error 这类会重试的词） */
const responsesFailed = (code = 'stream_interrupted', message = MID_STREAM_TEXT): string =>
  `event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: {
      id: `resp_pixelsky_${randomUUID().replace(/-/g, '')}`,
      object: 'response',
      status: 'failed',
      error: { code, message },
      output: [],
    },
  })}\n\n`

/** 本机网关收的请求体上限 */
export const BODY_LIMIT = 32 * 1024 * 1024
const OPTIONS_BODY_LIMIT = 64 * 1024
/** Codex 超过上限时的说明（Codex 按错误代码显示它自己的「上下文窗口不够」，这句只进日志和原始事件） */
const TOO_LARGE_TEXT = 'Request exceeds size limit (32 MB): compact the conversation'

/** Chat Completions 中途断开：OpenAI SDK 读到带 error 的数据块就报错 */
const chatFailed = `data: ${JSON.stringify({ error: { type: 'stream_interrupted', message: MID_STREAM_TEXT } })}\n\n`

/** 转发出去的这段 SSE 里有没有正常的收尾事件：Messages 的 message_stop、Responses 的终止事件、Chat 的 finish_reason 或 [DONE]，或者已有错误事件 */
const TERMINAL = {
  messages: /^event:\s*(?:message_stop|error)\s*$|"type"\s*:\s*"message_stop"/m,
  responses: /"type"\s*:\s*"(?:response\.(?:completed|incomplete|failed)|error)"|^event:\s*error\s*$/m,
  chat: /"finish_reason"\s*:\s*"|^data:\s*(?:\[DONE\]|\{\s*"error"\s*:)/m,
} as const

/**
 * 本机网关自己回的错误：类型按状态码（以前一律 authentication_error，502、413 这类也被界面认成要重新登录）。
 * OpenAI 格式的 402 用 insufficient_quota：Pi 认这个词，不会自动重试
 */
export function gatewayErrorType(status: number, openai = false): string {
  if (status === 401) return 'authentication_error'
  if (status === 402) return openai ? 'insufficient_quota' : 'billing_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status === 503 || status === 529) return 'overloaded_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

/** 余额不足 / 额度用完时给像素星空的说明：带上 billing，Pi 不会自动重试（这类错误重试也没用） */
export function balanceText(kind: 'balance' | 'quota', where: string, detail: string): string {
  const head = kind === 'balance' ? `${where}余额不足，请充值后重试` : `${where}的额度已用完`
  const tail = detail.length > 200 ? detail.slice(0, 200) + '…' : detail
  return `${head}（billing${tail ? '：' + tail : ''}）`
}

/** 像素星空的上游错误里这几种状态码可能其实是余额不足（Sub2api 用 403 / 429 回），要看一眼错误体 */
const BALANCE_STATUSES = new Set([400, 403, 429])

/** 像素星空把会话的模型名原样发出：去掉 Claude Code 的 `[1m]` 后缀，上游不认（Claude Code 自己发之前会去掉） */
export function withoutLongContextSuffix(body: string): string {
  if (!body.includes('[1m]') && !body.includes('[1M]')) return body
  const parsed = JSON.parse(body) as { model?: unknown }
  if (typeof parsed.model !== 'string') return body
  const model = stripLongContextSuffix(parsed.model)
  return model === parsed.model ? body : JSON.stringify({ ...parsed, model })
}

/** 计数接口这些状态码当作「没有这个接口」 */
const COUNT_TOKENS_MISSING = new Set([404, 405, 501])
const COUNT_TOKENS_RECHECK_MS = 60 * 60_000

/**
 * 平台的「在途预留」冲突（docs/ui/queue-jump-balance-403.md）：Sub2api 给每个请求先按估算占住一笔余额，
 * 被中断的请求要等后台计费扣完才释放；紧接着的请求（插队、停了马上再发）会因为「余额 − 在途 < 估算」被拒，
 * 回 403 billing_error「insufficient balance」，过几秒就好。同一个平台账号最近这么久内断开过请求，才认为是这种情况
 */
export const RESERVATION_WINDOW_MS = 20_000
/** 认出预留冲突后隔这么久重发一次（只重发一次；被拒的请求 Sub2api 没转发，不扣费） */
export const RESERVATION_RETRY_MS = 2_500

/** 等 ms；引擎断开（signal）时立刻抛出，交给外面按「引擎先断开了连接」收尾 */
const sleep = (ms: number, signal: AbortSignal): Promise<void> => delay(ms, undefined, { signal })

/**
 * 是不是 Sub2api 在途预留拒绝的回应：403 且错误文字正好是「insufficient balance」（Messages 和 Responses 的错误体都认）。
 * 余额真的用完（鉴权层）写的是「Insufficient account balance」，不算；余额低于预留门槛回的是同一句，分不出来，只多重发一次
 */
export function reservationConflict(status: number, text: string): boolean {
  if (status !== 403) return false
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message
    return typeof message === 'string' && message.trim().toLowerCase() === 'insufficient balance'
  } catch {
    return false
  }
}

export interface GatewaySession {
  secret: string
  recordId: string
  /** 像素星空子智能体单独走的站点（设置 › 子智能体）：这把密钥的请求按它选上游，其余照会话记录 */
  target?: SubagentTarget
}

/** 子智能体的请求：会话记录换成子智能体的站点和模型（计费、日志仍记在这个会话上） */
export function subagentRecord(record: SessionRecord, target: SubagentTarget): SessionRecord {
  return {
    ...record,
    platform: target.kind === 'platform' ? { groupId: target.groupId, account: target.account } : null,
    provider: target.kind === 'custom' ? { id: target.providerId } : null,
    model: target.model,
  }
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
  /** 在途预留冲突的等待（测试时缩短）：最近断开过的时间窗口、重发前等多久 */
  reservationRetry?: { windowMs: number; delayMs: number }
  /** 主模型调度：命令行问现在能选哪些模型；密钥不对时返回 null（这把密钥不在 sessions 里，发不了模型请求） */
  subagentOptions?: (token: string, request: unknown) => Promise<unknown | null>
}): Server {
  /** 没有计数接口的自定义接口地址 → 发现的时间；过一小时再试一次（接口可能补上了） */
  const noCountTokens = new Map<string, number>()
  /** 平台账号 → 最近一次引擎断开平台请求的时间（那个请求的在途预留可能还没释放） */
  const recentAborts = new Map<string, number>()
  const reservationRetry = options.reservationRetry ?? {
    windowMs: RESERVATION_WINDOW_MS,
    delayMs: RESERVATION_RETRY_MS,
  }
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
    /** 已经发往平台的请求属于哪个平台账号：引擎中途断开时记下（Sub2api 那边可能还占着它的在途预留） */
    let sentAccount: string | null = null
    const noteAbort = (): void => {
      if (sentAccount) recentAborts.set(sentAccount, Date.now())
    }
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
      const type = gatewayErrorType(status, responses || chat)
      res
        .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(
          JSON.stringify(
            responses || chat
              ? { error: { type, ...(status === 402 ? { code: type } : {}), message } }
              : { type: 'error', error: { type, message } },
          ),
        )
    }
    /**
     * Codex 的请求太大（网关 32 MB 或上游 413）：回它认得的上下文超限（response.failed + context_length_exceeded），
     * 下一轮先压缩，压缩请求也超限时它会丢掉最旧的历史再试；回 413 它只当普通错误重试，之后每轮都 413（ui/pixel-request-size.md §5）
     */
    const codexTooLarge = (message: string): void => {
      status = 200
      res
        .writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
        .end(responsesFailed('context_length_exceeded', message))
    }
    /** 像素星空的会话（Pi 会按错误原文重试；余额错误、中途断开要按它的规则回） */
    let pixel = false
    /** 上游报余额不足时说是谁（平台 / 自定义接口「名字」），detail 里的 Key 去掉 */
    let balanceWhere = '平台'
    let redactDetail = (text: string): string => text
    /** usageKey：Messages 请求的「线路或接口 + 模型」，转发时按它校正缓存用量的口径；计数接口、Responses 不传 */
    const pipe = async (upstream: Response, usageKey: string | null = null): Promise<void> => {
      // 像素星空：余额不足 / 额度用完常以 403 / 429 回来（Sub2api），改成 402 加说明：界面按余额提示，Pi 不按 429 重试
      if (pixel && BALANCE_STATUSES.has(upstream.status)) {
        const text = await upstream.text()
        const kind = balanceProblem(text)
        if (kind) {
          status = 402
          headersAt = Date.now()
          bytes += Buffer.byteLength(text)
          log.warn('上游报余额不足或额度用完', { ...trace(), upstreamStatus: upstream.status })
          const message = balanceText(kind, balanceWhere, redactDetail(upstreamMessage(text)))
          tap?.fail(message)
          fail(402, message)
          return
        }
        upstream = new Response(text, { status: upstream.status, headers: upstream.headers })
      }
      // Responses 线路只有 Codex 和像素星空；像素星空（Pi）认 413，自己压缩重试
      if (responses && !pixel && upstream.status === 413) {
        const text = await upstream.text()
        log.warn('上游说请求太大', { ...trace(), upstreamStatus: 413, detail: redactDetail(upstreamMessage(text)) })
        codexTooLarge('Upstream rejected the request as too large: compact the conversation')
        return
      }
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
      // SSE 只按完整事件转发：上游中途断开时能接一个错误事件收尾，而不是掐断连接。Messages 一直这样；
      // Responses / Chat 只对像素星空（掐断的话 Pi 报 terminated、按它的规则重试三次）。Codex 遇到 response.failed 怎么处理没验证过，照旧
      const sse = output['Content-Type'].includes('text/event-stream') && (pixel || (!responses && !chat))
      const protocol = responses ? 'responses' : chat ? 'chat' : 'messages'
      const failEvent = (): string => (responses ? responsesFailed() : chat ? chatFailed : midStreamError)
      // 像素星空：上游正常结束却没有收尾事件（云端的 Responses 中途断开就是这样）时也补一个错误事件，
      // 不然 Pi 报「stream ended before …」又去重试
      let terminal = !(pixel && sse && upstream.ok)
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
              if ((rewriter || tap || !terminal) && out.length) {
                const text = out.toString('utf8')
                if (!terminal && TERMINAL[protocol].test(text)) terminal = true
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
        res.end(failEvent())
        return
      }
      if (whole && held.length) res.write(rewriter!.json(Buffer.concat(held).toString('utf8')))
      // 最后一个事件后面没有空行：照样转发（收尾事件可能就在这里）
      if (!terminal && tail.length && TERMINAL[protocol].test(tail.toString('utf8'))) terminal = true
      if (!terminal && !abort.signal.aborted) {
        // 没收尾就结束了：半截事件丢掉，补一个错误事件
        log.warn('上游没发收尾事件就结束了', trace())
        tap?.fail('上游连接中途断开')
        res.end(failEvent())
        return
      }
      if (tail.length) res.write(tail)
      res.end()
      tap?.end()
      if (abort.signal.aborted) {
        noteAbort()
        log.info('引擎先断开了连接', trace())
      } else if (upstream.status >= 400 && !quiet) log.warn('上游返回错误', trace())
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
      if (pixel) body = withoutLongContextSuffix(body)
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
      if (req.method === 'POST' && path === SUBAGENT_OPTIONS_PATH && options.subagentOptions) {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size <= OPTIONS_BODY_LIMIT) chunks.push(Buffer.from(chunk))
        }
        if (size > OPTIONS_BODY_LIMIT) return fail(413, 'Request exceeds size limit')
        let request: unknown = null
        try {
          request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          return fail(400, 'Invalid JSON request')
        }
        const token = req.headers.authorization?.replace(/^Bearer /i, '') ?? ''
        const reply = await options.subagentOptions(token, request)
        if (!reply) return fail(401, 'Invalid token')
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(reply))
        return
      }
      if (req.method !== 'POST' || (!responses && !chat && !countTokens && path !== '/v1/messages')) {
        fail(404, 'Unsupported gateway endpoint')
        return
      }
      const token = req.headers.authorization?.replace(/^Bearer /i, '') ?? req.headers['x-api-key']
      const session = [...options.sessions.values()].find(entry => entry.secret === token)
      const current = session ? await options.record(session.recordId) : null
      const record = current && session?.target ? subagentRecord(current, session.target) : current
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
      pixel = record.engine === 'pixel'
      if (provider) {
        const p = provider
        balanceWhere = `自定义接口「${p.name}」`
        redactDetail = text => redact(text, p)
      }
      const chunks: Buffer[] = []
      let size = 0
      // 超限也读完再回：中途跳出循环会销毁请求，回复可能发不全
      for await (const chunk of req) {
        size += chunk.length
        if (size <= BODY_LIMIT) chunks.push(Buffer.from(chunk))
      }
      if (size > BODY_LIMIT) {
        log.warn('请求超过本机网关的大小上限', { ...trace(), size, engine: record.engine, model: record.model })
        if (responses && record.engine === 'codex') codexTooLarge(TOO_LARGE_TEXT)
        else fail(413, 'Request exceeds size limit')
        return
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
      if (pixel) body = withoutLongContextSuffix(body)
      // DeepSeek 这类线路没有 Claude 模型：Claude Code 请求的 claude-* 换成线路里的模型（haiku 后台请求换小模型）
      if (!responses && options.routeModels) {
        const sent = JSON.parse(body) as { model?: unknown }
        const fallback = vendorFallbackModel(
          await options.routeModels(platform.groupId),
          typeof sent.model === 'string' ? sent.model : null,
          record.model,
        )
        if (fallback) body = JSON.stringify({ ...sent, model: fallback })
      }
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
      const send = (): Promise<Response> =>
        options.fetch(responses ? '/v1/platform/responses' : '/v1/platform/messages', {
          method: 'POST',
          headers,
          body,
          signal: abort.signal,
        })
      sentAccount = platform.account
      let upstream = await send()
      // 刚断开过一个请求（插队、停了马上再发）就被在途预留拒了：旧请求的预留几秒后才释放，等一下原样重发一次，
      // 引擎看不到这次拒绝（docs/ui/queue-jump-balance-403.md）。还被拒就照常转给引擎
      const aborted = recentAborts.get(platform.account)
      if (upstream.status === 403 && aborted !== undefined && Date.now() - aborted <= reservationRetry.windowMs) {
        const text = await upstream.text()
        if (reservationConflict(upstream.status, text)) {
          log.info('平台的在途预留还没释放，稍后重发一次', { ...trace(), abortedMsAgo: Date.now() - aborted })
          await sleep(reservationRetry.delayMs, abort.signal)
          upstream = await send()
        } else upstream = new Response(text, { status: upstream.status, headers: upstream.headers })
      }
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
      if (abort.signal.aborted) noteAbort()
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

// 报错提示的结构化信息（notice.error）和标题里的 HTTP 状态码（docs/ui/conversation-ux-2.md §2.1）
import { describe, expect, it } from 'vitest'
import { classifyErrorText, type EngineEvent, type Item, type NoticeErrorKind } from '@pixelsky/protocol'
import { ERROR_TEXT, apiNoticeError, friendlyApiError } from '../src/claude/apiError'
import { ClaudeTranslator } from '../src/claude/translate'
import { textError } from '../src/pixel/translate'
import { turnNoticeError } from '../src/codex/session'

describe('服务出错的标题带 HTTP 状态码', () => {
  const server = (status: number): string =>
    `API Error: ${status} Internal server error. This is a server-side issue, usually temporary — try again in a moment.`

  it('500 / 502 / 503 不再是同一句话：状态码放进标题', () => {
    for (const status of [500, 502, 503, 504])
      expect(friendlyApiError('server_error', server(status))).toBe(
        `服务出错（HTTP ${status}），通常是暂时的，稍后再试`,
      )
  })

  it('529 / 429 的标题也带状态码；原文里没有状态码时保持原来的标题', () => {
    expect(friendlyApiError('server_error', 'API Error: 529 Overloaded')).toBe('服务繁忙（HTTP 529），请稍后再试')
    expect(friendlyApiError('overloaded', 'API Error: 529 Overloaded')).toBe('服务繁忙（HTTP 529），请稍后再试')
    expect(friendlyApiError('rate_limit', 'API Error: Request rejected (429) · slow down')).toBe(
      '请求太频繁（HTTP 429），已触发限额',
    )
    expect(friendlyApiError('server_error', 'API Error: Internal server error')).toBe(ERROR_TEXT.server_error)
    expect(friendlyApiError('server_error', 'Overloaded')).toBe(ERROR_TEXT.overloaded)
    expect(friendlyApiError('rate_limit', 'rate limited')).toBe(ERROR_TEXT.rate_limit)
  })

  it('连不上模型服务、原文里的状态码不是 5xx 时不带状态码', () => {
    expect(friendlyApiError('server_error', 'API Error: 404 not found (ECONNRESET)')).toBe(
      '连不上模型服务：检查网络、代理或防火墙',
    )
    expect(friendlyApiError('server_error', 'API Error: 429 something')).toBe(ERROR_TEXT.server_error)
  })
})

describe('报错提示的结构化信息（notice.error）', () => {
  /** 用真实的合成消息 + 失败结果走一遍翻译器，取出那条错误提示 */
  const noticeOf = (code: string, raw: string): Extract<Item, { kind: 'notice' }> => {
    const events: EngineEvent[] = []
    const t = new ClaudeTranslator('D:/work', {
      emit: e => events.push(e),
      sessionId: () => {},
      permissionMode: () => {},
      turnEnded: () => {},
      fastState: () => {},
    })
    t.startTurn('turn-1')
    t.handle({
      type: 'assistant',
      message: { id: 'msg_1', model: '<synthetic>', content: [{ type: 'text', text: raw }] },
      error: code,
      parent_tool_use_id: null,
    })
    t.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, result: raw })
    const notices = events.flatMap(e =>
      e.type === 'item_completed' && e.item.kind === 'notice' && e.item.level === 'error' ? [e.item] : [],
    )
    expect(notices).toHaveLength(1)
    return notices[0]
  }

  // 引擎 ERROR_TEXT 里每个代码：[典型原文, 期望的归类]；新增代码必须在这里表态
  const EXPECTED: Record<string, [raw: string, kind: NoticeErrorKind | undefined]> = {
    authentication_failed: ['Please run /login · API Error: 401 OAuth token has expired', 'auth'],
    oauth_org_not_allowed: ['OAuth organization is not allowed to use Claude Code', undefined],
    account_on_hold: ['Your account is on hold', undefined],
    verification_required: ['Verification required', undefined],
    billing_error: ['Credit balance is too low', 'balance'],
    rate_limit: ['API Error: Request rejected (429) · slow down', 'busy'],
    overloaded: ['API Error: 529 Overloaded', 'busy'],
    invalid_request: ['API Error: 400 invalid request', undefined],
    model_not_found: ["There's an issue with the selected model (claude-nope).", 'route'],
    server_error: ['API Error: 502 Bad gateway', 'busy'],
    max_output_tokens: ['Output blocked by max_output_tokens', undefined],
    cloud_credential_error: ['Could not load credentials from any providers', undefined],
  }

  it('ERROR_TEXT 里每个代码都表态了，产出的提示带正确的 kind 和 code，并且按文字猜得到同一个结果', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(ERROR_TEXT).sort())
    for (const [code, [raw, kind]] of Object.entries(EXPECTED)) {
      const n = noticeOf(code, raw)
      expect(n.error?.kind, code).toBe(kind)
      expect(n.error?.code, code).toBe(code)
      // 老会话没有 error 字段，界面按文字猜：猜出来的必须和引擎给的一致
      expect(classifyErrorText(n.text), `${code}: ${n.text}`).toBe(kind ?? null)
    }
  })

  it('状态码记在 error.status 里，标题也带上', () => {
    const n = noticeOf('server_error', 'API Error: 502 Bad gateway')
    expect(n.error).toEqual({ kind: 'busy', code: 'server_error', status: 502 })
    expect(n.text).toBe('服务出错（HTTP 502），通常是暂时的，稍后再试')
    expect(noticeOf('rate_limit', 'API Error: Request rejected (429) · slow').error?.status).toBe(429)
  })

  it('同一个代码的特例：没有权限算 route、连不上模型服务不归类', () => {
    const permission = noticeOf(
      'authentication_failed',
      'Failed to authenticate. API Error: 403 Your API key does not have permission to use the specified resource.',
    )
    expect(permission.error).toEqual({ kind: 'route', code: 'authentication_failed', status: 403 })
    expect(classifyErrorText(permission.text)).toBe('route')
    const offline = noticeOf(
      'server_error',
      'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
    )
    expect(offline.error?.kind).toBeUndefined()
    expect(classifyErrorText(offline.text)).toBeNull()
  })

  it('上下文超限归 overflow；压缩也失败的那句不归（再压缩没有用）', () => {
    const overflow = noticeOf(
      'invalid_request',
      'Prompt is too long · the request is ~250000 tokens (limit 200000) but this conversation is only ~2249 tokens',
    )
    expect(overflow.error?.kind).toBe('overflow')
    expect(overflow.text).toBe('上下文太长：先压缩（/compact）或开一个新会话')
    expect(classifyErrorText(overflow.text)).toBe('overflow')
    const compaction = noticeOf(
      'invalid_request',
      'Prompt is too long · automatic compaction failed: summarization produced empty response',
    )
    expect(compaction.error?.kind).toBeUndefined()
    expect(classifyErrorText(compaction.text)).toBeNull()
  })

  it('原文带中文（平台网关的说明）按文字认，不信代码', () => {
    const n = noticeOf('authentication_failed', 'API Error: 403 分组不可用，请换一个线路')
    expect(n.error).toEqual({ kind: 'route', code: 'authentication_failed', status: 403 })
    expect(noticeOf('authentication_failed', 'API Error: 401 平台账号已退出或切换，请重新登录原账号').error?.kind).toBe(
      'auth',
    )
  })

  it('认不出的报错不带 error 字段', () => {
    const n = noticeOf('', 'something odd happened')
    expect(n.error).toBeUndefined()
    expect('error' in n).toBe(false)
  })
})

describe('Codex / Pixel 的报错归类', () => {
  // 真实协议的 codexErrorInfo 是 camelCase（codex-cli 0.163.0 的 schema）：字符串，或 { 类型名: { httpStatusCode } }
  it('Codex：codexErrorInfo 的类型名当代码，HTTP 状态码取出来', () => {
    const kindOf = (codexErrorInfo: unknown) => turnNoticeError({ message: 'x', codexErrorInfo }, 'x')?.kind
    expect(turnNoticeError({ message: 'x', codexErrorInfo: 'contextWindowExceeded' }, 'x')).toEqual({
      kind: 'overflow',
      code: 'contextWindowExceeded',
    })
    expect(kindOf('usageLimitExceeded')).toBe('balance')
    expect(kindOf('sessionBudgetExceeded')).toBe('balance')
    expect(kindOf('unauthorized')).toBe('auth')
    expect(kindOf('rateLimitExceeded')).toBe('busy')
    expect(kindOf('serverOverloaded')).toBe('busy')
    expect(kindOf('internalServerError')).toBe('busy')
    // 连接问题不归类；带 429 状态码时按状态码归 busy
    expect(
      turnNoticeError({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } } }, 'x'),
    ).toEqual({ code: 'httpConnectionFailed' })
    expect(
      turnNoticeError({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }, 'x'),
    ).toEqual({ kind: 'busy', code: 'httpConnectionFailed', status: 429 })
    // 带状态码但不在归类表里的：只记下，不归类
    expect(
      turnNoticeError({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } }, 'x'),
    ).toEqual({ code: 'httpConnectionFailed', status: 502 })
    expect(turnNoticeError({ message: 'plain failure' }, 'plain failure')).toBeUndefined()
  })

  it('Codex：上下文超限的真实原句 + 代码', () => {
    const message =
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
    expect(turnNoticeError({ message, codexErrorInfo: 'contextWindowExceeded' }, message)).toEqual({
      kind: 'overflow',
      code: 'contextWindowExceeded',
    })
    // 老版本没有 codexErrorInfo：按原句认
    expect(turnNoticeError({ message }, message)).toEqual({ kind: 'overflow' })
  })

  it('Codex：已知代码优先于原文里的上下文字样', () => {
    const message = 'rate limit exceeded: too many tokens per minute'
    expect(turnNoticeError({ message, codexErrorInfo: 'rateLimitExceeded' }, message)).toEqual({
      kind: 'busy',
      code: 'rateLimitExceeded',
    })
  })

  it('Pixel：只有原文，认状态码和上下文超限', () => {
    expect(textError('429 {"type":"error","error":{"type":"rate_limit_error"}}')).toEqual({ kind: 'busy', status: 429 })
    expect(textError('Prompt is too long: 250000 tokens > 200000 maximum')?.kind).toBe('overflow')
    expect(textError('Request failed after retries')).toBeUndefined()
  })
})

describe('各种上下文超限的说法', () => {
  it('英文原文和我们翻好的中文都认', () => {
    for (const text of [
      'Prompt is too long',
      'API Error: 400 {"error":{"code":"context_length_exceeded"}}',
      "This model's maximum context length is 128000 tokens",
      'Too many tokens in the request',
      'Codex: contextWindowExceeded',
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      '上下文太长：先压缩（/compact）或开一个新会话',
    ])
      expect(classifyErrorText(text), text).toBe('overflow')
  })
})

describe('已知代码 / 状态码优先于上下文字样', () => {
  it('Claude：限流（429）的原文里带 “too many tokens” 仍是 busy；没有代码时才按文字认 overflow', () => {
    expect(apiNoticeError('rate_limit', 'API Error: Request rejected (429) · too many tokens per minute')).toEqual({
      kind: 'busy',
      code: 'rate_limit',
      status: 429,
    })
    expect(apiNoticeError('invalid_request', 'Prompt is too long')?.kind).toBe('overflow')
    expect(apiNoticeError(null, 'API Error: 400 context_length_exceeded')?.kind).toBe('overflow')
  })
})

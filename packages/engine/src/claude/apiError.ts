// Claude Code 的报错说人话（docs/ui/conversation-ux-2.md §2.1）。
// 实测：每次 API 报错它先发一条合成的助手消息（model 是 <synthetic>，带 error 代码，内容是一句英文），
// 再发 is_error 的结果，result 是同一句英文。这里按代码和英文原文给出提示的第一行，原文放进「详情」。
import {
  ERROR_CODE_KIND,
  classifyErrorText,
  errorKindOfStatus,
  httpStatusOf,
  isOverflowText,
  type NoticeError,
  type NoticeErrorKind,
} from '@pixelsky/protocol'

/** assistant 消息里 error 字段的说明 */
export const ERROR_TEXT: Record<string, string> = {
  authentication_failed: '登录已失效：在终端运行 claude auth login 重新登录',
  oauth_org_not_allowed: '当前账号的组织不允许使用 Claude Code',
  account_on_hold: '账号已被暂停',
  verification_required: '账号需要验证',
  billing_error: '账户余额或账单有问题',
  rate_limit: '请求太频繁，已触发限额',
  overloaded: '服务繁忙，请稍后再试',
  invalid_request: '请求无效',
  model_not_found: '找不到所选模型',
  server_error: '服务出错，通常是暂时的，稍后再试',
  max_output_tokens: '回复超过了最大长度',
  cloud_credential_error: '云服务凭据有问题',
}

const CJK = /[一-鿿]/
const UNREACHABLE =
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|connection (?:refused|error|reset)|fetch failed|network error/i
const PERMISSION = /\b403\b|permission/i
/**
 * 接口返回的流不合规（第三方中转常见，docs/ui/error-retry.md §10）：思考增量发到了不是思考的内容块上、
 * 压缩请求拿到空的总结、回复没发完（缺少结束标记）就断了。按原文认，不管错误代码（这类常是 unknown）。
 */
const STREAM_FORMAT: Array<[RegExp, string]> = [
  [
    /not a thinking block|signature_delta/i,
    '接口返回的思考内容格式不对（第三方中转常见）：对这个接口关掉思考，或者换一个接口',
  ],
  [
    /automatic compaction failed[^]*(empty response|never arrived)/i,
    '上下文太长，自动压缩也没成功：接口给压缩请求返回了空内容或没发完。可以开一个新会话，或换一个接口再压缩（/compact）',
  ],
  [
    /never arrived|response above may be incomplete/i,
    '接口的回复没发完就断了，上面的内容可能不完整；可以重试，反复出现就换一个接口',
  ],
]

/** 把状态码放进提示的第一小句后面：「服务出错，通常是…」→「服务出错（HTTP 502），通常是…」；没有逗号就放在最后 */
function withStatus(text: string, status: number | undefined): string {
  if (status === undefined) return text
  const at = text.indexOf('，')
  const tag = `（HTTP ${status}）`
  return at < 0 ? text + tag : text.slice(0, at) + tag + text.slice(at)
}

/** 没有合成消息时（例如旧版本只给结果原文），从原文认出同样的错误类型；不像 API 报错的返回 null */
export function errorCodeFromText(raw: string): string | null {
  if (!/API Error|Invalid API key|authentication_error|Prompt is too long|overloaded|rate.?limit/i.test(raw))
    return null
  if (/\b40[13]\b|authentication_error|Invalid API key|Failed to authenticate/i.test(raw))
    return 'authentication_failed'
  if (/\b429\b|rate.?limit/i.test(raw)) return 'rate_limit'
  if (/Prompt is too long/i.test(raw)) return 'invalid_request'
  if (UNREACHABLE.test(raw) || /\b5\d\d\b|overloaded/i.test(raw)) return 'server_error'
  if (/\b404\b|not_found_error/i.test(raw)) return 'model_not_found'
  return null
}

/**
 * 一次 API 报错给用户看的那句；认不出时返回 null，照原文显示。
 * 原文里带中文的也返回 null：那是像素星空自己的平台网关、适配层写好的说明，换成通用的一句反而丢信息。
 */
export function friendlyApiError(code: string | null, raw: string): string | null {
  if (CJK.test(raw)) return null
  const format = STREAM_FORMAT.find(([re]) => re.test(raw))
  if (format) return format[1]
  const c = code || errorCodeFromText(raw)
  if (!c) return null
  const status = httpStatusOf(raw)
  switch (c) {
    case 'authentication_failed':
      if (PERMISSION.test(raw)) return '没有权限：当前账号或 API Key 不能用这个模型或资源'
      if (/api[ -]?key/i.test(raw)) return 'API Key 无效：检查环境变量里的 ANTHROPIC_API_KEY'
      return ERROR_TEXT.authentication_failed
    case 'server_error':
      if (UNREACHABLE.test(raw)) return '连不上模型服务：检查网络、代理或防火墙'
      if (/\b529\b|overloaded/i.test(raw)) return withStatus(ERROR_TEXT.overloaded, status === 529 ? 529 : undefined)
      // 500 / 502 / 503 原来是同一句话：状态码放进标题，不用点开详情才知道
      return withStatus(ERROR_TEXT.server_error, status !== undefined && status >= 500 ? status : undefined)
    case 'overloaded':
      return withStatus(ERROR_TEXT.overloaded, status === 529 ? 529 : undefined)
    case 'rate_limit':
      return withStatus(ERROR_TEXT.rate_limit, status === 429 ? 429 : undefined)
    case 'invalid_request':
      if (isOverflowText(raw)) return '上下文太长：先压缩（/compact）或开一个新会话'
      return ERROR_TEXT.invalid_request
    default:
      return ERROR_TEXT[c] ?? null
  }
}

/**
 * 这次报错的结构化信息（notice.error）：界面按 kind 给按钮，不再按翻好的中文猜。
 * 代码表是协议里的 ERROR_CODE_KIND；这里只处理同一个代码的特例：没有权限算 route、连不上模型服务不归类、上下文超限算 overflow。
 * 原文带中文的（平台网关、适配层写好的说明）代码常不准，先按文字认
 */
export function apiNoticeError(code: string | null, raw: string): NoticeError | undefined {
  const c = code || errorCodeFromText(raw) || undefined
  const status = httpStatusOf(raw)
  const byCode = c ? ERROR_CODE_KIND[c] : undefined
  let kind: NoticeErrorKind | undefined
  if (STREAM_FORMAT.some(([re]) => re.test(raw))) kind = undefined
  // 已知的代码 / 状态码优先：限流提示里带 “too many tokens” 之类的话不能被当成上下文超限
  else if (!byCode && errorKindOfStatus(status) === undefined && isOverflowText(raw)) kind = 'overflow'
  else if (CJK.test(raw)) kind = classifyErrorText(raw) ?? byCode
  else if (c === 'authentication_failed' && PERMISSION.test(raw)) kind = 'route'
  else if (c === 'server_error' && UNREACHABLE.test(raw)) kind = undefined
  else kind = byCode ?? errorKindOfStatus(status) ?? classifyErrorText(raw) ?? undefined
  if (!kind && !c && status === undefined) return undefined
  return { ...(kind ? { kind } : {}), ...(c ? { code: c } : {}), ...(status !== undefined ? { status } : {}) }
}

// 不影响使用的引擎警告（docs/ui/ai-commit-codex-warnings-history.md §3）：Codex 读到用户 config.toml 里
// 不认识的设置项、开了开发中的功能时，每轮都会发一条 warning。这类和哪一轮无关，不进对话：
// 引擎报给宿主，显示在设置 › 本机引擎 › Codex 的「配置提示」里；读出旧会话时把以前存下的去掉。
// 以后看到新的同类警告再加进来

import type { NoticeError, NoticeErrorKind } from './types/item'

const QUIET_WARNINGS: readonly [key: string, re: RegExp][] = [
  ['unrecognized', /^Codex is ignoring \d+ unrecognized configuration settings?\b/i],
  ['unstable', /^Under-development features? enabled\b/i],
]

/** 配置类警告属于哪一类；同一类新的一条替换旧的（例如改掉一个设置项后「忽略 2 个」变成「忽略 1 个」）。别的警告返回 null */
export function quietWarningKey(text: string): string | null {
  const head = text.trimStart()
  return QUIET_WARNINGS.find(([, re]) => re.test(head))?.[0] ?? null
}

/** 这条警告是不是只和用户自己的配置有关、不影响使用 */
export function isQuietWarning(text: string): boolean {
  return quietWarningKey(text) !== null
}

// ---------------------------------------------------------------------------
// 报错提示的归类（NoticeError.kind）：引擎填结构化的 kind，界面优先用它，没有时才按文字猜
// ---------------------------------------------------------------------------

const NOTICE_ERROR_KINDS: readonly NoticeErrorKind[] = ['auth', 'balance', 'route', 'busy', 'overflow']

/** 界面读到未知的 kind（以后新增的、别的版本写的）时当没有，退回按文字猜 */
export function isNoticeErrorKind(value: unknown): value is NoticeErrorKind {
  return typeof value === 'string' && (NOTICE_ERROR_KINDS as readonly string[]).includes(value)
}

/**
 * 引擎给的错误代码 → 归类，只有这一张表。Claude Code 的是合成消息里的 error 代码（claude/apiError.ts 的 ERROR_TEXT），
 * Codex 的是 TurnError.codexErrorInfo 的类型名——协议里是 camelCase（codex-cli 0.163.0 的
 * `codex app-server generate-json-schema` 里 CodexErrorInfo 的全部取值，下面逐个表过态）。
 * 没列的代码（invalid_request、max_output_tokens、badRequest、other……）不归类；
 * 同一个代码的特例（没有权限算 route、连不上不算 busy）由引擎按原文调整
 */
export const ERROR_CODE_KIND: Readonly<Record<string, NoticeErrorKind>> = {
  // Claude Code
  authentication_failed: 'auth',
  billing_error: 'balance',
  rate_limit: 'busy',
  overloaded: 'busy',
  server_error: 'busy',
  model_not_found: 'route',
  // Codex（CodexErrorInfo，camelCase）
  unauthorized: 'auth',
  usageLimitExceeded: 'balance',
  sessionBudgetExceeded: 'balance',
  rateLimitExceeded: 'busy',
  serverOverloaded: 'busy',
  internalServerError: 'busy',
  flexUnavailable: 'busy',
  contextWindowExceeded: 'overflow',
  // 其余不归类（写在这里是为了「逐个表过态」，不放进表）：
  //   httpConnectionFailed / responseStreamConnectionFailed / responseStreamDisconnected / responseTooManyFailedAttempts
  //     = 连接问题，和 Claude「连不上模型服务」一样不归类（带 4xx / 5xx 状态码时仍按状态码归）
  //   cyberPolicy / misalignmentPolicyViolation / tooManyDenials / badRequest / threadRollbackFailed /
  //   sandboxError / activeTurnNotSteerable / other = 与登录、余额、线路、繁忙、上下文无关
}

/** 原文里的 HTTP 状态码（只认 4xx / 5xx） */
const STATUS_IN_RAW = [
  /API Error:?\s*(?:Request rejected\s*)?\(?([45]\d\d)\b/i,
  /\bHTTP(?: status(?: code)?)?[ :]*([45]\d\d)\b/i,
  /\bstatus(?: code)?[ :=]+([45]\d\d)\b/i,
]
/** 认不出返回 undefined */
export function httpStatusOf(raw: string): number | undefined {
  for (const re of STATUS_IN_RAW) {
    const m = re.exec(raw)
    if (m) return Number(m[1])
  }
  return undefined
}

/** HTTP 状态码 → 归类（和按文字猜时认的状态码一致）；别的状态码不归类 */
export function errorKindOfStatus(status: number | null | undefined): NoticeErrorKind | undefined {
  if (status === 401) return 'auth'
  if (status === 402) return 'balance'
  if (status === 403 || status === 404) return 'route'
  if (status === 429 || status === 529) return 'busy'
  return undefined
}

/**
 * 上下文超限的各种说法（Claude「Prompt is too long」、OpenAI 系「context_length_exceeded / maximum context length」、
 * Codex 的 contextWindowExceeded 和 “ran out of room in the model's context window”、我们翻好的「上下文太长」）。压缩失败的那句（上下文太长，自动压缩也没成功）不算：再压缩也没用
 */
const OVERFLOW =
  /Prompt is too long|context[_ ]length|maximum context|context window (?:exceeded|is full)|ContextWindowExceeded|ran out of room in the model's context window|too many tokens|上下文(?:太长|超限|超出)/i
const COMPACTION_FAILED = /自动压缩也没成功|automatic compaction failed/i

/** 这句话是不是在说上下文超限 */
export function isOverflowText(text: string): boolean {
  return OVERFLOW.test(text) && !COMPACTION_FAILED.test(text)
}

/**
 * 按错误文字归类（老会话和别的来源没有 NoticeError 时用）：Claude Code 的错误码已在引擎里翻成中文，
 * 平台代理 / 适配层返回中文或 HTTP 状态码
 */
export function classifyErrorText(text: string): NoticeErrorKind | null {
  if (isOverflowText(text)) return 'overflow'
  if (/登录已失效|已退出或切换|已改用自有|API Key 无效|authentication|unauthori[sz]ed|\b401\b/i.test(text))
    return 'auth'
  if (/余额|账单|billing|insufficient|quota|\b402\b/i.test(text)) return 'balance'
  if (/分组|线路|找不到所选模型|没有权限|not available|model_not_found|forbidden|\b403\b|\b404\b/i.test(text))
    return 'route'
  if (/频繁|限额|繁忙|服务出错|rate.?limit|overloaded|\b429\b|\b529\b/i.test(text)) return 'busy'
  return null
}

/**
 * 给 Codex、Pixel 这类只有代码 / 状态码 / 原文的来源用：代码表 → 状态码 → 原文，哪个先认出用哪个；什么都没有时返回 undefined。
 * 已知的代码 / 状态码优先于文字：限流提示里带 “too many tokens” 之类的话不能被当成上下文超限
 */
export function noticeErrorOf(input: {
  code?: string | null
  status?: number | null
  text?: string
}): NoticeError | undefined {
  const code = input.code || undefined
  const status = typeof input.status === 'number' && input.status > 0 ? input.status : undefined
  const kind =
    (code ? ERROR_CODE_KIND[code] : undefined) ??
    errorKindOfStatus(status) ??
    (input.text ? (classifyErrorText(input.text) ?? undefined) : undefined)
  if (!kind && !code && status === undefined) return undefined
  return { ...(kind ? { kind } : {}), ...(code ? { code } : {}), ...(status !== undefined ? { status } : {}) }
}

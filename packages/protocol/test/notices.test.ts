import { describe, expect, it } from 'vitest'
import {
  ERROR_CODE_KIND,
  classifyErrorText,
  isOverflowText,
  noticeErrorOf,
  isQuietWarning,
  quietWarningKey,
} from '../src/notices'

describe('isQuietWarning', () => {
  it('认出 Codex 的配置类警告（单复数、前面有空白）', () => {
    expect(
      isQuietWarning(
        'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n  user (~/.codex/config.toml): `x` is ignored.',
      ),
    ).toBe(true)
    expect(isQuietWarning('Codex is ignoring 1 unrecognized configuration setting.')).toBe(true)
    expect(
      isQuietWarning(
        '\nUnder-development features enabled: local_thread_store_compaction. Under-development features are incomplete.',
      ),
    ).toBe(true)
  })
  it('别的警告和报错不算', () => {
    expect(isQuietWarning('Model metadata for `gpt-x` not found.')).toBe(false)
    expect(isQuietWarning('Reconnecting... 1/5')).toBe(false)
    expect(isQuietWarning('提示：Codex is ignoring 2 unrecognized configuration settings')).toBe(false)
    expect(isQuietWarning('')).toBe(false)
  })
})

describe('quietWarningKey', () => {
  it('同一类警告的数量变了仍是同一类', () => {
    expect(quietWarningKey('Codex is ignoring 2 unrecognized configuration settings.')).toBe('unrecognized')
    expect(quietWarningKey('Codex is ignoring 1 unrecognized configuration setting.')).toBe('unrecognized')
    expect(quietWarningKey('Under-development features enabled: a, b.')).toBe('unstable')
    expect(quietWarningKey('Model metadata for `gpt-x` not found.')).toBeNull()
  })
})

// codex-cli 0.163.0 `codex app-server generate-json-schema` 里 CodexErrorInfo 的全部取值（camelCase）：
// 字符串枚举 + 带 httpStatusCode 的对象变体 + activeTurnNotSteerable。新版本多出来的值要在这里表态
const CODEX_ERROR_INFO: Record<string, 'auth' | 'balance' | 'route' | 'busy' | 'overflow' | undefined> = {
  contextWindowExceeded: 'overflow',
  sessionBudgetExceeded: 'balance',
  usageLimitExceeded: 'balance',
  rateLimitExceeded: 'busy',
  flexUnavailable: 'busy',
  serverOverloaded: 'busy',
  cyberPolicy: undefined,
  misalignmentPolicyViolation: undefined,
  tooManyDenials: undefined,
  internalServerError: 'busy',
  unauthorized: 'auth',
  badRequest: undefined,
  threadRollbackFailed: undefined,
  sandboxError: undefined,
  other: undefined,
  httpConnectionFailed: undefined,
  responseStreamConnectionFailed: undefined,
  responseStreamDisconnected: undefined,
  responseTooManyFailedAttempts: undefined,
  activeTurnNotSteerable: undefined,
}

describe('ERROR_CODE_KIND（Codex 的 CodexErrorInfo 是 camelCase）', () => {
  it('schema 里的每个取值都按约定归类，没列的不归类', () => {
    for (const [code, kind] of Object.entries(CODEX_ERROR_INFO)) {
      expect(ERROR_CODE_KIND[code], code).toBe(kind)
      expect(noticeErrorOf({ code, text: 'x' })?.kind, code).toBe(kind)
    }
  })

  it('表里没有 PascalCase 的老写法（真实协议不会发）', () => {
    for (const code of Object.keys(ERROR_CODE_KIND)) expect(code, code).not.toMatch(/^[A-Z]/)
  })

  it('连接类的错误带 4xx / 5xx 状态码时按状态码归，别的不归类', () => {
    expect(noticeErrorOf({ code: 'httpConnectionFailed', status: 429, text: 'x' })?.kind).toBe('busy')
    expect(noticeErrorOf({ code: 'responseStreamDisconnected', status: 502, text: 'x' })).toEqual({
      code: 'responseStreamDisconnected',
      status: 502,
    })
    expect(noticeErrorOf({ code: 'httpConnectionFailed', text: 'error sending request' })).toEqual({
      code: 'httpConnectionFailed',
    })
  })
})

describe('上下文超限的文字和优先级', () => {
  it("认 Codex 的原句 “ran out of room in the model's context window”", () => {
    const text =
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying."
    expect(isOverflowText(text)).toBe(true)
    expect(classifyErrorText(text)).toBe('overflow')
    expect(noticeErrorOf({ code: 'contextWindowExceeded', text })?.kind).toBe('overflow')
    // 没带代码时按文字认
    expect(noticeErrorOf({ text })).toEqual({ kind: 'overflow' })
  })

  it('已知的代码 / 状态码优先于文字：限流提示里带 “too many tokens” 不算上下文超限', () => {
    const text = 'Rate limit reached: too many tokens per minute, context length unchanged'
    expect(noticeErrorOf({ code: 'rateLimitExceeded', text })?.kind).toBe('busy')
    expect(noticeErrorOf({ status: 429, text })?.kind).toBe('busy')
    // 代码不认识、也没有可归类的状态码，才退回文字
    expect(noticeErrorOf({ code: 'other', text: 'Too many tokens in the request' })?.kind).toBe('overflow')
    expect(noticeErrorOf({ code: 'badRequest', status: 400, text: 'maximum context length is 128000' })?.kind).toBe(
      'overflow',
    )
  })
})

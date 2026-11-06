export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 当前上下文占用的 token 数 */
  contextTokens: number
  /** 上下文窗口大小；不知道时为 null */
  contextWindow: number | null
  /** 本会话累计花费（美元）；引擎不报告时为 null */
  costUsd: number | null
}

/** 一轮里一个模型的用量；四个 token 字段互不包含 */
export interface ModelTurnUsage {
  costSource?: import('../billing').CostSource
  billing?: import('../billing').BillingSource
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 引擎报告的费用（美元）；不报告时为 null（例如 Codex） */
  costUsd: number | null
  /** 这一轮这个模型的请求次数 */
  requests?: number
  /** 量到的输出时间（毫秒）和这段时间的输出量；量不准的引擎和旧记录没有（docs/ui/usage-learn.md §1.1） */
  genMs?: number
  genOutput?: number
  /** 这一轮从开始到第一次收到内容（毫秒）；只记在第一个请求的模型上 */
  firstTokenMs?: number
}

/** 一轮的用量（docs/ui/usage.md §6.1） */
export interface TurnUsage {
  settlement?: import('../billing').PlatformSettlement
  /** 'official'：自定义 API 的会话，费用按官方模型定价估算（docs/ui/custom-api.md §4.3） */
  estimate?: 'official'
  /** 键是模型 id */
  models: Record<string, ModelTurnUsage>
  /** 这一轮总耗时（毫秒） */
  durationMs: number
}

export interface RequestCacheUsage {
  turnId: string
  messageId: string
  model: string
  input: number
  cacheRead: number
  cacheWrite: number
  observedAt: number
}

export interface RequestRetryState {
  turnId: string
  attempt: number | null
  maxRetries: number | null
  retryAt: number | null
  reason: string
}

/**
 * 压缩请求在本机网关上的实时进度（平台和自定义 API 的 Claude Code 会话才有）：网关转发压缩请求时顺带读出来的，
 * 界面据此显示「等待接通 / 模型读取对话 / 输出摘要 / 整理上下文」。瞬时状态，不落盘；结束时汇总写进压缩条目
 */
export interface CompactionProgress {
  /** 对应的压缩条目 */
  itemId: string
  /** 这次压缩发了几次请求（Claude Code 失败后会重发），从 1 起 */
  requests: number
  /** 实际请求的模型（换成压缩模型后就是压缩模型） */
  model: string | null
  /** Claude Code 原本请求的模型；没换模型时和 model 相同 */
  requestedModel: string | null
  /** 当前这次请求发出的时间 */
  requestAt: number
  /** 收到上游响应头的时间 */
  connectedAt: number | null
  /** 上游的 HTTP 状态码 */
  status: number | null
  /** 第一段摘要内容到达的时间 */
  firstTokenAt: number | null
  /** 最近一次收到摘要内容的时间 */
  lastContentAt: number | null
  /** 最近一次收到任何数据的时间（含心跳） */
  lastByteAt: number | null
  /** 已输出的 token：结束前按字数估，拿到上游用量后换成准确值 */
  outputTokens: number
  outputExact: boolean
  /** 上游这次请求已经结束（成功或失败） */
  done: boolean
  /** 上游报错或中途断开的原因 */
  error: string | null
}

export interface CacheWarning {
  sessionId: string
  turnId: string
  messageId: string
  title: string
  model: string
  input: number
  cached: number
  previousInput: number
  expiresAt: number
}

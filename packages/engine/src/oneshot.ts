// 用引擎自己的登录单独问一次（AI 写提交信息的 Claude 授权 / ChatGPT 授权通道，docs/ui/ai-commit-channels.md §4）：
// 不进任何会话、不给工具、不留记录，在临时目录里跑

/** model 为 null 时跟随引擎自己的设置 */
export interface OneShotRequest {
  prompt: string
  model: string | null
  requireEphemeral?: true
}

export interface OneShotUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface OneShotReply {
  text: string
  /** 实际用的模型（引擎报的）；拿不到时 null */
  model: string | null
  usage: OneShotUsage | null
}

/**
 * 出错原因：notInstalled 引擎没装或太旧；notAuthorized 没登录 / 登录失效；usageLimit 订阅额度用完；
 * model 没有这个模型；timeout 超时；cancelled 停止了；failed 其他
 */
export type OneShotProblem =
  | 'notInstalled'
  | 'notAuthorized'
  | 'usageLimit'
  | 'model'
  | 'timeout'
  | 'cancelled'
  | 'failed'

export class OneShotError extends Error {
  constructor(
    readonly kind: OneShotProblem,
    message: string,
  ) {
    super(message)
    this.name = 'OneShotError'
  }
}

/** 一次最多等这么久 */
export const ONE_SHOT_TIMEOUT = 90_000

/** 引擎报的错误原话 → 原因（两家的说法都认） */
export function oneShotProblem(text: string): OneShotProblem {
  if (/usage limit|usage_limit|limit reached|hit your (usage )?limit|rate limit|quota|额度/i.test(text))
    return 'usageLimit'
  if (
    /not logged in|please run \/login|invalid api key|unauthorized|\b401\b|authentication|login required|未登录/i.test(
      text,
    )
  )
    return 'notAuthorized'
  if (
    /model.*(not found|not exist|not supported|unknown|invalid)|(unknown|invalid) model|模型.*(不存在|不支持)/i.test(
      text,
    )
  )
    return 'model'
  return 'failed'
}

/** null 沿用引擎默认；0 是关闭，不能用 truthy 判断。 */
export function retryLimit(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 15)
    throw new Error('重试次数必须是 0～15 的整数')
  return value
}

/**
 * 一轮失败的原因是哪一类连接问题（docs/ui/error-retry.md）：
 * 'network'：断线、超时、网关 5xx、上游繁忙——请求没送到或回复没收完，重连有用；
 * 'exit'：引擎进程意外退出——不知道消息收没收到，只有引擎确认收到过这条才值得「继续」；
 * null：不是连接问题。登录失效、余额不足、模型不可用、请求被拒、限额这些重连也没用，照常失败。
 * 原文同时带网络关键词和「意外退出」的算 'network'。引擎已经把常见报错翻成中文（claude/apiError.ts），中英文都认。
 */
export type ConnectionKind = 'network' | 'exit'
export function connectionKind(text: string | null | undefined): ConnectionKind | null {
  if (!text) return null
  if (
    /登录已失效|余额|账单|API Key 无效|没有权限|找不到所选模型|请求太频繁|限额|上下文太长|请求无效|\b40[0-4]\b|\b429\b|unauthori[sz]ed|forbidden|billing|insufficient|quota|rate.?limit|Prompt is too long/i.test(
      text,
    )
  )
    return null
  if (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|connection (?:refused|error|reset|closed|lost)|stream (?:disconnected|error|closed)|disconnected before completion|error sending request|timed? ?out|\b50[234]\b|\b529\b|bad gateway|service unavailable|gateway timeout|overloaded|premature close|unexpected EOF|连不上模型服务|网络错误|网络连接|服务繁忙|服务出错|回复没发完就断了/i.test(
      text,
    )
  )
    return 'network'
  return /意外退出|process exited/i.test(text) ? 'exit' : null
}

/** 失败的原因是不是连接类的（connectionKind 不是 null） */
export function isConnectionError(text: string | null | undefined): boolean {
  return connectionKind(text) !== null
}

/** 第几次自动重连前等多久（毫秒）：1 秒起翻倍，封顶 30 秒，加 ±20% 随机（很多会话同时断线时不一起重连） */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1))
  return Math.round(base * (0.8 + random() * 0.4))
}

/** 自动重连最多几次：请求重试是「跟随引擎」时 5 次（和 Codex 的流重连一样），自定义了就按自定义，0 是关闭 */
export const RECONNECT_DEFAULT = 5
export function reconnectLimit(maxRetries: number | null): number {
  return maxRetries === null ? RECONNECT_DEFAULT : maxRetries
}

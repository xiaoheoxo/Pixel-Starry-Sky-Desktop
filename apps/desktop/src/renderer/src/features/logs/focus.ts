// 从对话里的报错跳到设置 › 日志（docs/ui/logging.md §3.2）：先记下要筛的会话和时间，日志页打开后取走
export interface LogFocus {
  sessionId: string
  since: number
}

/** 从这一轮开始前一点筛起：条目时间和用户消息时间来自不同的地方，留一点余量 */
const LEAD_MS = 60_000
const EVENT = 'pixelsky:log-focus'
let pending: LogFocus | null = null

/** 筛到这个会话、from（这一轮的用户消息时间）以后；日志页已经打开时立即生效 */
export function requestLogFocus(sessionId: string, from: number): void {
  pending = { sessionId, since: from - LEAD_MS }
  window.dispatchEvent(new Event(EVENT))
}

/** 把另一个窗口里记下的请求原样放回来（开设置独立窗口时随打开请求带过来的，docs/ui/settings-window.md） */
export function restoreLogFocus(focus: LogFocus): void {
  pending = focus
  window.dispatchEvent(new Event(EVENT))
}

export function takeLogFocus(): LogFocus | null {
  const focus = pending
  pending = null
  return focus
}

/** 日志页打开期间收到新的跳转请求 */
export function onLogFocus(callback: () => void): () => void {
  window.addEventListener(EVENT, callback)
  return () => window.removeEventListener(EVENT, callback)
}

// 额度来源的操作请求（docs/ui/source-switch.md §3.5）：对话流里错误卡片上的按钮发 window 事件，
// 由同一会话的输入框接住执行（打开模型菜单、切换额度来源要先确认，都由输入框负责）。
export const SOURCE_ACTION_EVENT = 'pixelsky:source-action'

/**
 * retry：出错后一键接着做，往会话里发一条「继续」（和 Claude 桌面版的 Try again 一样）；
 * compact-retry：上下文超限时先压缩（排进队列的 /compact），再发同一条「继续」，排在压缩后面
 */
export type SourceAction =
  | 'open-menu'
  | 'use-self'
  | 'use-platform'
  | 'open-account'
  | 'sign-in'
  | 'edit-provider'
  | 'retry'
  | 'compact-retry'

export function requestSourceAction(sessionId: string, action: SourceAction): void {
  window.dispatchEvent(new CustomEvent(SOURCE_ACTION_EVENT, { detail: { sessionId, action } }))
}

/** 等会话的输入框挂上再执行的操作：侧栏悬停卡里的「重试」「改线路」这类要输入框做的按钮，会话还没打开时先记着 */
const pending = new Map<string, { action: SourceAction; at: number }>()
/** 记着的操作超过这么久没人接就作废（会话没打开成功时，不要过一会儿在别的时候突然执行） */
export const PENDING_SOURCE_ACTION_MS = 15_000

/**
 * 先记下，再发一次事件：会话已经打开（输入框在）时事件直接被接住；还没打开时，由调用方去打开会话，
 * 输入框挂上后用 takePendingSourceAction 取走执行
 */
export function requestSourceActionAfterOpen(sessionId: string, action: SourceAction, now = Date.now()): void {
  pending.set(sessionId, { action, at: now })
  if (typeof window !== 'undefined') requestSourceAction(sessionId, action)
}

/** 取走（同时清掉）这个会话记着的操作；过期的当没有 */
export function takePendingSourceAction(sessionId: string, now = Date.now()): SourceAction | null {
  const entry = pending.get(sessionId)
  pending.delete(sessionId)
  return entry && now - entry.at <= PENDING_SOURCE_ACTION_MS ? entry.action : null
}

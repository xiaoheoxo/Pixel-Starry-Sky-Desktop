// 概况里的「明细」打开输入框旁的上下文弹窗（弹窗开关是 ContextWindowButton 自己的状态）。
// 只通知当下挂着的按钮，不留状态：留着的话按钮重新挂载时又弹一次
const listeners = new Set<(sessionId: string) => void>()

export function requestContextDetails(sessionId: string): void {
  for (const listener of listeners) listener(sessionId)
}

export function onContextDetails(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

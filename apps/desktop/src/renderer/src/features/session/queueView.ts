import type { QueuedMessage, QueueMove } from '@pixelsky/protocol'

/** 空闲时直接发送、正在启动的消息：显示在对话里，不放进消息队列（docs/ui/message-queue.md §2.1）。 */
export function isStarting(q: QueuedMessage, paused: boolean): boolean {
  return !!q.direct && !q.held && !paused && !q.reconnect && (q.status === 'queued' || q.status === 'dispatching')
}

/** 断线后正在自动重连的那条：显示重连卡片（ReconnectStatus），不放进消息队列。
 *  单独暂停（held）的留在队列里等「继续队列」，不算重连中 */
export function isReconnecting(q: QueuedMessage): boolean {
  return !!q.reconnect && !q.held && (q.status === 'queued' || q.status === 'dispatching')
}

/** 到点后过了这么久还是排队、没开始派发：宿主那边没排上（会话忙、锁住等），卡片不再装作「正在连接」 */
const STALLED_MS = 3000

export type ReconnectPhase = 'waiting' | 'connecting' | 'paused' | 'stalled'

/** 重连卡片处在哪个阶段：倒计时中 / 正在连接 / 队列暂停 / 到点却没动静。调用方保证 q 是 isReconnecting 的 */
export function reconnectPhase(q: QueuedMessage, paused: boolean, now: number): ReconnectPhase {
  if (paused) return 'paused'
  if (q.status === 'dispatching') return 'connecting'
  const at = q.reconnect?.at ?? Infinity
  if (now < at) return 'waiting'
  return now - at > STALLED_MS ? 'stalled' : 'connecting'
}

/** 失败的这条已经在对话里：可以「关掉」，不重发也不撤回 */
export function canDismiss(q: QueuedMessage): boolean {
  return (q.status === 'failed' || q.status === 'uncertain') && !!q.messageUuid
}

/** 直接发送却没能开始的消息：仍在队列面板里给出重试 / 撤回，但标为「发送失败」而不是排队。
 *  「待核对」另有含义（可能已交付），保留原标签。 */
export function isSendFailure(q: QueuedMessage): boolean {
  return !!q.direct && q.status === 'failed'
}

/** 已经在交付的消息：不能当调序的锚点（排到它前面等于插到正在发的消息前面） */
const inFlight = (q: QueuedMessage): boolean => ['dispatching', 'running', 'delivering'].includes(q.status)

/**
 * 上移 / 下移要发给宿主的调序目标，按界面上这一刻看到的邻居算成 { before: 消息 id }（不用下标，
 * 点击到宿主收到之间队首发完了也不会挪错）。上移 = 排到上一条前面；下移 = 排到「下一条的下一条」前面，
 * 后面没有了就是 null（排到最后）。挪不了（已经在头 / 尾，或上一条已经在交付）返回 null。
 * items 是界面上列出的那些（隐藏的重连 / 正在跑的不在里面）
 */
export function queueMoveTarget(items: readonly QueuedMessage[], id: string, dir: -1 | 1): QueueMove | null {
  const at = items.findIndex(q => q.id === id)
  if (at < 0 || items[at].status !== 'queued') return null
  if (dir < 0) {
    const prev = items[at - 1]
    return prev && !inFlight(prev) ? { before: prev.id } : null
  }
  if (!items[at + 1]) return null
  const after = items[at + 2]
  return { before: after ? after.id : null }
}

type MoveKey = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

/** 队列行上的调序快捷键：Alt+↑ / Alt+↓（单按方向键留给列表滚动）；返回 -1、1，不匹配返回 0 */
export function queueMoveKey(e: MoveKey): -1 | 0 | 1 {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return 0
  return e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
}

// 消息队列（docs/mobile-remote.md §17 第 2 项）：哪些放进队列面板、每条显示什么、能做什么。
// 规则和桌面端 features/session/queueView.ts、QueuedMessages.tsx 一样（docs/ui/message-queue.md）。
import { replaceCodedErrors, type QueueMove, type QueuedMessage, type SessionSnapshot } from '@pixelsky/protocol'

/** 空闲时直接发送、正在启动的消息：显示在对话里，不放进队列面板 */
export function isStarting(q: QueuedMessage, paused: boolean): boolean {
  return !!q.direct && !q.held && !paused && !q.reconnect && (q.status === 'queued' || q.status === 'dispatching')
}

/** 断线后电脑正在自动重连的那条：面板里写「正在重连 n/m」，可以立即重连或停止；
 *  单独暂停（held）的按普通暂停项显示 */
export const isReconnecting = (q: QueuedMessage): boolean =>
  !!q.reconnect && !q.held && (q.status === 'queued' || q.status === 'dispatching')

/** 失败的这条已经在对话里：可以「关掉」，不重发也不撤回，对话里标「未送达」 */
export const canDismiss = (q: QueuedMessage): boolean =>
  (q.status === 'failed' || q.status === 'uncertain') && !!q.messageUuid

/** 直接发送却没能开始的消息：仍在队列面板里给重试 / 撤回，但标为「发送失败」 */
export const isSendFailure = (q: QueuedMessage): boolean => !!q.direct && q.status === 'failed'

/** 队列面板里要显示的消息（正在执行的在对话里） */
export function queueItems(snapshot: Pick<SessionSnapshot, 'queue' | 'queuePaused'>): QueuedMessage[] {
  return snapshot.queue.filter(q => q.status !== 'running' && !isStarting(q, snapshot.queuePaused))
}

/** 已经在交付，不能撤回 / 插队 */
export const isPending = (q: QueuedMessage): boolean => q.status === 'dispatching' || q.status === 'delivering'

/** paused：整个队列暂停（比如电脑重启后恢复出来的）。重连项这时不会自己重连，要点「继续重连」 */
export function queueLabel(q: QueuedMessage, paused = false): string {
  if (q.reconnect && isReconnecting(q))
    return `${paused ? '重连已暂停' : '正在重连'} ${q.reconnect.attempt}/${q.reconnect.max}`
  if (isSendFailure(q)) return '发送失败'
  if (q.status === 'failed') return '执行失败'
  if (q.status === 'uncertain') return '待核对'
  if (q.status === 'delivering') return '等待接收'
  if (q.status === 'dispatching') return '正在启动'
  if (q.held) return '已暂停'
  return '排队中'
}

/** 面板标题：全是发送失败的、暂停了的、普通排队 */
export function queueTitle(items: QueuedMessage[], paused: boolean): string {
  if (items.length && items.every(isSendFailure)) return '发送失败'
  return paused || items.some(q => q.held) ? '队列已暂停' : '排队中'
}

/** 能不能「引导」：这条还在排队，引擎支持运行中引导，当前有一轮在跑（设置是否一致由电脑判断） */
export function canSteer(q: QueuedMessage, snapshot: Pick<SessionSnapshot, 'state' | 'turnId' | 'flags'>): boolean {
  return (
    q.status === 'queued' && snapshot.flags.steerAvailable === true && snapshot.state === 'running' && !!snapshot.turnId
  )
}

/** 上移 / 下移发给电脑的调序目标：按手机上这一刻看到的邻居算成 { before: 消息 id }，不用下标
 *  （点击到电脑收到之间队首发完了也不会挪错）。上移 = 排到上一条前面；下移 = 排到下一条的下一条前面，后面没有了就是 null（最后）。
 *  挪不了（已在头 / 尾，或上一条已经在交付）返回 null。规则同桌面 queueView.ts 的 queueMoveTarget */
export function queueMoveTarget(items: readonly QueuedMessage[], id: string, dir: -1 | 1): QueueMove | null {
  // 正在重连的那条桌面端不放进列表，也不能当锚点：跳过它，邻居按桌面看到的算
  items = items.filter(q => q.id === id || !isReconnecting(q))
  const at = items.findIndex(q => q.id === id)
  if (at < 0 || items[at].status !== 'queued') return null
  if (dir < 0) {
    const prev = items[at - 1]
    return prev && prev.status !== 'running' && !isPending(prev) ? { before: prev.id } : null
  }
  if (!items[at + 1]) return null
  const after = items[at + 2]
  return { before: after ? after.id : null }
}

/**
 * 上移 / 下移最终发给电脑的参数。电脑 hello 带 queueMoveBefore 才发 { before }；
 * 旧版电脑把对象当「第 0 位」，会把消息挪到队首，所以退回旧写法：消息在整个队列（snapshot.queue）里的下标 ±1。
 * 挪不了返回 null
 */
export function queueMoveArg(
  queue: readonly QueuedMessage[],
  items: readonly QueuedMessage[],
  id: string,
  dir: -1 | 1,
  supportsBefore: boolean,
): QueueMove | number | null {
  if (supportsBefore) return queueMoveTarget(items, id, dir)
  const index = queue.findIndex(q => q.id === id)
  if (index < 0 || queue[index].status !== 'queued') return null
  if (dir < 0) return index <= 0 ? null : index - 1
  return index >= queue.length - 1 ? null : index + 1
}

/** 操作失败时给人看的话：电脑回的「队列已变化」是带代码的错误，换成中文；别的原样 */
export function queueErrorText(message: string): string {
  return replaceCodedErrors(message, info => (info.code === 'queue.changed' ? '队列已变化，排序未保存' : message))
}

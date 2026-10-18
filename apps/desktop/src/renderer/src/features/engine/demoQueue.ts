// 演示模式里的消息队列和错误卡片「重试」（docs/ui/demo-conversation.md §3）：不连引擎，按钮直接改演示快照，
// 让队列面板、发送失败、重试、撤回这些在演示数据里也看得到效果。不是演示模式时都不起作用。
import type { ApprovalDecision, Item, QueuedMessage } from '@pixelsky/protocol'
import { isDemo } from '@/data'
import { tr } from '../../i18n/core'
import type { QueueController } from './hooks'
import { updateDemoSnapshot, useEngineState } from './store'

const NOT_SENT = '演示模式不会真的发送。'

/**
 * 演示模式里答复审批（docs/ui/approval-stack.md）：移走这一项，对话里对应的工具行改成完成 / 已拒绝；
 * 都处理完就回到空闲。不是演示模式时什么都不做
 */
export function demoAnswer(sessionId: string, requestId: string, decision: ApprovalDecision): void {
  updateDemoSnapshot(sessionId, snap => {
    const request = snap.pending.find(p => p.requestId === requestId)
    if (!request) return snap
    const pending = snap.pending.filter(p => p !== request)
    const status = decision.type === 'deny' ? 'declined' : 'completed'
    const items = snap.items.map(i =>
      i.id === request.itemId && (i.kind === 'command' || i.kind === 'file_change' || i.kind === 'tool')
        ? ({ ...i, status } as Item)
        : i,
    )
    return { ...snap, pending, items, state: pending.length ? snap.state : 'idle' }
  })
}

let seq = 0
const demoId = (prefix: string): string => `${prefix}-${Date.now()}-${++seq}`

/** 对话末尾补上一条用户消息和一句演示说明 */
function appendTurn(
  sessionId: string,
  user: Omit<Extract<Item, { kind: 'user' }>, 'kind' | 'id' | 'createdAt'>,
  note: string,
) {
  updateDemoSnapshot(sessionId, snap => ({
    ...snap,
    items: [
      ...snap.items,
      { kind: 'user', id: demoId('demo-user'), createdAt: Date.now(), ...user },
      { kind: 'assistant', id: demoId('demo-reply'), text: note, status: 'completed' },
    ],
  }))
}

/** 错误卡片的「重试」：真实会话里发一条「继续」，演示里直接显示出来 */
export function demoRetry(sessionId: string): void {
  if (!isDemo) return
  appendTurn(
    sessionId,
    { text: tr('session.live.NoticeActions.retryMessage') },
    `${NOT_SENT}真实会话里会用输入框当前的模型和线路，接着出错前的上下文继续做。`,
  )
}

/** 演示会话的队列面板；会话里没有排队的消息时也返回（面板自己不显示） */
export function useDemoQueueController(sessionId: string | null): QueueController | undefined {
  const snap = useEngineState(s => (isDemo && sessionId ? (s.snapshots[sessionId] ?? null) : null))
  if (!isDemo || !sessionId || !snap) return undefined
  const setQueue = (change: (queue: QueuedMessage[]) => QueuedMessage[], paused?: boolean) =>
    updateDemoSnapshot(sessionId, s => ({
      ...s,
      queue: change(s.queue),
      ...(paused === undefined ? {} : { queuePaused: paused }),
    }))
  const find = (id: string): QueuedMessage => {
    const item = snap.queue.find(q => q.id === id)
    if (!item) throw new Error('这条消息已经不在队列里')
    return item
  }
  return {
    queue: snap.queue,
    queuePaused: snap.queuePaused,
    execution: snap.execution,
    state: snap.state,
    steerAvailable: false,
    cancelQueued: async id => {
      const item = find(id)
      setQueue(queue => queue.filter(q => q.id !== id))
      return item.text
    },
    dismissQueued: async id => {
      const item = find(id)
      updateDemoSnapshot(sessionId, s => ({
        ...s,
        queue: s.queue.filter(q => q.id !== id),
        items: s.items.map(i => (i.kind === 'user' && i.id === item.messageUuid ? { ...i, dismissed: true } : i)),
      }))
    },
    moveQueued: async (id, to) =>
      setQueue(queue => {
        const item = queue.find(q => q.id === id)
        if (!item) return queue
        const rest = queue.filter(q => q.id !== id)
        const at =
          typeof to === 'number' ? to : to.before === null ? rest.length : rest.findIndex(q => q.id === to.before)
        rest.splice(Math.max(0, Math.min(rest.length, at)), 0, item)
        return rest
      }),
    // 重试 / 插队：从队列拿掉，在对话里显示成已发出
    runQueuedNow: async id => {
      const item = find(id)
      setQueue(queue => queue.filter(q => q.id !== id))
      appendTurn(
        sessionId,
        { text: item.text, ...(item.attachments?.length ? { attachments: item.attachments } : {}) },
        `${NOT_SENT}真实会话里会用这条消息记下的模型和线路，把它原样再发一次。`,
      )
    },
    steerQueued: async () => {
      throw new Error(NOT_SENT)
    },
    resumeQueue: async () => setQueue(queue => queue.map(q => (q.held ? { ...q, held: false } : q)), false),
  }
}

// Codex 异步提问（request_user_input_async）的前端纯状态推导与答复拼装（docs/ui/codex-async-user-input.md）：
// 异步提问挂在 assistant 条目的 questions 上，不随 turn_completed 清空；
// 一旦后续出现新的用户消息（含手打或卡片提交）或用户点「跳过」，立即自动收起。
import type { Item, Question, QueuedMessage } from '@pixelsky/protocol'

export interface ActiveAsyncQuestion {
  itemId: string
  questions: Question[]
}

// 注意：status === 'running' 是开启当前这一轮的那条用户消息（已在 items 里排在提问之前），不能算作对本轮提问的回答
const PENDING_REPLY_STATUS = new Set<QueuedMessage['status']>(['queued', 'dispatching', 'delivering'])

/**
 * 找出当前会话需要展示在输入框上方的未作答异步提问：
 * - 队列里已有待发送 / 引导交付中的非重连用户消息时先收起（撤回排队项后会自动恢复）；
 * - 从末尾往前扫，遇到真实用户消息（非自动重连、非已丢弃失败项）即停止，只取已完成或运行中的提问条目。
 */
export function findActiveAsyncQuestion(
  items: readonly Item[] | undefined,
  dismissedIds: ReadonlySet<string>,
  queue?: readonly QueuedMessage[],
): ActiveAsyncQuestion | null {
  if (!items?.length) return null
  if (queue?.some(q => !q.reconnect && !q.held && PENDING_REPLY_STATUS.has(q.status))) return null
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.kind === 'user' && item.reconnect === undefined && !item.dismissed) return null
    if (
      item.kind === 'assistant' &&
      (item.status === 'completed' || item.status === 'running') &&
      item.questions?.length &&
      !dismissedIds.has(item.id)
    ) {
      return { itemId: item.id, questions: item.questions }
    }
  }
  return null
}

/** 把用户的选择 / 输入拼成发给 Codex 的自然语言用户消息（单题直发答案，多题带题面防串行） */
export function formatAsyncAnswer(questions: readonly Question[], answers: Record<string, string>): string {
  if (questions.length === 1) {
    const q = questions[0]!
    return (answers[q.question] ?? '').trim()
  }
  return questions
    .map(q => `${q.question}\n${(answers[q.question] ?? '').trim()}`)
    .filter(block => block.trim().length > 0)
    .join('\n\n')
}

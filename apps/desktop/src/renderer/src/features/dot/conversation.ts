import type { Item } from '@pixelsky/protocol'
import type { DotAttachment, DotChatMessage } from '@pixelsky/engine'

export interface DotTranscriptRow {
  id: string
  role: 'user' | 'assistant' | 'notice'
  text: string
  createdAt: number
  attachments: DotAttachment[]
  level?: 'info' | 'warn' | 'error'
}

/** 将原生房间记录与本地正在发送的条目合并，使用 request_id 和 Dot 消息 ID 去重。 */
export function dotTranscript(history: DotChatMessage[], local: Item[]): DotTranscriptRow[] {
  const rows = new Map<string, DotTranscriptRow>()
  for (const message of history) {
    const id = message.role === 'user' && message.requestId ? message.requestId : `dot-${message.id}`
    rows.set(id, { ...message, id })
  }
  let at = 0
  for (const item of local) {
    if (item.kind === 'user') at = item.createdAt
    else at++
    if (rows.has(item.id)) continue
    if (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'notice')
      rows.set(item.id, {
        id: item.id,
        role: item.kind === 'notice' ? 'notice' : item.kind,
        text: item.text,
        createdAt: at,
        attachments: [],
        ...(item.kind === 'notice' ? { level: item.level } : {}),
      })
  }
  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt)
}

export function mergeDotHistory(previous: DotChatMessage[], incoming: DotChatMessage[]): DotChatMessage[] {
  const messages = new Map(previous.map(m => [m.id, m]))
  for (const item of incoming) messages.set(item.id, item)
  return [...messages.values()].sort((a, b) => a.createdAt - b.createdAt)
}

// 控制请求体积（docs/ui/pixel-request-size.md §7）：历史里的图片每次请求都原样 base64 重发，看图多的会话涨到几十 MB，
// 光上传就超过 Pi 等响应的 5 分钟，重试又整包重发。
// - 每次请求前只留最近的图片，更早的换成一行文字；只改这一次发出的内容，会话历史和界面不变。
// - 请求超时而且请求很大时，在报错后面写明大小。
// 只用可擦除的 TS 语法。
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/** 图片 base64 合计最多这么多、最多这么多张；超了就从最早的开始省，降到一半为止（界线少移动，提示缓存少断） */
export const IMAGE_BYTES = 8 * 1024 * 1024
export const IMAGE_COUNT = 20
/** 请求体不到这么大就不在超时报错后面写大小 */
export const BIG_REQUEST = 5 * 1024 * 1024

interface Block {
  text?: string
  mimeType?: string
  type?: string
  data?: string
  id?: string
  name?: string
  arguments?: unknown
}
export interface Message {
  role?: string
  content?: string | Block[]
  toolCallId?: string
  toolName?: string
}

interface Picture {
  message: number
  block: number
  size: number
}

interface Batch {
  /** 用户消息；否则是同一次回复后的那些工具结果 */
  user: boolean
  /** 模型第几次回复之后的：和最后一批相同的，模型还没看过 */
  reply: number
  pictures: Picture[]
}

const blocks = (message: Message | undefined): Block[] =>
  Array.isArray(message?.content) ? (message.content as Block[]) : []

/**
 * 要省掉的图片（第几条消息的第几块）。按历史从头推一遍：一批（一条用户消息，或同一次回复后的那些工具结果）进来后
 * 超了，就从最早的一批批省，直到不超过一半。模型还没看过的（最后一次回复之后的）不省。
 * 最近一条带图的用户消息另算（用户发的图没法重新读，追问时还要看）：还是最新的用户消息时不省，之后最多留一份总量。
 * 不存状态，同一段历史每次结果一样；后面加消息也不会把已经省掉的又放回来
 */
export function omittedImages(
  messages: readonly Message[],
  maxBytes: number = IMAGE_BYTES,
  maxCount: number = IMAGE_COUNT,
): Picture[] {
  const omitted: Picture[] = []
  let kept: Batch[] = []
  let batch: Batch | null = null
  let reply = 0
  const close = (): void => {
    const last = batch
    batch = null
    if (!last || (!last.pictures.length && !last.user)) return
    kept.push(last)
    const pinned = kept.findLast(b => b.user && b.pictures.length)
    if (pinned && pinned.reply !== last.reply && pinned !== kept.findLast(b => b.user)) {
      let size = pinned.pictures.reduce((sum, p) => sum + p.size, 0)
      while (size > maxBytes || pinned.pictures.length > maxCount) {
        const p = pinned.pictures.shift()!
        size -= p.size
        omitted.push(p)
      }
    }
    let bytes = 0,
      count = 0
    for (const b of kept) {
      if (b === pinned) continue
      for (const p of b.pictures) bytes += p.size
      count += b.pictures.length
    }
    if (bytes <= maxBytes && count <= maxCount) return
    kept = kept.filter(b => {
      if (b.reply === last.reply || b === pinned || (bytes <= maxBytes / 2 && count <= maxCount / 2)) return true
      for (const p of b.pictures) bytes -= p.size
      count -= b.pictures.length
      omitted.push(...b.pictures)
      return false
    })
  }
  messages.forEach((message, index) => {
    if (message.role === 'system') return
    const tool = message.role === 'toolResult'
    // 工具结果接着算同一批；别的消息都另起一批
    if (!tool || !batch || batch.user) {
      close()
      if (message.role === 'assistant') reply++
      batch = { user: message.role === 'user', reply, pictures: [] }
    }
    blocks(message).forEach((b, block) => {
      if (b.type === 'image' && typeof b.data === 'string')
        batch!.pictures.push({ message: index, block, size: b.data.length })
    })
  })
  close()
  return omitted
}

/** 省掉的图片换成的文字：read 读的写明路径，模型要看可以再读一次 */
function placeholder(path: string | null): string {
  return path
    ? `[Image omitted to keep the request small: ${path}. Read it again if you need to see it.]`
    : '[An earlier image was omitted to keep the request small.]'
}

/** 换掉要省的图片；没有要省的返回 null */
export function withoutOldImages(
  messages: readonly Message[],
  maxBytes: number = IMAGE_BYTES,
  maxCount: number = IMAGE_COUNT,
): Message[] | null {
  const omitted = omittedImages(messages, maxBytes, maxCount)
  if (!omitted.length) return null
  const paths = new Map<string, string>()
  for (const message of messages)
    for (const b of message.role === 'assistant' ? blocks(message) : []) {
      const path = (b.arguments as { path?: unknown } | undefined)?.path
      if (b.type === 'toolCall' && b.name === 'read' && b.id && typeof path === 'string') paths.set(b.id, path)
    }
  const out = [...messages]
  for (const p of omitted) {
    const message = out[p.message]!
    const content = [...blocks(message)]
    content[p.block] = { type: 'text', text: placeholder(paths.get(message.toolCallId ?? '') ?? null) } as Block
    out[p.message] = { ...message, content }
  }
  return out
}

/** 请求体大约多少字节：只加字符串和标点，不真的序列化（几十 MB 序列化一次要上百毫秒） */
export function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length + 2
  if (Array.isArray(value)) return value.reduce<number>((sum, v) => sum + sizeOf(v) + 1, 2)
  if (value && typeof value === 'object')
    return Object.entries(value).reduce((sum, [key, v]) => sum + key.length + 4 + sizeOf(v), 2)
  return 4
}

/** 超时报错后面加的一句（桌面端按模板翻译：apps/desktop/src/shared/i18n/pixelMessages.ts）；不用加返回 null。原文留着：Pi 按它判断要不要重试 */
export function timeoutNote(error: string, bytes: number): string | null {
  if (bytes < BIG_REQUEST || !/timed? ?out/i.test(error)) return null
  return `${error} — the request was ${(bytes / 1024 / 1024).toFixed(1)} MB and may be too large to upload in time. Compact the conversation or start a new one.`
}

export function imageBudgetExtension(pi: ExtensionAPI): void {
  let bytes = 0
  // 不用 context：它改了消息后，Pi 会把历史中间的系统消息并成开头一条，提示缓存整段断掉
  pi.on('context_with_system', async event => {
    const messages = withoutOldImages(event.messages as Message[])
    return messages ? { messages: messages as typeof event.messages } : undefined
  })
  pi.on('before_provider_request', async event => {
    bytes = sizeOf(event.payload)
    return undefined
  })
  pi.on('message_end', async event => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string }
    if (message.role !== 'assistant' || message.stopReason !== 'error') return undefined
    const errorMessage = timeoutNote(message.errorMessage ?? '', bytes)
    return errorMessage ? { message: { ...event.message, errorMessage } as typeof event.message } : undefined
  })
}

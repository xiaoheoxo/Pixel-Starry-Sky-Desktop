import type { Item } from '@pixelsky/protocol'
import type { DotAttachment, DotChatMessage } from '@pixelsky/engine'
import type { DotDroppedFile } from '../../../../shared/types/dot-chat'

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

/** 这之后才是真的时间（2001 年）：没有时间的本地条目用的是排序序号，不能当时间显示 */
const REAL_TIME = 1_000_000_000_000
/** Dot 连着回的几条：隔这么久再写一次名字和时间 */
const GROUP_GAP_MS = 5 * 60_000

const dayStart = (at: number): number => {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export interface DotRowMark {
  /** 新的一天从这条开始：当天零点；否则 null */
  day: number | null
  /** Dot 一组回复的第一条：上面写头像、名字和时间 */
  head: boolean
  /** 这条的时间；没有可信的时间时 null */
  time: number | null
}

/**
 * 每条消息前要不要写日期、名字（docs/ui/dot-optimize.md §8 #1）：按天分隔；
 * Dot 连着回的几条只在第一条写名字和时间（中间夹着提示行不算断开），换了一天或隔了 5 分钟再写一次
 */
export function markDotRows(rows: readonly DotTranscriptRow[]): Map<string, DotRowMark> {
  const marks = new Map<string, DotRowMark>()
  let lastDay: number | null = null
  let previous: { role: string; time: number | null } | null = null
  for (const row of rows) {
    const time = row.createdAt >= REAL_TIME ? row.createdAt : null
    const start = time === null ? null : dayStart(time)
    const day = start !== null && start !== lastDay ? start : null
    if (start !== null) lastDay = start
    if (row.role === 'notice') {
      marks.set(row.id, { day, head: false, time })
      // 日期分隔下面的回复重新写名字
      if (day !== null) previous = null
      continue
    }
    const gap = time !== null && previous?.time != null && time - previous.time >= GROUP_GAP_MS
    marks.set(row.id, {
      day,
      head: row.role === 'assistant' && (day !== null || previous?.role !== 'assistant' || gap),
      time,
    })
    previous = { role: row.role, time }
  }
  return marks
}

const WEB_SUFFIX = /:\s*https:\/\/chatgpt\.com\/dots\/\S+$/
const WEB_NOTICES: ReadonlySet<string> = new Set([
  'View the Dot attachment in ChatGPT',
  'Dot needs your input in ChatGPT',
  'Dot workflow needs your input in ChatGPT',
  'Dot workflow status unavailable. Review it in ChatGPT',
])

/**
 * 会话里的提示行（docs/ui/dot-optimize.md §7 #1）：旧记录的原文后面带一串链接，去掉后才对得上词典；
 * web：这件事要到 ChatGPT 处理，界面在后面加「在 ChatGPT 打开」
 */
export function dotNotice(text: string): { text: string; web: boolean } {
  const plain = text.replace(WEB_SUFFIX, '')
  return { text: plain, web: WEB_NOTICES.has(plain) }
}

/**
 * 任务卡片放在派出它的那条消息下面（toolUseId 是那条消息的条目 id，§7 #4）；
 * 那条消息不在已加载的记录里、或旧记录没记的，放最后
 */
export function placeDotTasks<T extends { toolUseId: string | null }>(
  rows: readonly { id: string }[],
  tasks: readonly T[],
): { under: Map<string, T[]>; rest: T[] } {
  const ids = new Set(rows.map(row => row.id))
  const under = new Map<string, T[]>()
  const rest: T[] = []
  for (const task of tasks) {
    if (task.toolUseId && ids.has(task.toolUseId))
      under.set(task.toolUseId, [...(under.get(task.toolUseId) ?? []), task])
    else rest.push(task)
  }
  return { under, rest }
}

const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

/** 20 MiB，和引擎的 DOT_FILE_LIMIT 一样 */
export const DOT_DROP_LIMIT = 20 * 1024 * 1024

/**
 * 拖进来、粘贴的文件 → 交给主进程的样子（§7 #5）：有本机路径的只给路径；没有的（剪贴板截图）读出内容。
 * 超过 20 MiB 的报 Dot 的原文（界面按词典翻译）
 */
export async function readDropped(files: readonly File[], pathOf: (file: File) => string): Promise<DotDroppedFile[]> {
  const out: DotDroppedFile[] = []
  for (const file of files) {
    const path = pathOf(file)
    if (path) out.push({ path })
    else {
      if (file.size > DOT_DROP_LIMIT) throw new Error('Dot attachment exceeds 20 MiB')
      out.push({ name: file.name || 'attachment', dataBase64: base64(new Uint8Array(await file.arrayBuffer())) })
    }
  }
  return out
}

export function mergeDotHistory(previous: DotChatMessage[], incoming: DotChatMessage[]): DotChatMessage[] {
  const messages = new Map(previous.map(m => [m.id, m]))
  for (const item of incoming) messages.set(item.id, item)
  return [...messages.values()].sort((a, b) => a.createdAt - b.createdAt)
}

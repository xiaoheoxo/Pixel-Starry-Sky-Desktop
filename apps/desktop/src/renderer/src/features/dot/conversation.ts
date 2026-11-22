import type { EngineEvent, Item, QueuedMessage, SessionSnapshot } from '@pixelsky/protocol'
import type { DotAttachment, DotChatMessage, DotHistoryPage, DotReadReceipt } from '@pixelsky/engine'
import type { DotDroppedFile } from '../../../../shared/types/dot-chat'

import type { DotLocalSend } from './localImagePreviews'

/** These events signal a remote message, not a reason to reload profile data. */
export function dotEventHasNewMessage(event: EngineEvent): boolean {
  return (
    event.type === 'item_completed' &&
    ((event.item.kind === 'assistant' && event.item.id.startsWith('dot-')) ||
      (event.item.kind === 'notice' && event.item.id.startsWith('dot-attachment-')))
  )
}

export interface DotTranscriptRow {
  id: string
  role: 'user' | 'assistant' | 'notice'
  text: string
  createdAt: number
  attachments: DotAttachment[]
  native?: true
  level?: 'info' | 'warn' | 'error'
}

/** 将原生房间记录与本地正在发送的条目合并，使用 request_id 和 Dot 消息 ID 去重。 */
export function dotTranscript(
  history: DotChatMessage[],
  local: Item[],
  pending: readonly DotLocalSend[] = [],
): DotTranscriptRow[] {
  const rows = new Map<string, DotTranscriptRow>()
  for (const message of history) {
    const id = message.role === 'user' && message.requestId ? message.requestId : `dot-${message.id}`
    rows.set(id, { ...message, id, native: true })
  }
  let at = 0
  for (const item of local) {
    const echoed = rows.get(item.id)
    if (item.kind === 'user') at = echoed?.createdAt ?? item.createdAt
    else if (echoed) at = Math.max(at, echoed.createdAt)
    else at++
    if (echoed) continue
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
  for (const draft of pending) {
    if (draft.optimistic && !rows.has(draft.id))
      rows.set(draft.id, { id: draft.id, role: 'user', text: draft.text, createdAt: draft.createdAt, attachments: [] })
  }
  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt)
}

/** An optimistic/local echo is not a native message and cannot have a remote read receipt. */
export function dotReadReceiptRow(
  rows: readonly DotTranscriptRow[],
  receipt: DotReadReceipt | undefined,
): string | undefined {
  if (!receipt) return undefined
  return rows.findLast(
    row => row.role === 'user' && row.native && row.createdAt > 0 && row.createdAt <= receipt.readThroughAt,
  )?.id
}

/** Don't move a verified cursor backwards when a mirror request fails or responds out of order. */
export function mergeDotReadReceipt(
  previous: DotReadReceipt | undefined,
  next: DotReadReceipt | undefined,
): DotReadReceipt | undefined {
  if (!next) return previous
  if (!previous || next.readThroughAt > previous.readThroughAt) return next
  return next.readThroughAt === previous.readThroughAt && (next.updatedAt ?? 0) > (previous.updatedAt ?? 0)
    ? next
    : previous
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
  if (!incoming.length) return previous
  const messages = new Map(previous.map(m => [m.id, m]))
  for (const item of incoming) messages.set(item.id, item)
  return [...messages.values()].sort((a, b) => a.createdAt - b.createdAt)
}

/** A replacement page is contiguous on its own; never keep an older cursor across an unknown gap. */
export function dotHistoryUpdate(page: DotHistoryPage, before: string | undefined, loaded: boolean) {
  return {
    merge: (previous: DotChatMessage[]) => (page.reset ? page.items : mergeDotHistory(previous, page.items)),
    replaceBefore: !!before || !loaded || page.reset === true,
  }
}

/**
 * 输入框和「正在回复」的状态（docs/ui/dot-optimize.md §9）：
 * - busy：不能发。只在没读到会话、正在发这一下、有待核对的消息（要先处理）时；Dot 正在回复时也能发，消息进宿主的队列，忙完自动发出
 * - replying：真的有一轮在跑（以前有排队的消息也算，排队卡片另外显示）
 * - queued：排着等发的消息
 */
export function dotComposerState(
  snapshot: Pick<SessionSnapshot, 'state' | 'queue'> | null,
  now: { sending: boolean; resolving: boolean },
): { busy: boolean; replying: boolean; uncertain: QueuedMessage[]; queued: QueuedMessage[] } {
  const queue = snapshot?.queue ?? []
  const uncertain = queue.filter(q => q.status === 'uncertain')
  const queued = queue.filter(q => q.status === 'queued' || (q.status === 'delivering' && q.mode === 'guidance'))
  const busy = now.resolving || now.sending || !snapshot || uncertain.length > 0
  const replying =
    !!snapshot &&
    !uncertain.length &&
    (now.sending ||
      snapshot.state !== 'idle' ||
      queue.some(q => q.status === 'dispatching' || q.status === 'running' || q.status === 'delivering'))
  return { busy, replying, uncertain, queued }
}

/** Use the observed turn ID so a click cannot be applied to a later reply. */
export function dotGuidanceTurn(
  snapshot: Pick<SessionSnapshot, 'state' | 'turnId' | 'flags' | 'queue'> | null,
): string | null {
  if (snapshot?.state !== 'running' || !snapshot.flags.steerAvailable) return null
  if (snapshot.queue.some(q => q.status === 'delivering' || q.status === 'uncertain')) return null
  return snapshot.turnId
}

export const DOT_NO_REPLY_MS = 60_000

export function dotReplyDisplay(
  replying: boolean,
  waitingSince: number | undefined,
  now: number,
): 'none' | 'working' | 'unanswered' {
  if (!replying) return 'none'
  return waitingSince !== undefined && now - waitingSince >= DOT_NO_REPLY_MS ? 'unanswered' : 'working'
}

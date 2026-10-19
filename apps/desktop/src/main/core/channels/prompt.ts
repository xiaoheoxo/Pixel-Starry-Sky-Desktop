// 协作频道派活的提示词和结果摘取（docs/ui/channels-phase-b.md §4.2、§5.2）。纯函数，不碰磁盘和引擎。
import type { Locale } from '../../../shared/i18n/messages'
import type { ChannelMessage, ChannelTaskStatus } from '../../../shared/types/channels'
import { excerpt, splitMentions, type Mentionable } from '../../../shared/channels/mentions'

/** 最近的讨论最多带这么多条 / 这么多字，先到哪个停在哪个 */
export const HISTORY_MESSAGES = 20
export const HISTORY_CHARS = 8000
/** 任务卡标题、摘要的长度上限 */
export const TITLE_MAX = 60
export const SUMMARY_MAX = 140
/** 发回频道的回复最多存这么多字 */
export const RESULT_MAX = 20_000
/** 历史里一条真人消息最多带这么多字 */
const LINE_MAX = 1000

const en = (locale: Locale): boolean => locale === 'en-US'

const STATUS: Record<ChannelTaskStatus, [string, string]> = {
  queued: ['排队中', 'queued'],
  approval: ['等待同意', 'awaiting approval'],
  running: ['进行中', 'in progress'],
  waiting: ['等你确认', 'waiting for approval'],
  done: ['已完成', 'done'],
  failed: ['失败', 'failed'],
  stopped: ['已停止', 'stopped'],
}

/** 消息正文 → 任务卡标题：去掉 @成员 和 @全体，取第一行非空文字 */
export function taskTitle(text: string, members: readonly Mentionable[]): string {
  const plain = splitMentions(text, members)
    .filter(s => !s.memberId && !s.all)
    .map(s => s.text)
    .join('')
  const line =
    plain
      .split('\n')
      .map(l =>
        l
          .replace(/\s+/g, ' ')
          .replace(/^[\s,，:：、]+/, '')
          .trim(),
      )
      .find(Boolean) ?? ''
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line
}

/** 云端生成的团队任务卡标题只去掉了被派活的成员名，@全体 还在：去掉它，其余照旧 */
export function titleWithoutAll(title: string, members: readonly Mentionable[]): string {
  const segments = splitMentions(title, members)
  if (!segments.some(s => s.all)) return title
  const plain = segments
    .filter(s => !s.all)
    .map(s => s.text)
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,，:：、]+/, '')
    .trim()
  return plain || title
}

const DECISION = /^\s*(?:[-*>]\s*)?(?:\*\*)?(?:需要你决定|Needs your decision)\s*[:：]\s*(?:\*\*)?\s*(.+?)\s*$/im

/** 回复里「需要你决定：」那一行的内容；没有时 null */
export function decisionOf(text: string): string | null {
  const m = DECISION.exec(text)
  return m ? m[1].replace(/\*\*$/, '').trim() || null : null
}

/** 回复的第一段（不含「需要你决定」那一行），压成一行，最多 140 字 */
export function summaryOf(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(p =>
      p
        .split('\n')
        .filter(line => !DECISION.test(line))
        .join(' ')
        .replace(/^#+\s*/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
  return excerpt(paragraphs[0] ?? '', SUMMARY_MAX)
}

/** 回复太长时截断，末尾注明去会话里看 */
export function clipResult(text: string, locale: Locale): string {
  if (text.length <= RESULT_MAX) return text
  return `${text.slice(0, RESULT_MAX)}\n\n${en(locale) ? '…full reply in the session' : '…完整内容见会话'}`
}

/** 消息带了附件：「（附 2 张图片、1 个文件）」；都没有时空串 */
export function attachedNote(images: number, files: number, locale: Locale): string {
  if (!images && !files) return ''
  if (en(locale)) {
    const parts = [
      images ? `${images} image${images > 1 ? 's' : ''}` : '',
      files ? `${files} file${files > 1 ? 's' : ''}` : '',
    ]
    return `(attached: ${parts.filter(Boolean).join(', ')})`
  }
  const parts = [images ? `${images} 张图片` : '', files ? `${files} 个文件` : '']
  return `（附 ${parts.filter(Boolean).join('、')}）`
}

/** 几条消息的附件合在一起超过上限、这一轮没带上的；都带上了时空串 */
export function droppedNote(images: number, files: number, locale: Locale): string {
  if (!images && !files) return ''
  if (en(locale)) {
    const parts = [
      images ? `${images} image${images > 1 ? 's' : ''}` : '',
      files ? `${files} file${files > 1 ? 's' : ''}` : '',
    ]
    return `(${parts.filter(Boolean).join(' and ')} from the channel could not be attached: over the per-message limit)`
  }
  const parts = [images ? `${images} 张图片` : '', files ? `${files} 个文件` : '']
  return `（频道里还有 ${parts.filter(Boolean).join('、')} 超过一条消息的上限，这次没带上）`
}

/** 历史里的一行；事件不带（null） */
function historyLine(m: ChannelMessage, nameOf: (id: string) => string, locale: Locale): string | null {
  const colon = en(locale) ? ': ' : '：'
  if (m.kind === 'event') return null
  if (m.kind === 'task') {
    const status = STATUS[m.status][en(locale) ? 1 : 0]
    return en(locale)
      ? `${nameOf(m.authorId)} handed to ${nameOf(m.assigneeId)}: ${m.title} (${status})`
      : `${nameOf(m.authorId)} 交给 ${nameOf(m.assigneeId)}：${m.title}（${status}）`
  }
  // AI 的长回复只带第一段
  const body = m.format === 'markdown' ? (m.text.split(/\n\s*\n/)[0] ?? '') : m.text
  const clipped = body.trim().length > LINE_MAX ? `${body.trim().slice(0, LINE_MAX)}…` : body.trim()
  const note = m.attached ? attachedNote(m.attached.images.length, m.attached.files.length, locale) : ''
  const text = [clipped, note].filter(Boolean).join(' ')
  return text ? `${nameOf(m.authorId)}${colon}${text}` : null
}

/**
 * 派活时带上的最近讨论（从旧到新）：源消息之前的消息，从新往旧取，最多 20 条或 8000 字。
 * `since`：一直用同一个会话的成员，只补上次派活之后的；`skip`：单独列出的被引用消息不再重复。
 */
export function historyLines(
  messages: readonly ChannelMessage[],
  opts: {
    beforeId: string
    since?: number | null
    skip?: string | null
    nameOf: (id: string) => string
    locale: Locale
  },
): string[] {
  const end = messages.findIndex(m => m.id === opts.beforeId)
  const earlier = end < 0 ? messages : messages.slice(0, end)
  const lines: string[] = []
  let chars = 0
  for (let i = earlier.length - 1; i >= 0 && lines.length < HISTORY_MESSAGES; i--) {
    const m = earlier[i]
    if (opts.since != null && m.at <= opts.since) break
    if (m.id === opts.skip) continue
    const line = historyLine(m, opts.nameOf, opts.locale)
    if (!line) continue
    if (chars + line.length > HISTORY_CHARS) break
    chars += line.length
    lines.unshift(line)
  }
  return lines
}

export interface DispatchInput {
  locale: Locale
  channel: { name: string; topic: string | null }
  /** 频道说明：每项活都要照着做 */
  notes?: string | null
  /** 置顶的资料（「名字：原文」） */
  pinned?: string[]
  author: string
  instructions: string
  history: string[]
  /** 被引用的消息（一定带上） */
  quoted: string | null
  request: string
  /** 这条消息带的附件数：提示词里说一句，图片和文件本身跟着这条消息一起发 */
  attached?: { images: number; files: number } | null
  /** 这条消息 @全体：同时收到这项活的其他 AI 成员 */
  together?: string[]
}

/** 置顶资料每条、合计最多这么多字（派活提示词里，超出的截掉） */
export const PINNED_ITEM_CHARS = 1000
export const PINNED_CHARS = 4000

/** 置顶资料：多行压成一行，每条和合计都截断 */
function pinnedRefs(lines: string[]): string[] {
  const out: string[] = []
  let total = 0
  for (const line of lines) {
    const flat = line.replace(/\s*\n\s*/g, ' ').trim()
    const item = flat.length > PINNED_ITEM_CHARS ? `${flat.slice(0, PINNED_ITEM_CHARS)}…` : flat
    if (!item || total + item.length > PINNED_CHARS) break
    out.push(item)
    total += item.length
  }
  return out
}

/** 第一次派给一个会话的提示词（§4.2） */
export function dispatchPrompt(input: DispatchInput): string {
  const { locale, channel } = input
  const parts: string[] = []
  const together = input.together?.length ? input.together : null
  const pinned = pinnedRefs(input.pinned ?? [])
  if (en(locale)) {
    parts.push(
      `You have received a task in the channel #${channel.name}.${channel.topic ? ` (Channel topic: ${channel.topic})` : ''}\nHanded to you by: ${input.author}` +
        (together ? `\nThis message went to every AI member in the channel; ${together.join(', ')} got it too.` : ''),
    )
    if (input.instructions.trim()) parts.push(`Your role:\n${input.instructions.trim()}`)
    if (input.notes?.trim()) parts.push(`Channel guidelines (follow them for every task here):\n${input.notes.trim()}`)
    if (pinned.length) parts.push(`Pinned reference in this channel:\n${pinned.map(p => `- ${p}`).join('\n')}`)
    if (input.history.length) parts.push(`Recent discussion (oldest first):\n${input.history.join('\n')}`)
    if (input.quoted) parts.push(`Quoted message:\n> ${input.quoted.replace(/\n/g, '\n> ')}`)
    parts.push(
      `The request:\n${[input.request.trim(), attachedNote(input.attached?.images ?? 0, input.attached?.files ?? 0, locale)].filter(Boolean).join('\n')}`,
    )
    parts.push(
      'When you are done, end with one or two paragraphs summarizing what you did, which files you changed and anything left unfinished.\nIf something needs a person to decide, put it on its own line starting with "Needs your decision:".',
    )
  } else {
    parts.push(
      `你在协作频道 #${channel.name} 里收到一项活。${channel.topic ? `（频道主题：${channel.topic}）` : ''}\n交给你的人：${input.author}` +
        (together ? `\n这条消息发给了频道里全体 AI 成员，${together.join('、')} 也同时收到了。` : ''),
    )
    if (input.instructions.trim()) parts.push(`你的职责：\n${input.instructions.trim()}`)
    if (input.notes?.trim()) parts.push(`频道说明（这个频道里每项活都要照着做）：\n${input.notes.trim()}`)
    if (pinned.length) parts.push(`频道里置顶的资料：\n${pinned.map(p => `- ${p}`).join('\n')}`)
    if (input.history.length) parts.push(`最近的讨论（从旧到新）：\n${input.history.join('\n')}`)
    if (input.quoted) parts.push(`引用的消息：\n> ${input.quoted.replace(/\n/g, '\n> ')}`)
    parts.push(
      `这次的要求：\n${[input.request.trim(), attachedNote(input.attached?.images ?? 0, input.attached?.files ?? 0, locale)].filter(Boolean).join('\n')}`,
    )
    parts.push(
      '做完后，最后用一两段话总结：做了什么、改了哪些文件、有没有没做完的。\n如果有需要人来决定的事，单独写一行，以「需要你决定：」开头。',
    )
  }
  return parts.join('\n\n')
}

/** 回复任务卡 = 追加要求：会话里已经有上下文，只带原文（§7.1） */
export function followUpPrompt(input: { locale: Locale; channel: string; author: string; text: string }): string {
  return en(input.locale)
    ? `${input.text.trim()}\n\n(From #${input.channel}, ${input.author})`
    : `${input.text.trim()}\n\n（来自频道 #${input.channel}，${input.author}）`
}

/** 做到一半失败 / 停止后重试：和错误卡片的「重试」一样，发一条「继续」 */
export const continuePrompt = (locale: Locale): string => (en(locale) ? 'Try again' : '继续')

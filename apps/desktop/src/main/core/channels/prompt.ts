// 协作频道派活的提示词和结果摘取（docs/ui/channels-phase-b.md §4.2、§5.2）。纯函数，不碰磁盘和引擎。
import { codexPlainText } from '@pixelsky/protocol'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Locale } from '../../../shared/i18n/messages'
import type { ChannelMessage, ChannelTaskStatus } from '../../../shared/types/channels'
import { excerpt, splitMentions, type Mentionable } from '../../../shared/channels/mentions'

/** 最近的讨论最多带这么多条 / 这么多字，先到哪个停在哪个 */
export const HISTORY_MESSAGES = 20
/** 会话有频道工具（channel_read 能往前翻）时只带这么多条（docs/ui/channels-collab-v2.md §1） */
export const HISTORY_WITH_TOOLS = 5
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
  const paragraphs = codexPlainText(text)
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

/** 按路径引用的附件在发送人的电脑上，SSH 成员读不到、这一轮没带上的；都带上了时空串 */
export function unreachableNote(names: readonly string[], locale: Locale): string {
  if (!names.length) return ''
  return en(locale)
    ? `(Attachment ${names.join(', ')} is on the sender's computer. This machine can't read it, so it was not included)`
    : `（附件 ${names.join('、')} 在发送人的电脑上，你这台机器读不到，这次没带上）`
}

/** 历史里的一行；事件和只在讨论串里的消息不带（null） */
export function historyLine(m: ChannelMessage, nameOf: (id: string) => string, locale: Locale): string | null {
  const colon = en(locale) ? ': ' : '：'
  if (m.kind === 'event' || (m.kind === 'message' && m.threadId)) return null
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
    /** 最多几条，默认 HISTORY_MESSAGES */
    limit?: number
    nameOf: (id: string) => string
    locale: Locale
  },
): string[] {
  const limit = opts.limit ?? HISTORY_MESSAGES
  const end = messages.findIndex(m => m.id === opts.beforeId)
  const earlier = end < 0 ? messages : messages.slice(0, end)
  const lines: string[] = []
  let chars = 0
  for (let i = earlier.length - 1; i >= 0 && lines.length < limit; i--) {
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

/**
 * 去掉代码块和行内代码：AI 回复里代码中的 @ 不算派活。按 Markdown 解析（和界面显示一致）：围栏、缩进代码块，
 * 引用和列表里的也算；没闭合的围栏算到末尾。代码块的位置留一个空行，前后仍分两段
 */
export function withoutCode(text: string): string {
  const ranges: [number, number][] = []
  type Node = { type: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: Node[] }
  const walk = (node: Node): void => {
    if ((node.type === 'code' || node.type === 'inlineCode') && node.position)
      ranges.push([node.position.start.offset!, node.position.end.offset!])
    else node.children?.forEach(walk)
  }
  walk(fromMarkdown(text))
  // 从后往前删，前面的位置不变
  for (const [start, end] of ranges.reverse()) text = text.slice(0, start) + text.slice(end)
  return text
}

/** AI 互相派活时交接的内容：谁、做完了哪项活、他的回复、改了哪些文件 */
export interface Handoff {
  from: string
  title: string
  reply: string
  files: string[]
}

/** 交接时最多列出这么多个改动的文件 */
const HANDOFF_FILES = 20

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
  /** 别的 AI 成员交过来的：交接内容（docs/ui/import-collab.md 第 5 项①） */
  handoff?: Handoff | null
  /** 频道允许 AI 成员互相派活：频道里其他 AI 成员（名字、职责第一行）；不允许时 null */
  peers?: { name: string; role: string }[] | null
  /** 会话挂了频道工具（pixelsky_channel）：说明能翻更早的讨论、在串里回复、提议派活；relay 时还能直接交接 */
  tools?: { relay: boolean } | null
}

/** 看图走工具：没这句模型会自己开电脑控制去截屏 */
function attachmentHint(locale: Locale): string {
  return en(locale)
    ? 'To see images or files in this channel use the attachment_read tool (no id: the ones on this task; with an id: that message or task card). Do not use computer control or screenshots for this.'
    : '要看频道里的图片或文件，用 attachment_read 工具（不填 id 读这项活带的，填 id 读那条消息或任务卡的），不要开电脑控制、截屏去看。'
}

/** 工具列表里找不到 task_done 时怎么交付（flowRoundEnded 认回复里带 task_done: true 的 JSON） */
function deliveryFallback(locale: Locale): string {
  return en(locale)
    ? 'If task_done is not in your tool list, first look it up with ToolSearch (mcp__pixelsky_channel__task_done) if you have that tool. If it really is unavailable, deliver by ending your reply with a fenced json block: {"task_done": true, "summary": "...", "files": ["..."]} (review steps also add "verdict" and "issues").'
    : '工具列表里找不到 task_done 时，有 ToolSearch 就先搜 mcp__pixelsky_channel__task_done；确实没有这个工具，就在回复最后写一个 json 代码块交付：{"task_done": true, "summary": "…", "files": ["…"]}（审查步骤另外写 verdict 和 issues）。'
}

function toolsText(tools: { relay: boolean }, locale: Locale): string {
  if (en(locale))
    return [
      "You have the channel tools (MCP server pixelsky_channel): channel_read reads earlier messages in this channel (only the last few are above), thread_read reads the discussion thread of a task card, channel_reply posts a short note in this task's thread (progress, questions; it does not interrupt anyone), and task_propose suggests giving a task to another AI member (the user decides whether to send it).",
      attachmentHint(locale),
      tools.relay
        ? 'This channel lets AI members hand work to each other: task_handover gives part of the work to another member right away. For the same handoff use either task_handover or "@name" in your final reply, not both.'
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  return [
    '你有频道工具（MCP 服务 pixelsky_channel）：channel_read 读这个频道更早的消息（上面只带了最近几条），thread_read 读某张任务卡的讨论串，channel_reply 在这项活的串里写一句（进展、问题，不会打断别人），task_propose 提议把一项活交给别的 AI 成员（由用户决定派不派）。',
    attachmentHint(locale),
    tools.relay
      ? '这个频道允许 AI 成员互相派活：task_handover 可以直接把一部分活交给别的成员。同一次交接用 task_handover 或在最后的回复里写「@名字」二选一，不要两样都用。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function handoffText(h: Handoff, locale: Locale): string {
  const files = h.files.slice(0, HANDOFF_FILES)
  const more = h.files.length - files.length
  // 用频道工具 task_handover 做到一半交过来的：没有回复，要求里写了要做什么
  const quote = h.reply.trim() ? `> ${h.reply.trim().replace(/\n/g, '\n> ')}` : ''
  if (en(locale))
    return [
      quote
        ? `${h.from} finished "${h.title}" and handed it on to you.`
        : `${h.from} is working on "${h.title}" and handed this part to you.`,
      quote ? `${h.from}'s reply:\n${quote}` : '',
      files.length ? `Files changed: ${files.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  return [
    quote ? `${h.from} 做完「${h.title}」后把活交给了你。` : `${h.from} 在做「${h.title}」，把这部分交给了你。`,
    quote ? `${h.from} 的回复：\n${quote}` : '',
    files.length ? `改动的文件：${files.join('、')}${more > 0 ? ` 等 ${h.files.length} 个` : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function peersText(peers: { name: string; role: string }[], locale: Locale): string {
  const list = peers.map(p => `- ${p.name}${p.role ? (en(locale) ? `: ${p.role}` : `：${p.role}`) : ''}`).join('\n')
  return en(locale)
    ? `AI members in this channel can hand work to each other: if another member should take over, write "@name" followed by what they should do in your reply, and the channel will hand it to them along with your reply and the files you changed. Only do this when it is really needed; if no handoff is needed, do not @ anyone.\nOther AI members in this channel:\n${list}`
    : `这个频道允许 AI 成员互相派活：需要别的成员接着做时，在回复里写「@名字」和要他做的事，频道会把活交给他，并带上你的回复和改动的文件。确实需要时才这样做；不用交接就不要写 @。\n频道里的其他 AI 成员：\n${list}`
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
    if (input.handoff) parts.push(handoffText(input.handoff, locale))
    parts.push(
      `The request:\n${[input.request.trim(), attachedNote(input.attached?.images ?? 0, input.attached?.files ?? 0, locale)].filter(Boolean).join('\n')}`,
    )
    if (input.peers?.length) parts.push(peersText(input.peers, locale))
    if (input.tools) parts.push(toolsText(input.tools, locale))
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
    if (input.handoff) parts.push(handoffText(input.handoff, locale))
    parts.push(
      `这次的要求：\n${[input.request.trim(), attachedNote(input.attached?.images ?? 0, input.attached?.files ?? 0, locale)].filter(Boolean).join('\n')}`,
    )
    if (input.peers?.length) parts.push(peersText(input.peers, locale))
    if (input.tools) parts.push(toolsText(input.tools, locale))
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

// ---------------------------------------------------------------------------
// 流程（docs/ui/channels-pipeline.md §4.4）
// ---------------------------------------------------------------------------

/** 流程概览里的一行：「② 写代码 · 程序员 · 已交付」 */
export interface FlowLine {
  no: string
  title: string
  member: string
  status: string
  /** 这一行就是收到提示词的这一步 */
  self?: boolean
}

/** 依赖步骤交上来的东西 */
export interface FlowInput {
  no: string
  title: string
  member: string
  summary: string
  files: string[]
  /** 交付时说还没做完、没验证到的 */
  open?: string[]
}

export interface FlowStepPromptInput {
  locale: Locale
  channel: { name: string; topic: string | null }
  notes?: string | null
  pinned?: string[]
  instructions: string
  flow: string
  /** 分工提案里定下来的要点和还没定的 */
  brief?: FlowBriefInput | null
  lines: FlowLine[]
  step: { no: string; title: string; kind: 'work' | 'review' | 'summary' }
  inputs: FlowInput[]
  /** 审查步骤：被审的那一步 */
  target?: FlowInput | null
  /** 流程里别的成员（member_ask 能问的） */
  peers: string[]
  /** 这一步在独立的 Git 副本里做（第 11 项）：分支、基于哪个分支（null 是主目录的当前提交） */
  copy?: { branch: string; base: string | null } | null
  /** 汇合步骤：前面的步骤各在哪个分支上，要合并进主目录 */
  merge?: { no: string; title: string; branch: string }[]
  /** 在主目录做、后面几步会从主目录分出副本：交付前要提交，不然副本里没有这一步的改动 */
  forks?: boolean
  /** 汇合步骤：好几个分支都改了的文件（steps 是步骤序号） */
  overlap?: { path: string; steps: string[] }[]
}

/** 要点（和 shared 的 FlowBrief 同形，by 不用） */
export interface FlowBriefInput {
  goal: string
  facts: { k: string; v: string }[]
  open: { q: string; required: boolean }[]
}

/** 要点写进提示词：目标、定下来的、还没定的（还没定的按合理默认值定，交付时写明） */
function briefText(b: FlowBriefInput | null | undefined, locale: Locale): string {
  if (!b || (!b.goal && !b.facts.length && !b.open.length)) return ''
  const lines: string[] = []
  if (en(locale)) {
    if (b.goal) lines.push(`Goal: ${b.goal}`)
    for (const f of b.facts) lines.push(`- ${f.k}: ${f.v}`)
    if (b.open.length)
      lines.push(
        `Not decided yet (use a sensible default and say what you chose when you deliver): ${b.open.map(o => o.q).join('; ')}`,
      )
    return `What the people in the channel agreed on (follow it):\n${lines.join('\n')}`
  }
  if (b.goal) lines.push(`目标：${b.goal}`)
  for (const f of b.facts) lines.push(`- ${f.k}：${f.v}`)
  if (b.open.length) lines.push(`还没定的（按合理默认值定，交付时写明你定了什么）：${b.open.map(o => o.q).join('；')}`)
  return `频道里大家定下来的要点（照着做）：\n${lines.join('\n')}`
}

function inputText(i: FlowInput, locale: Locale): string {
  const files = i.files.slice(0, HANDOFF_FILES)
  const more = i.files.length - files.length
  const list = files.length
    ? en(locale)
      ? `\n  Files: ${files.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
      : `\n  文件：${files.join('、')}${more > 0 ? ` 等 ${i.files.length} 个` : ''}`
    : ''
  const open = i.open?.length
    ? en(locale)
      ? `\n  Not done / not verified: ${i.open.join('; ')}`
      : `\n  没做完 / 没验证：${i.open.join('；')}`
    : ''
  return en(locale)
    ? `- ${i.no} ${i.title} (${i.member}): ${i.summary}${list}${open}`
    : `- ${i.no} ${i.title}（${i.member}）：${i.summary}${list}${open}`
}

/** 流程里一步的提示词：流程概览、这一步要做什么、依赖交上来的东西、怎么交付 */
export function flowStepPrompt(input: FlowStepPromptInput): string {
  const { locale, channel, step } = input
  const pinned = pinnedRefs(input.pinned ?? [])
  const overview = input.lines
    .map(l => `${l.self ? '→ ' : '  '}${l.no} ${l.title} · ${l.member} · ${l.status}`)
    .join('\n')
  const peers = input.peers.length ? input.peers.join(en(locale) ? ', ' : '、') : null
  if (en(locale))
    return [
      `You are doing one step of the flow "${input.flow}" in the channel #${channel.name}.${channel.topic ? ` (Channel topic: ${channel.topic})` : ''}`,
      input.instructions.trim() ? `Your role:\n${input.instructions.trim()}` : '',
      input.notes?.trim() ? `Channel guidelines:\n${input.notes.trim()}` : '',
      pinned.length ? `Pinned reference:\n${pinned.map(p => `- ${p}`).join('\n')}` : '',
      briefText(input.brief, locale),
      `The flow (→ is your step):\n${overview}`,
      input.inputs.length
        ? `Delivered by earlier steps:\n${input.inputs.map(i => inputText(i, locale)).join('\n')}`
        : '',
      input.target
        ? `Review ${input.target.no} "${input.target.title}" by ${input.target.member}. Look at the actual changes with git diff / git status. Run the checks you need yourself; do not take the earlier step's word for test results. If something is wrong, reject it so they fix it; do not change the code yourself. When done, call task_done with verdict "pass", or "reject" plus issues (one problem per item, concrete enough to fix).`
        : '',
      step.kind === 'summary'
        ? 'This is the final step: read what every step delivered, check that the pieces fit together, and write a summary for the user (what was done, which files, anything unresolved). Keep what you or a reviewer actually verified separate from what earlier steps only claimed, and list every "not done" item they handed over as is.'
        : '',
      input.copy
        ? `You work in a separate Git copy on branch ${input.copy.branch}${input.copy.base ? ` (based on ${input.copy.base})` : ''}. Do not switch branches and do not touch the project's main folder. Before task_done, commit your changes and output files to this branch (git add -A && git commit): later steps take your work from the branch.`
        : '',
      input.merge?.length
        ? `Earlier steps worked on their own branches:\n${input.merge.map(m => `- ${m.no} ${m.title}: ${m.branch}`).join('\n')}\nFirst check with git status that this folder is clean, then git merge --no-ff each branch. Resolve conflicts yourself and explain them in the task_done summary; run the checks after merging, then call task_done.`
        : '',
      input.overlap?.length
        ? `These files were changed on more than one branch; take extra care when merging them:\n${input.overlap.map(o => `- ${o.path} (${o.steps.join(', ')})`).join('\n')}`
        : '',
      input.forks
        ? 'The next steps branch off from the current commit of this folder. Before task_done, commit the files you changed in this step (only yours, not git add -A); otherwise the next steps will not see them.'
        : '',
      `Your step: ${step.no} ${step.title}`,
      `When you are really done, call the task_done tool (summary, files you changed); the flow moves on only after task_done. If you need something from another member${peers ? ` (${peers})` : ''}, call member_ask and then end your turn; the answer will be sent to you as a new message. If something only the user can decide is missing (it changes the result and you cannot infer it), call user_ask and end your turn instead of guessing or stopping; keep doing the parts that do not depend on it.`,
      deliveryFallback(locale),
      attachmentHint(locale),
    ]
      .filter(Boolean)
      .join('\n\n')
  return [
    `你在协作频道 #${channel.name} 里做流程「${input.flow}」的一步。${channel.topic ? `（频道主题：${channel.topic}）` : ''}`,
    input.instructions.trim() ? `你的职责：\n${input.instructions.trim()}` : '',
    input.notes?.trim() ? `频道说明：\n${input.notes.trim()}` : '',
    pinned.length ? `频道里置顶的资料：\n${pinned.map(p => `- ${p}`).join('\n')}` : '',
    briefText(input.brief, locale),
    `整个流程（→ 是你这一步）：\n${overview}`,
    input.inputs.length ? `前面的步骤交上来的：\n${input.inputs.map(i => inputText(i, locale)).join('\n')}` : '',
    input.target
      ? `审查 ${input.target.no}「${input.target.title}」（${input.target.member} 做的）。用 git diff / git status 看实际改动。需要的检查自己跑一遍，不要采信前一步说的测试结果；有问题打回给它改，不要自己动手改代码。审完调用 task_done：verdict 写 "pass"（通过）或 "reject"（打回），打回时 issues 一条写一个问题，要具体到能照着改。`
      : '',
    step.kind === 'summary'
      ? '这是最后一步：读每一步交上来的东西，确认它们接得上，给用户写一份总结（做了什么、改了哪些文件、还有什么没解决）。亲自验证过的（你或审查跑过的）和前面步骤只是声称的分开写；前面交上来的「没做完」原样列出。'
      : '',
    input.copy
      ? `你在独立的 Git 副本里做这一步（分支 ${input.copy.branch}${input.copy.base ? `，基于 ${input.copy.base}` : ''}）。别切换分支，别动项目主目录。调用 task_done 之前把改动和产出的文件提交到这个分支（git add -A && git commit），后面的步骤按分支取你的东西。`
      : '',
    input.merge?.length
      ? `前面的步骤各在自己的分支上：\n${input.merge.map(m => `- ${m.no} ${m.title}：${m.branch}`).join('\n')}\n先用 git status 确认当前目录干净，再逐个 git merge --no-ff 这些分支；有冲突自己解决，并在 task_done 的摘要里说明；合并后跑一遍检查再调用 task_done。`
      : '',
    input.overlap?.length
      ? `这些文件在好几个分支上都改了，合并时格外留意：\n${input.overlap.map(o => `- ${o.path}（${o.steps.join('、')}）`).join('\n')}`
      : '',
    input.forks
      ? '后面的步骤会从这个目录的当前提交分出去。调用 task_done 之前把你这一步改的文件提交（只提交你改的，别用 git add -A），不然后面的步骤看不到。'
      : '',
    `你这一步：${step.no} ${step.title}`,
    `确实做完了再调用 task_done 工具交付（摘要、你改的文件）；流程只在 task_done 之后往下走。需要别的成员${peers ? `（${peers}）` : ''}提供东西时，调用 member_ask，然后结束这一轮，回答会作为新消息发给你。缺了只有用户能定的信息（影响结果、又推不出来）时，调用 user_ask 问用户再结束这一轮，不要瞎猜，也不要直接停下；不依赖它的部分先做。`,
    deliveryFallback(locale),
    attachmentHint(locale),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 让成员拆流程的提示词 */
export function flowPlanPrompt(input: {
  locale: Locale
  channel: string
  request: string
  members: { name: string; role: string }[]
  /** 牵头成员按用户不带 @ 的消息自动拆的：只是问题时直接回答 */
  auto?: boolean
  /** 牵头分派（docs/ui/channels-auto-route.md）：一个成员一次能做完的，只给一步、交给职责最合适的那个，软件直接派活 */
  route?: boolean
  /** 用户 @ 它派的活：先出计划，一个人能做完的计划可以只有一步给它自己 */
  mention?: boolean
  /** 换人接手时：前一个成员拆到哪了、用户答过什么 */
  handover?: string
}): string {
  const sep = en(input.locale) ? ': ' : '：'
  const list = input.members.map(m => `- ${m.name}${m.role ? `${sep}${m.role}` : ''}`).join('\n')
  if (en(input.locale))
    return [
      `In the channel #${input.channel}, the user wants this done by several AI members as a flow:\n${input.request}`,
      `Members you can use:\n${list}`,
      'You are in plan mode (read-only): look, do not change anything. Deliver through task_done; do not call ExitPlanMode or ask to leave plan mode.',
      'Split it into at most 9 steps. Each step: title (what to do), member (exact name), deps (numbers of the steps that must be delivered first, counting from 1), kind ("work"; "review" with target = the step number it reviews; or "summary" for the final wrap-up). Steps that do not depend on each other run in parallel. If the work spans several layers (say the main process and the UI), first add a step that defines the shared interfaces and types, and make the others depend on it. Steps that run at the same time should not change the same files; put anything they share into that earlier step. Do not do the work yourself.',
      'Ask first, all at once: if something changes the result and cannot be inferred, call task_done once with summary and questions (at most 6, each {q, options}: 2-4 short options where possible) and no steps. The answers will be sent to you. Ask only what really matters; if nothing, skip this.',
      'Then deliver the complete plan in one go, without asking again: steps (each may also have effort: "low" | "medium" | "high" | "xhigh", the reasoning effort that step needs; think hard on interfaces and reviews, less on mechanical work) and brief: goal (one line), facts (what was decided, {k, v}; things you decided for the user get suggested: true, e.g. acceptance criteria or tech stack nobody named). Leave open empty. Also give title: a short name for the plan (at most 20 characters), not a copy of the request. Nobody starts yet: the user can edit it or ask for changes, and starts it when ready.',
      'If the task_done tool is not available to you, put exactly the same JSON (summary, title, questions or steps and brief) in a ```json block at the end of your reply instead; the app reads it from there.',
      input.auto && input.route
        ? 'You are the lead of this channel and the user did not name anyone. If this is just a question, do not call task_done: answer directly in your reply. If one member can finish it in one go, deliver exactly one step assigned to the member whose role fits best (when two fit equally, prefer the one marked less busy; it may be you); its title says what to do and, briefly, why that member. The app assigns it right away, no draft. Use several steps only when it really needs several members.'
        : input.auto
          ? 'You are the lead of this channel and the user did not name anyone. If this is just a question, or one member can finish it in one go, do not call task_done: answer directly in your reply.'
          : '',
      input.mention
        ? 'The user named you for this. Plan it before doing anything; if you can do it alone, a one-step plan assigned to yourself is fine. If it is only a question that needs no changes, answer directly and do not call task_done.'
        : '',
      input.handover
        ? `You are taking over from another member. Where they got to:\n${input.handover}\nKeep the user's answers and decisions; deliver the complete plan.`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  return [
    `用户想在频道 #${input.channel} 里让几个 AI 成员按流程做这件事：\n${input.request}`,
    `能用的成员：\n${list}`,
    '你现在在计划模式（只读）：只看不改。计划用 task_done 交，不要调用 ExitPlanMode，也不要申请退出计划模式。',
    '把它拆成最多 9 步。每一步写：title（做什么）、member（成员名字，原样写）、deps（要先交付的步骤序号，从 1 数）、kind（"work" 干活；"review" 审查，target 写审第几步；"summary" 最后汇总）。互相不依赖的步骤会同时做。跨好几层的活（比如主进程和界面都要改），先安排一步定共用的接口和类型，其余步骤依赖它；同时做的步骤不要改同一批文件，要共用的东西放进前面那一步。不要自己动手做这件事。',
    '先问、一次问完：有影响结果、又推不出来的事要用户定时，先只调用一次 task_done，写 summary 和 questions（最多 6 个，每个 {q, options}，尽量给 2–4 个简短选项），不写 steps。用户答完会发给你。只问真正要紧的，没有就跳过这一步。',
    '然后一次交出完整计划，不要再追问：steps（每一步可以带 effort："low" | "medium" | "high" | "xhigh"，这一步需要的推理强度；定接口、审查要想得深，照着写的活用低一些）和 brief：goal（一句话目标）、facts（定下来的，{k, v}；你替用户定的标 suggested: true，比如没人提的验收标准、技术栈），open 留空。再写 title：给计划起个短名字（20 字以内），不要照抄用户的原话。现在不会开工：用户可以直接改、或说要改哪里，确认后才开始。',
    '如果你这边没有 task_done 工具，就把一模一样的 JSON（summary、title、questions 或 steps 和 brief）放在回复最后的 ```json 代码块里，软件会从那里读取。',
    input.auto && input.route
      ? '你是这个频道的牵头成员，用户没有点名交给谁。如果这只是个问题，不要调用 task_done，直接在回复里回答。如果一个成员一次就能做完，只交一步，交给职责最合适的那个成员（两个一样合适时挑标着手上活少的；也可以是你自己），这一步的 title 写做什么、再简短说为什么交给他。软件会直接派活，不出草稿。真要几个人分工时才拆成几步。'
      : input.auto
        ? '你是这个频道的牵头成员，用户没有点名交给谁。如果这只是个问题，或者一个成员一次就能做完，不要调用 task_done，直接在回复里回答。'
        : '',
    input.mention
      ? '用户点名把这件事交给你。先拟计划，不要动手；你一个人能做完的，计划可以只有一步、交给你自己。如果只是个问题、不用改东西，直接在回复里回答，不要调用 task_done。'
      : '',
    input.handover
      ? `你接手另一个成员拟的计划。它做到这里：\n${input.handover}\n保留用户的回答和定下的东西，交出完整计划。`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const quote = (text: string): string => `> ${text.trim().replace(/\n/g, '\n> ')}`

/** 提案还没开工时，频道里有人接着说（补充细节、改主意、回答问题）：发给拆提案的成员改 */
export function flowRefinePrompt(input: {
  locale: Locale
  from: string
  text: string
  steps: { title: string; member: string; deps: number[]; kind: string }[]
  brief: FlowBriefInput | null
  /** 带了图片 / 文件（这里只转文字） */
  attached?: boolean
}): string {
  const steps = input.steps
    .map(
      (s, i) =>
        `${i + 1}. ${s.title} · ${s.member}${s.deps.length ? ` · deps ${s.deps.join(',')}` : ''}${s.kind !== 'work' ? ` · ${s.kind}` : ''}`,
    )
    .join('\n')
  const brief = briefText(input.brief, input.locale)
  if (en(input.locale))
    return [
      `${input.from} said in the channel, about the proposal you made (nothing has started yet):\n${quote(input.text)}`,
      input.attached
        ? '(They also attached images or files; read them with the attachment_read tool if you need them.)'
        : '',
      `Current steps:\n${steps || '(none)'}`,
      brief ? `Current ${brief}` : '',
      'If this adds details or asks for changes, update the plan: call task_done again with the complete steps and brief (facts gets what was just decided). Change only what they asked for and keep the rest, including edits they made on the card. Do not ask new questions. Then reply in one or two lines with what changed. If it does not change the proposal (just chat or a question), only reply; do not call task_done. Do not start the work.',
    ]
      .filter(Boolean)
      .join('\n\n')
  return [
    `${input.from} 在频道里接着说（关于你拆的提案，现在还没开工）：\n${quote(input.text)}`,
    input.attached ? '（还带了图片或文件；需要的话用 attachment_read 工具读）' : '',
    `现在的步骤：\n${steps || '（还没有）'}`,
    brief ? `现在的${brief}` : '',
    '如果这是在补充细节或要你改，就更新计划：再调用一次 task_done，交回完整的 steps 和 brief（刚定下的写进 facts）。只改用户要改的，其余照旧，包括用户在卡上改过的分工；不要再提新问题。然后在回复里用一两句说改了什么。如果和计划无关（闲聊、提问），只在回复里回答，不要调用 task_done。不要开始干活。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 用户一次答完了拟计划时问的问题：接着一次交出完整计划 */
export function flowAnswersPrompt(locale: Locale, items: { q: string; a: string }[]): string {
  const list = items.map((x, i) => `${i + 1}. ${x.q}\n   ${en(locale) ? 'Answer' : '回答'}: ${x.a}`).join('\n')
  return en(locale)
    ? `The user answered your questions:\n${list}\n\nNow deliver the complete plan in one go with task_done (steps and brief, facts include these answers). Do not ask again.`
    : `用户回答了你的问题：\n${list}\n\n现在用 task_done 一次交出完整计划（steps 和 brief，facts 里带上这些回答）。不要再问。`
}

/** 别的成员问过来的问题（发给被问的成员） */
export function flowAskPrompt(locale: Locale, from: string, question: string): string {
  return en(locale)
    ? `${from} (another member of the flow) asks you:\n${quote(question)}\n\nAnswer in your reply; the answer will be passed to ${from}. Do not call task_done for this: answering does not change your own delivery.`
    : `${from}（流程里的另一个成员）问你：\n${quote(question)}\n\n直接在回复里回答，回答会转给 ${from}。这次不用调用 task_done，回答不改你自己的交付。`
}

/** 被问的成员的回答（发回给提问的人） */
export function flowAnswerPrompt(locale: Locale, from: string, answer: string): string {
  return en(locale)
    ? `${from}'s answer:\n${quote(answer)}\n\nContinue your step; call task_done when it is really done.`
    : `${from} 的回答：\n${quote(answer)}\n\n接着做你这一步，确实做完了再调用 task_done。`
}

/** 一轮做完了却没交付：提醒一次 */
export function flowRemindPrompt(locale: Locale): string {
  return en(locale)
    ? `Your turn ended without task_done, so the flow is still waiting on this step. If it is done, call task_done now (summary, files). If not, keep going, or say exactly what is missing. ${deliveryFallback(locale)}`
    : `你这一轮结束了，但还没有调用 task_done，流程还在等这一步。做完了就现在调用 task_done（摘要、文件）；没做完就接着做，或者写清楚还差什么。${deliveryFallback(locale)}`
}

/** 被审查打回：问题清单 */
export function flowRejectPrompt(
  locale: Locale,
  reviewer: string,
  issues: string[],
  round: number,
  max: number,
): string {
  const list = issues.map((x, i) => `${i + 1}. ${x}`).join('\n')
  return en(locale)
    ? `${reviewer} reviewed your step and sent it back (${round}/${max}):\n${list}\n\nFix these, then call task_done again.`
    : `${reviewer} 审查了你这一步，打回了（第 ${round} / ${max} 次）：\n${list}\n\n改好后再调用 task_done。`
}

/** 被审的那一步改完了：再审一次 */
export function flowReviewAgainPrompt(locale: Locale, target: FlowInput): string {
  return en(locale)
    ? `${target.no} "${target.title}" was changed after your review:\n${inputText(target, locale)}\n\nReview it again and call task_done with the verdict.`
    : `${target.no}「${target.title}」按你的意见改过了：\n${inputText(target, locale)}\n\n再审一次，审完调用 task_done 给出结论。`
}

/** 等的回答一直没来，你点了继续：自己判断 */
export function flowNoAnswerPrompt(locale: Locale): string {
  return en(locale)
    ? 'The answer you asked for did not come. Decide on your own, continue your step and call task_done when it is really done; note what you assumed.'
    : '你问的问题一直没等到回答。自己判断后接着做这一步，确实做完了再调用 task_done，并写明你做了什么假设。'
}

/** 人工关卡打回（第 12 项）：用户看了交付，要改的地方 */
export function flowGatePrompt(locale: Locale, note: string): string {
  return en(locale)
    ? `The user looked at what you delivered and wants changes:\n${quote(note)}\n\nMake the changes, then call task_done again.`
    : `用户看了你这一步交上来的东西，要你改：\n${quote(note)}\n\n改好后再调用 task_done。`
}

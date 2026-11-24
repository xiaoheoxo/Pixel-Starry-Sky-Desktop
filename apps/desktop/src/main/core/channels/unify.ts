// 频道和团队融合第 2 批（docs/ui/channels-unify.md §5.2）的纯函数：共享到团队时的派活规则、改回只有我时留在本机的记录
import type { AgentPolicy, ChannelMessage, ChannelTaskStatus } from '../../../shared/types/channels'
import type { Locale } from '../../../shared/i18n/messages'

/** 共享时能选的派活规则；「指定的人直接派」要名单，共享之后在成员栏里设 */
export const SHARE_POLICIES: readonly AgentPolicy[] = ['owner', 'approve', 'team']

/**
 * 共享时哪些 AI 成员登记进团队频道、各按什么规则：只认这个频道里自己的成员（own），没列的不带进去；
 * 规则不认识的按「要我同意」
 */
export function sharePolicies(raw: unknown, own: readonly string[]): [string, AgentPolicy][] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const picked = raw as Record<string, unknown>
  return own
    .filter(id => Object.prototype.hasOwnProperty.call(picked, id))
    .map(id => [id, SHARE_POLICIES.includes(picked[id] as AgentPolicy) ? (picked[id] as AgentPolicy) : 'approve'])
}

const STATUS: Record<'zh' | 'en', Record<ChannelTaskStatus, string>> = {
  zh: {
    queued: '排队中',
    approval: '等同意',
    running: '进行中',
    waiting: '等确认',
    done: '完成',
    failed: '失败',
    stopped: '已停止',
  },
  en: {
    queued: 'queued',
    approval: 'awaiting approval',
    running: 'running',
    waiting: 'needs confirmation',
    done: 'done',
    failed: 'failed',
    stopped: 'stopped',
  },
}

const two = (n: number): string => String(n).padStart(2, '0')
/** 记录里的时间：月-日 时:分（本地时间） */
export function transcriptTime(at: number): string {
  const d = new Date(at)
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * 团队频道的消息写成本机留的记录，一条一段（Markdown）：文字消息是「**名字** 时间」加原文，任务卡写谁交给谁、状态、
 * 标题和结果；成员进出这类事件不记。名字找不到的写「?」
 */
export function transcriptBlocks(
  messages: readonly ChannelMessage[],
  name: (id: string) => string,
  locale: Locale,
  time: (at: number) => string = transcriptTime,
): string[] {
  const en = locale === 'en-US'
  const out: string[] = []
  for (const m of messages) {
    if (m.kind === 'message') {
      // 附件的内容跟着云端的频道一起删了，记录里留下名字
      const names = [...(m.attached?.images ?? []), ...(m.attached?.files ?? [])].map(a => a.name)
      const note = !names.length ? '' : en ? `(attachments: ${names.join(', ')})` : `（附件：${names.join('、')}）`
      const body = [m.text.trim(), note].filter(Boolean).join('\n')
      if (!body) continue
      out.push(`**${name(m.authorId)}** ${time(m.at)}\n${body}`)
    } else if (m.kind === 'task') {
      const head = en
        ? `**${name(m.authorId)} → ${name(m.assigneeId)}** ${time(m.at)} · ${STATUS.en[m.status]}`
        : `**${name(m.authorId)} 交给 ${name(m.assigneeId)}** ${time(m.at)} · ${STATUS.zh[m.status]}`
      const more = [m.summary, m.error]
        .filter((x): x is string => !!x && !!x.trim())
        .map(x => `> ${x.trim().replace(/\n/g, '\n> ')}`)
      out.push([head, m.title.trim(), ...more].join('\n'))
    }
  }
  return out
}

/**
 * 把一段段记录拼成几条消息，每条不超过 max 个字符；单独一段就超了的按 max 切开（不丢内容）
 */
export function transcriptChunks(blocks: readonly string[], max: number): string[] {
  const out: string[] = []
  let cur = ''
  const flush = (): void => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const block of blocks) {
    if (block.length > max) {
      flush()
      for (let i = 0; i < block.length; i += max) out.push(block.slice(i, i + max))
      continue
    }
    if (cur && cur.length + 2 + block.length > max) flush()
    cur = cur ? `${cur}\n\n${block}` : block
  }
  flush()
  return out
}

/** 记录最前面的一句：从哪个团队收回来的、多少条；truncated 是只留了最近的这些 */
export function transcriptHead(team: string, count: number, truncated: boolean, locale: Locale): string {
  if (locale === 'en-US')
    return `Record brought back from team “${team}”: ${count} messages${truncated ? ' (only the most recent ones were kept)' : ''}.`
  return `从团队「${team}」收回的记录：${count} 条${truncated ? '（只留了最近的这些）' : ''}。`
}

/** 团队频道里真人一条消息的字数上限（云端 MaxTextRunes），留一点给截断的省略号 */
const SIDE_TEXT_MAX = 7900

/**
 * 「我的协作」里的结果发到团队频道时的正文（docs/ui/channels-unify.md §7.2）：成员没登记在团队频道里时以我的名义发，
 * 开头写上成员名（name），并截到真人消息放得下；登记了的（name 为 null）原样发，长度由云端按 AI 结果的上限管
 */
export function sideMirrorText(text: string, name: string | null): string {
  const body = text.trim()
  if (!name) return body
  const out = `**${name}**\n\n${body}`
  return out.length > SIDE_TEXT_MAX ? `${out.slice(0, SIDE_TEXT_MAX)}…` : out
}

/**
 * 流程的状态变了，要不要告诉团队频道、说什么：草稿点了开始 → 列出步骤；跑过的流程完成、停止各说一句。
 * 没开始过就停掉的（牵头直接派走的、丢弃的草稿）、暂停和继续都不说（null）
 */
export function flowNotice(
  before: { status: string },
  after: { status: string; title: string; since?: unknown; steps: readonly { title: string; memberId: string }[] },
  nameOf: (id: string) => string,
  locale: Locale,
): { kind: 'start' | 'done' | 'stopped'; text: string } | null {
  if (before.status === after.status) return null
  const en = locale === 'en-US'
  if (before.status === 'draft' && after.status === 'running') {
    const steps = after.steps.map(
      (s, i) => `${i + 1}. ${s.title}${en ? ' — ' : '（'}${nameOf(s.memberId)}${en ? '' : '）'}`,
    )
    const head = en
      ? `Started the flow “${after.title}” (${steps.length} steps):`
      : `开始流程「${after.title}」（${steps.length} 步）：`
    return { kind: 'start', text: [head, ...steps].join('\n') }
  }
  if (!after.since) return null
  if (after.status === 'done')
    return { kind: 'done', text: en ? `The flow “${after.title}” is done.` : `流程「${after.title}」完成了。` }
  if (after.status === 'stopped')
    return { kind: 'stopped', text: en ? `The flow “${after.title}” was stopped.` : `流程「${after.title}」停了。` }
  return null
}

/** 本机频道不能重名：名字被占了就在后面加 2、3…（不超过 max 个字符） */
export function freeChannelName(name: string, taken: readonly string[], max = 40): string {
  const used = new Set(taken.map(n => n.toLowerCase()))
  if (!used.has(name.toLowerCase())) return name
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`
    const next = name.slice(0, max - suffix.length) + suffix
    if (!used.has(next.toLowerCase())) return next
  }
}

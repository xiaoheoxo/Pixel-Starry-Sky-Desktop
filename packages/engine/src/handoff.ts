// 跨引擎接力的交接材料：把对话里目标引擎没看过的部分整理成一段文字，放在用户消息前面发给它。
// 纯函数、确定性：同样的输入一定得到同样的文字（不读时间和随机数）。
import { ENGINES, type EngineId, type ImageAttachment, type Item } from '@pixelsky/protocol'
import { cut, wellFormed } from './text'

export interface HandoffInput {
  /** 要交接的条目：full 是整段对话，delta 是目标引擎上次处理之后新增的部分 */
  items: readonly Item[]
  mode: 'full' | 'delta'
  /** 接手的引擎 */
  target: EngineId
  conversationId: string
  /** 整段文字的字数上限 */
  budget?: number
  /** 目标引擎能用 pixelsky_history 工具（outline / read / search）时为 true */
  historyTool?: boolean
  /** 随这条消息一起发给目标引擎的更早消息的图片，按发送顺序（排在当前消息自己的图片前面）；交接材料里说明各是哪条消息附的 */
  images?: readonly HandoffImage[]
  /** 更早消息里没带上的图片张数，交接材料里说一声 */
  omittedImages?: number
}

export const HANDOFF_TAG = 'pixelsky-handoff'
export const DEFAULT_HANDOFF_BUDGET = 24_000

const TASK_CHARS = 1500
const REQUEST_CHARS = 400
const DONE_CHARS = 400
const TAIL_USER_CHARS = 1500
const TAIL_ASSISTANT_CHARS = 2500
const OUTPUT_CHARS = 300
const SECTION_REQUEST_CAP = 6000
const SECTION_DONE_CAP = 6000
const SECTION_TAIL_CAP = 10_000
const FILES_LIMIT = 80
const FILES_CHARS = 3000
const SECTION_TODO_CAP = 2000

export type UserItem = Extract<Item, { kind: 'user' }>

/** 一张图片和它所属的那条用户消息；bytes 同 image.bytes（挑图按它算额度） */
export interface HandoffImage {
  image: ImageAttachment
  item: UserItem
  bytes: number
}

/** 这些条目里用户发过的图片（含中途补充），按时间顺序 */
export function userImages(items: readonly Item[]): HandoffImage[] {
  return items.flatMap(item =>
    item.kind === 'user' ? (item.attachments ?? []).map(image => ({ image, item, bytes: image.bytes })) : [],
  )
}

/** 有信息量的条目：思考、提示和统计不算 */
export function isMeaningful(item: Item): boolean {
  return (
    item.kind === 'user' ||
    item.kind === 'assistant' ||
    item.kind === 'command' ||
    item.kind === 'file_change' ||
    item.kind === 'tool' ||
    item.kind === 'todo'
  )
}

/** 这些条目里有没有值得交接的内容（有信息量、而且能渲染出文字） */
export function hasHandoffContent(items: readonly Item[]): boolean {
  return items.some(item => isMeaningful(item) && render(item) !== null)
}

/** 这些条目里出现过的、处理过用户消息的引擎（按出现顺序，不含 except） */
export function handoffEngines(items: readonly Item[], except?: EngineId): EngineId[] {
  const seen: EngineId[] = []
  for (const item of items)
    if (item.kind === 'user' && item.engine && item.engine !== except && !seen.includes(item.engine))
      seen.push(item.engine)
  return seen
}

export const clip = (text: string, max: number): string =>
  text.length > max ? `${cut(text, 0, max)}…（已截断）` : text
export const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
/** 用户内容里不能出现我们的结束标签，免得提前结束交接段 */
const safe = (text: string): string => text.replaceAll(`</${HANDOFF_TAG}`, `</ ${HANDOFF_TAG}`)
export const isNormalUser = (item: Item): item is UserItem => item.kind === 'user' && item.mode !== 'guidance'

/** 说图片的消息时引用用户原话的字数 */
const QUOTE_CHARS = 20

/** 随消息发出的更早消息的图片：第几张图是哪条消息附的（顺序和发送顺序一致）；没带上的说一声 */
export function imageNotes(images: readonly HandoffImage[], omitted: number): string[] {
  const lines: string[] = []
  if (images.length) {
    lines.push(`这条消息附带的图片里，前 ${images.length} 张是之前消息里的图，不是用户这一条发的：`)
    images.forEach(({ image, item }, i) => {
      // 按码点截，免得把 emoji 劈成半个代理项（Codex 的 JSON 解析器会拒收）
      const said = Array.from(flat(item.text))
      const from = said.length
        ? `「${said.length > QUOTE_CHARS ? `${said.slice(0, QUOTE_CHARS).join('')}…` : said.join('')}」那条消息`
        : '那条只发了图片的消息'
      lines.push(`下面第 ${i + 1} 张图是之前${from}附的 ${image.name}`)
    })
    lines.push('图片没有随消息送达（例如当前模型不能看图）时，按文字说明理解即可。')
  }
  if (omitted > 0) lines.push(`另有 ${omitted} 张之前消息里的图片没有带过来，只留下了文件名。`)
  return lines.map(safe)
}

export function attachmentNames(item: UserItem): string {
  const names = [...(item.attachments ?? []).map(a => a.name), ...(item.files ?? []).map(f => f.name)]
  return names.length ? `（附：${names.join('、')}）` : ''
}

const KIND_LABEL = { add: '新增', update: '修改', delete: '删除' } as const
const STEP_LABEL = { completed: '已完成', in_progress: '进行中', pending: '待办' } as const

/** 单个条目渲染时各段文字的字数上限（命令输出取末尾） */
export interface RenderLimits {
  user: number
  assistant: number
  output: number
}
const HANDOFF_LIMITS: RenderLimits = { user: TAIL_USER_CHARS, assistant: TAIL_ASSISTANT_CHARS, output: OUTPUT_CHARS }

/** 单个条目的原文渲染（交接和对话历史工具共用）；不渲染的条目返回 null */
export function render(item: Item, limits: RenderLimits = HANDOFF_LIMITS): string | null {
  switch (item.kind) {
    case 'user': {
      const text = clip(item.text.trim(), limits.user)
      const extra = attachmentNames(item)
      if (!text && !extra) return null
      return `${item.mode === 'guidance' ? '用户（中途补充）' : '用户'}：${text}${extra}`
    }
    case 'assistant': {
      const text = item.text.trim()
      return text ? `助手：${clip(text, limits.assistant)}` : null
    }
    case 'command': {
      const out = item.output.trim()
      const tail = out.length > limits.output ? `…${cut(out, out.length - limits.output)}` : out
      return `$ ${item.command}${item.exitCode === null ? '' : `（退出码 ${item.exitCode}）`}${tail ? `\n${tail}` : ''}`
    }
    case 'tool':
      return `· ${item.name}：${item.title}`
    case 'file_change':
      return item.changes.length
        ? `· 改动文件：${item.changes.map(c => `${c.path}（${KIND_LABEL[c.kind]}）`).join('、')}`
        : null
    case 'todo':
      return item.steps.length ? `待办：${item.steps.map(s => `[${STEP_LABEL[s.status]}] ${s.text}`).join('；')}` : null
    case 'compaction':
      return item.status === 'completed' ? '（上下文已压缩）' : null
    default:
      return null
  }
}

/** 按用户消息切成轮：每轮从一条普通用户消息开始；第一条之前的零散条目自成一组 */
function turnsOf(items: readonly Item[]): Item[][] {
  const turns: Item[][] = []
  for (const item of items) {
    if (isNormalUser(item) || turns.length === 0) turns.push([item])
    else turns[turns.length - 1].push(item)
  }
  return turns
}

const renderTurn = (turn: readonly Item[]): string =>
  turn
    .map(item => render(item))
    .filter((s): s is string => s !== null)
    .join('\n')

/** 超长时留开头和结尾 */
function squeeze(text: string, max: number): string {
  if (text.length <= max) return text
  if (max < 40) return cut(text, 0, Math.max(0, max))
  const head = Math.floor(max * 0.4)
  const tail = max - head - 12
  return `${cut(text, 0, head)}\n…（中间省略）…\n${cut(text, text.length - tail)}`
}

/** 从最近一轮往前取，装得下就整轮放进去；至少放最近一轮（太长就压缩）。from 是放进去的最早一轮的序号 */
function tailTurns(turns: readonly Item[][], cap: number): { rendered: string; from: number } {
  const picked: string[] = []
  let used = 0
  let from = turns.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const text = renderTurn(turns[i])
    if (!text) {
      from = i
      continue
    }
    const size = text.length + 2
    if (picked.length > 0 && used + size > cap) break
    picked.unshift(text)
    used += size
    from = i
  }
  return { rendered: picked.length === 1 ? squeeze(picked[0], cap) : picked.join('\n\n'), from }
}

function filesSection(items: readonly Item[]): string {
  const last = new Map<string, keyof typeof KIND_LABEL>()
  for (const item of items)
    if (item.kind === 'file_change')
      for (const c of item.changes) {
        last.delete(c.path)
        last.set(c.path, c.kind)
      }
  const all = [...last]
  if (all.length === 0) return ''
  const shown = all.slice(-FILES_LIMIT)
  const lines: string[] = []
  let used = 0
  for (const [path, kind] of shown.reverse()) {
    const line = `- ${clip(path, 200)}（${KIND_LABEL[kind]}）`
    if (used + line.length + 1 > FILES_CHARS) break
    lines.unshift(line)
    used += line.length + 1
  }
  const omitted = all.length - lines.length
  return [...(omitted > 0 ? [`（更早的 ${omitted} 个文件未列出）`] : []), ...lines].join('\n')
}

/** 最后一份待办；超过上限时先省掉已完成的，还放不下就只列前面的 */
function todoSection(items: readonly Item[]): string {
  const todo = items.findLast(item => item.kind === 'todo')
  if (!todo || todo.kind !== 'todo' || todo.steps.length === 0) return ''
  const line = (s: (typeof todo.steps)[number]) => `- [${STEP_LABEL[s.status]}] ${clip(flat(s.text), 200)}`
  const all = todo.steps.map(line)
  if (all.join('\n').length <= SECTION_TODO_CAP) return all.join('\n')
  const done = todo.steps.filter(s => s.status === 'completed').length
  const open = todo.steps.filter(s => s.status !== 'completed').map(line)
  const kept: string[] = []
  let used = 0
  for (const l of open) {
    if (used + l.length + 1 > SECTION_TODO_CAP) break
    kept.push(l)
    used += l.length + 1
  }
  return [
    ...(done > 0 ? [`（已完成的 ${done} 项未列出）`] : []),
    ...kept,
    ...(kept.length < open.length ? [`（另有 ${open.length - kept.length} 项未列出）`] : []),
  ].join('\n')
}

/** 从最新往前装，装不下的更早的丢掉；返回按原顺序的行和丢掉的条数 */
function newest(lines: readonly string[], cap: number): { lines: string[]; omitted: number } {
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = lines[i].length + 1
    if (kept.length > 0 && used + size > cap) break
    if (kept.length === 0 && size > cap) break
    kept.unshift(lines[i])
    used += size
  }
  return { lines: kept, omitted: lines.length - kept.length }
}

/** 交接材料的一节。总长超预算时按 order 从小到大压缩（小的先压），shrink 把正文压到 max 字以内 */
interface Section {
  title: string
  body: string
  order: number
  shrink: (body: string, max: number) => string
}
/** 列表类的节：留最新的几行 */
const keepNewest = (body: string, max: number): string => {
  const marker = '（更早的已省略）'
  const lines = body.split('\n')
  const kept = newest(lines, max - marker.length - 1).lines
  // 最后一行就比 max 长：压缩这一行，不整节丢掉
  if (!kept.length) return `${marker}\n${squeeze(lines[lines.length - 1], max - marker.length - 1)}`
  return [marker, ...kept].join('\n')
}
/** 待办：前面的（正在做的、接下来要做的）最要紧，留开头 */
const keepFirst = (body: string, max: number): string => {
  const marker = '（后面的已省略）'
  const kept: string[] = []
  let used = marker.length + 1
  for (const line of body.split('\n')) {
    if (used + line.length + 1 > max) break
    kept.push(line)
    used += line.length + 1
  }
  return kept.length ? [...kept, marker].join('\n') : squeeze(body, max)
}
const section = (
  title: string,
  body: string,
  order: number,
  shrink: (body: string, max: number) => string = squeeze,
): Section => ({ title, body, order, shrink })
const joinSections = (sections: readonly Section[]): string =>
  sections
    .filter(s => s.body)
    .map(s => `## ${s.title}\n${s.body}`)
    .join('\n\n')

/**
 * 交接材料。返回 null 表示没有值得交接的内容。
 * count 是交接涉及的有信息量的条目数（用于界面提示）
 */
export function buildHandoff(input: HandoffInput): { text: string; count: number } | null {
  const { mode, target, conversationId } = input
  const budget = input.budget ?? DEFAULT_HANDOFF_BUDGET
  const items = input.items.filter(isMeaningful)
  if (!hasHandoffContent(items)) return null
  const count = items.length
  const engines = handoffEngines(items, target)
  const names = engines.length ? engines.map(e => ENGINES[e].name).join('、') : '其他 AI 引擎'
  const open = `<${HANDOFF_TAG} conversation="${conversationId}">`
  const close = `</${HANDOFF_TAG}>`
  const intro: string[] =
    mode === 'full'
      ? [`这段对话之前由${names}在像素星空里处理过。下面是像素星空为你整理的交接材料，帮你接上之前的进展。`]
      : [
          `自你上次处理这段对话以来，${names}又在像素星空里继续了 ${items.filter(isNormalUser).length} 轮。下面是这期间发生的事，帮你补上进展。`,
        ]
  intro.push(
    '上一个引擎的内部推理、等待批准的操作和正在运行的工具都没有带过来。',
    '请直接回应用户最新的消息，不要复述这份交接材料。',
  )
  if (input.historyTool)
    intro.push(
      '需要更早几轮的细节时，用 MCP 服务器 pixelsky_history 的 outline（目录）/ read（读某几轮原文）/ search（按关键词查）工具查询这段对话，不要凭印象猜；Claude Code 里它们叫 mcp__pixelsky_history__outline 等。',
    )
  intro.push(...imageNotes(input.images ?? [], input.omittedImages ?? 0))
  const head = [open, ...intro].join('\n')

  // 超预算时先压缩次要的节（已完成的事、用户的要求、文件……），最近几轮原文最后才动；
  // 以前是把拼好的正文从末尾裁掉，裁掉的正好是放在最后的最近几轮原文
  const finish = (sections: Section[]): { text: string; count: number } => {
    const room = Math.max(0, budget - head.length - close.length - 3)
    for (const s of [...sections].filter(s => s.body).sort((a, b) => a.order - b.order)) {
      const over = joinSections(sections).length - room
      if (over <= 0) break
      // 留 32 字给省略说明；压到太短就整节去掉
      const max = s.body.length - over - 32
      s.body = max < 80 ? '' : s.shrink(s.body, max)
    }
    let body = joinSections(sections)
    // 预算比开头说明还小这类极端情况：只能整体压缩
    if (body.length > room) body = squeeze(body, room)
    return { text: wellFormed(`${head}\n\n${body}\n${close}`), count }
  }

  const turns = turnsOf(items)
  // delta：整段放得下就原文照放
  if (mode === 'delta') {
    const whole = turns.map(renderTurn).filter(Boolean).join('\n\n')
    if (head.length + whole.length + close.length + 64 <= budget) return finish([section('期间的对话', safe(whole), 6)])
  }

  const fixed = head.length + close.length + 400
  const rest = Math.max(0, budget - fixed)
  const files = safe(filesSection(items))
  const tail = tailTurns(turns, Math.min(SECTION_TAIL_CAP, Math.floor(rest * 0.5)))
  // 最近几轮原文一开始就限在预算的一半以内，别的节压完一般都放得下，这里只是兜底：
  // 真要压缩时重新从最近一轮往前取（整轮保留），不从中间劈开最近一轮
  const shrinkTail = (_: string, max: number) => safe(tailTurns(turns, max).rendered)
  // 最近几轮原文已经覆盖了全部：不再重复摘要
  if (tail.from === 0)
    return finish([
      section(mode === 'full' ? '对话原文' : '期间的对话', safe(tail.rendered), 6, shrinkTail),
      section('涉及的文件', files, 3, keepNewest),
    ])

  const earlier = turns.slice(0, tail.from)
  const first = items.find(isNormalUser)
  const task = mode === 'full' && first ? safe(clip(first.text.trim(), TASK_CHARS) + attachmentNames(first)) : ''
  const todo = safe(todoSection(items))
  // 原文、任务、文件、待办先占，剩下的按 4:6 分给「用户的要求」和「已完成的事」
  // （以前这两节各按总量取比例，再加上任务、文件、待办，几节都满时合起来会超预算）
  const left = Math.max(0, rest - tail.rendered.length - task.length - files.length - todo.length)
  const requests = newest(
    earlier
      .flat()
      .flatMap(item =>
        item.kind === 'user' ? [`- ${clip(flat(item.text) || attachmentNames(item), REQUEST_CHARS)}`] : [],
      ),
    Math.min(SECTION_REQUEST_CAP, Math.floor(left * 0.4)),
  )
  const done = newest(
    earlier.flatMap(turn => {
      const last = turn.findLast(item => item.kind === 'assistant' && item.text.trim())
      return last && last.kind === 'assistant' ? [`- ${clip(flat(last.text), DONE_CHARS)}`] : []
    }),
    Math.min(SECTION_DONE_CAP, Math.floor(left * 0.6)),
  )
  const note = (n: number, what: string) => (n > 0 ? `（更早的 ${n} ${what}已省略）\n` : '')
  return finish([
    section('当前任务', task, 5),
    section(
      '用户的要求',
      requests.lines.length ? safe(note(requests.omitted, '条') + requests.lines.join('\n')) : '',
      2,
      keepNewest,
    ),
    section(
      '已完成的事',
      done.lines.length ? safe(note(done.omitted, '轮') + done.lines.join('\n')) : '',
      1,
      keepNewest,
    ),
    section('涉及的文件', files, 3, keepNewest),
    section('待办', todo, 4, keepFirst),
    section('最近几轮原文', safe(tail.rendered), 6, shrinkTail),
  ])
}

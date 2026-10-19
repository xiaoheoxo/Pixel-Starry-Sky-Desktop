// 对话历史查询（pixelsky_history 工具的纯逻辑）：目录、读几轮原文、关键词搜索。
// 只读、确定性：同样的条目一定得到同样的文字；输出都是给引擎读的中文纯文本。
import { ENGINES, type EngineId, type Item } from '@pixelsky/protocol'
import {
  HANDOFF_TAG,
  attachmentNames,
  clip,
  flat,
  isMeaningful,
  isNormalUser,
  render,
  type RenderLimits,
} from './handoff'
import { cut, wellFormed } from './text'

export const OUTLINE_PAGE_SIZE = 50
export const READ_MAX_COUNT = 5
export const READ_MAX_CHARS = 20_000
export const SEARCH_DEFAULT_LIMIT = 20
export const SEARCH_MAX_LIMIT = 50

const OUTLINE_CHARS = 120
const OUTPUT_CHARS = 2000
const SNIPPET_RADIUS = 80
const QUERY_MAX = 200
/** 读原文时用户和助手的话不截断，命令输出取末尾；总长由 READ_MAX_CHARS 兜底 */
const READ_LIMITS: RenderLimits = { user: Infinity, assistant: Infinity, output: OUTPUT_CHARS }

export interface HistoryTurn {
  /** 从 1 开始；第一条用户消息之前有实质内容时，那一组是第 0 轮 */
  number: number
  /** 处理这一轮的引擎（用户消息上的标记，没有就用 fallback）；都没有为 null */
  engine: EngineId | null
  items: Item[]
}

/** 按普通用户消息切成轮（中途补充不开新的一轮） */
export function historyTurns(items: readonly Item[], fallbackEngine?: EngineId): HistoryTurn[] {
  const turns: HistoryTurn[] = []
  const lead: Item[] = []
  const leadTurn = (): HistoryTurn[] =>
    lead.some(isMeaningful) ? [{ number: 0, engine: fallbackEngine ?? null, items: [...lead] }] : []
  let started = false
  let n = 0
  for (const item of items) {
    if (isNormalUser(item)) {
      if (!started) turns.push(...leadTurn())
      started = true
      turns.push({ number: ++n, engine: item.engine ?? fallbackEngine ?? null, items: [item] })
    } else if (started) turns[turns.length - 1].items.push(item)
    else lead.push(item)
  }
  if (!started) turns.push(...leadTurn())
  return turns
}

const engineName = (engine: EngineId | null): string => (engine ? ENGINES[engine].name : '未知引擎')
const noEmpty = (text: string): string => text || '（空）'

export interface OutlineOptions {
  page?: number
  fallbackEngine?: EngineId
}

/** 目录：每轮一行（用户说了什么 → 助手最后答了什么），按页给 */
export function historyOutline(items: readonly Item[], options: OutlineOptions = {}): string {
  const turns = historyTurns(items, options.fallbackEngine)
  if (turns.length === 0) return '这段对话还没有内容。'
  const pages = Math.ceil(turns.length / OUTLINE_PAGE_SIZE)
  const page = options.page === undefined ? 1 : options.page
  if (!Number.isInteger(page) || page < 1 || page > pages)
    return `没有第 ${page} 页，目录共 ${pages} 页（page 从 1 开始）。`
  const last = turns.at(-1)!.number
  const lines = turns.slice((page - 1) * OUTLINE_PAGE_SIZE, page * OUTLINE_PAGE_SIZE).map(turn => {
    const first = turn.items.find(item => item.kind === 'user')
    const user = first && first.kind === 'user' ? flat(first.text) || attachmentNames(first) : ''
    const answer = turn.items.findLast(item => item.kind === 'assistant' && item.text.trim())
    const reply = answer && answer.kind === 'assistant' ? flat(answer.text) : ''
    return `#${turn.number} [${engineName(turn.engine)}] 用户：${user ? clip(user, OUTLINE_CHARS) : '（无）'} → 助手：${reply ? clip(reply, OUTLINE_CHARS) : '（无回复）'}`
  })
  // 落单的代理项（上游原文、早先按下标截断的工具标题等）换掉：Codex 的 JSON 解析器会拒收
  const outline = [
    `这段对话共 ${turns.length} 轮（#${turns[0].number}–#${last}），第 ${page}/${pages} 页，每页最多 ${OUTLINE_PAGE_SIZE} 轮。`,
    ...lines,
    [
      page < pages ? `还有更多：outline(page=${page + 1}) 看下一页。` : '',
      '用 read(turn=N) 读第 N 轮原文，用 search(query) 按关键词查。',
    ]
      .filter(Boolean)
      .join(' '),
  ].join('\n')
  return wellFormed(outline)
}

/** 一轮里的条目渲染成原文；交接材料的提示条目不算对话 */
function renderForRead(item: Item): string | null {
  if (item.kind === 'notice')
    return item.detail?.startsWith(`<${HANDOFF_TAG}`) ? null : item.text.trim() ? `（提示）${item.text.trim()}` : null
  return render(item, READ_LIMITS)
}

export interface ReadOptions {
  turn: number
  count?: number
  fallbackEngine?: EngineId
}

/** 读从第 turn 轮起最多 count 轮的原文 */
export function historyRead(items: readonly Item[], options: ReadOptions): string {
  const turns = historyTurns(items, options.fallbackEngine)
  if (turns.length === 0) return '这段对话还没有内容。'
  const first = turns[0].number
  const last = turns.at(-1)!.number
  const { turn } = options
  if (!Number.isInteger(turn) || turn < first || turn > last)
    return `没有第 ${turn} 轮。这段对话的轮次是 #${first}–#${last}，先用 outline 看目录。`
  const asked = options.count === undefined ? 1 : options.count
  const count = Math.min(Math.max(Number.isInteger(asked) ? asked : 1, 1), READ_MAX_COUNT)
  const picked = turns.slice(turn - first, turn - first + count)
  const text = picked
    .map(t => {
      const body = t.items
        .map(renderForRead)
        .filter((s): s is string => s !== null)
        .join('\n')
      return `===== 第 ${t.number} 轮 [${engineName(t.engine)}] =====\n${noEmpty(body)}`
    })
    .join('\n\n')
  const end = picked.at(-1)!.number
  const more = end < last ? `\n\n（后面还有第 ${end + 1}–${last} 轮，read(turn=${end + 1}) 继续读。）` : ''
  if (text.length <= READ_MAX_CHARS) return wellFormed(text + more)
  return wellFormed(
    `${cut(text, 0, READ_MAX_CHARS)}\n…（超过 ${READ_MAX_CHARS} 字已截断，原文共 ${text.length} 字；请减小 count 或逐轮读取）${more}`,
  )
}

const SEARCH_KIND = { user: '用户', assistant: '助手', command: '命令', tool: '工具', file_change: '文件' } as const

/** 条目里能被搜索的文字（不带「用户：」之类的前缀，免得搜这些词全中） */
function searchText(item: Item): string {
  switch (item.kind) {
    case 'user':
      return `${item.text}\n${attachmentNames(item)}`
    case 'assistant':
      return item.text
    case 'command':
      return `${item.command}\n${item.output}`
    case 'tool':
      return `${item.name} ${item.title}`
    case 'file_change':
      return item.changes.map(c => c.path).join('\n')
    default:
      return ''
  }
}

export interface SearchOptions {
  query: string
  limit?: number
  fallbackEngine?: EngineId
}

/** 在用户、助手、命令、工具、文件改动里按关键词（不分大小写）找，每个条目最多给一处片段 */
export function historySearch(items: readonly Item[], options: SearchOptions): string {
  const query = options.query.trim()
  if (!query) return '请给出要搜索的关键词。'
  if (query.length > QUERY_MAX) return `关键词太长（最多 ${QUERY_MAX} 字）。`
  const asked = options.limit === undefined ? SEARCH_DEFAULT_LIMIT : options.limit
  const limit = Math.min(Math.max(Number.isInteger(asked) ? asked : SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT)
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const hits: string[] = []
  let total = 0
  for (const turn of historyTurns(items, options.fallbackEngine))
    for (const item of turn.items) {
      if (!(item.kind in SEARCH_KIND)) continue
      const text = searchText(item)
      const at = text.search(pattern)
      if (at < 0) continue
      total++
      if (hits.length >= limit) continue
      const from = Math.max(0, at - SNIPPET_RADIUS)
      const to = Math.min(text.length, at + query.length + SNIPPET_RADIUS)
      const snippet = `${from > 0 ? '…' : ''}${flat(cut(text, from, to))}${to < text.length ? '…' : ''}`
      hits.push(`#${turn.number} [${SEARCH_KIND[item.kind as keyof typeof SEARCH_KIND]}] ${snippet}`)
    }
  if (total === 0) return `没有找到包含「${query}」的内容。`
  return wellFormed(
    [
      `找到 ${total} 处包含「${query}」的内容${total > hits.length ? `，显示前 ${hits.length} 处` : ''}：`,
      ...hits,
      '用 read(turn=N) 读对应轮次的原文。',
    ].join('\n'),
  )
}

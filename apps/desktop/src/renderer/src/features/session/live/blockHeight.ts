// 对话流里没渲染过的块的估计高度（docs/ui/conversation-ux.md §2.7）。
// 块加了 content-visibility: auto，看不见的块按这个高度占位；只求大致接近，让滚动条长度和拖动位置不至于差太多。
// 渲染过一次以后浏览器记住真实高度（contain-intrinsic-block-size 的 auto），不再用这里的估计
import type { Item } from '@pixelsky/protocol'
import { FOLD_OVER, FOLD_SHOW } from '@/ui/code/CodeBlock'
import { USER_FOLD_CHARS, USER_FOLD_LINES } from './userBlocks'

/** 正文一行（含行距） */
const PROSE_LINE = 26
/** 空行（段落间距） */
const BLANK = 10
/** 代码一行 */
const CODE_LINE = 20
/** 代码块的标题栏和上下内边距 */
const CODE_CHROME = 56
/** 长代码块折叠后底部的「展开全部」 */
const FOLD_BUTTON = 36
/** 一行正文大约容纳的宽度单位：中日韩字算 2，其余算 1 */
const LINE_UNITS = 110
/** 工具行、思考、待办这类单行条目（density.css 的 [data-step-row]，两种模式都是 24） */
export const ROW = 24
/** 「执行」块的标题行 */
const PROCESS_HEAD = 30
/** 执行块里夹在工具行之间的过渡话、提示：上下各留 6px（density.css） */
const PROCESS_GAP = 12
/** 执行块运行中收起时还露出的最后几条（TurnProcess 的 TAIL） */
const PROCESS_TAIL = 2
/** 折叠的长用户消息：显示 12 行（max-h-[12lh]）加「展开」按钮 */
const USER_FOLDED = 20 + 22 * 12 + 24
/** 用户消息里的图片缩略图一排、文件标签一排 */
const USER_IMAGES = 112
const USER_FILES = 32
/** 估计值上限：再长的块也不至于超过这个，避免离谱的估计把滚动条撑得太长 */
const MAX = 50_000

function units(line: string): number {
  let n = 0
  for (const ch of line) n += ch.charCodeAt(0) >= 0x2e80 ? 2 : 1
  return n
}

const proseLines = (line: string, perLine = LINE_UNITS): number => Math.max(1, Math.ceil(units(line) / perLine))

/** 回复（Markdown）：正文按折行估，代码块按行数，超过 FOLD_OVER 行的折叠后只显示 FOLD_SHOW 行 */
export function markdownHeight(text: string): number {
  let height = 0,
    code = -1
  const codeBlock = (lines: number): number =>
    CODE_CHROME + CODE_LINE * (lines > FOLD_OVER ? FOLD_SHOW : lines) + (lines > FOLD_OVER ? FOLD_BUTTON : 0)
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (code < 0) code = 0
      else {
        height += codeBlock(code)
        code = -1
      }
    } else if (code >= 0) code++
    else height += line.trim() ? PROSE_LINE * proseLines(line) : BLANK
  }
  // 还没闭合的代码块（流式输出中）
  if (code >= 0) height += codeBlock(code)
  return Math.min(MAX, Math.round(height))
}

export function itemHeight(item: Item): number {
  switch (item.kind) {
    case 'user': {
      // 图片缩略图一排、带的文件一排标签
      const extra = (item.attachments?.length ? USER_IMAGES : 0) + (item.files?.length ? USER_FILES : 0)
      // 长消息折起来只显示前 12 行（ItemRows 的 UserBody）
      if (item.text.length > USER_FOLD_CHARS || item.text.split('\n').length > USER_FOLD_LINES)
        return USER_FOLDED + extra
      // 气泡最宽约为正文的四分之三
      return Math.min(MAX, 20 + extra + PROSE_LINE * item.text.split('\n').reduce((n, l) => n + proseLines(l, 80), 0))
    }
    case 'assistant':
      return markdownHeight(item.text)
    case 'notice':
      // 自动换账号的提示下面还有一行按钮（AccountNoticeActions）
      return item.account ? 64 : 40
    case 'compaction':
      return 72
    default:
      return ROW
  }
}

/** 一组连续的工具行 */
export const toolsHeight = (count: number): number => ROW * count

/** 改动文件卡片：标题加内边距 50，文件一行 26（density.css 的 [data-change-row]） */
export const changesHeight = (files: number): number => 50 + 26 * files

/** 对话里的报错提示：一行红字的卡片，最近一轮的报错下面还有一排按钮（NoticeActions） */
export const errorNoticeHeight = (actions: boolean): number => (actions ? 78 : 46)

/** 子智能体小框（density.css 的 [data-subagent-box]，两种模式都是 28） */
export const SUBAGENT_BOX = 28

/**
 * 「执行」块：收起时只有标题行；展开时（极简模式默认展开）加上里面每一条：工具行、思考、待办一行，
 * 过渡话按 Markdown 估、上下留空。运行中收起时还露出最后几条
 */
export function processHeight(items: readonly Item[], open: boolean, running: boolean): number {
  const shown = open ? items : running ? items.slice(-PROCESS_TAIL) : []
  if (!shown.length) return PROCESS_HEAD
  let height = PROCESS_HEAD + 4
  for (const item of shown) {
    if (item.kind === 'assistant' || item.kind === 'notice' || item.kind === 'user')
      height += itemHeight(item) + PROCESS_GAP
    else height += ROW
  }
  return Math.min(MAX, Math.round(height))
}

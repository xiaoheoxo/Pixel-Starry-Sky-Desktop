// 查看模式的纯函数（docs/ui/view-mode.md）：不碰 window、store，测试直接导入
import type { Item } from '@pixelsky/protocol'

export type ViewMode = 'normal' | 'chat' | 'detailed'
export const VIEW_MODES: readonly ViewMode[] = ['normal', 'chat', 'detailed']

/** 存的旧值 thinking（2026-11-14 前的「思考」档，D281 换成「聊天」）按聊天读 */
export const parseViewMode = (v: unknown): ViewMode =>
  v === 'thinking' ? 'chat' : VIEW_MODES.includes(v as ViewMode) ? (v as ViewMode) : 'normal'
export const nextViewMode = (m: ViewMode): ViewMode => VIEW_MODES[(VIEW_MODES.indexOf(m) + 1) % VIEW_MODES.length]!

/** 详细模式的输出限高：数到 13 行就停，不把大输出整段切开（§5） */
export const OUTPUT_CLAMP_LINES = 12
export function overClamp(text: string): boolean {
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) if (++n >= OUTPUT_CLAMP_LINES) return true
  return false
}

/**
 * 限高时实际画几行（§13 A）。限高按外层的行高算 12 行，改动内容自己的行高更小，12 行的高度里装得下不止 12 行，
 * 所以画 2 倍垫着；其余的点「展开」才画，对话内搜索把它们算进「折叠中还有 N 处」（foldedText.ts 的 clampedText）
 */
export const CLAMP_DRAWN_LINES = OUTPUT_CLAMP_LINES * 2
/** 第 CLAMP_DRAWN_LINES 行结尾的位置；不到这么多行时是全文长度 */
function clampCut(text: string): number {
  let i = -1
  for (let n = 0; n < CLAMP_DRAWN_LINES; n++) {
    i = text.indexOf('\n', i + 1)
    if (i < 0) return text.length
  }
  return i
}
/** 限高时画出来的部分 */
export const clampLines = (text: string): string => text.slice(0, clampCut(text))
/** 限高时没画出来的部分（没有就是空串） */
export const clampedRest = (text: string): string => text.slice(clampCut(text) + 1)

/** 正在输出的思考每块几行 */
const STREAM_CHUNK_LINES = 16
/**
 * 正在输出的长文字按行分块（§13 C）：每块是整行，块尾的换行去掉（一块一个 div，块和块之间本来就换行），
 * 用换行拼起来就是原文。写满的块不再变，每来一段只有最后一块要重排
 */
export function streamChunks(text: string): string[] {
  const out: string[] = []
  let start = 0
  let lines = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (++lines % STREAM_CHUNK_LINES) continue
    out.push(text.slice(start, i))
    start = i + 1
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

const failed = (i: Item): boolean =>
  (i.kind === 'command' || i.kind === 'tool' || i.kind === 'file_change') &&
  i.status === 'failed' &&
  i.review?.status !== 'denied' &&
  i.review?.status !== 'timedOut'

/** 收起的「执行」也露出来的失败项（所有模式一样，§3 例外） */
export const failedItems = (items: readonly Item[]): Item[] => items.filter(failed)

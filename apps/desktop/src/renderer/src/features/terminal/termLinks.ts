// 终端里的链接定位（docs/ui/files-search-terminal-pins.md §4.2）：自动折行的几行接成一段文字去匹配，
// 匹配到的文字下标再换算回单元格。不能把下标直接当列号：中文占两列，emoji 一列可能是两个码元。
import type { IBuffer, IBufferRange } from '@xterm/xterm'

/** 往上、往下最多各接这么多列（压缩过的代码一行能折出几千行）；按行数限的话，窄终端里的长网址会被截断 */
const MAX_COLUMNS = 4096

export interface TerminalText {
  text: string
  /** 文字下标 [start, end) → xterm 的链接范围（行列从 1 起，含末尾那一格） */
  range(start: number, end: number): IBufferRange
  /** 只留碰到第 row 行的：xterm 去重时把链接都当成在这一行上，别的行的会把这一行的挤掉 */
  onRow<T extends { start: number; end: number }>(matches: T[]): T[]
}

/** 第 row 行（0 起）所在的一整段文字；row 不在缓冲区里时为 null */
export function terminalText(buffer: IBuffer, row: number, cols: number): TerminalText | null {
  if (!buffer.getLine(row)) return null
  const wrapped = (r: number): boolean => !!buffer.getLine(r)?.isWrapped
  const limit = Math.ceil(MAX_COLUMNS / cols)
  let top = row,
    bottom = row
  while (top > 0 && row - top < limit && wrapped(top)) top--
  while (bottom - row < limit && wrapped(bottom + 1)) bottom++
  let text = ''
  /** 每个码元所在的行、它那一格的首列和末列（都从 1 起） */
  const at: { y: number; first: number; last: number }[] = []
  const cell = buffer.getNullCell()
  for (let r = top; r <= bottom; r++) {
    const line = buffer.getLine(r)!
    const width = Math.min(line.length, cols)
    // 折到下一行的整行都算，末尾空格照留：全屏程序盖写旧行后折行标记还在，去掉空格会把两行不相干的字粘成一个词
    let used = width
    while (r === bottom && used > 0 && !line.getCell(used - 1, cell)?.getChars() && cell.getWidth() !== 0) used--
    for (let x = 0; x < used; x++) {
      line.getCell(x, cell)
      const columns = cell.getWidth()
      if (!columns) continue // 全角字的后半格
      const chars = cell.getChars() || ' '
      for (let i = 0; i < chars.length; i++) at.push({ y: r + 1, first: x + 1, last: x + columns })
      text += chars
    }
  }
  return {
    text,
    range: (start, end) => ({
      start: { x: at[start].first, y: at[start].y },
      end: { x: at[end - 1].last, y: at[end - 1].y },
    }),
    onRow: matches => matches.filter(m => at[m.start].y <= row + 1 && at[m.end - 1].y >= row + 1),
  }
}

// 碰到空白、引号、尖括号、反引号、制表线、中日韩文字和全角标点就停：中文里网址后面常常不空格
const HTTP =
  /https?:\/\/[^\s<>"'`\u2014-\u201f\u2026\u2500-\u257f\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]+/g

/** 文字里的网址；末尾的标点、没有配对的右括号不算 */
export function findUrls(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  for (const match of text.matchAll(HTTP)) {
    let url = match[0]
    for (;;) {
      const last = url.at(-1)!
      const open = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : null
      const extra = open ? url.split(last).length > url.split(open).length : /[.,;:!?*]/.test(last)
      if (!extra) break
      url = url.slice(0, -1)
    }
    if (/:\/\/./.test(url)) out.push({ start: match.index, end: match.index + url.length })
  }
  return out
}

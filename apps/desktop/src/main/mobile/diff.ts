// 手机看 Git 改动（docs/mobile-remote.md §18.4）：电脑把两边的全文比成带上下文的 unified diff 再发，
// 不把两份全文都发过去（单帧 1 MB）。只有 @@ 行和 +/-/空格 开头的行，和会话里改动卡片的 diff 一样。

import { diffLines } from '@pixelsky/engine'

/** 每处改动前后留几行 */
const CONTEXT = 3
/** 发给手机的 diff 最多这么多字符，再多截断 */
export const PHONE_DIFF_LIMIT = 400_000

export interface PhoneDiff {
  diff: string
  added: number
  removed: number
  /** 太长被截断了 */
  cut: boolean
}

type Line = readonly [' ' | '-' | '+', string]

const split = (text: string | null): string[] => {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** 两段全文（新文件 original 为 null，删除的 modified 为 null）→ 只含改动和前后几行的 diff */
export function phoneDiff(original: string | null, modified: string | null): PhoneDiff {
  const a = split(original),
    b = split(modified)
  // 共用引擎的逐行比对（先去相同头尾，中间小用 LCS、大用 Myers）
  const lines: Line[] = diffLines(a, b)
  const changed: number[] = []
  lines.forEach(([t], i) => t !== ' ' && changed.push(i))
  // 每一行之前，两边各走到第几行（从 1 起）
  const oldAt = new Uint32Array(lines.length + 1),
    newAt = new Uint32Array(lines.length + 1)
  oldAt[0] = newAt[0] = 1
  lines.forEach(([t], i) => {
    oldAt[i + 1] = oldAt[i] + (t === '+' ? 0 : 1)
    newAt[i + 1] = newAt[i] + (t === '-' ? 0 : 1)
  })
  const out: string[] = []
  let size = 0,
    cut = false,
    added = 0,
    removed = 0
  for (const [t] of lines) {
    if (t === '+') added++
    else if (t === '-') removed++
  }
  for (let h = 0; h < changed.length && !cut; ) {
    // 相邻两处改动之间不超过两倍上下文就并成一段
    let k = h
    while (k + 1 < changed.length && changed[k + 1] - changed[k] <= 2 * CONTEXT + 1) k++
    const from = Math.max(0, changed[h] - CONTEXT),
      to = Math.min(lines.length, changed[k] + CONTEXT + 1)
    const hunk = [`@@ -${oldAt[from]},${oldAt[to] - oldAt[from]} +${newAt[from]},${newAt[to] - newAt[from]} @@`]
    for (let i = from; i < to; i++) hunk.push(lines[i][0] + lines[i][1])
    for (const line of hunk) {
      if (size + line.length + 1 > PHONE_DIFF_LIMIT) {
        cut = true
        break
      }
      out.push(line)
      size += line.length + 1
    }
    h = k + 1
  }
  return { diff: out.join('\n'), added, removed, cut }
}

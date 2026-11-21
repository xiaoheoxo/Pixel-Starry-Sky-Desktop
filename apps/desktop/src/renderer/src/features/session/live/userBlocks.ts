// 用户消息拆成文字段和代码段（docs/ui/conversation-ux-2.md §2.4）：成对的 ``` / ~~~ 代码块按代码显示，
// 没闭合的照原文；代码块前后的空行去掉（代码块自己有上下间距）。

export type UserBlock = { kind: 'text'; text: string } | { kind: 'code'; lang: string | null; code: string }

const OPEN = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)[^`]*$/

export function userBlocks(text: string): UserBlock[] {
  const lines = text.split('\n')
  const blocks: UserBlock[] = []
  let buffer: string[] = []
  const flushText = () => {
    if (buffer.length) blocks.push({ kind: 'text', text: buffer.join('\n') })
    buffer = []
  }
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i])
    if (!open) {
      buffer.push(lines[i])
      continue
    }
    const fence = open[1]
    const close = lines.findIndex(
      (l, j) => j > i && l.trim().startsWith(fence[0].repeat(fence.length)) && /^[`~]+$/.test(l.trim()),
    )
    if (close < 0) {
      buffer.push(lines[i])
      continue
    }
    flushText()
    blocks.push({ kind: 'code', lang: open[2] || null, code: lines.slice(i + 1, close).join('\n') })
    i = close
  }
  flushText()
  // 代码块前后的空行去掉；只剩空白的文字段不要
  return blocks
    .map((b, i) => {
      if (b.kind !== 'text') return b
      let t = b.text
      if (blocks[i + 1]?.kind === 'code') t = t.replace(/\s*$/, '')
      if (blocks[i - 1]?.kind === 'code') t = t.replace(/^\s*\n/, '')
      return { ...b, text: t }
    })
    .filter(b => b.kind === 'code' || b.text.trim() !== '')
}

/** 长消息折叠：超过 16 行或 1200 个字 */
export const USER_FOLD_LINES = 16
export const USER_FOLD_CHARS = 1200
export const shouldFoldUser = (text: string): boolean =>
  text.length > USER_FOLD_CHARS || text.split('\n').length > USER_FOLD_LINES

/** 引导（插话）消息收得更紧：超过 6 行或 300 个字就折叠，只露 3 行 */
export const GUIDANCE_FOLD_LINES = 6
export const GUIDANCE_FOLD_CHARS = 300
export const shouldFoldGuidance = (text: string): boolean =>
  text.length > GUIDANCE_FOLD_CHARS || text.split('\n').length > GUIDANCE_FOLD_LINES

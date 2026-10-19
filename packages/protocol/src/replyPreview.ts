// 会话列表里「最后一句回复」的预览：把 AI 的 Markdown 回复变成一行纯文本（docs/mobile-remote.md §21.3）。
// 手机和桌面都用它，所以放在协议包里。

export const REPLY_PREVIEW_MAX = 120

const CODE_BLOCK = '[代码]'
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/
// 行内代码的占位符用私用区字符（回复里几乎不会出现，也不是控制字符）
const STASH = /(\d+)/g

/** 行内的 Markdown 记号：行内代码、图片、链接、加粗斜体删除线 */
function inline(line: string): string {
  // 行内代码先收起来（里面的 * _ 不是记号），去掉反引号后最后放回
  const code: string[] = []
  let s = line.replace(/(`+)(.+?)\1/g, (_m, _ticks: string, body: string) => {
    code.push(body.trim())
    return `${code.length - 1}`
  })
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片留说明文字
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只留文字
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // 引用式链接
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/(?<![A-Za-z0-9])\*(?=\S)(.+?)(?<=\S)\*(?![A-Za-z0-9])/g, '$1') // 2*3*4 这种乘号不算
    // 下划线斜体只在词边界上算（snake_case 里的下划线保留）
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1')
  return s.replace(STASH, (_m, i: string) => code[Number(i)] ?? '')
}

/** 行首的块级记号：标题 #、引用 >、列表符号、任务框；分隔线和表格分隔行整行去掉 */
function block(line: string): string {
  if (/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/.test(line)) return ''
  if (
    /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(line) &&
    line.includes('-') &&
    line.includes('|')
  )
    return ''
  return line
    .replace(/^[ \t]*(>[ \t]?)+/, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/, '')
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, '')
}

/**
 * 回复的纯文本开头，一行：代码块整块换成「[代码]」，行内代码去反引号，链接只留文字，
 * 标题 / 列表符号 / 引用 / 加粗斜体记号去掉，多个空白合成一个空格。
 * 结果最多 max 个字符（按字，不拆 emoji 等双字符）；超出就截断，结尾的「…」也算在 max 里。
 */
export function replyPreview(text: string, max: number = REPLY_PREVIEW_MAX): string {
  if (!Number.isFinite(max) || max < 1) return ''
  const out: string[] = []
  let size = 0
  let fence: { ch: string; len: number } | null = null
  for (const raw of text.split(/\r\n|\r|\n/)) {
    // 够长了就不用再读后面的
    if (size > max * 4) break
    let line: string
    if (fence) {
      const close = raw.trim()
      if (close.length >= fence.len && [...close].every(c => c === fence!.ch)) fence = null
      continue
    }
    const open = FENCE_OPEN.exec(raw)
    if (open) {
      // 反引号围栏的说明行里不能再有反引号（否则是行内代码，不是围栏）
      if (!(open[1][0] === '`' && raw.slice(open[0].length).includes('`'))) {
        fence = { ch: open[1][0], len: open[1].length }
        line = CODE_BLOCK
        out.push(line)
        size += line.length + 1
        continue
      }
    }
    // 一行很长时先截短：结果最多 max 个字，后面用不上；那几条带前后断言的正则在长行上是平方级的
    line = inline(block(raw.slice(0, max * 4))).trim()
    if (!line) continue
    out.push(line)
    size += line.length + 1
  }
  const flat = out.join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  if (chars.length <= max) return flat
  if (max === 1) return '…'
  return (
    chars
      .slice(0, max - 1)
      .join('')
      .trimEnd() + '…'
  )
}

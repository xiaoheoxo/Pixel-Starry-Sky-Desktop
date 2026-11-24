// 新会话标题：第一条消息的第一行，去掉 Markdown 记号（docs/ui/conversation-ux-2.md §2.2），链接和本机路径写短（docs/ui/session-title.md）
import { SESSION_TITLE_LIMIT } from '@pixelsky/protocol'

export const NEW_TITLE = '新会话'
/** 0.9.2-beta 以前存的长度，补旧标题时用 */
const OLD_MAX = 30

/** 一行里的 Markdown 记号去掉，只留读得出来的字 */
function plainLine(line: string): string {
  return (
    line
      // 行首：标题、引用、列表、任务框、GitHub 提示块
      .replace(/^(?:>\s*)+/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i, '')
      // 图片和链接只留方括号里的字
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // 行内代码的反引号、加粗
      .replace(/`+([^`]+)`+/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .trim()
  )
}

/**
 * 去掉从编辑器引用的代码（docs/ui/editor-quote.md）：单独一行的「路径#L12-18」和紧跟着的代码块。
 * 先引用代码再提问时，标题用问题，而不是路径
 */
function withoutQuotes(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^[^\s@#]+#L\d+(?:-L?\d+)?$/.test(lines[i]) ? /^(`{3,}|~{3,})/.exec(lines[i + 1] ?? '') : null
    const close = open ? lines.findIndex((l, j) => j > i + 1 && l.startsWith(open[1]) && /^[`~]+$/.test(l.trim())) : -1
    if (close < 0) out.push(lines[i])
    else i = close
  }
  return out.join('\n')
}

/** 第一行去掉记号后没字（代码块开头 ```ts、提示块的 > [!NOTE]）时往下找 */
function firstLine(text: string): string {
  return (
    text
      .trim()
      .split(/\r?\n/)
      .filter(l => !/^\s*(?:`{3,}|~{3,})/.test(l))
      .map(plainLine)
      .find(Boolean) ?? ''
  )
}

/** 只有引用、没有别的字时照旧取第一行（就是路径） */
const titleLine = (text: string): string => firstLine(withoutQuotes(text)) || firstLine(text)

// 链接只认 ASCII 里能出现在地址中的字符：后面紧跟着中文时不吃进去；结尾的标点不算
const URL_PART = String.raw`[\w\-.~:/?#@!$&*+,;=%]`
const LINK = new RegExp(String.raw`<?\bhttps?://(${URL_PART}*[\w/\-~=%&])>?`, 'gi')
const GITHUB = /^(?:www\.)?github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?(?:\/(.*))?$/i

function shortLink(rest: string): string {
  const m = GITHUB.exec(rest)
  if (!m) return rest.replace(/^www\./i, '').replace(/\/+$/, '')
  const [, repo, page = ''] = m
  const numbered = /^(?:issues|pull|discussions)\/(\d+)(?!\w)/.exec(page)
  if (numbered) return `${repo}#${numbered[1]}`
  const commit = /^commit\/([0-9a-f]{7})/i.exec(page)
  if (commit) return `${repo}@${commit[1]}`
  const path = page.replace(/\/+$/, '')
  const tree = /^(?:tree|blob)\/(.+)$/.exec(path)
  return tree ? `${repo}@${tree[1]}` : path ? `${repo}/${path}` : repo
}

const baseName = (path: string): string =>
  path
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1) ?? path
const PATHS = [
  // 带引号的 Windows 路径（路径里可以有空格）；@ 放在引号外面
  /()"([A-Za-z]:[\\/][^"\n]+)"/g,
  /(^|[^\w])([A-Za-z]:[\\/](?![\\/])[^\s"'<>|*?]+)/g,
  // 别的 /a/b 可能是接口地址，只认常见的根目录
  /(^|[\s@("'「（：:，,])((?:~|\/(?:home|Users|root|tmp|var|opt|mnt|etc|srv|usr|private|Volumes))\/[^\s"'<>|*?]+)/g,
]

/** 链接、本机绝对路径写短（docs/ui/session-title.md §1） */
function shorten(line: string): string {
  let out = line.replace(LINK, (_, rest: string) => shortLink(rest))
  for (const re of PATHS) out = out.replace(re, (_, lead: string, path: string) => lead + baseName(path))
  return out.trim() || line
}

/** 截到 max 个字符（「…」算在内），不切开表情 */
export function clipTitle(title: string, max = SESSION_TITLE_LIMIT): string {
  const chars = Array.from(title)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : title
}

export function titleFrom(text: string): string {
  // eslint-disable-next-line no-control-regex -- 控制字符（制表符等）换成空格：标题校验不收
  const line = shorten(titleLine(text)).replace(/[\u0000-\u001f\u007f]+/g, ' ')
  return clipTitle(line.trim()) || NEW_TITLE
}

/** 像是旧规则截出来的（正好 30 个字加「…」） */
export const oldClipped = (title: string): boolean => title.length === OLD_MAX + 1 && title.endsWith('…')

/** 这条消息按旧规则（各版本）算出来就是这个标题 */
export function oldTitleMatches(text: string, title: string): boolean {
  const raw = text.trim().split(/\r?\n/)[0]!.trim()
  return [titleLine(text), firstLine(text), raw].some(l => l.length > OLD_MAX && `${l.slice(0, OLD_MAX)}…` === title)
}

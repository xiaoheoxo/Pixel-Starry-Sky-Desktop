// 左栏搜索的「替换」（docs/ui/coding-tier1.md §3）：匹配规则、结果里的前后对比、每个文件的替换结果。
// 规则和主进程 workspace-grep.ts 的 grepPattern 一致：按行匹配，整词 = 前后不是字母数字下划线。

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export const NO_OPTIONS: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false }

// shortcut: 预览和替换在界面线程里直接跑用户的正则，回溯停不下来的（如 (\w+\s?)+:）会卡住窗口；
// 主进程的搜索有截止时间，这类正则通常搜不出结果、到不了这里。真碰到再把预览和替换挪进 Web Worker 加超时
/** 搜索词 → 全局正则；正则写错时抛 SyntaxError */
export function searchRegExp(text: string, options: SearchOptions): RegExp {
  let source = options.regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (options.wholeWord) source = `(?<!\\w)(?:${source})(?!\\w)`
  return new RegExp(source, options.caseSensitive ? 'g' : 'gi')
}

/** 正则写错时的说明；没错为 null */
export function regexError(text: string, options: SearchOptions): string | null {
  try {
    searchRegExp(text, options)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export interface PreviewPart {
  text: string
  kind: 'same' | 'del' | 'ins'
}

/** 一行的前后对比：每处匹配拆成删掉的和换上的。正则模式下换上的文字展开 $1 一类的引用 */
export function previewLine(line: string, re: RegExp, replacement: string, regex: boolean): PreviewPart[] {
  const parts: PreviewPart[] = []
  // 粘连正则从匹配位置开始换，前后文（零宽断言、^）和整行替换时一样
  const sticky = new RegExp(re.source, re.flags.replace('g', '') + 'y')
  let at = 0
  for (const m of line.matchAll(re)) {
    if (m.index > at) parts.push({ text: line.slice(at, m.index), kind: 'same' })
    if (m[0]) parts.push({ text: m[0], kind: 'del' })
    let inserted = replacement
    if (regex) {
      sticky.lastIndex = m.index
      const replaced = line.replace(sticky, replacement)
      inserted = replaced.slice(m.index, replaced.length - (line.length - m.index - m[0].length))
    }
    if (inserted) parts.push({ text: inserted, kind: 'ins' })
    at = m.index + m[0].length
  }
  if (at < line.length) parts.push({ text: line.slice(at), kind: 'same' })
  return parts
}

/**
 * 整个文件的替换结果：逐行换（和搜索一样不跨行），换行符原样保留。
 * lines 给了只换这些行（结果被截断时只换显示出来的），null 换整个文件
 */
export function replaceInText(
  text: string,
  re: RegExp,
  replacement: string,
  regex: boolean,
  lines: ReadonlySet<number> | null,
): { text: string; count: number } {
  const parts = text.split(/(\r?\n)/)
  let count = 0
  for (let i = 0; i < parts.length; i += 2) {
    if (lines && !lines.has(i / 2 + 1)) continue
    const found = [...parts[i].matchAll(re)].length
    if (!found) continue
    count += found
    parts[i] = regex ? parts[i].replace(re, replacement) : parts[i].replace(re, () => replacement)
  }
  return { text: parts.join(''), count }
}

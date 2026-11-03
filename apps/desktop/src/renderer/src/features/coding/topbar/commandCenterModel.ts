// 命令中心的输入解析（纯函数）。前缀：> 命令、# 对话、@ 符号、:N 跳到某行，其它都是文件
export type QueryKind = 'file' | 'command' | 'chat' | 'symbol' | 'line'

export interface ParsedQuery {
  kind: QueryKind
  /** 去掉前缀和首尾空格后的文字 */
  term: string
  /** 只有 kind 为 line 时有意义：合法的行号（>= 1），非法输入为 null */
  line: number | null
}

export function parseQuery(text: string): ParsedQuery {
  const s = text.trimStart()
  const rest = s.slice(1).trim()
  switch (s[0]) {
    case '>':
      return { kind: 'command', term: rest, line: null }
    case '#':
      return { kind: 'chat', term: rest, line: null }
    case '@':
      return { kind: 'symbol', term: rest, line: null }
    case ':': {
      const m = /^\d+$/.exec(rest)
      const n = m ? Number(rest) : 0
      return { kind: 'line', term: rest, line: n >= 1 && Number.isSafeInteger(n) ? n : null }
    }
    default:
      return { kind: 'file', term: s.trim(), line: null }
  }
}

/** @ 符号：名字里含 term（不分大小写）的，at 是命中位置（标高亮用）；term 为空时全列 */
export function matchSymbols<T extends { name: string }>(
  items: readonly T[],
  term: string,
): Array<{ item: T; at: number }> {
  const needle = term.toLowerCase()
  return items.flatMap(item => {
    const at = item.name.toLowerCase().indexOf(needle)
    return at < 0 ? [] : [{ item, at }]
  })
}

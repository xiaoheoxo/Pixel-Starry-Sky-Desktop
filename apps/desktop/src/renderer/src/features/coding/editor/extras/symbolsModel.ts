// 符号识别（纯函数）：正则 + 括号计数，不做完整解析。支持 ts / tsx / js / jsx / py，其它语言返回空。
export type SymbolKind = 'function' | 'class' | 'method'
export interface Declaration {
  name: string
  kind: SymbolKind
  /** 声明起始行（1 起） */
  line: number
  /** 声明范围：从起始行行首，到块结束（不含） */
  from: number
  to: number
}
export interface EnclosingSymbol {
  name: string
  kind: SymbolKind
  from: number
  to: number
}

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/i
const PY_EXT = /\.pyw?$/i
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'else', 'do', 'new'])

/** 把字符串、注释、模板字面量里的内容换成空格（长度、换行不变），括号计数就不会被带偏 */
export function maskSource(text: string, lang: 'js' | 'py'): string {
  const out = text.split('')
  const n = text.length
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  let i = 0
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (lang === 'js') {
      if (c === '/' && next === '/') {
        let j = i
        while (j < n && text[j] !== '\n') j++
        blank(i, j)
        i = j
        continue
      }
      if (c === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2)
        const j = end < 0 ? n : end + 2
        blank(i, j)
        i = j
        continue
      }
      if (c === '`') {
        let j = i + 1
        while (j < n && text[j] !== '`') j += text[j] === '\\' ? 2 : 1
        blank(i + 1, j)
        i = j + 1
        continue
      }
      if (c === '"' || c === "'") {
        // 单行字符串：没闭合就到行尾为止（JSX 文本里的撇号不会吞掉后面的代码）
        let j = i + 1
        while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
        blank(i + 1, j)
        i = text[j] === c ? j + 1 : j
        continue
      }
    } else {
      if (c === '#') {
        let j = i
        while (j < n && text[j] !== '\n') j++
        blank(i, j)
        i = j
        continue
      }
      if (c === '"' || c === "'") {
        const triple = text.startsWith(c.repeat(3), i)
        if (triple) {
          const end = text.indexOf(c.repeat(3), i + 3)
          const j = end < 0 ? n : end
          blank(i + 3, j)
          i = end < 0 ? n : j + 3
          continue
        }
        let j = i + 1
        while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
        blank(i + 1, j)
        i = text[j] === c ? j + 1 : j
        continue
      }
    }
    i++
  }
  return out.join('')
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}
/** 偏移量所在的行号（1 起），二分 */
function lineOfOffset(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function matchBrace(masked: string, open: number): number {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
  }
  return masked.length
}

const SCAN_LIMIT = 4000
type Scan = 'block' | 'arrow' | 'method'

/** 从 start 往后找声明的块结束位置；找不到（只是个调用、重载签名）返回 null */
function findEnd(masked: string, start: number, mode: Scan, viaFunction: boolean): number | null {
  const limit = Math.min(masked.length, start + SCAN_LIMIT)
  let depth = 0
  let paramsClosed = false
  for (let i = start; i < limit; i++) {
    const c = masked[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') {
      depth--
      if (depth < 0) return null
      if (depth === 0 && c === ')' && mode === 'method' && !paramsClosed) {
        paramsClosed = true
        let j = i + 1
        while (j < masked.length && /\s/.test(masked[j])) j++
        if (masked[j] !== '{' && masked[j] !== ':') return null
      }
    } else if (depth === 0) {
      if (c === ';' && mode !== 'arrow') return null
      if (c === '{') {
        if (mode === 'arrow' && !viaFunction) {
          // 返回类型里的对象类型：跳过整段花括号，继续找 =>
          i = matchBrace(masked, i) - 1
          continue
        }
        return matchBrace(masked, i)
      }
      if (mode === 'arrow') {
        // 括号外换行还没见到 =>：只是普通变量（semi: false 的写法没有分号可停）
        if (c === ';' || (c === '\n' && !viaFunction)) return null
        if (c === '=' && masked[i + 1] === '>') {
          let j = i + 2
          while (j < masked.length && /\s/.test(masked[j])) j++
          if (masked[j] === '{') return matchBrace(masked, j)
          // 表达式体：到分号、行尾（括号已配平）为止
          let d = 0
          for (let k = j; k < masked.length; k++) {
            const ch = masked[k]
            if (ch === '(' || ch === '[' || ch === '{') d++
            else if (ch === ')' || ch === ']' || ch === '}') {
              if (--d < 0) return k
            } else if (d === 0 && (ch === ';' || ch === '\n')) return k
          }
          return masked.length
        }
      }
    }
  }
  return null
}

const RE_FN =
  /^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:declare[ \t]+)?(?:async[ \t]+)?function[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)/
const RE_CLASS =
  /^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:declare[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)/
const RE_ARROW =
  /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]*)?=[ \t]*(?:async[ \t]+)?(function\b|\(|[A-Za-z_$][\w$]*[ \t]*=>|<)/
const RE_METHOD =
  /^[ \t]+(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)[ \t]+)*\*?[ \t]*([A-Za-z_$#][\w$]*)[ \t]*(?:<[^>(\n]*>)?[ \t]*\(/

function jsDeclarations(text: string): Declaration[] {
  const masked = maskSource(text, 'js')
  const starts = lineStartsOf(masked)
  const lines = masked.split('\n')
  const found: Declaration[] = []
  const classes: Array<{ from: number; to: number }> = []
  const add = (name: string, kind: SymbolKind, lineIdx: number, end: number): void => {
    const from = starts[lineIdx]
    found.push({ name, kind, line: lineIdx + 1, from, to: Math.max(from, end) })
  }
  // 先找 class，方法只在 class 范围里认
  lines.forEach((line, idx) => {
    const m = RE_CLASS.exec(line)
    if (!m) return
    const nameEnd = starts[idx] + m[0].length
    const end = findEnd(masked, nameEnd, 'block', false)
    if (end === null) return
    classes.push({ from: starts[idx], to: end })
    add(m[1], 'class', idx, end)
  })
  lines.forEach((line, idx) => {
    const at = starts[idx]
    let m = RE_FN.exec(line)
    if (m) {
      const end = findEnd(masked, at + m[0].length, 'block', false)
      if (end !== null) add(m[1], 'function', idx, end)
      return
    }
    m = RE_ARROW.exec(line)
    if (m) {
      const end = findEnd(masked, at + m[0].length - m[2].length, 'arrow', m[2] === 'function')
      if (end !== null) add(m[1], 'function', idx, end)
      return
    }
    m = RE_METHOD.exec(line)
    if (m && !KEYWORDS.has(m[1]) && classes.some(c => at > c.from && at < c.to)) {
      const end = findEnd(masked, at + m[0].length - 1, 'method', false)
      if (end !== null) add(m[1], 'method', idx, end)
    }
  })
  return found.sort((a, b) => a.line - b.line)
}

function pyDeclarations(text: string): Declaration[] {
  const masked = maskSource(text, 'py')
  const starts = lineStartsOf(masked)
  const lines = masked.split('\n')
  const indentOf = (line: string): number => (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length
  const found: Declaration[] = []
  const stack: Array<{ indent: number; kind: 'class' | 'def' }> = []
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    if (!line.trim()) continue
    const indent = indentOf(line)
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const m = /^[ \t]*(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/.exec(line)
    if (!m) continue
    // 签名可能跨行：括号配平后才算头结束
    let depth = 0
    let headEnd = idx
    for (let k = idx; k < lines.length; k++) {
      for (const ch of lines[k]) {
        if (ch === '(' || ch === '[' || ch === '{') depth++
        else if (ch === ')' || ch === ']' || ch === '}') depth--
      }
      headEnd = k
      if (depth <= 0) break
    }
    let last = headEnd
    for (let k = headEnd + 1; k < lines.length; k++) {
      if (!lines[k].trim()) continue
      if (indentOf(lines[k]) <= indent) break
      last = k
    }
    const kind: SymbolKind = m[1] === 'class' ? 'class' : stack.some(s => s.kind === 'class') ? 'method' : 'function'
    const to = starts[last] + lines[last].replace(/\s+$/, '').length
    found.push({ name: m[2], kind, line: idx + 1, from: starts[idx], to })
    stack.push({ indent, kind: m[1] === 'class' ? 'class' : 'def' })
  }
  return found
}

/** 这种文件认不认得出符号（ts / js / py） */
export const symbolsSupported = (path: string): boolean => JS_EXT.test(path) || PY_EXT.test(path)

/** 文件里每个声明的行号和范围；不认识的语言返回空数组 */
export function declarations(text: string, path: string): Declaration[] {
  if (JS_EXT.test(path)) return jsDeclarations(text)
  if (PY_EXT.test(path)) return pyDeclarations(text)
  return []
}

/** 大纲的缩进层数：被几个声明的范围包住就是几层（list 按起始位置排好） */
export function nestDepths(list: readonly Declaration[]): number[] {
  let open: Declaration[] = []
  return list.map(d => {
    // 范围可能交叠（识别有误时），已结束的全部去掉，不只看栈顶
    open = open.filter(o => o.to > d.from)
    open.push(d)
    return open.length - 1
  })
}

/** list 里光标（line，1 起）所在位置最里面那个声明；不在任何声明里返回 null */
export function enclosingDeclaration(list: readonly Declaration[], text: string, line: number): Declaration | null {
  if (!list.length) return null
  const starts = lineStartsOf(text)
  let best: Declaration | null = null
  for (const d of list) {
    const endLine = lineOfOffset(starts, Math.max(d.from, d.to - 1))
    if (line < d.line || line > endLine) continue
    if (!best || d.from >= best.from) best = d
  }
  return best
}

/** 光标（line，1 起）所在位置最里面那个声明；不在任何声明里返回 null */
export function enclosingSymbol(text: string, line: number, path: string): EnclosingSymbol | null {
  const best = enclosingDeclaration(declarations(text, path), text, line)
  return best ? { name: best.name, kind: best.kind, from: best.from, to: best.to } : null
}

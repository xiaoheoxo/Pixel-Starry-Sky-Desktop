// 终端里的报错问 AI（docs/ui/coding-tier2.md §7）：认报错行、认提示符行里的命令、找退出码、拼引用卡片。
// 纯函数：按行读终端缓冲区（Rows），不碰 xterm 和 window
import { tr } from '@/i18n/core'

/** 终端缓冲区的一行行文字（行号从 0 起）；wrapped：这一行是上一行太长折下来的 */
export interface Rows {
  length: number
  text(row: number): string
  wrapped(row: number): boolean
}

/** 已知的「某条命令以退出码 code 结束」：这条命令的输出在 row 行之前结束（row 是它之后的提示符行，或者进程退出后的末尾） */
export interface LatestEnd {
  row: number
  code: number
}

export interface TerminalQuote {
  /** 引用的首行、末行（含）；start 为 -1：不知道行号（运行胶囊引用的是历史文本），标题不写 */
  start: number
  end: number
  text: string
  command: string | null
  exitCode: number | null
}

/** 报错行带上前 20 行、后 5 行，最多约 4 KB */
const BEFORE = 20,
  AFTER = 5,
  MAX_CHARS = 4096
/** 往上找命令、往下找下一个提示符最多看这么多行 */
const SCAN = 500

// error 不分大小写（「0 Error(s)」这类成功总结不算）；FAIL 这些只认原样，小写的 fail 太常见
const ERROR = /(?<!\b0 )\berror\b/i
const MARKERS = /Error:|ERR!|\bFAIL\b|Traceback|panic:|Exception\b/
const EXIT = /\bexit(?:ed)?(?: with)? (?:code|status)[\s:=]*(-?\d+)/i

/** 行里写的退出码（exit code 1、exited with code 1、exit status 2），没写为 null */
export function exitCodeIn(text: string): number | null {
  const m = EXIT.exec(text)
  return m ? Number(m[1]) : null
}

/** 认得出的报错行：包含 error / ERR! / FAIL / Traceback / panic: / Exception，或写着非 0 退出码 */
export function isErrorLine(text: string): boolean {
  if (ERROR.test(text) || MARKERS.test(text)) return true
  const code = exitCodeIn(text)
  return code !== null && code !== 0
}

const PROMPTS = [
  /^PS [^>]*>(?: (.*))?$/, // PowerShell：PS C:\x> cmd
  // cmd：C:\x>cmd（注释不放行尾：i18n 防回归测试把正则里的 " 当成字符串开头，一直读到行尾）
  /^[A-Za-z]:\\[^<>|*?"]*>(.*)$/,
  /^\S+@\S+[$#](?: (.*))?$/, // bash：user@host:~/x$ cmd
  /^\S+@\S+ \S+ [%#](?: (.*))?$/, // zsh：user@host dir % cmd
  /^[$%❯](?: (.*))?$/, // 精简提示符：$ cmd、❯ cmd
]

/** 提示符行里写的命令（只有提示符时为 ''）；不是提示符行为 null */
export function promptCommand(text: string): string | null {
  for (const re of PROMPTS) {
    const m = re.exec(text)
    if (m) return (m[1] ?? '').trim()
  }
  return null
}

const isPrompt = (rows: Rows, row: number): boolean => promptCommand(rows.text(row)) !== null

/**
 * 提示符从哪一行开始：只有 $ / % / ❯ 的提示符多半是两行提示符的第二行（Git Bash、starship），紧挨着的上一行是它的头。
 * shortcut: 单行的 PS1='$ ' 会把上一行输出当成头，碰到再按头的样子认
 */
function promptTop(rows: Rows, row: number): number {
  const head = row - 1
  return row < rows.length &&
    head >= 0 &&
    /^[$%❯]$/.test(rows.text(row).trim()) &&
    rows.text(head).trim() &&
    !isPrompt(rows, head)
    ? head
    : row
}

/**
 * 最近一条命令以非 0 退出码结束、自己又没写报错字样时，把它的最后一行输出算作报错行。
 * 返回那一行；退出码是 0、上面紧挨着就是提示符（没有输出）时为 null
 */
export function failedTail(rows: Rows, latest: LatestEnd | null): number | null {
  if (!latest || latest.code === 0) return null
  for (let i = Math.min(promptTop(rows, latest.row), rows.length) - 1; i >= Math.max(0, latest.row - SCAN); i--) {
    const text = rows.text(i).trim()
    if (!text) continue
    return isPrompt(rows, i) ? null : i
  }
  return null
}

/** from 行所在命令的命令文字和退出码：往上找提示符行，往下到下一个提示符行之间找写出来的退出码 */
function commandInfo(
  rows: Rows,
  from: number,
  to: number,
  latest: LatestEnd | null,
): { prompt: number | null; next: number; command: string | null; exitCode: number | null } {
  let prompt: number | null = null
  for (let i = from; i >= Math.max(0, from - SCAN); i--)
    if (isPrompt(rows, i)) {
      prompt = i
      break
    }
  let next = Math.min(rows.length, to + SCAN),
    found = false
  for (let i = to + 1; i < next; i++)
    if (isPrompt(rows, i)) {
      next = i
      found = true
      break
    }
  let exitCode: number | null = null
  for (let i = prompt ?? Math.max(0, from - SCAN); i < next; i++) exitCode = exitCodeIn(rows.text(i)) ?? exitCode
  // 输出里没写退出码：这段正好是最近结束的那条命令（下面没有别的提示符挡着）时用 shell 集成报的
  if (exitCode === null && latest && to < latest.row && (!found || next >= latest.row)) exitCode = latest.code
  const command = prompt === null ? '' : promptCommand(rows.text(prompt))!
  // 两行提示符的头不算进这条命令的输出
  if (found) next = Math.max(to + 1, promptTop(rows, next))
  return { prompt, next, command: command || null, exitCode }
}

/** 几行拼成文字：折行接回上一行，末尾的空行去掉 */
function joinRows(rows: Rows, start: number, end: number): string {
  let text = ''
  for (let i = start; i <= end; i++) text += (i > start && !rows.wrapped(i) ? '\n' : '') + rows.text(i)
  return text.replace(/\s+$/, '')
}

/** 报错行 row 的引用：前 20 行、后 5 行，不越过这条命令的提示符；太长时先从前面去掉，还长就从后面截 */
export function errorQuote(rows: Rows, row: number, latest: LatestEnd | null = null): TerminalQuote {
  const info = commandInfo(rows, row, row, latest)
  let start = Math.max(row - BEFORE, info.prompt ?? 0),
    end = Math.min(row + AFTER, info.next - 1)
  while (start > 0 && rows.wrapped(start)) start--
  while (end + 1 < rows.length && rows.wrapped(end + 1)) end++
  let text = joinRows(rows, start, end)
  while (text.length > MAX_CHARS && start < row) {
    start++
    while (start < row && rows.wrapped(start)) start++
    text = joinRows(rows, start, end)
  }
  // 报错行本身或后面几行折了很长（JSON、压缩过的代码）时从后面截
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '…'
  // 末尾去掉的空行不算进行号
  while (end > row && !rows.text(end).trim()) end--
  return { start, end, text, command: info.command, exitCode: info.exitCode }
}

/** 选中文字的引用：命令、退出码按选区所在的那条命令找 */
export function selectionQuote(
  rows: Rows,
  start: number,
  end: number,
  text: string,
  latest: LatestEnd | null = null,
): TerminalQuote {
  const info = commandInfo(rows, start, end, latest)
  return { start, end, text: text.replace(/\s+$/, ''), command: info.command, exitCode: info.exitCode }
}

/** 卡片标题：终端 · 命令 · 退出码 N · 第 a–b 行（不知道的部分不写） */
export function quoteTitle(quote: TerminalQuote): string {
  const command = quote.command && quote.command.length > 80 ? quote.command.slice(0, 79) + '…' : quote.command
  return [
    tr('terminal.quote.title'),
    command,
    quote.exitCode === null ? null : tr('terminal.quote.exitCode', { code: quote.exitCode }),
    quote.start < 0
      ? null
      : quote.start === quote.end
        ? tr('terminal.quote.line', { line: quote.start + 1 })
        : tr('terminal.quote.lines', { start: quote.start + 1, end: quote.end + 1 }),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 放进输入框的引用：标题一行，下面是原文的代码块（反引号比原文里最长的一串多一个） */
export function quoteCard(quote: TerminalQuote): string {
  const longest = Math.max(0, ...(quote.text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${quoteTitle(quote)}\n${fence}\n${quote.text}\n${fence}`
}

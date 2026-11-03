// 问题面板的纯逻辑（docs/ui/coding-tier1.md §4）：从任务终端输出里认 tsc / eslint 的报错、路径换成项目内相对路径、汇总、找上一个 / 下一个
import type { RunTask } from '../../../../shared/types/project-tools'
import { stripAnsi } from '@/ui/code/ansi'

export interface Problem {
  /** 项目内相对路径（posix）；在项目外的保留绝对路径 */
  path: string
  line: number
  column: number
  severity: 'error' | 'warning'
  message: string
  /** 'tsc' | 'eslint' */
  source: string
  /** tsc 的 TS2304、eslint 的规则名；没有时 '' */
  code: string
}
export interface ProblemSummary {
  errors: number
  warnings: number
  items: Problem[]
  /** 跑过至少一个 tsc / eslint 任务（终端还在）：false 时面板显示「去任务」 */
  ran: boolean
}
export const EMPTY_PROBLEMS: ProblemSummary = { errors: 0, warnings: 0, items: [], ran: false }

/** 任务命令像 tsc / eslint 吗：npm 看脚本内容（detail），其它看任务名 */
export const isCheckTask = (task: RunTask): boolean =>
  /(?:^|[\s/"'])(?:vue-)?tsc\b|\beslint\b|\btype-?check\b|^lint\b/im.test(`${task.detail}\n${task.name}`)

const slash = (p: string): string => p.replaceAll('\\', '/')
export const isAbsolute = (p: string): boolean => /^[a-zA-Z]:\//.test(p) || p.startsWith('/')

/** 报错里的路径 → 项目内相对路径：相对的按任务目录（dir，相对项目根）拼，绝对的在项目里就去掉根 */
export function projectPath(file: string, root: string, dir: string): string {
  const path = slash(file.trim())
  const base = slash(root).replace(/\/+$/, '')
  if (isAbsolute(path)) {
    // Windows 盘符大小写可能不同（d:\ 和 D:\），按不区分大小写比
    const windows = /^[a-zA-Z]:/.test(path)
    const same = windows ? path.toLowerCase().startsWith(base.toLowerCase() + '/') : path.startsWith(base + '/')
    return same ? path.slice(base.length + 1) : path
  }
  const parts: string[] = []
  for (const part of `${dir}/${path}`.split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

const TSC_PAREN = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/
const TSC_PRETTY = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/
// stylish：「  3:10  warning  消息  规则」，列之间至少两个空格；解析错误没有规则
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/
// pnpm -r：每行前缀「包目录 脚本: 」，或 TTY 下先一行「包目录 脚本$ 命令」再跟「│ 」行；报错路径相对那个包
// shortcut: 包目录按任务目录拼（任务就在工作区根时对），在子目录里跑 pnpm -r 时路径会错，遇到再按 pnpm-workspace.yaml 找根
const PNPM_LINE = /^(\S+) [\w:.-]+:(?: (.*))?$/
const PNPM_HEAD = /^(\S+) [\w:.-]+\$ /
const PNPM_BOX = /^│ ?(.*)$/

/** 从一段终端输出里认出 tsc（两种格式）和 eslint stylish 的报错；root 是项目根，dir 是任务目录（相对根） */
export function parseProblems(output: string, root: string, dir: string): Problem[] {
  const list: Problem[] = []
  let eslintFile: string | null = null
  let boxDir = dir
  for (const raw of stripAnsi(output).split(/\r?\n|\r/)) {
    let line = raw.trimEnd()
    let base = dir
    const head = PNPM_HEAD.exec(line)
    if (head) boxDir = `${dir}/${slash(head[1])}`
    const box = PNPM_BOX.exec(line)
    const prefixed = box ? null : PNPM_LINE.exec(line)
    if (box) [line, base] = [box[1], boxDir]
    else if (prefixed) [line, base] = [prefixed[2] ?? '', `${dir}/${slash(prefixed[1])}`]
    const tsc = TSC_PAREN.exec(line) ?? TSC_PRETTY.exec(line)
    if (tsc) {
      list.push({
        path: projectPath(tsc[1], root, base),
        line: Number(tsc[2]),
        column: Number(tsc[3]),
        severity: tsc[4] as Problem['severity'],
        message: tsc[6],
        source: 'tsc',
        code: tsc[5],
      })
      continue
    }
    const row = eslintFile === null ? null : ESLINT_ROW.exec(line)
    if (row && eslintFile !== null) {
      list.push({
        path: projectPath(eslintFile, root, base),
        line: Math.max(1, Number(row[1])),
        column: Math.max(1, Number(row[2])),
        severity: row[3] as Problem['severity'],
        message: row[4],
        source: 'eslint',
        code: row[5] ?? '',
      })
      continue
    }
    // 不缩进的一行可能是 stylish 的文件标题（不是的话下面也不会跟着报错行）；「✖ n problems」是结尾汇总
    eslintFile = line && !/^[\s✖]/.test(line) ? line : line ? eslintFile : null
  }
  return list
}

/**
 * 只留终端里最后一次运行的输出：从最后一行「shell 回显的任务命令」、包管理器打印的「> 脚本」或 tsc 监视模式的「开始（增量）编译」开始。
 * shortcut: 按回显文字找运行起点，命令被终端折行时找不到就用整段；任务 store 记下运行起点的历史位置后改用它
 */
export function lastRun(text: string, command: string, detail: string): string {
  const lines = text.split(/\r?\n|\r/)
  const script = detail.trim()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (
      (command && line.includes(command)) ||
      (script && (line === `> ${script}` || line === `$ ${script}`)) ||
      /Starting (?:compilation in watch mode|incremental compilation)/.test(line)
    )
      return lines.slice(i + 1).join('\n')
  }
  return text
}

const problemKey = (p: Problem): string => `${p.path}\u0000${p.line}:${p.column}\u0000${p.message}`

/** 几个任务的问题合在一起：同一处同一句只留一条（根目录和子包都跑了 tsc），按路径、行、列排 */
export function summarize(lists: readonly (readonly Problem[])[], ran: boolean): ProblemSummary {
  const seen = new Map<string, Problem>()
  for (const list of lists) for (const p of list) if (!seen.has(problemKey(p))) seen.set(problemKey(p), p)
  const items = [...seen.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column,
  )
  const errors = items.filter(p => p.severity === 'error').length
  return { errors, warnings: items.length - errors, items, ran }
}

/** 按文件分组（items 已按路径排好） */
export function groupByFile(items: readonly Problem[]): { path: string; items: Problem[] }[] {
  const groups: { path: string; items: Problem[] }[] = []
  for (const p of items) {
    const last = groups[groups.length - 1]
    if (last?.path === p.path) last.items.push(p)
    else groups.push({ path: p.path, items: [p] })
  }
  return groups
}

/** 光标之后（dir=1）或之前（-1）的下一个问题，到头了绕回去；items 是同一个文件的、已排好序 */
export function stepProblem(items: readonly Problem[], line: number, column: number, dir: 1 | -1): Problem | null {
  if (!items.length) return null
  const after = (p: Problem): boolean => p.line > line || (p.line === line && p.column > column)
  const before = (p: Problem): boolean => p.line < line || (p.line === line && p.column < column)
  if (dir === 1) return items.find(after) ?? items[0]
  return [...items].reverse().find(before) ?? items[items.length - 1]
}

/** 「交给 AI 修」引用的那一行：路径:行:列 消息 (来源 规则) */
export const problemLine = (p: Problem, path: string): string =>
  `${path}:${p.line}:${p.column} ${p.message} (${p.code ? `${p.source} ${p.code}` : p.source})`

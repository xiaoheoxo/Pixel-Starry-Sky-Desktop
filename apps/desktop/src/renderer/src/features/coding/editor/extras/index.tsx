import type { Extension } from '@codemirror/state'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useMemo, useRef, type JSX } from 'react'
import { tr } from '@/i18n/core'
import { openFile, type OpenFile } from '@/features/files/store'
import { useToast } from '@/ui'
import { PROBLEMS_READY, useProblems } from '../../problems'
import { useCodingWorkspace } from '../../workspace'
import { stepProblem, type Problem } from '../../problemsModel'
import { codeLens, LENS_MAX_LINES } from './codeLens'
import { overviewRuler } from './overviewRuler'
import { problemsLint } from './problemsLint'
import { useTaskGutter } from './taskGutter'
import { enclosingSymbol } from './symbolsModel'

const NONE: readonly Extension[] = []
/** 面包屑算符号时的文件大小上限，再大每次按键都要重新扫一遍 */
const CRUMB_MAX_CHARS = 400_000

/** 文本超过 limit 行吗（数到 limit+1 个换行就停） */
function overLines(text: string, limit: number): boolean {
  let count = 0
  let at = -1
  while ((at = text.indexOf('\n', at + 1)) >= 0) if (++count >= limit) return true
  return false
}

const NO_PROBLEMS: readonly Problem[] = []
/** 这个文件的问题（useProblems 没新结果时同一个数组）；按代码模式的工作区取，tab.ref 是换成项目后的，跟任务列表的缓存对不上 */
function useFileProblems(tab: OpenFile | null): readonly Problem[] {
  const problems = useProblems(useCodingWorkspace().ref)
  const path = tab?.path ?? ''
  return useMemo(() => {
    const list = problems.items.filter(p => p.path === path)
    return list.length ? list : NO_PROBLEMS
  }, [problems, path])
}

/** 代码透镜 + 概览标尺 + package.json 的运行 ▶ + 问题波浪线；返回值 memo */
export function useEditorExtras(tab: OpenFile | null): readonly Extension[] {
  const toast = useToast()
  const toastRef = useRef(toast)
  useEffect(() => {
    toastRef.current = toast
  })
  const id = tab?.id ?? null
  const path = tab?.path ?? ''
  const head = tab?.head ?? null
  const text = tab?.document?.kind === 'text'
  const big = text && tab ? overLines(tab.draft, LENS_MAX_LINES) : false
  const tasks = useTaskGutter(tab)
  const problems = useFileProblems(tab)
  return useMemo(() => {
    if (!id || !text) return NONE
    const list: Extension[] = [...tasks]
    if (!big) list.push(codeLens(id, path, message => toastRef.current(message)))
    list.push(overviewRuler(head))
    if (problems.length) list.push(problemsLint(problems))
    return list
  }, [id, path, head, text, big, tasks, problems])
}

/** 面包屑后面的「› ƒ 名字」和问题计数 */
export function SymbolCrumb({ tab }: { tab: OpenFile }): JSX.Element | null {
  const problems = useFileProblems(tab)
  const errors = problems.filter(p => p.severity === 'error').length
  const line = tab.cursor.line
  const draft = tab.draft
  const isText = tab.document?.kind === 'text'
  const symbol = useMemo(
    () => (isText && draft.length <= CRUMB_MAX_CHARS ? enclosingSymbol(draft, line, tab.path) : null),
    [isText, draft, line, tab.path],
  )
  if (!isText || (!symbol && !PROBLEMS_READY)) return null
  // 上一个 / 下一个问题：从光标处往前 / 往后找，到头绕回去
  const step = (dir: 1 | -1): void => {
    const p = stepProblem(problems, line, tab.cursor.column, dir)
    if (p) void openFile(tab.ref, tab.path, p.line, p.column, undefined, { target: 'code' })
  }
  const arrow = (dir: 1 | -1): JSX.Element => {
    const label = tr(dir === 1 ? 'coding.bottom.problems.next' : 'coding.bottom.problems.prev')
    const Icon = dir === 1 ? ChevronDown : ChevronUp
    return (
      <button
        type="button"
        disabled={!problems.length}
        title={label}
        aria-label={label}
        onClick={() => step(dir)}
        className="rounded-sm hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Icon size={14} strokeWidth={1.5} className="shrink-0" />
      </button>
    )
  }
  return (
    <span className="ml-1 flex min-w-0 max-w-full flex-wrap items-center gap-2 text-xs text-fg-muted" data-symbol-crumb>
      {symbol && (
        <span
          className="flex min-w-0 max-w-full items-center gap-1"
          title={tr('coding.editor.extras.symbol', { name: symbol.name })}
        >
          <span aria-hidden className="shrink-0">
            ›
          </span>
          <span aria-hidden className="shrink-0 font-mono text-accent">
            {symbol.kind === 'class' ? 'C' : 'ƒ'}
          </span>
          <span className="min-w-0 text-fg [overflow-wrap:anywhere]">{symbol.name}</span>
        </span>
      )}
      {PROBLEMS_READY && (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className={errors ? 'text-danger' : undefined} title={tr('coding.editor.extras.errors', { n: errors })}>
            {errors}E
          </span>
          <span
            className={problems.length - errors ? 'text-warn' : undefined}
            title={tr('coding.editor.extras.warnings', { n: problems.length - errors })}
          >
            {problems.length - errors}W
          </span>
          {arrow(-1)}
          {arrow(1)}
        </span>
      )}
    </span>
  )
}

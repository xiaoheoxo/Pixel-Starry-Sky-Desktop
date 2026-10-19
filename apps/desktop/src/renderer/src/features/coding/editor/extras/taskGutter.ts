// package.json 的 scripts 每一项、build.gradle(.kts) 里写的任务和 runs 每一项，行号左边的 ▶（在跑时 ■）：docs/ui/coding-tasks.md §5、§9.3
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
import { useEffect, useMemo, useRef } from 'react'
import { tr } from '@/i18n/core'
import type { OpenFile } from '@/features/files/store'
import { useCodingWorkspace } from '../../workspace'
import { gutterGroupForFile } from '../../tasks/model'
import { isAlive, loadTasks, TASKS_STALE_MS, useRunTasks, useTaskRunner, useTaskStatuses } from '../../tasks/store'

export interface GutterItem {
  line: number
  name: string
  running: boolean
}

class RunMark extends GutterMarker {
  constructor(
    readonly name: string,
    readonly running: boolean,
    readonly onClick: (name: string, running: boolean) => void,
  ) {
    super()
  }
  eq(other: RunMark): boolean {
    return other.name === this.name && other.running === this.running
  }
  toDOM(): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'cm-task-run' + (this.running ? ' cm-task-run-on' : '')
    el.textContent = this.running ? '■' : '▶'
    const label = tr(this.running ? 'coding.tasks.stop' : 'coding.tasks.run', { name: this.name })
    el.title = label
    el.setAttribute('aria-label', label)
    // mousedown 里拦掉，免得点击先把编辑器的光标移走
    el.addEventListener('mousedown', e => e.preventDefault())
    el.addEventListener('click', e => {
      e.preventDefault()
      this.onClick(this.name, this.running)
    })
    return el
  }
}

const theme = EditorView.theme({
  '.cm-task-gutter': { width: '18px' },
  '.cm-task-gutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center' },
  '.cm-task-run': {
    border: 'none',
    background: 'transparent',
    padding: '0',
    width: '16px',
    fontSize: '11px',
    lineHeight: 'inherit',
    color: 'var(--accent)',
    cursor: 'pointer',
    borderRadius: '3px',
  },
  '.cm-task-run:hover': { background: 'var(--bg-hover)' },
  '.cm-task-run-on': { color: 'var(--danger)' },
})

/** 纯扩展：items 给出每个脚本所在的行；onClick(name, running) 运行或停止 */
export function taskGutter(items: readonly GutterItem[], onClick: (name: string, running: boolean) => void): Extension {
  const byLine = new Map(items.map(i => [i.line, i]))
  return [
    // 放在行号左边
    Prec.highest(
      gutter({
        class: 'cm-task-gutter',
        lineMarker(view, block) {
          const item = byLine.get(view.state.doc.lineAt(block.from).number)
          return item ? new RunMark(item.name, item.running, onClick) : null
        },
      }),
    ),
    theme,
  ]
}

const NONE: readonly Extension[] = []

/** 代码模式编辑器：打开的文件是任务列表里的 package.json / build.gradle(.kts) 时返回 ▶ 扩展，否则空 */
export function useTaskGutter(tab: OpenFile | null): readonly Extension[] {
  const { ref } = useCodingWorkspace()
  const isPackage =
    !!tab &&
    tab.document?.kind === 'text' &&
    /(^|\/)(package\.json|build\.gradle(\.kts)?)$/.test(tab.path.replaceAll('\\', '/'))
  const entry = useRunTasks(ref)
  useEffect(() => {
    if (isPackage && ref) void loadTasks(ref, TASKS_STALE_MS)
    // ref 的内容变化由 refKey 体现
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPackage, ref ? JSON.stringify(ref) : ''])
  const group = isPackage && tab ? gutterGroupForFile(entry.state, tab.root, tab.path) : null
  const statuses = useTaskStatuses(entry.state)
  const runner = useTaskRunner(entry.state)
  const runnerRef = useRef(runner)
  useEffect(() => {
    runnerRef.current = runner
  })
  // 状态拼成字符串：只有哪些在跑变了才重建扩展
  const items = group
    ? group.tasks.flatMap(t =>
        t.line ? [{ line: t.line, name: t.name, running: isAlive(statuses.of(group, t)) }] : [],
      )
    : []
  const token = items.map(i => `${i.line}:${i.name}:${i.running ? 1 : 0}`).join(',')
  return useMemo(() => {
    if (!group || items.length === 0) return NONE
    return [
      taskGutter(items, (name, running) => {
        const task = group.tasks.find(t => t.name === name)
        if (!task) return
        if (running) runnerRef.current.stop(group, task)
        else void runnerRef.current.run(group, task)
      }),
    ]
    // items 的内容由 token 代表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, token])
}

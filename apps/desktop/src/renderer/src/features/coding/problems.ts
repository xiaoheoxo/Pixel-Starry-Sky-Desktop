// 问题面板的数据（docs/ui/coding-tier1.md §4）：只读「任务」里跑过的 tsc / eslint 的终端输出，不在后台自己跑检查
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RunTask, RunTaskGroup, RunTaskState } from '../../../../shared/types/project-tools'
import type { TerminalRecord } from '../../../../shared/types/terminal'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { subscribeTerminalHistory, terminalHistoryText, useTerminalStore } from '@/features/terminal/store'
import { focusTask, loadTasks, TASKS_STALE_MS, useRunTasks } from './tasks/store'
import { taskCommand } from './tasks/model'
import {
  EMPTY_PROBLEMS,
  isCheckTask,
  lastRun,
  parseProblems,
  summarize,
  type Problem,
  type ProblemSummary,
} from './problemsModel'

export type { Problem, ProblemSummary } from './problemsModel'
/** 问题入口（状态栏、活动栏、底部标签、面包屑）都显示 */
export const PROBLEMS_READY: boolean = true

// 终端历史每次变化（节流 500ms）加一；所有用到 useProblems 的地方共用一次解析
let tick = 0
const tickListeners = new Set<() => void>()
let watching = false
function subscribeTick(cb: () => void): () => void {
  if (!watching) {
    watching = true
    subscribeTerminalHistory(() => {
      tick++
      tickListeners.forEach(fn => fn())
    })
  }
  tickListeners.add(cb)
  return () => {
    tickListeners.delete(cb)
  }
}

/** 每个终端上次解析的文字和结果：没新输出就不重新解析 */
const parsed = new Map<string, { text: string; items: Problem[] }>()
/** 每个工作区上次的汇总：各终端结果都没变时返回同一个对象，编辑器的波浪线不用重建 */
const summaries = new Map<string, { lists: Problem[][]; summary: ProblemSummary }>()

/** 任务这次运行在哪个终端（任务 store 只给了 focusTask，借它的 select 回调拿到 id）；没有时 null */
function taskTerminal(root: string, group: RunTaskGroup, task: RunTask): string | null {
  let id: string | null = null
  focusTask({ runTask: () => Promise.resolve(null), select: t => (id = t) }, root, group, task)
  return id
}

function collect(key: string, state: RunTaskState, terminals: readonly TerminalRecord[]): ProblemSummary {
  // 关掉的终端不再占着缓存的文字
  for (const id of parsed.keys()) if (!terminals.some(t => t.id === id)) parsed.delete(id)
  const lists: Problem[][] = []
  for (const group of state.groups)
    for (const task of group.tasks) {
      if (!isCheckTask(task)) continue
      const terminal = taskTerminal(state.root, group, task)
      if (!terminal) continue
      let command = ''
      try {
        command = taskCommand(group, task)
      } catch {
        // cmd 下拼不出来的命令：只按脚本内容找运行起点
      }
      const text = lastRun(terminalHistoryText(terminal), command, task.detail)
      const cached = parsed.get(terminal)
      const items = cached?.text === text ? cached.items : parseProblems(text, state.root, group.dir)
      parsed.set(terminal, { text, items })
      lists.push(items)
    }
  const previous = summaries.get(key)
  if (previous && previous.lists.length === lists.length && previous.lists.every((l, i) => l === lists[i]))
    return previous.summary
  const summary = lists.length ? summarize(lists, true) : EMPTY_PROBLEMS
  summaries.set(key, { lists, summary })
  return summary
}

/** 这个工作区的错误和警告；终端有新输出、任务换了终端、终端关掉时更新 */
export function useProblems(ref: WorkspaceRef | null): ProblemSummary {
  const { state } = useRunTasks(ref)
  const { terminals } = useTerminalStore()
  const version = useSyncExternalStore(subscribeTick, () => tick)
  const key = ref ? JSON.stringify(ref) : ''
  // 任务列表按工作区缓存，任务视图没显示过的工作区（换了会话）也要读一次，不然问题全没了；只读任务文件，不跑检查
  useEffect(() => {
    if (ref) void loadTasks(ref, TASKS_STALE_MS)
    // ref 的内容变化由 key 体现
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useMemo(
    () => (state ? collect(key, state, terminals) : EMPTY_PROBLEMS),
    // version 只用来触发重新读
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, state, terminals, version],
  )
}

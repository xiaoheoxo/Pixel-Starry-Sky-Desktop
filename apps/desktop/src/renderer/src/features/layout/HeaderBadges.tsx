// 极简模式顶栏工具图标上的状态（docs/ui/minimal-mode.md §12 C）：右栏关着也看得到终端在跑、有没有没提交的改动
import { useEffect, useState } from 'react'
import { useActiveWorkspace } from '@/features/editor/target'
import { changeCount } from '@/features/panel/git/gitModel'
import { useGitStatus } from '@/features/panel/git/summary'
import { pillsOf } from '@/features/terminal/pills'
import { projectOf } from '@/features/terminal/projectOf'
import { hiddenRuns } from '@/features/terminal/RunPills'
import { useTerminalStore } from '@/features/terminal/store'
import { workspaceTerminals } from '@/features/terminal/workspace'

/** 没提交的文件数；没有就不显示 */
export function GitCount() {
  const { ref } = useActiveWorkspace()
  const status = useGitStatus(ref)
  const n = status?.repo ? changeCount(status) : 0
  return n > 0 ? (
    <span data-header-count className="font-mono text-label text-fg-muted">
      {n}
    </span>
  ) : null
}

/** 当前工作区手动开的终端里有命令在跑：橙点（和运行胶囊同一个判断） */
export function TerminalDot() {
  const workspace = useActiveWorkspace()
  const store = useTerminalStore()
  const records = workspaceTerminals(
    store.terminals,
    projectOf(workspace.ref),
    workspace.path,
    window.pixelsky?.platform === 'win32',
  )
  const { pills, nextAt } = pillsOf(records, store.marks, store.runs, Date.now(), hiddenRuns)
  const [, tick] = useState(0)
  useEffect(() => {
    if (nextAt === null) return
    const timer = setTimeout(() => tick(n => n + 1), Math.max(0, nextAt - Date.now()) + 20)
    return () => clearTimeout(timer)
  }, [nextAt])
  return pills.some(p => p.state === 'running') ? (
    <span
      data-header-running
      className="pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warn"
    />
  ) : null
}

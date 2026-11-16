import type { GitFileChange, GitStatus } from '../../../../../shared/types/project-tools'

// 演示模式：在内存里模拟操作结果，方便看界面
export function demoApply(status: GitStatus, action: string, arg?: unknown): GitStatus {
  const s = structuredClone(status)
  const paths = (list: GitFileChange[], p: unknown) =>
    p === 'all' ? list : list.filter(f => (p as string[]).includes(f.path))
  if (action === 'stage') {
    const moved = [...paths(s.unstaged, arg), ...paths(s.untracked, arg)]
    s.unstaged = s.unstaged.filter(f => !moved.includes(f))
    s.untracked = s.untracked.filter(f => !moved.includes(f))
    s.staged = [
      ...s.staged.filter(f => !moved.some(m => m.path === f.path)),
      ...moved.map(f => ({ ...f, code: f.code === '?' ? ('A' as const) : f.code })),
    ]
  }
  if (action === 'unstage') {
    const moved = paths(s.staged, arg)
    s.staged = s.staged.filter(f => !moved.includes(f))
    s.unstaged = [...s.unstaged.filter(f => !moved.some(m => m.path === f.path)), ...moved.filter(f => f.code !== 'A')]
    s.untracked = [...s.untracked, ...moved.filter(f => f.code === 'A').map(f => ({ ...f, code: '?' as const }))]
  }
  if (action === 'discard') {
    const p =
      arg === 'all' ? 'all' : [...(arg as { paths: string[] }).paths, ...(arg as { untracked: string[] }).untracked]
    s.unstaged = s.unstaged.filter(f => !paths(s.unstaged, p).includes(f))
    s.untracked = s.untracked.filter(f => !paths(s.untracked, p).includes(f))
  }
  // 只提交这些（docs/ui/git-panel.md §10.1）：别的取消暂存，再暂存这些
  if (action === 'commitOnly') {
    const keep = arg as string[]
    const others = s.staged.filter(f => !keep.includes(f.path)).map(f => f.path)
    return demoApply(demoApply(s, 'unstage', others), 'stage', keep)
  }
  // 加入 .gitignore：未跟踪里在这些路径下的不再显示
  if (action === 'ignore') {
    const list = arg as { path: string; dir: boolean }[]
    s.untracked = s.untracked.filter(
      f => !list.some(e => f.path === e.path || (e.dir && f.path.startsWith(e.path + '/'))),
    )
  }
  if (action === 'commit') {
    const all = (arg as { all: boolean }).all
    s.staged = []
    if (all) {
      s.unstaged = []
      s.untracked = []
    }
    s.ahead += 1
    if ((arg as { push: boolean }).push) s.ahead = 0
  }
  if (action === 'push') {
    s.ahead = 0
    s.upstream = s.upstream ?? `origin/${s.branch}`
  }
  if (action === 'pull') s.behind = 0
  if (action === 'fetch') s.fetchedAt = Date.now()
  if (action === 'switch') s.branch = (arg as string).replace(/^origin\//, '')
  return s
}

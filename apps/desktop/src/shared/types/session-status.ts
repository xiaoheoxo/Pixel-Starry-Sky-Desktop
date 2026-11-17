// 侧栏对话状态图标要的额外信号（docs/ui/sidebar-status-icons.md、docs/ui/sidebar-pr-v2-mockup.html）：工作文件夹还在不在、对话关联的 GitHub PR。
// 主进程算好推给界面；只读，不改远端。

/** 对话关联的一个 PR */
export interface SessionPr {
  /** owner/repo */
  repo: string
  number: number
  url: string
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  /** 检查（CI）汇总：没有检查或查不到为 null */
  ci: 'pass' | 'fail' | 'pending' | null
  /** 没通过的检查数（ci 为 fail 时） */
  ciFailed: number
  /** 和目标分支有合并冲突 */
  conflict: boolean
  additions: number
  deletions: number
  head: string
  base: string
  /** ISO 时间：已合并 / 已关闭的时间 */
  closedAt: string | null
  /** 只知道有这个 PR（对话里出现过链接），查不到状态：私有仓库又没登录 gh */
  unknown?: boolean
  /** 每项检查（没过的在前，最多 20 项）；查不到检查（REST 回退、只知道链接）时没有 */
  checks?: PrCheck[]
}

/** PR 的一项检查（docs/ui/review-pr-actions.md §3.1） */
export interface PrCheck {
  name: string
  state: 'fail' | 'pending' | 'pass'
  /** 检查详情页（GitHub Actions 的运行页）；没有时为空 */
  url: string
}

/** 合并方式（gh pr merge 的 --merge / --squash / --rebase） */
export type PrMergeMethod = 'merge' | 'squash' | 'rebase'

/** 合并确认框要的：仓库允许的合并方式（按 GitHub 网页的顺序），仓库默认要不要删分支 */
export interface PrMergeOptions {
  methods: PrMergeMethod[]
  deleteBranch: boolean
}

/** 「让 AI 修检查」发给会话的话：给 AI 看的，不走界面词典（和 prConflictRequest 一样） */
export function prChecksRequest(pr: Pick<SessionPr, 'url' | 'head' | 'checks'>): string {
  const failed = (pr.checks ?? []).filter(c => c.state === 'fail')
  const list = failed.map(c => '- ' + c.name + (c.url ? '：' + c.url : '')).join('\n')
  return (
    `这个 PR 有检查没通过：${pr.url}\n` +
    (list ? list + '\n' : '') +
    `用 gh run view <运行 id> --log-failed（或打开上面的链接）看失败的日志，找到原因后在 ${pr.head} 上修好，本地跑一遍相关的检查，没问题就推送到 ${pr.head}（不要强推）。`
  )
}

/** 「让它修」PR 冲突时发给会话的话：和 checks.ts 的 fixRequest 一样是给 AI 看的，不走界面词典 */
export function prConflictRequest(pr: Pick<SessionPr, 'url' | 'head' | 'base'>): string {
  return `这个 PR 和 ${pr.base} 有合并冲突，请解决：${pr.url}\n把最新的 ${pr.base} 合并进 ${pr.head}，处理冲突，跑一遍检查，没问题就推送到 ${pr.head}（不要强推）。`
}

export interface SessionStatusState {
  /** 工作文件夹找不到了的对话（只查本机对话） */
  missingFolders: Record<string, true>
  /** 对话关联的 PR，按「最需要看」排好：检查没过 / 有冲突的开着的 > 开着的 > 草稿 > 已合并 > 已关闭 */
  prs: Record<string, SessionPr[]>
  /** 对话里只是提到过的 PR 链接（不是这个对话建的，不查状态、不出图标，悬停卡里折叠列出） */
  mentioned: Record<string, string[]>
  /** 本机有没有能用的 gh（装了且登录了）；悬停卡里提示用 */
  gh: 'ready' | 'missing' | 'signed-out'
}

export interface SessionStatusBridge {
  get(): Promise<SessionStatusState>
  /** 立刻重查（不传就查全部）；切回窗口、悬停卡里点「刷新」时用 */
  refresh(sessionId?: string): Promise<void>
  /** 合并确认框：仓库允许的合并方式 */
  mergeOptions(url: string): Promise<PrMergeOptions>
  /** 合并这个 PR（gh pr merge），合并后重查这个对话的 PR；失败抛出 gh 的原话 */
  mergePr(sessionId: string, url: string, method: PrMergeMethod, deleteBranch: boolean): Promise<void>
  onChange(callback: (state: SessionStatusState) => void): () => void
}

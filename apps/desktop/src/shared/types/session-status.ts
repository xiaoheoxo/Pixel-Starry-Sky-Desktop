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
  onChange(callback: (state: SessionStatusState) => void): () => void
}

// Git 面板的纯函数（docs/ui/git-panel.md）
import type {
  GitArea,
  GitDiff,
  GitFailureKind,
  GitFileChange,
  GitStatus,
} from '../../../../../shared/types/project-tools'
import { tr, type TranslationKey } from '../../../i18n/core'

export interface GitSection {
  area: GitArea
  title: TranslationKey
  files: GitFileChange[]
}

/** 显示顺序：合并冲突 → 暂存的更改 → 更改 → 未跟踪；空的组不显示 */
export function gitSections(status: GitStatus): GitSection[] {
  const sections: GitSection[] = [
    { area: 'conflicted', title: 'git.section.conflicted', files: status.conflicted },
    { area: 'staged', title: 'git.section.staged', files: status.staged },
    { area: 'unstaged', title: 'git.section.unstaged', files: status.unstaged },
    { area: 'untracked', title: 'git.section.untracked', files: status.untracked },
  ]
  return sections.filter(s => s.files.length > 0)
}

export const changeCount = (status: GitStatus): number =>
  status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length

/** 提交时要不要先「提交全部」：没有暂存内容但有其他改动 */
export const needsCommitAll = (status: GitStatus): boolean =>
  status.staged.length === 0 && status.unstaged.length + status.untracked.length > 0

/**
 * 输入框上方的「↑2 ↓1」（docs/ui/composer-git.md）：没有远端、都同步了时为 null；
 * 有分支但还没推送过（没有上游）算「未发布」
 */
export function syncState(status: GitStatus): { ahead: number; behind: number; unpublished: boolean } | null {
  const unpublished = !status.upstream && !status.detached && !status.initial && !!status.branch
  if (!status.remotes.length || (!status.ahead && !status.behind && !unpublished)) return null
  return { ahead: status.ahead, behind: status.behind, unpublished }
}

/** 文件名和所在目录 */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

/** 「N 分钟前」 */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return tr('git.ago.now')
  if (s < 3600) return tr('git.ago.minutes', { n: Math.floor(s / 60) })
  if (s < 86400) return tr('git.ago.hours', { n: Math.floor(s / 3600) })
  return tr('git.ago.days', { n: Math.floor(s / 86400) })
}

export const failureTitle = (kind: GitFailureKind): string => tr(`git.failure.${kind}.title` as TranslationKey)
/** 切换分支时改动会被覆盖：拉取那一套说法（拉完再放回来）不对，换成切换的 */
export const failureHint = (kind: GitFailureKind, action?: string): string =>
  kind === 'dirty' && (action === 'switch' || action === 'create')
    ? tr('git.failure.dirty.switchHint')
    : tr(`git.failure.${kind}.hint` as TranslationKey)

/** 面板窄于这个宽度时并排差异放不下，只用行内 */
export const SPLIT_MIN_WIDTH = 560
export const diffMode = (preferred: 'split' | 'inline', width: number): 'split' | 'inline' =>
  width < SPLIT_MIN_WIDTH ? 'inline' : preferred

/** 下一个要看的文件：同一组里的下一个，到头了换下一组 */
export function neighbour(
  sections: GitSection[],
  area: GitArea,
  path: string,
  delta: 1 | -1,
): { area: GitArea; file: GitFileChange } | null {
  const flat = sections.flatMap(s => s.files.map(file => ({ area: s.area, file })))
  const i = flat.findIndex(e => e.area === area && e.file.path === path)
  return i < 0 ? null : (flat[i + delta] ?? null)
}

/** 两次读到的对比是不是一样（状态刷新后重读：一样就不替换，编辑器不重建、滚动位置不丢） */
export const sameGitDiff = (a: GitDiff, b: GitDiff): boolean =>
  a.path === b.path &&
  a.original === b.original &&
  a.modified === b.modified &&
  a.binary === b.binary &&
  a.tooLarge === b.tooLarge

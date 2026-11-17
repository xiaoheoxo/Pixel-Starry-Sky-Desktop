// PR「通过后合并」（docs/ui/review-pr-actions.md §3.2）：问仓库允许哪几种合并方式，再用 gh pr merge 合并。
// gh 在用户主目录里跑（gh.ts），不在工作区里：--delete-branch 只删远端分支，不去切、删本地分支
import type { PrMergeMethod, PrMergeOptions } from '../../shared/types/session-status'
import type { GhResult, GhRunner } from './gh'
import { parsePrUrl } from './github'

const METHODS: readonly PrMergeMethod[] = ['merge', 'squash', 'rebase']

export const isMergeMethod = (v: unknown): v is PrMergeMethod => METHODS.includes(v as PrMergeMethod)

/** 只认 GitHub 的 PR 地址，返回 owner/repo */
export function prRepo(url: unknown): string {
  const link = typeof url === 'string' && url.length <= 500 ? parsePrUrl(url) : null
  if (!link) throw new Error('不是 GitHub 的 PR 地址')
  return `${link.owner}/${link.repo}`
}

/** gh 的失败 → 给用户看的话：没装、没登录、超时，其余原样（比如分支保护要求审核） */
function ghError(r: GhResult): Error {
  if (r.missing) return new Error('没找到 gh（GitHub CLI），装好并登录后再试')
  if (r.timedOut) return new Error('gh 超时了，稍后再试')
  const text = (r.stderr || r.stdout).trim()
  if (/auth login|not logged in/i.test(text)) return new Error('gh 还没登录：在终端里运行 gh auth login')
  return new Error(text.split('\n').slice(0, 6).join('\n') || `gh 退出码 ${r.code}`)
}

/** 仓库设置里允许的合并方式（按 GitHub 网页的顺序）和「合并后自动删分支」；一个都没读到时只给 merge */
export async function mergeOptions(gh: GhRunner, url: unknown): Promise<PrMergeOptions> {
  const repo = prRepo(url)
  const r = await gh([
    'repo',
    'view',
    repo,
    '--json',
    'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge',
  ])
  if (r.code !== 0) throw ghError(r)
  let o: Record<string, unknown> = {}
  try {
    o = JSON.parse(r.stdout) as Record<string, unknown>
  } catch {}
  const methods = METHODS.filter(
    m => o[{ merge: 'mergeCommitAllowed', squash: 'squashMergeAllowed', rebase: 'rebaseMergeAllowed' }[m]] === true,
  )
  // 仓库开了「合并后自动删分支」时 GitHub 自己会删；不管开没开，确认框默认都勾上
  return { methods: methods.length ? methods : ['merge'], deleteBranch: true }
}

/** gh pr merge 的参数 */
export function mergeArgs(url: string, method: PrMergeMethod, deleteBranch: boolean): string[] {
  return ['pr', 'merge', url, '--' + method, ...(deleteBranch ? ['--delete-branch'] : [])]
}

export async function mergePr(gh: GhRunner, url: unknown, method: unknown, deleteBranch: unknown): Promise<void> {
  prRepo(url)
  if (!isMergeMethod(method)) throw new Error('合并方式不正确')
  const r = await gh(mergeArgs(url as string, method, deleteBranch === true))
  if (r.code !== 0) throw ghError(r)
}

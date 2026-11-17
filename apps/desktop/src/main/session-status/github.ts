// 侧栏状态图标里的 PR（docs/ui/sidebar-status-icons.md §4）：纯函数部分——解析 GitHub 地址、从文字里找 PR 链接、
// 把 gh / GitHub 接口的 JSON 转成 SessionPr、排序和过期过滤。不碰文件、网络和进程，方便测试。
import type { PrCheck, SessionPr } from '../../shared/types/session-status'

export interface RepoRef {
  owner: string
  repo: string
}

/** gh pr list / view 要的字段（statusCheckRollup 用来算检查汇总） */
export const GH_PR_FIELDS =
  'number,title,url,state,isDraft,mergedAt,closedAt,mergeable,additions,deletions,headRefName,baseRefName,statusCheckRollup'

/** 已关闭（没合并）的 PR 超过这么久就不再显示 */
export const CLOSED_KEEP_MS = 7 * 24 * 60 * 60_000

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const REPO = '[A-Za-z0-9._-]{1,100}?'

/** 解析 origin 的地址：只认 github.com 的 https / ssh（含 scp 写法）；别的返回 null */
export function parseGithubRemote(url: string): RepoRef | null {
  const text = url.trim()
  const patterns = [
    new RegExp(`^https?://(?:[^@/\\s]+@)?(?:www\\.)?github\\.com(?::\\d+)?/(${OWNER})/(${REPO})(?:\\.git)?/?$`, 'i'),
    new RegExp(`^(?:ssh://)?(?:[^@/\\s]+@)?github\\.com[:/](${OWNER})/(${REPO})(?:\\.git)?/?$`, 'i'),
  ]
  for (const pattern of patterns) {
    const m = pattern.exec(text)
    if (m && m[2] !== '.' && m[2] !== '..') return { owner: m[1], repo: m[2] }
  }
  return null
}

export interface PrLink extends RepoRef {
  number: number
  /** 规整后的地址：https://github.com/<o>/<r>/pull/<n> */
  url: string
}

const PR_URL = new RegExp(`https://github\\.com/(${OWNER})/([A-Za-z0-9._-]{1,100})/pull/(\\d{1,9})(?!\\d)`, 'gi')

/** 从一段文字（命令输出、工具输出、助手回复）里找出 PR 链接，去重，保持出现顺序 */
export function extractPrUrls(text: string): PrLink[] {
  const found = new Map<string, PrLink>()
  for (const m of text.matchAll(PR_URL)) {
    const link = {
      owner: m[1],
      repo: m[2],
      number: Number(m[3]),
      url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`,
    }
    if (!found.has(link.url.toLowerCase())) found.set(link.url.toLowerCase(), link)
  }
  return [...found.values()]
}

const CREATE_COMMAND = /\bgh(?:\.exe)?\s+pr\s+create\b|\bgit\s+push\b/i
const CREATE_TOOL = /create_pull_request|pull_request_create|create_pr\b|createpullrequest/i

/** 这一步是不是在建 / 推 PR：命令里有 gh pr create 或 git push（推送时 GitHub 会给出这个分支的 PR 链接），或建 PR 的工具（GitHub MCP 的 create_pull_request 等） */
export function createsPr(item: { kind: 'command'; command: string } | { kind: 'tool'; name: string }): boolean {
  return item.kind === 'command' ? CREATE_COMMAND.test(item.command) : CREATE_TOOL.test(item.name)
}

/** 单个 PR 链接（记下来的那种）→ 仓库和编号 */
export function parsePrUrl(url: string): PrLink | null {
  const links = extractPrUrls(url)
  return links.length === 1 && links[0].url.toLowerCase() === url.trim().toLowerCase() ? links[0] : null
}

const FAIL_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING_STATUSES = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'])

/** statusCheckRollup → 汇总：有没过的算 fail；否则有进行中的算 pending；否则有检查算 pass；没有检查为 null */
export function summarizeChecks(rollup: unknown): { ci: SessionPr['ci']; ciFailed: number } {
  if (!Array.isArray(rollup) || !rollup.length) return { ci: null, ciFailed: 0 }
  let failed = 0,
    pending = false
  for (const raw of rollup) {
    const c = (raw ?? {}) as Record<string, unknown>
    const conclusion = typeof c.conclusion === 'string' ? c.conclusion.toUpperCase() : ''
    const status = typeof c.status === 'string' ? c.status.toUpperCase() : ''
    const state = typeof c.state === 'string' ? c.state.toUpperCase() : ''
    if (FAIL_CONCLUSIONS.has(conclusion) || state === 'FAILURE' || state === 'ERROR') failed++
    else if (PENDING_STATUSES.has(state) || (status && status !== 'COMPLETED') || (!conclusion && !state && !status))
      pending = true
  }
  if (failed) return { ci: 'fail', ciFailed: failed }
  return { ci: pending ? 'pending' : 'pass', ciFailed: 0 }
}

/** 卡片里最多列这么多项检查 */
export const CHECKS_MAX = 20

/** statusCheckRollup → 每一项（CheckRun 有 name / detailsUrl，旧的 StatusContext 有 context / targetUrl）；没过的在前、进行中其次 */
export function listChecks(rollup: unknown): PrCheck[] {
  if (!Array.isArray(rollup)) return []
  const order = { fail: 0, pending: 1, pass: 2 }
  return rollup
    .map((raw): PrCheck | null => {
      const c = (raw ?? {}) as Record<string, unknown>
      const name = str(c.name) || str(c.context)
      if (!name) return null
      const { ci } = summarizeChecks([c])
      const url = str(c.detailsUrl) || str(c.targetUrl)
      return { name, state: ci ?? 'pending', url: /^https:\/\//.test(url) ? url : '' }
    })
    .filter((c): c is PrCheck => !!c)
    .sort((a, b) => order[a.state] - order[b.state])
    .slice(0, CHECKS_MAX)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const time = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

/** gh 的 JSON（pr list 的一项或 pr view 的结果）→ SessionPr；缺编号或地址返回 null */
export function mapGhPr(raw: unknown, fallbackRepo?: string): SessionPr | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const number = num(o.number),
    url = str(o.url)
  if (!number || !url) return null
  const link = parsePrUrl(url)
  const state = str(o.state).toUpperCase()
  const mergedAt = time(o.mergedAt),
    closedAt = time(o.closedAt)
  const { ci, ciFailed } = summarizeChecks(o.statusCheckRollup)
  return {
    repo: link ? `${link.owner}/${link.repo}` : (fallbackRepo ?? ''),
    number,
    url,
    title: str(o.title),
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : o.isDraft === true ? 'draft' : 'open',
    ci,
    ciFailed,
    conflict: str(o.mergeable).toUpperCase() === 'CONFLICTING',
    additions: num(o.additions),
    deletions: num(o.deletions),
    head: str(o.headRefName),
    base: str(o.baseRefName),
    closedAt: mergedAt ?? closedAt,
    checks: listChecks(o.statusCheckRollup),
  }
}

/** GitHub REST 的 pull 对象 → SessionPr（没有检查信息：ci 为 null；单个 PR 接口才有 mergeable_state / additions） */
export function mapRestPr(raw: unknown, fallbackRepo?: string): SessionPr | null {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const number = num(o.number),
    url = str(o.html_url)
  if (!number || !url) return null
  const link = parsePrUrl(url)
  const mergedAt = time(o.merged_at)
  const head = (o.head ?? {}) as Record<string, unknown>,
    base = (o.base ?? {}) as Record<string, unknown>
  return {
    repo: link ? `${link.owner}/${link.repo}` : (fallbackRepo ?? ''),
    number,
    url,
    title: str(o.title),
    state: mergedAt ? 'merged' : str(o.state) === 'closed' ? 'closed' : o.draft === true ? 'draft' : 'open',
    ci: null,
    ciFailed: 0,
    conflict: str(o.mergeable_state) === 'dirty',
    additions: num(o.additions),
    deletions: num(o.deletions),
    head: str(head.ref),
    base: str(base.ref),
    closedAt: mergedAt ?? time(o.closed_at),
  }
}

/** 只知道链接、查不到状态时的占位 */
export function unknownPr(link: PrLink): SessionPr {
  return {
    repo: `${link.owner}/${link.repo}`,
    number: link.number,
    url: link.url,
    title: '',
    state: 'open',
    ci: null,
    ciFailed: 0,
    conflict: false,
    additions: 0,
    deletions: 0,
    head: '',
    base: '',
    closedAt: null,
    unknown: true,
  }
}

/** 已关闭（没合并）超过 7 天的不再显示 */
export function isExpired(pr: SessionPr, now: number): boolean {
  if (pr.state !== 'closed' || !pr.closedAt) return false
  const at = Date.parse(pr.closedAt)
  return !Number.isNaN(at) && now - at > CLOSED_KEEP_MS
}

function rank(pr: SessionPr): number {
  if (pr.state === 'open') return pr.ci === 'fail' || pr.conflict ? 0 : 1
  return { draft: 2, merged: 3, closed: 4 }[pr.state]
}

/** 按 url 去重（先出现的留下）、去掉过期的、排序：开着且检查没过 / 有冲突 > 开着 > 草稿 > 已合并 > 已关闭；同级新的在前 */
export function arrangePrs(prs: SessionPr[], now: number): SessionPr[] {
  const seen = new Set<string>()
  const kept = prs.filter(pr => {
    const key = pr.url.toLowerCase()
    if (seen.has(key) || isExpired(pr, now)) return false
    seen.add(key)
    return true
  })
  const at = (pr: SessionPr): number => (pr.closedAt ? Date.parse(pr.closedAt) : 0)
  return kept.sort((a, b) => rank(a) - rank(b) || at(b) - at(a) || b.number - a.number)
}

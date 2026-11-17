// 网页里的错误：控制台 error 和失败的请求。页面检查（page-check.ts）和内置浏览器的运行胶囊（docs/ui/panel-pill.md §8.1）共用一套过滤
import { redact } from '../core/project-tools/services'
import type { BrowserIssueEntry } from '../../shared/types/project-browser'

/** 控制台里的这句和失败的请求是同一件事，只记请求 */
export const NETWORK_NOISE = /^Failed to load resource/
export const ISSUE_CHARS = 400
/** 胶囊详情里留最近几条原文 */
export const ISSUE_KEEP = 5

export const cleanIssue = (text: string): string => redact(text, []).slice(0, ISSUE_CHARS)

/** 控制台消息 → 要记的一行；不是 error 级、是网络噪音时为 null */
export function consoleIssue(d: {
  level: string
  message: string
  sourceId?: string
  lineNumber?: number
}): string | null {
  if (d.level !== 'error' || NETWORK_NOISE.test(d.message)) return null
  return cleanIssue(d.message + (d.sourceId ? ` (${d.sourceId}:${d.lineNumber})` : ''))
}

/**
 * 子资源请求 → 要记的一行：4xx/5xx 或网络错误。主框架（整页打不开另有提示）、favicon、取消的请求不算
 */
export function failedRequest(d: {
  url: string
  resourceType: string
  statusCode?: number
  error?: string
}): string | null {
  if (d.resourceType === 'mainFrame' || /\/favicon\.ico(\?|$)/.test(d.url)) return null
  // Electron 的 onCompleted 成功时也带 error: 'net::OK'，不算网络错误，看状态码
  if (d.error !== undefined && d.error !== 'net::OK')
    return d.error === 'net::ERR_ABORTED' ? null : cleanIssue(`${d.error} ${d.url}`)
  return d.statusCode !== undefined && d.statusCode >= 400 ? cleanIssue(`${d.statusCode} ${d.url}`) : null
}

export interface PageIssues {
  errors: number
  requests: number
  /** 警告只在抽屉里看，胶囊和红点不算 */
  warnings?: number
  /** 最近几条原文，旧的在前 */
  last: string[]
}

export function addIssue(prev: PageIssues | undefined, kind: 'errors' | 'requests', line: string): PageIssues {
  const base = prev ?? { errors: 0, requests: 0, last: [] }
  return { ...base, [kind]: base[kind] + 1, last: [...base.last, line].slice(-ISSUE_KEEP) }
}

/** 控制台抽屉的一条（类型在 shared，界面也用） */
export type IssueEntry = BrowserIssueEntry

/** 每页错误和失败请求留这么多条，警告另外留这么多条 */
export const ENTRY_KEEP = 50

/** 控制台消息 → 抽屉里的一条：error 和 warning 级；网络噪音不记（失败请求那边已经有） */
export function consoleEntry(
  d: { level: string; message: string; sourceId?: string; lineNumber?: number },
  at: number,
): IssueEntry | null {
  if ((d.level !== 'error' && d.level !== 'warning') || NETWORK_NOISE.test(d.message)) return null
  // Electron 自己往网页控制台打的安全提示（没打包时才有），不是网页的问题
  if (d.sourceId && /^(node:)?electron\//.test(d.sourceId)) return null
  return {
    kind: d.level === 'error' ? 'error' : 'warning',
    text: cleanIssue(d.message),
    source: d.sourceId ? cleanIssue(`${d.sourceId}:${d.lineNumber ?? 0}`) : '',
    at,
  }
}

/** 加一条：错误和请求一起最多 ENTRY_KEEP 条，警告另算，各自丢最旧的 */
export function pushEntry(list: readonly IssueEntry[] | undefined, entry: IssueEntry): IssueEntry[] {
  const next = [...(list ?? []), entry]
  const warning = entry.kind === 'warning'
  const same = next.filter(e => (e.kind === 'warning') === warning)
  if (same.length <= ENTRY_KEEP) return next
  const drop = same[0]
  return next.filter(e => e !== drop)
}

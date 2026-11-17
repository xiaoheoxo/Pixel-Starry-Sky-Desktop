// 网页里的错误：控制台 error 和失败的请求。页面检查（page-check.ts）和内置浏览器的运行胶囊（docs/ui/panel-pill.md §8.1）共用一套过滤
import { redact } from '../core/project-tools/services'

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
  if (d.error !== undefined) return d.error === 'net::ERR_ABORTED' ? null : cleanIssue(`${d.error} ${d.url}`)
  return d.statusCode !== undefined && d.statusCode >= 400 ? cleanIssue(`${d.statusCode} ${d.url}`) : null
}

export interface PageIssues {
  errors: number
  requests: number
  /** 最近几条原文，旧的在前 */
  last: string[]
}

export function addIssue(prev: PageIssues | undefined, kind: 'errors' | 'requests', line: string): PageIssues {
  const base = prev ?? { errors: 0, requests: 0, last: [] }
  return { ...base, [kind]: base[kind] + 1, last: [...base.last, line].slice(-ISSUE_KEEP) }
}

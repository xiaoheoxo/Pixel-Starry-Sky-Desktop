import { describe, expect, it } from 'vitest'
import { ISSUE_KEEP, addIssue, consoleIssue, failedRequest } from './page-issues'

describe('网页错误的过滤（页面检查、浏览器胶囊共用）', () => {
  it('控制台只记 error 级，带出处；「Failed to load resource」算请求那边', () => {
    expect(consoleIssue({ level: 'warning', message: 'x' })).toBeNull()
    expect(consoleIssue({ level: 'error', message: 'Failed to load resource: 404' })).toBeNull()
    expect(consoleIssue({ level: 'error', message: 'boom', sourceId: 'http://a/b.js', lineNumber: 3 })).toBe(
      'boom (http://a/b.js:3)',
    )
  })
  it('请求：4xx/5xx、网络错误算；主框架、favicon、取消、成功的不算', () => {
    const r = (patch: object) => failedRequest({ url: 'http://a/api', resourceType: 'xhr', ...patch })
    expect(r({ statusCode: 404 })).toBe('404 http://a/api')
    expect(r({ error: 'net::ERR_CONNECTION_REFUSED' })).toBe('net::ERR_CONNECTION_REFUSED http://a/api')
    expect(r({ statusCode: 200 })).toBeNull()
    expect(r({ error: 'net::ERR_ABORTED' })).toBeNull()
    expect(r({ statusCode: 500, resourceType: 'mainFrame' })).toBeNull()
    expect(failedRequest({ url: 'http://a/favicon.ico', resourceType: 'image', statusCode: 404 })).toBeNull()
  })
  it('计数分开记，原文只留最近几条', () => {
    let issues = addIssue(undefined, 'errors', 'e0')
    for (let i = 1; i <= ISSUE_KEEP + 2; i++) issues = addIssue(issues, 'requests', 'r' + i)
    expect(issues.errors).toBe(1)
    expect(issues.requests).toBe(ISSUE_KEEP + 2)
    expect(issues.last).toHaveLength(ISSUE_KEEP)
    expect(issues.last.at(-1)).toBe('r' + (ISSUE_KEEP + 2))
  })
})

import { describe, expect, it } from 'vitest'
import { ENTRY_KEEP, ISSUE_KEEP, addIssue, consoleEntry, consoleIssue, failedRequest, pushEntry } from './page-issues'

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
    // onCompleted 成功时 error 是 net::OK：按状态码算（之前把所有成功的请求都算成了失败）
    expect(r({ statusCode: 200, error: 'net::OK' })).toBeNull()
    expect(r({ statusCode: 404, error: 'net::OK' })).toBe('404 http://a/api')
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

describe('控制台抽屉的明细', () => {
  it('error 和 warning 都记，网络噪音和别的级别不记；来源是文件:行', () => {
    expect(
      consoleEntry({ level: 'warning', message: 'deprecated', sourceId: 'http://a/x.js', lineNumber: 3 }, 1),
    ).toEqual({
      kind: 'warning',
      text: 'deprecated',
      source: 'http://a/x.js:3',
      at: 1,
    })
    expect(consoleEntry({ level: 'error', message: 'boom' }, 2)?.kind).toBe('error')
    expect(consoleEntry({ level: 'info', message: 'hi' }, 3)).toBeNull()
    expect(consoleEntry({ level: 'error', message: 'Failed to load resource: 404' }, 4)).toBeNull()
    // Electron 自己的安全提示（真实实例里见到的）
    expect(
      consoleEntry(
        {
          level: 'warning',
          message: '%cElectron Security Warning (Insecure Content-Security-Policy)',
          sourceId: 'node:electron/js2c/sandbox_bundle',
          lineNumber: 2,
        },
        5,
      ),
    ).toBeNull()
  })
  it('错误和请求一起最多 ENTRY_KEEP 条，警告另算，各丢最旧的', () => {
    let list = pushEntry(undefined, { kind: 'warning', text: 'w0', source: '', at: 0 })
    for (let i = 1; i <= ENTRY_KEEP + 3; i++)
      list = pushEntry(list, { kind: i % 2 ? 'error' : 'request', text: 'e' + i, source: '', at: i })
    expect(list.filter(e => e.kind !== 'warning')).toHaveLength(ENTRY_KEEP)
    expect(list[0].text).toBe('w0')
    expect(list[1].text).toBe('e4')
  })
})

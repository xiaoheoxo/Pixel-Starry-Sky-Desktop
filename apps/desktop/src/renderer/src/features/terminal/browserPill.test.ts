import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserState } from '../../../../shared/types/project-browser'
import { browserFailed, browserIssueQuote, browserPillOf, shortUrl } from './browserPill'

const page = (patch: Partial<BrowserPage> = {}): BrowserPage => ({
  id: 'p1',
  url: 'http://localhost:5173/settings/',
  title: 'App',
  loading: false,
  error: null,
  canBack: false,
  canForward: false,
  annotations: [],
  ...patch,
})
const state = (pages: BrowserPage[], activeId = 'p1'): BrowserState => ({ scope: 's', pages, activeId })

describe('运行胶囊里的内置浏览器', () => {
  it('浏览器标签不在眼前、有当前页时显示地址，不带协议和结尾斜杠', () => {
    const pill = browserPillOf(state([page()]), false)
    expect(pill).toMatchObject({ pageId: 'p1', label: 'localhost:5173/settings', issues: 0 })
    expect(browserFailed(pill!)).toBe(false)
    expect(shortUrl('https://example.com/')).toBe('example.com')
  })
  it('正看着浏览器、没有页面、空白页、当前页不存在时不显示', () => {
    expect(browserPillOf(state([page()]), true)).toBeNull()
    expect(browserPillOf(state([]), false)).toBeNull()
    expect(browserPillOf(state([page({ url: 'about:blank' })]), false)).toBeNull()
    expect(browserPillOf(state([page()], 'gone'), false)).toBeNull()
    expect(browserPillOf(null, false)).toBeNull()
  })
  it('控制台错误和失败请求加起来算错误数；打不开也算红', () => {
    const pill = browserPillOf(state([page({ issues: { errors: 1, requests: 2, last: ['a', 'b'] } })]), false)!
    expect(pill.issues).toBe(3)
    expect(browserFailed(pill)).toBe(true)
    expect(browserFailed(browserPillOf(state([page({ error: 'ERR_CONNECTION_REFUSED' })]), false)!)).toBe(true)
  })
  it('发给 AI 的那段带地址、总数和最近几条', () => {
    const pill = browserPillOf(
      state([page({ error: 'X', issues: { errors: 1, requests: 0, last: ['boom'] } })]),
      false,
    )!
    const quote = browserIssueQuote(pill)
    expect(quote).toContain('http://localhost:5173/settings/')
    expect(quote).toContain('共 2 个')
    expect(quote).toContain('X\nboom')
  })
})

import { describe, expect, it } from 'vitest'
import { MAX_IMAGE_COUNT, type ImageAttachment } from '@pixelsky/protocol'
import type { BrowserIssueEntry, BrowserPage } from '../../../../shared/types/project-browser'
import {
  CONSOLE_HEIGHT,
  QUOTE_MAX,
  parseConsolePrefs,
  attachmentProblem,
  captureAttachment,
  captureName,
  entriesQuote,
  entryLine,
  filterCounts,
  isWebPage,
  issueCount,
  visibleEntries,
  zoomPercent,
} from './browserTools'

const entry = (kind: BrowserIssueEntry['kind'], text: string, source = ''): BrowserIssueEntry => ({
  kind,
  text,
  source,
  at: 0,
})
const list = [entry('warning', 'w1'), entry('error', 'e1', 'a.js:3'), entry('request', 'GET 404 /x', 'xhr')]
const page = (over: Partial<BrowserPage> = {}): BrowserPage => ({
  id: 'p',
  url: 'http://localhost:5173/',
  title: '',
  loading: false,
  error: null,
  canBack: false,
  canForward: false,
  annotations: [],
  ...over,
})

describe('控制台抽屉的筛选', () => {
  it('「全部」默认不带警告，开了才带；新的在上面', () => {
    expect(visibleEntries(list, 'all', false).map(e => e.text)).toEqual(['GET 404 /x', 'e1'])
    expect(visibleEntries(list, 'all', true).map(e => e.text)).toEqual(['GET 404 /x', 'e1', 'w1'])
  })
  it('「错误」「失败请求」只看各自的', () => {
    expect(visibleEntries(list, 'error', true).map(e => e.text)).toEqual(['e1'])
    expect(visibleEntries(list, 'request', true).map(e => e.text)).toEqual(['GET 404 /x'])
  })
  it('各个筛选的条数', () => {
    expect(filterCounts(list, false)).toEqual({ all: 2, error: 1, request: 1 })
    expect(filterCounts(list, true)).toEqual({ all: 3, error: 1, request: 1 })
  })
  it('工具栏的数：警告只在开了开关时算', () => {
    const p = page({ issues: { errors: 1, requests: 2, warnings: 4, last: [] } })
    expect(issueCount(p, false)).toBe(3)
    expect(issueCount(p, true)).toBe(7)
    expect(issueCount(page(), true)).toBe(0)
    expect(issueCount(undefined, true)).toBe(0)
  })
})

describe('发给 AI 的文字', () => {
  it('控制台带来源，请求不重复写类型，警告标出来', () => {
    expect(entryLine(list[1])).toBe('e1 (a.js:3)')
    expect(entryLine(list[2])).toBe('GET 404 /x')
    expect(entryLine(list[0])).toBe('[warning] w1')
  })
  it('和运行胶囊一样的格式；太多时只放最新的几条，总数照实写', () => {
    const many = Array.from({ length: QUOTE_MAX + 5 }, (_, i) => entry('error', `e${i}`))
    const text = entriesQuote('http://localhost:5173/', many)
    expect(text).toContain(`共 ${QUOTE_MAX + 5} 个`)
    expect(text).not.toContain('e4\n')
    expect(text).toContain(`e${QUOTE_MAX + 4}`)
  })
})

describe('截图放进输入框', () => {
  it('base64 → 附件，字节数去掉补位', () => {
    const a = captureAttachment({ dataBase64: 'AAAA', width: 2, height: 1, truncated: false }, 'x.jpg', 'id1')
    expect(a).toMatchObject({ id: 'id1', name: 'x.jpg', mediaType: 'image/jpeg', bytes: 3, width: 2, height: 1 })
    expect(captureAttachment({ dataBase64: 'AA==', width: 1, height: 1, truncated: false }, 'x', 'i').bytes).toBe(1)
  })
  it('张数、单张、总大小超了不放', () => {
    const img = (bytes: number): ImageAttachment => ({
      id: String(bytes),
      name: 'a',
      mediaType: 'image/jpeg',
      bytes,
      width: 1,
      height: 1,
      dataBase64: '',
    })
    expect(attachmentProblem([], img(1000))).toBeNull()
    expect(
      attachmentProblem(
        Array.from({ length: MAX_IMAGE_COUNT }, () => img(1)),
        img(1),
      ),
    ).toBe('composer.attachment.tooMany')
    expect(attachmentProblem([], img(11 * 1024 * 1024))).toBe('composer.attachment.tooLarge')
    expect(attachmentProblem([img(9 * 1024 * 1024), img(9 * 1024 * 1024)], img(3 * 1024 * 1024))).toBe(
      'composer.attachment.totalTooLarge',
    )
  })
  it('文件名：主机 + 时间', () => {
    const at = new Date(2026, 10, 17, 12, 4, 31).getTime()
    expect(captureName('http://localhost:5173/a', at)).toBe('localhost-5173-120431.jpg')
    expect(captureName('not a url', at)).toBe('page-120431.jpg')
  })
})

describe('控制台抽屉记住的设置', () => {
  it('坏的、缺的用默认值，高度夹到范围里', () => {
    expect(parseConsolePrefs(null)).toEqual({ height: CONSOLE_HEIGHT.initial, warnings: false })
    expect(parseConsolePrefs('{')).toEqual({ height: CONSOLE_HEIGHT.initial, warnings: false })
    expect(parseConsolePrefs('{"height":9999,"warnings":true}')).toEqual({ height: CONSOLE_HEIGHT.max, warnings: true })
    expect(parseConsolePrefs('{"height":10,"warnings":"yes"}')).toEqual({ height: CONSOLE_HEIGHT.min, warnings: false })
  })
})

describe('缩放和网页种类', () => {
  it('百分比', () => {
    expect(zoomPercent(undefined)).toBe('100%')
    expect(zoomPercent(1.1)).toBe('110%')
    expect(zoomPercent(0.67)).toBe('67%')
  })
  it('只有 http / https 能清数据；远端看原地址', () => {
    expect(isWebPage(page())).toBe(true)
    expect(isWebPage(page({ url: 'file:///d/a.html' }))).toBe(false)
    expect(isWebPage(undefined)).toBe(false)
  })
})

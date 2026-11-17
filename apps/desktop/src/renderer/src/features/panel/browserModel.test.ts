import { describe, expect, it } from 'vitest'
import type { BrowserPage } from '../../../../shared/types/project-browser'
import { addressParts, addressSuggestions, loadFailureReason, pageHasProblem, showPageTabs } from './browserModel'

const page = (id: string, extra: Partial<BrowserPage> = {}): BrowserPage => ({
  id,
  url: 'http://localhost:5173/',
  title: id,
  loading: false,
  error: null,
  canBack: false,
  canForward: false,
  annotations: [],
  ...extra,
})

describe('地址栏的短地址', () => {
  it('不写协议和结尾斜杠；主机和路径分开；图标按本机 / https / http / 文件', () => {
    expect(addressParts('http://127.0.0.1:8330/')).toEqual({ kind: 'local', host: '127.0.0.1:8330', path: '' })
    expect(addressParts('https://example.com/a/b?x=1#y')).toEqual({
      kind: 'secure',
      host: 'example.com',
      path: '/a/b?x=1#y',
    })
    expect(addressParts('http://example.com/').kind).toBe('insecure')
    expect(addressParts('file:///D:/proj/docs/ui/%E6%A0%B7%E7%A8%BF.html')).toEqual({
      kind: 'file',
      host: '样稿.html',
      path: ' — docs/ui',
    })
  })
})

describe('地址栏下拉', () => {
  const ports = [
    { port: 5173, command: 'npm run dev' },
    { port: 8330, command: 'python -m http.server 8330' },
  ]
  const recent = ['http://127.0.0.1:8330/settings', 'http://localhost:5173/', 'https://example.com/docs']

  it('刚聚焦（和当前地址一样）：不过滤，端口在前、最近在后，去重，标出正在看的', () => {
    const list = addressSuggestions('http://localhost:5173/', 'http://localhost:5173/', ports, recent)
    expect(list.map(s => [s.kind, s.label, !!s.current])).toEqual([
      ['port', 'localhost:5173', true],
      ['port', 'localhost:8330', false],
      ['recent', '127.0.0.1:8330/settings', false],
      ['recent', 'example.com/docs', false],
    ])
  })

  it('只输数字：第一条是「打开这个端口」，下面按输入过滤', () => {
    const list = addressSuggestions('5173', 'https://example.com/docs', ports, recent)
    expect(list[0]).toMatchObject({ kind: 'go', url: 'http://localhost:5173/', port: true })
    expect(list.slice(1).map(s => s.label)).toEqual([])
    expect(addressSuggestions('5173/login', '', [], [])[0]).toMatchObject({
      url: 'http://localhost:5173/login',
      label: 'localhost:5173/login',
    })
    const typed = addressSuggestions('83', 'https://example.com/docs', ports, recent)
    expect(typed.map(s => s.label)).toEqual(['localhost:83', 'localhost:8330', '127.0.0.1:8330/settings'])
  })

  it('输了别的：第一条原样，按地址过滤（不管协议）', () => {
    const list = addressSuggestions('https://exam', 'http://localhost:5173/', ports, recent)
    expect(list.map(s => s.label)).toEqual(['https://exam', 'example.com/docs'])
  })
})

describe('整页打不开的原因', () => {
  it('常见错误码给一句话，其余兜底', () => {
    expect(loadFailureReason(-102)).toBe('projectTools.fail.refused')
    expect(loadFailureReason(-105)).toBe('projectTools.fail.notFound')
    expect(loadFailureReason(-202)).toBe('projectTools.fail.cert')
    expect(loadFailureReason(0)).toBe('projectTools.fail.crashed')
    expect(loadFailureReason(-999)).toBe('projectTools.fail.other')
  })
})

describe('标签行和红点', () => {
  it('两个以上页面才有标签行；一个页面但在开新页面时也有', () => {
    expect(showPageTabs([page('a')], 'a')).toBe(false)
    expect(showPageTabs([page('a')], null)).toBe(true)
    expect(showPageTabs([page('a'), page('b')], 'a')).toBe(true)
    expect(showPageTabs([], null)).toBe(false)
  })
  it('打不开或有错误时标签上红点', () => {
    expect(pageHasProblem(page('a'))).toBe(false)
    expect(pageHasProblem(page('a', { failed: -102 }))).toBe(true)
    expect(pageHasProblem(page('a', { issues: { errors: 0, requests: 1, last: [] } }))).toBe(true)
  })
})

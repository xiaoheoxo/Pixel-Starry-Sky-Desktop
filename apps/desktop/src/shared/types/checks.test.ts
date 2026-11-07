import { describe, expect, it } from 'vitest'
import { checkProblems, fixRequest, pageCheckUrl, type CheckPageResult, type CheckRun } from './checks'

const page = (over: Partial<CheckPageResult> = {}): CheckPageResult => ({
  kind: 'page',
  url: 'http://localhost:5173/',
  status: 'pass',
  ms: 1,
  errors: [],
  requests: [],
  shot: 'data:image/jpeg;base64,AAAA',
  ...over,
})
const run = (...items: CheckRun['items']): CheckRun => ({ id: 'r', at: 0, status: 'done', items })

describe('页面检查的地址', () => {
  it('本机地址可以不写协议', () => {
    expect(pageCheckUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(pageCheckUrl(' 127.0.0.1:3000/app ')).toBe('http://127.0.0.1:3000/app')
    expect(pageCheckUrl('https://[::1]:8443/')).toBe('https://[::1]:8443/')
  })
  it('空的、别的机器、带账号密码、别的协议都不要', () => {
    for (const bad of [
      '',
      '   ',
      'example.com',
      'https://localhost.evil.com/',
      'http://a:b@localhost/',
      'file:///c:/x',
    ])
      expect(pageCheckUrl(bad)).toBeNull()
  })
})

describe('页面检查的结果', () => {
  it('通过和连不上（开发服务没开）都不算问题', () => {
    expect(checkProblems(run(page(), page({ status: 'skipped', reason: 'unreachable' }))).pages).toEqual([])
  })
  it('「让它修」带上错误和失败的请求，不带截图', () => {
    const text = fixRequest(
      run(
        page({ status: 'fail', errors: ['TypeError: x is undefined'], requests: ['404 http://localhost:5173/a.js'] }),
      ),
    )
    expect(text).toContain('TypeError: x is undefined')
    expect(text).toContain('404 http://localhost:5173/a.js')
    expect(text).not.toContain('base64')
  })
  it('页面本身打不开时写明原因', () => {
    expect(fixRequest(run(page({ status: 'fail', reason: 'http', detail: '500' })))).toContain('HTTP 500')
  })
})

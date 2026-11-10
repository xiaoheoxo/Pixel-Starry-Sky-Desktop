import { describe, expect, it } from 'vitest'
import type { RequestRetryState } from '@pixelsky/protocol'
import { retryProgress } from './retryProgress'

const base: RequestRetryState = { turnId: 't', attempt: 1, maxRetries: 3, retryAt: null, reason: 'HTTP 502' }

describe('retryProgress', () => {
  it('每个请求计数的引擎照旧显示 n/m', () => {
    expect(retryProgress(base)).toBe(' 1/3')
    expect(retryProgress({ ...base, maxRetries: null })).toBe(' 1')
    expect(retryProgress({ ...base, attempt: null })).toBe('')
  })
  it('Claude 一轮共用额度：显示本轮还剩几次，不再出现 1/1', () => {
    expect(retryProgress({ ...base, scope: 'turn' })).toContain('2')
    expect(retryProgress({ ...base, scope: 'turn' })).not.toContain('/')
    const last = retryProgress({ ...base, attempt: 1, maxRetries: 1, scope: 'turn' })
    expect(last).not.toContain('1/1')
    expect(last).not.toBe(retryProgress({ ...base, scope: 'turn' }))
  })
})

import { describe, expect, it } from 'vitest'
import type { SessionPr } from '../../../../../shared/types/session-status'
import { canMergePr } from './overviewModel'

const pr = (over: Partial<SessionPr> = {}): SessionPr =>
  ({ url: 'u', state: 'open', conflict: false, ci: 'pass', ...over }) as SessionPr

describe('PR 卡片的「合并」什么时候出', () => {
  it('开着、检查全过或没有检查、没冲突、gh 能用', () => {
    expect(canMergePr(pr(), 'ready')).toBe(true)
    expect(canMergePr(pr({ ci: null }), 'ready')).toBe(true)
  })
  it('检查没过或还在跑、有冲突、草稿、已合并、查不到状态、gh 不能用时不出', () => {
    expect(canMergePr(pr({ ci: 'fail' }), 'ready')).toBe(false)
    expect(canMergePr(pr({ ci: 'pending' }), 'ready')).toBe(false)
    expect(canMergePr(pr({ conflict: true }), 'ready')).toBe(false)
    expect(canMergePr(pr({ state: 'draft' }), 'ready')).toBe(false)
    expect(canMergePr(pr({ state: 'merged' }), 'ready')).toBe(false)
    expect(canMergePr(pr({ unknown: true }), 'ready')).toBe(false)
    expect(canMergePr(pr(), 'signed-out')).toBe(false)
  })
})

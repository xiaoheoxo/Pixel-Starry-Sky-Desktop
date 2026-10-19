import { describe, expect, it } from 'vitest'
import { parseRecovered, withoutRecovered } from './recovered'

describe('崩溃恢复的地址参数', () => {
  it('读出原因和次数', () => {
    expect(parseRecovered('?recovered=oom&n=2')).toEqual({ reason: 'oom', n: 2 })
  })
  it('没有参数是正常启动', () => {
    expect(parseRecovered('')).toBeNull()
    expect(parseRecovered('?n=2')).toBeNull()
  })
  it('次数缺失或不合理按 1', () => {
    expect(parseRecovered('?recovered=crashed')).toEqual({ reason: 'crashed', n: 1 })
    expect(parseRecovered('?recovered=crashed&n=-3')).toEqual({ reason: 'crashed', n: 1 })
    expect(parseRecovered('?recovered=crashed&n=abc')).toEqual({ reason: 'crashed', n: 1 })
  })
  it('去掉 recovered 和 n，别的参数留着（设置独立窗口刷新后还是设置窗口）', () => {
    expect(withoutRecovered('?recovered=oom&n=2')).toBe('')
    expect(withoutRecovered('?view=settings&recovered=oom&n=2')).toBe('?view=settings')
    expect(withoutRecovered('?view=settings')).toBe('?view=settings')
    expect(withoutRecovered('')).toBe('')
  })
})

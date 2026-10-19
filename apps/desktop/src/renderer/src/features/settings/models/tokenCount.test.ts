import { describe, expect, it } from 'vitest'
import { formatTokens, isTokenDraftDirty, parseTokens } from './tokenCount'

describe('上下文长度输入', () => {
  it('认数字、千分位和 k / m 单位，大小写都行', () => {
    expect(parseTokens('200000')).toBe(200_000)
    expect(parseTokens('200,000')).toBe(200_000)
    expect(parseTokens('200k')).toBe(200_000)
    expect(parseTokens('1m')).toBe(1_000_000)
    expect(parseTokens(' 1.5M ')).toBe(1_500_000)
    expect(parseTokens('')).toBeNull()
  })
  it('认不出或超出范围返回 undefined', () => {
    expect(parseTokens('abc')).toBeUndefined()
    expect(parseTokens('1g')).toBeUndefined()
    expect(parseTokens('500')).toBeUndefined()
    expect(parseTokens('200m')).toBeUndefined()
  })
  it('显示成 1M / 200K', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(200_000)).toBe('200K')
    expect(formatTokens(123_456)).toBe('123456')
  })
})

describe('isTokenDraftDirty', () => {
  it('认不出的文字算没交出去：200x', () => {
    expect(isTokenDraftDirty('200x', 200000)).toBe(true)
  })
  it('改成别的有效值也算；写法不同但值一样不算', () => {
    expect(isTokenDraftDirty('1M', 200000)).toBe(true)
    expect(isTokenDraftDirty('200k', 200000)).toBe(false)
    expect(isTokenDraftDirty('', null)).toBe(false)
  })
})

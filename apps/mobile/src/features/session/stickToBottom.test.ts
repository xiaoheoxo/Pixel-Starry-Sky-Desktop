import { describe, expect, it } from 'vitest'
import { stickAfterScroll } from './stickToBottom'

const at = (top: number, height: number) => ({ top, height })

describe('stickAfterScroll', () => {
  it('内容长高、离底很远但用户没往上滚：还跟着', () => {
    expect(stickAfterScroll(true, at(1000, 1600), at(1000, 2600), false)).toBe(true)
  })
  it('用户往上滚、离开底部：不跟了', () => {
    expect(stickAfterScroll(true, at(1000, 1600), at(500, 1600), false)).toBe(false)
  })
  it('回到底部附近：又跟了；没跟着时往下滚但没到底：还是不跟', () => {
    expect(stickAfterScroll(false, at(500, 1600), at(1000, 1600), true)).toBe(true)
    expect(stickAfterScroll(false, at(100, 1600), at(500, 1600), false)).toBe(false)
  })
})

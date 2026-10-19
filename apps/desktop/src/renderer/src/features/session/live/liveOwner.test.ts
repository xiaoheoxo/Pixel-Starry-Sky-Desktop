// 状态行独占「在动」：还在跑的行在状态行显示时安静下来，结束的行不受影响
import { describe, expect, it } from 'vitest'
import { rowLook } from './liveOwner'

describe('运行中的行要不要自己动', () => {
  it('没有状态行（侧边对话等）：跑着的行脉冲、闪光、自己计时', () => {
    expect(rowLook(true, false)).toEqual({ pulse: true, shimmer: true, clock: true })
  })

  it('状态行在转：跑着的行保留文字，但都不动', () => {
    expect(rowLook(true, true)).toEqual({ pulse: false, shimmer: false, clock: false })
  })

  it('结束的行不管有没有状态行都不动', () => {
    expect(rowLook(false, false)).toEqual({ pulse: false, shimmer: false, clock: false })
    expect(rowLook(false, true)).toEqual({ pulse: false, shimmer: false, clock: false })
  })
})

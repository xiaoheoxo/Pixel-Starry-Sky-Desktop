// 画面停止刷新的判断（docs/ui/logging.md §4.9）
import { describe, expect, it } from 'vitest'
import { FRAME_TICK_MS as T, frameWatch } from './frameStall'

describe('frameWatch', () => {
  it('asks for one frame per tick and stays quiet while frames come back', () => {
    const w = frameWatch()
    for (let i = 0; i < 5; i++) {
      expect(w.tick(i * T, true)).toEqual({ kind: 'probe' })
      expect(w.frame(i * T + 16)).toBeNull()
    }
  })

  it('reports a stall after 3 on-time ticks without the frame, once, then the recovery', () => {
    const w = frameWatch()
    expect(w.tick(0, true)).toEqual({ kind: 'probe' })
    expect(w.tick(T, true)).toBeNull()
    expect(w.tick(2 * T, true)).toBeNull()
    expect(w.tick(3 * T, true)).toEqual({ kind: 'stalled', stalledMs: 3 * T })
    expect(w.tick(4 * T, true)).toBeNull()
    expect(w.frame(4 * T + 500)).toEqual({ kind: 'recovered', stalledMs: 4 * T + 500, inactiveDuring: false })
    // 恢复后重新开始请求
    expect(w.tick(5 * T, true)).toEqual({ kind: 'probe' })
  })

  it('does not count a late tick (main thread blocked: that is a long task, not a stalled screen)', () => {
    const w = frameWatch()
    w.tick(0, true)
    expect(w.tick(4 * T, true)).toBeNull()
    expect(w.tick(5 * T, true)).toBeNull()
    expect(w.tick(6 * T, true)).toBeNull()
    expect(w.tick(7 * T, true)).toEqual({ kind: 'stalled', stalledMs: 3 * T })
  })

  it('does not ask or count while hidden / unfocused, and restarts the count after', () => {
    const w = frameWatch()
    expect(w.tick(0, false)).toBeNull()
    expect(w.tick(T, true)).toEqual({ kind: 'probe' })
    w.tick(2 * T, true)
    w.tick(3 * T, false)
    w.tick(4 * T, true)
    w.tick(5 * T, true)
    expect(w.tick(6 * T, true)).toEqual({ kind: 'stalled', stalledMs: 3 * T })
  })

  it('marks a recovery that came after the window was hidden or left', () => {
    const w = frameWatch()
    for (let i = 0; i < 4; i++) w.tick(i * T, true)
    w.tick(4 * T, false)
    expect(w.frame(5 * T)).toEqual({ kind: 'recovered', stalledMs: 5 * T, inactiveDuring: true })
    // 下一次停住不带上一次的标记
    for (let i = 6; i < 10; i++) w.tick(i * T, true)
    expect(w.frame(10 * T)).toMatchObject({ inactiveDuring: false })
  })

  it('ignores a frame nobody asked for', () => {
    expect(frameWatch().frame(0)).toBeNull()
  })
})

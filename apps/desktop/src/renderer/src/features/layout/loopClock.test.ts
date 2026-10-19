import { afterEach, describe, expect, it, vi } from 'vitest'
import { alignAllLoops, alignLoop, startLoopClock } from './loopClock'

/** 假的 CSS 动画：只有用到的几个字段 */
const anim = (animationName: string, playState = 'running', startTime: number | null = 1234) =>
  ({ animationName, playState, startTime }) as unknown as Animation & { startTime: number | null }

afterEach(() => vi.unstubAllGlobals())

describe('循环动画对齐同一个时钟', () => {
  it('spin / pulse 的起点对齐到时间轴 0，别的动画和暂停中的不动', () => {
    const spin = anim('spin')
    const pulse = anim('pulse')
    const other = anim('effort-sweep')
    const paused = anim('spin', 'paused')
    const web = { playState: 'running', startTime: 99 } as unknown as Animation
    expect([spin, pulse, other, paused, web].map(alignLoop)).toEqual([true, true, false, false, false])
    expect(spin.startTime).toBe(0)
    expect(pulse.startTime).toBe(0)
    expect(other.startTime).toBe(1234)
    expect(paused.startTime).toBe(1234)
    // 已经对齐的不再写
    expect(alignLoop(spin)).toBe(false)
  })

  it('一起对齐页面上所有的', () => {
    const list = [anim('spin', 'running', 5), anim('pulse', 'running', 7), anim('ping', 'running', 9)]
    alignAllLoops({ getAnimations: () => list })
    expect(list.map(a => a.startTime)).toEqual([0, 0, 9])
  })

  it('动画开始（新出现、移动后重新开始）时对齐；窗口回到前台时整体再对齐', () => {
    class FakeElement {
      constructor(readonly list: Animation[]) {}
      getAnimations() {
        return this.list
      }
    }
    let observed: (() => void) | null = null
    vi.stubGlobal('Element', FakeElement)
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(cb: () => void) {
          observed = cb
        }
        observe() {}
      },
    )
    const listeners: Record<string, (e: unknown) => void> = {}
    const all = [anim('spin', 'running', 40)]
    const dataset: Record<string, string> = { windowIdle: '' }
    const doc = {
      addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
      documentElement: { dataset },
      getAnimations: () => all,
    } as unknown as Document
    startLoopClock(doc)

    const mine = anim('spin', 'running', 10)
    listeners.animationstart({ animationName: 'spin', target: new FakeElement([mine]) })
    expect(mine.startTime).toBe(0)
    const sweep = anim('effort-sweep', 'running', 10)
    listeners.animationstart({ animationName: 'effort-sweep', target: new FakeElement([sweep]) })
    expect(sweep.startTime).toBe(10)

    // 还在后台：属性变了但仍是 idle，不动
    observed!()
    expect(all[0].startTime).toBe(40)
    delete dataset.windowIdle
    observed!()
    expect(all[0].startTime).toBe(0)
  })
})

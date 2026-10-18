import { describe, expect, it, vi } from 'vitest'
import { startupTimeline } from './startup-timing'

function setup(start = 800) {
  let clock = start
  const write = vi.fn()
  return { write, tick: (ms: number) => (clock += ms), timeline: startupTimeline(write, () => clock) }
}

describe('启动耗时打点', () => {
  it('每一步记自己花的时间；画好和加载完两个里程碑都到了才写一条汇总', () => {
    const { write, tick, timeline } = setup()
    tick(120)
    timeline.step('whenReady')
    tick(300)
    timeline.step('initEngine')
    tick(10)
    timeline.step('createWindow')
    tick(200)
    timeline.reach('didFinishLoad')
    expect(write).not.toHaveBeenCalled()
    tick(50)
    timeline.reach('readyToShow')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({
      bootMs: 800,
      steps: { whenReady: 120, initEngine: 300, createWindow: 10 },
      readyToShowMs: 680,
      didFinishLoadMs: 630,
    })
  })

  it('只写一次：再开的窗口、重复到达都不再记', () => {
    const { write, tick, timeline } = setup()
    timeline.reach('readyToShow')
    timeline.reach('didFinishLoad')
    tick(5_000)
    timeline.step('late')
    timeline.reach('readyToShow')
    timeline.reach('didFinishLoad')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0].steps).toEqual({})
  })

  it('同一个里程碑到两次，以第一次为准', () => {
    const { write, tick, timeline } = setup()
    timeline.reach('didFinishLoad')
    tick(100)
    timeline.reach('didFinishLoad')
    tick(100)
    timeline.reach('readyToShow')
    expect(write.mock.calls[0][0].didFinishLoadMs).toBe(0)
  })
})

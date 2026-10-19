// 刷新定时器：假时钟下测页签用的 schedulePoll（页签的 effect 就是 schedulePoll 一行）
import { describe, expect, it, vi } from 'vitest'
import { schedulePoll } from './publishModel'
import { extension, publisherState, version } from './fixtures'

describe('PublishTab 刷新', () => {
  const pending = publisherState([extension({ versions: [version({ status: 'pending' })] })])
  const idle = publisherState([extension()])

  it('有待审核：2 分钟后 publisher() 又被调一次；没有待审核不调；卸载后不再调', () => {
    vi.useFakeTimers()
    try {
      const publisher = vi.fn()
      const stop = schedulePoll(pending, publisher)
      vi.advanceTimersByTime(120_000)
      expect(publisher).toHaveBeenCalledTimes(1)
      stop()
      vi.advanceTimersByTime(600_000)
      expect(publisher).toHaveBeenCalledTimes(1)

      const quiet = vi.fn()
      schedulePoll(idle, quiet)
      vi.advanceTimersByTime(600_000)
      expect(quiet).not.toHaveBeenCalled()

      const unmounted = vi.fn()
      const cleanup = schedulePoll(pending, unmounted)
      vi.advanceTimersByTime(60_000)
      cleanup()
      vi.advanceTimersByTime(600_000)
      expect(unmounted).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

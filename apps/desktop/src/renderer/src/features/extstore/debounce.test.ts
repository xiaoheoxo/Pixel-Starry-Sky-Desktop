import { afterEach, describe, expect, it, vi } from 'vitest'
import { debounced } from './debounce'

describe('debounced', () => {
  afterEach(() => vi.useRealTimers())

  it('300 ms 内连续调 3 次只执行 1 次，参数是最后一次的', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = debounced(fn, 300)
    d('a')
    vi.advanceTimersByTime(200)
    d('ab')
    vi.advanceTimersByTime(200)
    d('abc')
    vi.advanceTimersByTime(299)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('abc')
  })

  it('间隔够长就各执行一次；cancel 丢掉还没执行的', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = debounced(fn, 300)
    d(1)
    vi.advanceTimersByTime(300)
    d(2)
    vi.advanceTimersByTime(300)
    expect(fn.mock.calls).toEqual([[1], [2]])
    d(3)
    d.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

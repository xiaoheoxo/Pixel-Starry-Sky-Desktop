import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeActionResult } from '@pixelsky/protocol'
import { useNativeCheck } from './useNativeCheck'

const { setLive, sync, effect } = vi.hoisted(() => ({
  setLive: vi.fn(),
  sync: vi.fn<(sessionId: string, kind: 'sync') => Promise<NativeActionResult>>(),
  effect: vi.fn<(setup: () => (() => void) | undefined) => void>(),
}))
vi.mock('react', () => ({ useEffect: effect, useState: () => [null, setLive] }))
vi.mock('@/features/engine/store', () => ({ nativeSessionAction: sync }))

let cleanup: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
  setLive.mockClear()
  sync.mockReset()
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function mount(id: string) {
  effect.mockImplementation(setup => {
    cleanup = setup()
  })
  useNativeCheck(id, true)
}

it('clears a confirmed writer banner when the next sync fails', async () => {
  sync
    .mockResolvedValueOnce({ added: 0, live: true, liveSource: 'terminal' })
    .mockRejectedValueOnce(new Error('offline'))
  mount('failed-sync')
  await vi.advanceTimersByTimeAsync(0)
  expect(setLive).toHaveBeenLastCalledWith({ sessionId: 'failed-sync', source: 'terminal' })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(setLive).toHaveBeenLastCalledWith(null)
})

it('expires an unconfirmed writer for a stalled sync, without concurrent checks', async () => {
  sync.mockResolvedValueOnce({ added: 0, live: true }).mockReturnValueOnce(new Promise(() => {}))
  mount('stalled-sync')
  await vi.advanceTimersByTimeAsync(0)
  expect(setLive).toHaveBeenLastCalledWith({ sessionId: 'stalled-sync', source: 'unknown' })
  await vi.advanceTimersByTimeAsync(30_000)
  window.dispatchEvent(new Event('focus'))
  expect(setLive).toHaveBeenLastCalledWith(null)
  expect(sync).toHaveBeenCalledTimes(2)
})

it('clears the banner once the external writer releases the lock', async () => {
  sync.mockResolvedValueOnce({ added: 0, live: true, liveSource: 'other' }).mockResolvedValueOnce({ added: 1 })
  mount('released-lock')
  await vi.advanceTimersByTimeAsync(0)
  expect(setLive).toHaveBeenLastCalledWith({ sessionId: 'released-lock', source: 'other' })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(setLive).toHaveBeenLastCalledWith(null)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(sync).toHaveBeenCalledTimes(2)
})

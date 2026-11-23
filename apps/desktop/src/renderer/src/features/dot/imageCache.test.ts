import { afterEach, expect, it, vi } from 'vitest'
import { createDotImageCache } from './imageCache'

function setup(options?: { maxBytes?: number; maxFiles?: number }) {
  const urls = { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }
  const cache = createDotImageCache({ ...options, urls, keepMs: 5000 })
  const load = vi.fn(async () => new Blob(['12345']))
  return { cache, urls, load }
}

afterEach(() => vi.useRealTimers())

it('shares one request and immediately reuses a decoded thumbnail after all views are unmounted', async () => {
  vi.useFakeTimers()
  const { cache, urls, load } = setup()
  const a = cache.acquire('alice/room', 'same-file', load)
  const b = cache.acquire('alice/room', 'same-file', load)
  expect(await a.url).toBe(await b.url)
  expect(load).toHaveBeenCalledTimes(1)
  cache.decoded('alice/room', 'same-file', 'blob:preview')
  a.release()
  b.release()
  expect(cache.peek('alice/room', 'same-file')).toEqual({ url: 'blob:preview', decoded: true })
  const reopened = cache.acquire('alice/room', 'same-file', load)
  await reopened.url
  expect(load).toHaveBeenCalledTimes(1)
  expect(cache.peek('other/room', 'same-file')).toBeUndefined()
  reopened.release()
  await vi.advanceTimersByTimeAsync(5000)
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  expect(cache.peek('alice/room', 'same-file')).toBeUndefined()
})

it('evicts unused objects over budget, removes inaccessible rooms, and retries failed loads', async () => {
  vi.useFakeTimers()
  const { cache, urls, load } = setup({ maxBytes: 6 })
  const a = cache.acquire('one', 'a', load)
  const b = cache.acquire('two', 'a', load)
  await Promise.all([a.url, b.url])
  a.release()
  b.release()
  expect(cache.peek('one', 'a')).toBeUndefined()
  expect(cache.peek('two', 'a')).toBeDefined()
  cache.retain(new Set(['one']))
  expect(cache.peek('two', 'a')).toBeUndefined()
  expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2)
  const failed = cache.acquire('one', 'a', async () => {
    throw new Error('offline')
  })
  await expect(failed.url).rejects.toThrow('offline')
  failed.release()
  const retry = cache.acquire('one', 'a', load)
  await expect(retry.url).resolves.toBe('blob:preview')
  retry.release()
  cache.retain(new Set())
})

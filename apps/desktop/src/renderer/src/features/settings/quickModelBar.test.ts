import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const KEY = 'pixelsky.quick-model-bar'
const values = new Map<string, string>()
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, value),
}
const target = new EventTarget()

beforeEach(() => {
  values.clear()
  vi.resetModules()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', target)
})
afterEach(() => vi.unstubAllGlobals())

function dispatchStorage(key: string | null): void {
  target.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea: storage }))
}

it.each([
  ['no value', undefined, true],
  ['malformed value', '{', true],
  ['non-boolean value', '0', true],
  ['saved off', 'false', false],
  ['saved on', 'true', true],
] as const)('reads the quick model bar preference: %s', async (_scenario, raw, expected) => {
  if (raw !== undefined) values.set(KEY, raw)
  const { getQuickModelBar } = await import('./quickModelBar')
  expect(getQuickModelBar()).toBe(expected)
})

it('persists local changes and observes sync or other windows without echoing them', async () => {
  const { getQuickModelBar, setQuickModelBar, subscribeQuickModelBar } = await import('./quickModelBar')
  const listener = vi.fn()
  const stop = subscribeQuickModelBar(listener)

  setQuickModelBar(false)
  expect(values.get(KEY)).toBe('false')
  expect(getQuickModelBar()).toBe(false)
  expect(listener).toHaveBeenCalledTimes(1)

  values.delete(KEY)
  dispatchStorage('unrelated')
  expect(getQuickModelBar()).toBe(false)
  dispatchStorage(null)
  expect(getQuickModelBar()).toBe(true)
  expect(values.has(KEY)).toBe(false)
  expect(listener).toHaveBeenCalledTimes(2)
  stop()
})

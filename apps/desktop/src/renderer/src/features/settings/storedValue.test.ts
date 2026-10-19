import { afterEach, describe, expect, it, vi } from 'vitest'
import { onStoredChange, readStoredFlag, readStoredJson } from './storedValue'

// 另一个窗口 / 云同步改了 localStorage 里的小设置：useRemember（git 对比方式）、编辑器自动换行靠它重新读。

const store = new Map<string, string>()
const area = { getItem: (k: string) => store.get(k) ?? null }
const handlers = new Set<(e: unknown) => void>()

function stub(): void {
  store.clear()
  handlers.clear()
  vi.stubGlobal('localStorage', area)
  vi.stubGlobal('window', {
    addEventListener: (_: string, fn: (e: unknown) => void) => handlers.add(fn),
    removeEventListener: (_: string, fn: (e: unknown) => void) => handlers.delete(fn),
  })
}
const fire = (event: { key: string | null; storageArea?: unknown }): void =>
  handlers.forEach(h => h({ storageArea: area, ...event }))
afterEach(() => vi.unstubAllGlobals())

describe('onStoredChange', () => {
  it('收到同一个键的 storage 事件就回调；别的键、别的存储区不理；清空存储（key 为 null）也算', () => {
    stub()
    const changed = vi.fn()
    const off = onStoredChange('pixelsky.git.diffMode', changed)
    fire({ key: 'pixelsky.git.diffMode' })
    expect(changed).toHaveBeenCalledTimes(1)
    fire({ key: 'other' })
    fire({ key: 'pixelsky.git.diffMode', storageArea: {} })
    expect(changed).toHaveBeenCalledTimes(1)
    fire({ key: null })
    expect(changed).toHaveBeenCalledTimes(2)
    off()
    expect(handlers.size).toBe(0)
    fire({ key: 'pixelsky.git.diffMode' })
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('收到事件后读到的就是新值（git 对比方式：JSON；自动换行：true / false）', () => {
    stub()
    store.set('pixelsky.git.diffMode', JSON.stringify('inline'))
    store.set('pixelsky.editor.wrap', 'false')
    let diff = readStoredJson<'split' | 'inline'>('pixelsky.git.diffMode', 'inline')
    let wrap = readStoredFlag('pixelsky.editor.wrap')
    onStoredChange('pixelsky.git.diffMode', () => (diff = readStoredJson('pixelsky.git.diffMode', 'inline')))
    onStoredChange('pixelsky.editor.wrap', () => (wrap = readStoredFlag('pixelsky.editor.wrap')))
    expect([diff, wrap]).toEqual(['inline', false])
    store.set('pixelsky.git.diffMode', JSON.stringify('split'))
    fire({ key: 'pixelsky.git.diffMode' })
    store.set('pixelsky.editor.wrap', 'true')
    fire({ key: 'pixelsky.editor.wrap' })
    expect([diff, wrap]).toEqual(['split', true])
    // 云同步把它删了：回到默认
    store.delete('pixelsky.git.diffMode')
    fire({ key: 'pixelsky.git.diffMode' })
    expect(diff).toBe('inline')
  })

  it('没有 window（node 里）时什么都不做', () => {
    expect(onStoredChange('k', () => undefined)()).toBeUndefined()
  })
})

describe('readStoredJson / readStoredFlag', () => {
  it('没有、坏 JSON、存储不可用都用默认值', () => {
    stub()
    expect(readStoredJson('a', 7)).toBe(7)
    store.set('a', '{坏')
    expect(readStoredJson('a', 7)).toBe(7)
    expect(readStoredFlag('b')).toBe(false)
    expect(readStoredFlag('b', true)).toBe(true)
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
    })
    expect(readStoredJson('a', 7)).toBe(7)
    expect(readStoredFlag('b', true)).toBe(true)
  })
})

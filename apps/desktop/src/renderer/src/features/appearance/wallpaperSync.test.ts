import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 壁纸：另一个窗口（设置独立窗口）换图、改透明度 / 模糊、去掉壁纸，这个窗口收到 storage 事件后
// 重读设置、必要时重读 IndexedDB 里的图片，并重新套到 <html> 上（data-wallpaper）。

const KEY = 'pixelsky.wallpaper'
const store = new Map<string, string>()
const area = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
}
let root: { dataset: Record<string, string | undefined> }
let setTheme: ReturnType<typeof vi.fn>
let handler: (e: unknown) => void
/** 假的 IndexedDB：files 表里只有一个文件 */
let blob: Blob | undefined
const revoked: string[] = []

function fakeIndexedDb() {
  return {
    open: () => {
      const req: Record<string, unknown> = {}
      queueMicrotask(() => {
        const get = { result: blob }
        const tx: Record<string, unknown> = {
          objectStore: () => ({ get: () => get, put: () => undefined, delete: () => undefined }),
        }
        req.result = { transaction: () => tx, close: () => undefined, createObjectStore: () => undefined }
        ;(req.onsuccess as () => void)()
        queueMicrotask(() => (tx.oncomplete as () => void)())
      })
      return req
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  store.clear()
  revoked.length = 0
  blob = undefined
  root = { dataset: {} }
  setTheme = vi.fn()
  vi.stubGlobal('localStorage', area)
  vi.stubGlobal('document', { documentElement: root })
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }))
  vi.stubGlobal('indexedDB', fakeIndexedDb())
  vi.stubGlobal('window', {
    pixelsky: { setTheme },
    addEventListener: (_: string, fn: (e: unknown) => void) => (handler = fn),
  })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(b => `blob:${(b as Blob).size}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(u => void revoked.push(u))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const event = { key: KEY, storageArea: area }

describe('planWallpaperSync', () => {
  it('按差别决定怎么同步', async () => {
    const { planWallpaperSync } = await import('./wallpaper')
    const base = { name: 'a.png', kind: 'image' as const, show: 0.45, blur: 0, stamp: 1 }
    expect(planWallpaperSync(base, base)).toBe('none')
    expect(planWallpaperSync({ ...base, show: 0.6 }, base)).toBe('prefs')
    expect(planWallpaperSync({ ...base, blur: 8 }, base)).toBe('prefs')
    expect(planWallpaperSync({ ...base, name: 'b.png' }, base)).toBe('reload')
    expect(planWallpaperSync({ ...base, kind: 'video' }, base)).toBe('reload')
    // 同一个文件名换了内容：靠选图时间区分
    expect(planWallpaperSync({ ...base, stamp: 2 }, base)).toBe('reload')
    expect(planWallpaperSync({ ...base, name: '' }, base)).toBe('clear')
    expect(planWallpaperSync({ ...base, name: '', show: 0.7 }, { ...base, name: '' })).toBe('prefs')
  })
})

describe('onWallpaperStorage', () => {
  it('模块加载时挂上 storage 监听', async () => {
    await import('./wallpaper')
    expect(handler).toBeTypeOf('function')
  })

  it('别的键、别的存储区：不理', async () => {
    const wp = await import('./wallpaper')
    store.set(KEY, JSON.stringify({ name: '', kind: 'image', show: 0.8, blur: 3 }))
    handler({ key: 'other', storageArea: area })
    handler({ key: KEY, storageArea: {} })
    expect(wp.getWallpaper()).toMatchObject({ show: 0.45, blur: 0 })
    expect(setTheme).not.toHaveBeenCalled()
  })

  it('透明度、模糊变了：更新状态并重新套到 <html>，不动图片', async () => {
    store.set(KEY, JSON.stringify({ name: 'a.png', kind: 'image', show: 0.45, blur: 0, stamp: 1 }))
    blob = new Blob(['x'])
    const wp = await import('./wallpaper')
    await vi.waitFor(() => expect(wp.getWallpaper().url).toBe('blob:1'))
    setTheme.mockClear()
    store.set(KEY, JSON.stringify({ name: 'a.png', kind: 'image', show: 0.7, blur: 6, stamp: 1 }))
    handler(event)
    expect(wp.getWallpaper()).toMatchObject({ show: 0.7, blur: 6, url: 'blob:1' })
    expect(root.dataset.wallpaper).toBe('image')
    expect(setTheme).toHaveBeenCalledTimes(1)
  })

  it('另一个窗口换了图片：从 IndexedDB 重读，换上新地址、释放旧地址', async () => {
    store.set(KEY, JSON.stringify({ name: 'a.png', kind: 'image', show: 0.45, blur: 0, stamp: 1 }))
    blob = new Blob(['x'])
    const wp = await import('./wallpaper')
    await vi.waitFor(() => expect(wp.getWallpaper().url).toBe('blob:1'))
    blob = new Blob(['yyy'])
    store.set(KEY, JSON.stringify({ name: 'b.mp4', kind: 'video', show: 0.45, blur: 0, stamp: 2 }))
    handler(event)
    await vi.waitFor(() => expect(wp.getWallpaper().url).toBe('blob:3'))
    expect(wp.getWallpaper()).toMatchObject({ name: 'b.mp4', kind: 'video' })
    expect(root.dataset.wallpaper).toBe('video')
    expect(revoked).toEqual(['blob:1'])
  })

  it('另一个窗口去掉了壁纸：清掉图片、去掉 <html> 上的标记', async () => {
    store.set(KEY, JSON.stringify({ name: 'a.png', kind: 'image', show: 0.45, blur: 0, stamp: 1 }))
    blob = new Blob(['x'])
    const wp = await import('./wallpaper')
    await vi.waitFor(() => expect(wp.getWallpaper().url).toBe('blob:1'))
    store.set(KEY, JSON.stringify({ name: '', kind: 'image', show: 0.45, blur: 0 }))
    handler(event)
    expect(wp.getWallpaper()).toMatchObject({ name: '', url: null })
    expect(root.dataset.wallpaper).toBeUndefined()
    expect(setTheme).toHaveBeenLastCalledWith('light', false, undefined)
    expect(revoked).toEqual(['blob:1'])
  })

  it('同步过来的改动不会再写回 localStorage（免得两个窗口来回通知）', async () => {
    store.set(KEY, JSON.stringify({ name: '', kind: 'image', show: 0.45, blur: 0 }))
    const wp = await import('./wallpaper')
    const before = store.get(KEY)
    const set = vi.spyOn(area, 'setItem')
    store.set(KEY, JSON.stringify({ name: '', kind: 'image', show: 0.8, blur: 3 }))
    handler(event)
    expect(wp.getWallpaper()).toMatchObject({ show: 0.8, blur: 3 })
    expect(set).not.toHaveBeenCalled()
    expect(before).not.toBe(store.get(KEY))
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSettings } from '../../../../../shared/types/settings-sync'

// 两台电脑共用一个假云端（docs/ui/settings-sync.md §6 S2）：每台电脑一份 localStorage、一份同步模块

// 每台电脑一个类：同步模块会包一层 Storage.prototype 的 setItem，两台不能共用
const storageClass = () =>
  class FakeStorage {
    private map = new Map<string, string>()
    getItem(k: string): string | null {
      return this.map.has(k) ? this.map.get(k)! : null
    }
    setItem(k: string, v: string): void {
      this.map.set(k, String(v))
    }
    removeItem(k: string): void {
      this.map.delete(k)
    }
  }
class FakeStorageEvent {
  constructor(
    public type: string,
    init: Record<string, unknown>,
  ) {
    Object.assign(this, init)
  }
}

function fakeCloud() {
  const settings: CloudSettings = {}
  let clock = 1000
  return {
    settings,
    pull: async () => ({ account: 'alice@example.com', settings: structuredClone(settings) }),
    push: async (changes: Record<string, unknown>) => {
      clock++
      for (const [k, v] of Object.entries(changes)) {
        if (v === null) delete settings[k]
        else settings[k] = { value: v, updatedAt: clock }
      }
      return { account: 'alice@example.com', settings: structuredClone(settings) }
    },
  }
}

async function computer(cloud: ReturnType<typeof fakeCloud>, preset: Record<string, string>) {
  const FakeStorage = storageClass()
  const storage = new FakeStorage()
  for (const [k, v] of Object.entries(preset)) storage.setItem(k, v)
  const activate = () => {
    vi.stubGlobal('Storage', FakeStorage)
    vi.stubGlobal('StorageEvent', FakeStorageEvent)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('window', {
      addEventListener() {},
      dispatchEvent() {},
      pixelsky: {
        demo: false,
        settingsSync: { pull: cloud.pull, push: cloud.push, engine: async () => null, applyEngine: async () => null },
        account: {
          getState: async () => ({ status: 'signed-in', account: { email: 'alice@example.com' } }),
          onChange: () => () => {},
        },
        engine: { onEvent: () => () => {} },
        editor: { state: async () => ({ window: 'reuse' }), preferences: async () => ({}) },
      },
    })
  }
  activate()
  vi.resetModules()
  const sync = await import('./engine')
  sync.startSettingsSync()
  // 定时器是假的：启动后的自动同步不会自己跑，下面都显式 run()；只等账号状态回来
  for (let i = 0; i < 5; i++) await Promise.resolve()
  const run = async () => {
    activate()
    await sync.syncNow()
  }
  return { storage, sync, run, activate }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('两台电脑之间同步设置', () => {
  it('第一台上传、第二台恢复并能撤销，之后改动互相带过去；勿扰到某时不同步', async () => {
    const cloud = fakeCloud()
    const a = await computer(cloud, {
      'pixelsky.theme': 'dark',
      'pixelsky.notifications.v1': JSON.stringify({ enabled: true, dndUntil: 999 }),
      'pixelsky.window-size': 'local-only',
    })
    await a.run()
    expect(cloud.settings['desktop.theme']?.value).toBe('dark')
    expect(JSON.parse(cloud.settings['desktop.notifications']!.value as string)).toEqual({
      enabled: true,
      dndUntil: null,
    })
    // 不在白名单里的不传
    expect(Object.keys(cloud.settings).every(k => k.startsWith('desktop.'))).toBe(true)
    expect(JSON.stringify(cloud.settings)).not.toContain('local-only')

    const b = await computer(cloud, {
      'pixelsky.theme': 'light',
      'pixelsky.notifications.v1': JSON.stringify({ enabled: false, dndUntil: 555 }),
    })
    await b.run()
    expect(b.storage.getItem('pixelsky.theme')).toBe('dark')
    // 勿扰到某时保留本机的
    expect(JSON.parse(b.storage.getItem('pixelsky.notifications.v1')!)).toEqual({ enabled: true, dndUntil: 555 })
    // 撤销第一次恢复：写回同步前本机的值并上传
    b.activate()
    await b.sync.undoRestore()
    expect(b.storage.getItem('pixelsky.theme')).toBe('light')
    expect(cloud.settings['desktop.theme']?.value).toBe('light')

    // 第一台下次同步时跟着变
    await a.run()
    expect(a.storage.getItem('pixelsky.theme')).toBe('light')

    // 第一台改了强调色，第二台下次拉取时跟着变；恢复默认（删掉本机的值）也会带过去
    a.storage.setItem('pixelsky.accent', 'rose')
    await a.run()
    await b.run()
    expect(b.storage.getItem('pixelsky.accent')).toBe('rose')
    a.storage.removeItem('pixelsky.accent')
    await a.run()
    expect(cloud.settings['desktop.accent']).toBeUndefined()
    await b.run()
    expect(b.storage.getItem('pixelsky.accent')).toBeNull()
  })

  it('关掉某个分类后既不上传也不接收', async () => {
    const cloud = fakeCloud()
    const a = await computer(cloud, {
      'pixelsky.theme': 'dark',
      'pixelsky.keybindings': '{"x":1}',
      'pixelsky.settings-sync': JSON.stringify({ enabled: true, off: ['appearance'] }),
    })
    await a.run()
    expect(cloud.settings['desktop.theme']).toBeUndefined()
    expect(cloud.settings['desktop.keybindings']?.value).toBe('{"x":1}')
  })
})

describe('在别的窗口里开启同步', () => {
  it('负责同步的窗口收到「开启」后马上同步一次，不等下一次定时拉取', async () => {
    const cloud = fakeCloud()
    const FakeStorage = storageClass()
    const storage = new FakeStorage()
    storage.setItem('pixelsky.theme', 'dark')
    storage.setItem('pixelsky.settings-sync', JSON.stringify({ enabled: false, off: [] }))
    const listeners: Record<string, ((e: unknown) => void)[]> = {}
    vi.stubGlobal('Storage', FakeStorage)
    vi.stubGlobal('StorageEvent', FakeStorageEvent)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('window', {
      addEventListener(type: string, fn: (e: unknown) => void) {
        ;(listeners[type] ??= []).push(fn)
      },
      dispatchEvent() {},
      pixelsky: {
        demo: false,
        settingsSync: { pull: cloud.pull, push: cloud.push, engine: async () => null, applyEngine: async () => null },
        account: {
          getState: async () => ({ status: 'signed-in', account: { email: 'alice@example.com' } }),
          onChange: () => () => {},
        },
        engine: { onEvent: () => () => {} },
        editor: { state: async () => ({ window: 'reuse' }), preferences: async () => ({}) },
      },
    })
    vi.resetModules()
    const sync = await import('./engine')
    sync.startSettingsSync()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    // 启动时的那次：同步关着，什么都不传
    await vi.advanceTimersByTimeAsync(10)
    expect(cloud.settings['desktop.theme']).toBeUndefined()

    // 另一个窗口把同步打开了：这个窗口只收到 storage 事件
    storage.setItem('pixelsky.settings-sync', JSON.stringify({ enabled: true, off: [] }))
    for (const fn of listeners.storage ?? [])
      fn(new FakeStorageEvent('storage', { key: 'pixelsky.settings-sync', storageArea: storage, isTrusted: true }))
    await vi.waitFor(() => expect(cloud.settings['desktop.theme']?.value).toBe('dark'))
  })
})

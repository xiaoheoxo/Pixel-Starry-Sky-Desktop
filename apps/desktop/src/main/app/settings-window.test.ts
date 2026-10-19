import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppContext } from './context'

// 设置独立窗口的控制器：只开一个、再次打开是提到前面并跳转、置顶用 parent、收回、跟着主窗口关、记住偏好。
// electron 和 IPC 注册换成假的，窗口只记录调用。

const handlers = new Map<string, (...args: never[]) => unknown>()
const sends: Array<{ target: string; channel: string; args: unknown[] }> = []
const store: Record<string, unknown> = {}

class FakeWindow {
  static all: FakeWindow[] = []
  listeners = new Map<string, Array<() => void>>()
  destroyed = false
  minimized = false
  parent: FakeWindow | null
  webContents: { name: string }
  calls: string[] = []
  constructor(public options: Record<string, unknown>) {
    this.parent = (options.parent as FakeWindow | undefined) ?? null
    this.webContents = { name: `win${FakeWindow.all.length}` }
    FakeWindow.all.push(this)
  }
  on(event: string, fn: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn])
    return this
  }
  once(event: string, fn: () => void): this {
    return this.on(event, fn)
  }
  emit(event: string): void {
    for (const fn of this.listeners.get(event) ?? []) fn()
  }
  isDestroyed = () => this.destroyed
  isMinimized = () => this.minimized
  isFullScreen = () => false
  restore = () => void (this.minimized = false)
  show = () => void this.calls.push('show')
  focus = () => void this.calls.push('focus')
  getBounds = () => ({ x: 100, y: 80, width: 1000, height: 800 })
  getNormalBounds = () => ({ x: 120, y: 90, width: 900, height: 650 })
  getBackgroundColor = () => '#1F1F1E'
  setParentWindow = (p: FakeWindow | null) => void (this.parent = p)
  close(): void {
    this.emit('close')
    this.destroyed = true
    this.emit('closed')
  }
  static fromWebContents(wc: { name: string }): FakeWindow | undefined {
    return FakeWindow.all.find(w => w.webContents === wc)
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => 'ud' },
  BrowserWindow: FakeWindow,
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  },
}))
vi.mock('../ipc/guard', () => ({
  handle: (channel: string, fn: (...args: never[]) => unknown) => void handlers.set(channel, fn),
  on: (channel: string, fn: (...args: never[]) => unknown) => void handlers.set(channel, fn),
}))
vi.mock('./rendererHealth', () => ({
  sendTo: (wc: { name: string }, channel: string, ...args: unknown[]) => sends.push({ target: wc.name, channel, args }),
  sendWhenReady: (wc: { name: string }, channel: string, ...args: unknown[]) =>
    sends.push({ target: wc.name, channel, args }),
}))
vi.mock('./windowFile', () => ({
  readWindowFile: () => ({ ...store }),
  mergeWindowFile: (_file: string, patch: Record<string, unknown>) => void Object.assign(store, patch),
}))
vi.mock('./ui-language', () => ({ windowLocale: () => 'zh-CN' }))

const { initSettingsWindow } = await import('./settings-window')
const { isSettingsWindow } = await import('./settingsWindowRegistry')

const broadcast = vi.fn()
const setup = vi.fn()
const load = vi.fn(() => Promise.resolve())
const options = vi.fn(() => ({ title: '像素星空' }))
const ctx = { events: { broadcast } } as unknown as AppContext

function start() {
  const controller = initSettingsWindow(ctx, { options, setup, load })
  const main = new FakeWindow({}) as unknown as import('electron').BrowserWindow
  controller.attachMain(main)
  return { controller, main: main as unknown as FakeWindow }
}
const settingsWindows = () => FakeWindow.all.filter(w => w.options.minWidth === 720)
const sentTo = (target: string, channel: string) => sends.filter(s => s.target === target && s.channel === channel)

beforeEach(() => {
  FakeWindow.all = []
  handlers.clear()
  sends.length = 0
  for (const key of Object.keys(store)) delete store[key]
  broadcast.mockClear()
  setup.mockClear()
  load.mockClear()
})

describe('只开一个', () => {
  it('第一次打开建窗口：同一个页面、带上要跳到哪、最小尺寸 720×520、登记为设置窗口', () => {
    const { controller } = start()
    controller.open({ section: 'models', row: '额度按钮设置' })
    const [win] = settingsWindows()
    expect(settingsWindows()).toHaveLength(1)
    expect(win.options).toMatchObject({ minWidth: 720, minHeight: 520, show: false, title: '设置 · 像素星空' })
    expect(isSettingsWindow(win as never)).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    const query = (load.mock.calls[0] as unknown[])[1] as Record<string, string>
    expect(query.view).toBe('settings')
    expect(JSON.parse(query.target)).toEqual({ section: 'models', row: '额度按钮设置' })
    expect(setup).toHaveBeenCalledWith(win, { view: 'settings' })
    expect(controller.state().open).toBe(true)
  })

  it('已经开着：不再建，提到前面并通知它跳转（含恢复最小化）', () => {
    const { controller } = start()
    controller.open({ section: 'appearance' })
    const [win] = settingsWindows()
    win.minimized = true
    controller.open({ section: 'usage', row: '用量图表' })
    expect(settingsWindows()).toHaveLength(1)
    expect(win.minimized).toBe(false)
    expect(win.calls).toEqual(expect.arrayContaining(['show', 'focus']))
    expect(sentTo(win.webContents.name, 'settingsWindow:navigate')).toEqual([
      expect.objectContaining({ args: [{ section: 'usage', row: '用量图表' }] }),
    ])
  })

  it('关掉之后再打开会重新建一个', () => {
    const { controller } = start()
    controller.open()
    controller.close()
    expect(controller.state().open).toBe(false)
    controller.open()
    expect(settingsWindows()).toHaveLength(2)
  })
})

describe('第一次的位置和上次的位置', () => {
  it('没存过：放在主窗口右边（顶端对齐）', () => {
    const { controller } = start()
    controller.open()
    expect(settingsWindows()[0].options).toMatchObject({ x: 960, y: 80, width: 960, height: 700 })
  })
  it('存过：用存的位置；移动后防抖保存，关闭时同步存还原后的位置', () => {
    store.bounds = { x: 300, y: 200, width: 900, height: 640 }
    const { controller } = start()
    controller.open()
    const win = settingsWindows()[0]
    expect(win.options).toMatchObject({ x: 300, y: 200, width: 900, height: 640 })
    win.close()
    expect(store.bounds).toEqual({ x: 120, y: 90, width: 900, height: 650 })
  })
})

describe('置顶：主窗口的子窗口', () => {
  it('默认置顶：建窗口时 parent 是主窗口、底色沿用主窗口', () => {
    const { controller, main } = start()
    controller.open()
    const win = settingsWindows()[0]
    expect(win.options.parent).toBe(main)
    expect(win.options.backgroundColor).toBe('#1F1F1E')
    expect(controller.state().pinned).toBe(true)
  })
  it('关掉置顶：去掉 parent、记住；再开：加回 parent', async () => {
    const { controller, main } = start()
    controller.open()
    const win = settingsWindows()[0]
    const setPinned = handlers.get('settingsWindow:setPinned')!
    const event = { sender: win.webContents } as never
    await setPinned(event, false as never)
    expect(win.parent).toBeNull()
    expect(store.pinned).toBe(false)
    expect(controller.state().pinned).toBe(false)
    await setPinned(event, true as never)
    expect(win.parent).toBe(main)
    expect(broadcast).toHaveBeenLastCalledWith('settingsWindow:changed', expect.objectContaining({ pinned: true }))
  })
  it('不置顶存过：下次开的窗口没有 parent', () => {
    store.pinned = false
    const { controller } = start()
    controller.open()
    expect(settingsWindows()[0].options.parent).toBeUndefined()
  })
  it('只有设置窗口能改置顶，参数必须是布尔值', async () => {
    const { controller, main } = start()
    controller.open()
    const win = settingsWindows()[0]
    const setPinned = handlers.get('settingsWindow:setPinned')!
    expect(() => setPinned({ sender: main.webContents } as never, false as never)).toThrow()
    expect(() => setPinned({ sender: win.webContents } as never, 'no' as never)).toThrow()
  })
})

describe('记住打开方式、收回', () => {
  it('打开就记住「下次用窗口」；收回改回浮层、关窗口、让主窗口打开浮层并停在同一分区', () => {
    const { controller, main } = start()
    expect(controller.state().preferWindow).toBe(false)
    controller.open({ section: 'terminal' })
    expect(controller.state().preferWindow).toBe(true)
    expect(store.preferWindow).toBe(true)
    const win = settingsWindows()[0]
    controller.dock('terminal')
    expect(win.destroyed).toBe(true)
    expect(controller.state()).toMatchObject({ open: false, preferWindow: false })
    expect(store.preferWindow).toBe(false)
    expect(sentTo(main.webContents.name, 'settings:openDialog')).toEqual([
      expect.objectContaining({ args: [{ section: 'terminal' }] }),
    ])
  })
  it('记住的方式重启后还在', () => {
    store.preferWindow = true
    const { controller } = start()
    expect(controller.state().preferWindow).toBe(true)
  })
})

describe('跟着主窗口', () => {
  it('主窗口隐藏到托盘：设置窗口关掉', () => {
    const { controller, main } = start()
    controller.open()
    const win = settingsWindows()[0]
    main.emit('hide')
    expect(win.destroyed).toBe(true)
  })
  it('主窗口关闭：设置窗口关掉（主窗口已经销毁了也不抛错）', () => {
    const { controller, main } = start()
    controller.open()
    const win = settingsWindows()[0]
    win.destroyed = true
    main.destroyed = true
    expect(() => main.emit('closed')).not.toThrow()
    expect(controller.state().open).toBe(false)
  })
  it('没有主窗口（已关）时打开：没有 parent', () => {
    const { controller, main } = start()
    main.destroyed = true
    main.emit('closed')
    controller.open()
    expect(settingsWindows()[0].options.parent).toBeUndefined()
  })
})

describe('请主窗口做事', () => {
  it('只有设置窗口能调；参数检查通过后主窗口被提到前面，再转成 mainWindow:action', async () => {
    const { controller, main } = start()
    controller.open()
    const win = settingsWindows()[0]
    const run = handlers.get('mainWindow:run')!
    expect(() => run({ sender: main.webContents } as never, { kind: 'manageMachines' } as never)).toThrow()
    expect(() => run({ sender: win.webContents } as never, { kind: 'rm' } as never)).toThrow()
    await run({ sender: win.webContents } as never, { kind: 'openSession', sessionId: 's1' } as never)
    expect(main.calls).toEqual(expect.arrayContaining(['show', 'focus']))
    expect(sentTo(main.webContents.name, 'mainWindow:action')).toEqual([
      expect.objectContaining({ args: [{ kind: 'openSession', sessionId: 's1' }] }),
    ])
  })
})

describe('主窗口的工作区转给设置窗口', () => {
  it('变了才转；设置窗口开着时才推；state 带着它', () => {
    const { controller, main } = start()
    const report = handlers.get('settingsWindow:reportWorkspace')!
    const ws = { ref: { projectId: 'p1' }, name: 'P', path: 'D:/p', key: 'k' }
    report({ sender: main.webContents } as never, ws as never)
    expect(controller.state().workspace).toEqual(ws)
    expect(sends.filter(s => s.channel === 'settingsWindow:changed')).toHaveLength(0)
    controller.open()
    const win = settingsWindows()[0]
    report({ sender: main.webContents } as never, { ...ws, name: 'Q' } as never)
    report({ sender: main.webContents } as never, { ...ws, name: 'Q' } as never)
    expect(sentTo(win.webContents.name, 'settingsWindow:changed')).toHaveLength(1)
    // 设置窗口自己报的不收
    report({ sender: win.webContents } as never, { ...ws, name: 'Z' } as never)
    expect(controller.state().workspace?.name).toBe('Q')
  })
})

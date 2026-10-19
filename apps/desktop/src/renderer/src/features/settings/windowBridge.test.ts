import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsWindowState } from '../../../../shared/types/settings-window'

// 设置独立窗口在界面这一侧：打开方式的选择、带去窗口的请求、请主窗口做事。
// window / location 换成假的；每个用例重新加载模块（模块里记着页面类型和主进程推来的状态）。

const STATE: SettingsWindowState = { open: false, pinned: true, preferWindow: false, workspace: null }

interface Env {
  bridge: {
    open: ReturnType<typeof vi.fn>
    state: ReturnType<typeof vi.fn>
    runInMain: ReturnType<typeof vi.fn>
    onChange: ReturnType<typeof vi.fn>
  }
  push(state: SettingsWindowState): void
  dispatched: Event[]
}

function env(opts: { search?: string; state?: SettingsWindowState; openFails?: boolean } = {}): Env {
  let push: (s: SettingsWindowState) => void = () => undefined
  const bridge = {
    open: vi.fn(() => (opts.openFails ? Promise.reject(new Error('boom')) : Promise.resolve())),
    state: vi.fn(() => Promise.resolve(opts.state ?? STATE)),
    runInMain: vi.fn(() => Promise.resolve()),
    onChange: vi.fn((cb: (s: SettingsWindowState) => void) => {
      push = cb
      return () => undefined
    }),
  }
  const dispatched: Event[] = []
  vi.stubGlobal('location', { search: opts.search ?? '' })
  vi.stubGlobal('window', { pixelsky: { settingsWindow: bridge }, dispatchEvent: (e: Event) => dispatched.push(e) })
  vi.stubGlobal(
    'CustomEvent',
    class {
      constructor(
        public type: string,
        init: { detail?: unknown } = {},
      ) {
        this.detail = init.detail
      }
      detail: unknown
    },
  )
  return { bridge, push: s => push(s), dispatched }
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('主窗口里 openSettings 选浮层还是窗口', () => {
  it('没记过窗口：开浮层，不碰主进程', async () => {
    const { bridge } = env()
    const m = await import('./windowBridge')
    m.startSettingsWindowSync()
    await Promise.resolve()
    const openDialog = vi.fn()
    m.openSettingsRouted('models', openDialog)
    expect(openDialog).toHaveBeenCalledWith('models')
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('主进程记着上次用窗口：交给主进程开，浮层不弹；section 原样传过去', async () => {
    const { bridge } = env({ state: { ...STATE, preferWindow: true } })
    const m = await import('./windowBridge')
    m.startSettingsWindowSync()
    await vi.waitFor(() => expect(m.getSettingsWindowState().preferWindow).toBe(true))
    const openDialog = vi.fn()
    m.openSettingsRouted('usage', openDialog)
    expect(bridge.open).toHaveBeenCalledWith('usage', undefined, undefined)
    expect(openDialog).not.toHaveBeenCalled()
  })

  it('点了「收回」后主进程推来 preferWindow=false：又开浮层', async () => {
    const { push } = env({ state: { ...STATE, preferWindow: true } })
    const m = await import('./windowBridge')
    m.startSettingsWindowSync()
    await vi.waitFor(() => expect(m.shouldOpenInWindow()).toBe(true))
    push({ ...STATE, preferWindow: false })
    const openDialog = vi.fn()
    m.openSettingsRouted(undefined, openDialog)
    expect(openDialog).toHaveBeenCalledTimes(1)
  })

  it('主进程没接住（窗口建不起来）：退回浮层', async () => {
    env({ state: { ...STATE, preferWindow: true }, openFails: true })
    const m = await import('./windowBridge')
    m.startSettingsWindowSync()
    await vi.waitFor(() => expect(m.shouldOpenInWindow()).toBe(true))
    const openDialog = vi.fn()
    m.openSettingsRouted('terminal', openDialog)
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalledWith('terminal'))
  })

  it('设置窗口自己里面不再开窗口', async () => {
    env({ search: '?view=settings', state: { ...STATE, preferWindow: true } })
    const m = await import('./windowBridge')
    expect(m.isSettingsWindowView).toBe(true)
    m.startSettingsWindowSync()
    await vi.waitFor(() => expect(m.getSettingsWindowState().preferWindow).toBe(true))
    expect(m.shouldOpenInWindow()).toBe(false)
  })

  it('没有主进程那一侧（演示 / 网页）：开浮层', async () => {
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('window', {})
    const m = await import('./windowBridge')
    m.startSettingsWindowSync()
    expect(m.shouldOpenInWindow()).toBe(false)
  })
})

describe('带去设置窗口的请求', () => {
  it('要高亮的那一行和先记下的请求一起带走，只带一次', async () => {
    const { bridge } = env()
    const jump = await import('./settingsJump')
    const scroll = await import('./models/scroll')
    const m = await import('./windowBridge')
    jump.requestSettingsRow('额度按钮设置')
    scroll.requestModelsScroll()
    await m.openInSettingsWindow('models')
    expect(bridge.open).toHaveBeenLastCalledWith('models', '额度按钮设置', { modelsScroll: true })
    await m.openInSettingsWindow('models')
    expect(bridge.open).toHaveBeenLastCalledWith('models', undefined, undefined)
  })
})

describe('请主窗口做事', () => {
  it('设置窗口里：转给主进程', async () => {
    const { bridge, dispatched } = env({ search: '?view=settings' })
    const m = await import('./windowBridge')
    m.runMainAction({ kind: 'openSession', sessionId: 's1' })
    expect(bridge.runInMain).toHaveBeenCalledWith({ kind: 'openSession', sessionId: 's1' })
    expect(dispatched).toHaveLength(0)
  })
  it('浮层里（主窗口自己）：发窗口事件，由主窗口里的执行处接', async () => {
    const { bridge, dispatched } = env()
    const m = await import('./windowBridge')
    m.runMainAction({ kind: 'manageMachines' })
    expect(bridge.runInMain).not.toHaveBeenCalled()
    expect(dispatched).toHaveLength(1)
    expect((dispatched[0] as unknown as { type: string; detail: unknown }).type).toBe(m.MAIN_ACTION_EVENT)
    expect((dispatched[0] as unknown as { detail: unknown }).detail).toEqual({ kind: 'manageMachines' })
  })
})

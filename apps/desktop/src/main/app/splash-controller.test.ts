import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  centerIn,
  createSplashController,
  splashPage,
  splashTheme,
  type SplashDeps,
  type SplashWindow,
} from './splash-controller'

/** 手动推进的时钟 + 定时器 */
function clock() {
  let now = 0
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true }
      timers.push(t)
      return () => {
        t.live = false
      }
    },
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const next = timers.filter(t => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        now = next.at
        next.live = false
        next.fn()
      }
      now = end
    },
  }
}

function fakeWindow() {
  let ready: (() => void) | null = null
  let destroyed = false
  const win = {
    shown: false,
    faded: false,
    onReady: (fn: () => void) => {
      ready = fn
    },
    show: () => {
      win.shown = true
    },
    fadeOut: async () => {
      win.faded = true
    },
    destroy: () => {
      destroyed = true
    },
    isDestroyed: () => destroyed,
    paint: () => ready?.(),
  }
  return win
}

function setup(over: Partial<SplashDeps> = {}) {
  const c = clock()
  const windows: ReturnType<typeof fakeWindow>[] = []
  const log = vi.fn()
  const controller = createSplashController({
    open: () => {
      const w = fakeWindow()
      windows.push(w)
      return w as SplashWindow
    },
    now: c.now,
    setTimer: c.setTimer,
    log,
    delayMs: 1000,
    minMs: 600,
    maxMs: 20_000,
    ...over,
  })
  return { c, windows, log, controller }
}

describe('开机画面：只在启动慢时弹', () => {
  it('主窗口 1 秒内画好：不建窗口，直接显示主窗口', () => {
    const { c, windows, controller } = setup()
    c.advance(450)
    const show = vi.fn()
    controller.handOff(show)
    expect(show).toHaveBeenCalledOnce()
    c.advance(5000)
    expect(windows).toHaveLength(0)
  })

  it('超过 1 秒才建窗口；页面画好才显示', () => {
    const { c, windows } = setup()
    c.advance(999)
    expect(windows).toHaveLength(0)
    c.advance(1)
    expect(windows).toHaveLength(1)
    expect(windows[0].shown).toBe(false)
    windows[0].paint()
    expect(windows[0].shown).toBe(true)
  })

  it('页面还没画好主窗口就好了：关掉开机画面、立即显示主窗口，不再弹', () => {
    const { c, windows, controller } = setup()
    c.advance(1100)
    const show = vi.fn()
    controller.handOff(show)
    expect(show).toHaveBeenCalledOnce()
    expect(windows[0].isDestroyed()).toBe(true)
    windows[0].paint()
    expect(windows[0].shown).toBe(false)
  })

  it('弹出来至少停 600ms：主窗口早好了也等到那时再显示，然后开机画面淡出关掉', async () => {
    const { c, windows, controller, log } = setup()
    c.advance(1000)
    windows[0].paint() // 1000ms 显示
    c.advance(100)
    const show = vi.fn()
    controller.handOff(show)
    expect(show).not.toHaveBeenCalled()
    c.advance(499)
    expect(show).not.toHaveBeenCalled()
    c.advance(1)
    expect(show).toHaveBeenCalledOnce()
    expect(windows[0].faded).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(windows[0].isDestroyed()).toBe(true)
    expect(log).toHaveBeenCalledWith('启动慢，显示开机画面', { afterMs: 1000 })
    expect(log).toHaveBeenCalledWith('开机画面结束', { shownMs: 600, totalMs: 1600 })
  })

  it('显示够久了：主窗口一好就显示', () => {
    const { c, windows, controller } = setup()
    c.advance(1000)
    windows[0].paint()
    c.advance(3000)
    const show = vi.fn()
    controller.handOff(show)
    c.advance(0)
    expect(show).toHaveBeenCalledOnce()
  })

  it('主窗口一直没画好：20 秒后关掉开机画面', () => {
    const { c, windows, log } = setup()
    c.advance(1000)
    windows[0].paint()
    c.advance(20_000)
    expect(windows[0].isDestroyed()).toBe(true)
    expect(log).toHaveBeenCalledWith('主窗口一直没画好，关掉开机画面', { afterMs: 21_000 })
  })

  it('退出时收掉：没弹的不再弹，弹着的关掉，等着显示的主窗口也不再显示', () => {
    const a = setup()
    a.controller.dispose()
    a.c.advance(5000)
    expect(a.windows).toHaveLength(0)

    const b = setup()
    b.c.advance(1000)
    b.windows[0].paint()
    const show = vi.fn()
    b.controller.handOff(show)
    b.controller.dispose()
    b.c.advance(1000)
    expect(show).not.toHaveBeenCalled()
    expect(b.windows[0].isDestroyed()).toBe(true)
  })

  it('之后再建的窗口（托盘重新打开）直接显示', () => {
    const { c, controller } = setup()
    c.advance(300)
    controller.handOff(vi.fn())
    const again = vi.fn()
    controller.handOff(again)
    expect(again).toHaveBeenCalledOnce()
  })

  it('建窗口失败：当作没弹', () => {
    const { c, controller } = setup({
      open: () => {
        throw new Error('no display')
      },
    })
    c.advance(1500)
    const show = vi.fn()
    controller.handOff(show)
    expect(show).toHaveBeenCalledOnce()
  })
})

describe('开机画面的主题', () => {
  it('没记过：跟系统', () => {
    expect(splashTheme(undefined, true)).toBe('dark')
    expect(splashTheme({ theme: 'nope' }, false)).toBe('light')
  })
  it('上次和系统一样（多半是跟随系统）：按现在的系统主题', () => {
    expect(splashTheme({ theme: 'dark', system: 'dark' }, false)).toBe('light')
  })
  it('上次和系统不一样（用户自己选的）：用上次的', () => {
    expect(splashTheme({ theme: 'light', system: 'dark' }, true)).toBe('light')
  })
})

describe('页面和位置', () => {
  it('参数插在 <head> 最前面', () => {
    const page = splashPage('<html><head><title>x</title></head></html>', { embed: '1', theme: 'light' })
    expect(page).toContain('<head><script>window.PIXELSKY_SPLASH_QUERY = "embed=1&theme=light"</script><title>')
  })
  it('真正的页面读这个参数', () => {
    const html = readFileSync(new URL('./splash.html', import.meta.url), 'utf8')
    expect(html.match(/<head>/g)).toHaveLength(1)
    expect(html.match(/window\.PIXELSKY_SPLASH_QUERY \?\? location\.search/g)).toHaveLength(2)
    expect(html).toContain('window.PixelSplash = ')
  })
  it('放在主窗口位置正中', () => {
    expect(centerIn({ x: 100, y: 50, width: 1568, height: 900 }, { width: 560, height: 340 })).toEqual({
      x: 604,
      y: 330,
    })
  })
})

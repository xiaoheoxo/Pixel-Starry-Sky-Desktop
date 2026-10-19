// 开机画面什么时候弹、什么时候收（纯逻辑，窗口操作由 splash.ts 注入）：
// 主窗口在 app ready 之后 delayMs 内还没画好才弹；弹出来至少停 minMs，免得一闪而过；
// 主窗口画好后先显示主窗口，再让开机画面淡出关掉；主窗口一直没画好时最多留 maxMs。

export type SplashTheme = 'light' | 'dark'

/** 开机画面窗口要用到的几个操作（测试里换成假的） */
export interface SplashWindow {
  /** 页面画好、可以显示时回调 */
  onReady(fn: () => void): void
  show(): void
  /** 主窗口出来后放到最上面淡出；淡完（或页面没响应、超时）后 resolve */
  fadeOut(): Promise<void>
  destroy(): void
  isDestroyed(): boolean
}

export interface SplashDeps {
  open: () => SplashWindow
  now: () => number
  /** 定时，返回取消函数 */
  setTimer: (fn: () => void, ms: number) => () => void
  log?: (message: string, fields: Record<string, number>) => void
  delayMs: number
  minMs: number
  maxMs: number
}

export interface SplashController {
  /** 主窗口画好了：没弹过就直接 show；弹着就等够最短时间再 show，然后开机画面淡出。之后再调直接 show */
  handOff(show: () => void): void
  /** 退出时收掉（没弹的不再弹，弹着的直接关） */
  dispose(): void
}

export function createSplashController(deps: SplashDeps): SplashController {
  const start = deps.now()
  // waiting：计时中；loading：窗口建了、页面还没画好；shown：显示着；leaving：等最短时间后交给主窗口；done：结束
  let state: 'waiting' | 'loading' | 'shown' | 'leaving' | 'done' = 'waiting'
  let win: SplashWindow | null = null
  let shownAt = 0
  let cancelMax = (): void => {}
  let cancelLeave = (): void => {}
  const close = (): void => {
    state = 'done'
    cancelDelay()
    cancelMax()
    cancelLeave()
    if (win && !win.isDestroyed()) win.destroy()
    win = null
  }
  const cancelDelay = deps.setTimer(() => {
    if (state !== 'waiting') return
    state = 'loading'
    try {
      win = deps.open()
    } catch {
      state = 'done'
      return
    }
    win.onReady(() => {
      if (state !== 'loading' || !win || win.isDestroyed()) return
      state = 'shown'
      shownAt = deps.now()
      win.show()
      deps.log?.('启动慢，显示开机画面', { afterMs: Math.round(shownAt - start) })
    })
    cancelMax = deps.setTimer(() => {
      if (state === 'done') return
      deps.log?.('主窗口一直没画好，关掉开机画面', { afterMs: Math.round(deps.now() - start) })
      close()
    }, deps.maxMs)
  }, deps.delayMs)

  return {
    handOff(show) {
      if (state !== 'shown' || !win) {
        // 还没弹（启动快）或者页面还没画好：不弹了，直接显示主窗口
        if (state !== 'leaving') close()
        show()
        return
      }
      const target = win
      state = 'leaving'
      cancelMax()
      cancelLeave = deps.setTimer(
        () => {
          if (state !== 'leaving') return
          state = 'done'
          win = null
          show()
          deps.log?.('开机画面结束', {
            shownMs: Math.round(deps.now() - shownAt),
            totalMs: Math.round(deps.now() - start),
          })
          void target.fadeOut().finally(() => {
            if (!target.isDestroyed()) target.destroy()
          })
        },
        Math.max(0, shownAt + deps.minMs - deps.now()),
      )
    },
    dispose: close,
  }
}

/**
 * 开机画面用哪个主题：上次界面报来的主题（theme:set）。上次界面主题和当时的系统主题一样时多半是「跟随系统」，
 * 按现在的系统主题来；没记过就用系统主题
 */
export function splashTheme(saved: unknown, systemDark: boolean): SplashTheme {
  const system: SplashTheme = systemDark ? 'dark' : 'light'
  if (!saved || typeof saved !== 'object') return system
  const { theme, system: then } = saved as Record<string, unknown>
  if (theme !== 'light' && theme !== 'dark') return system
  return theme === then ? system : theme
}

/** 页面的参数写进 window.PIXELSKY_SPLASH_QUERY（data: 地址没有查询串），插在 <head> 最前面 */
export function splashPage(template: string, query: Record<string, string>): string {
  const script = `<script>window.PIXELSKY_SPLASH_QUERY = ${JSON.stringify(new URLSearchParams(query).toString())}</script>`
  return template.replace('<head>', '<head>' + script)
}

/** 开机画面放在主窗口将要出现的位置正中 */
export function centerIn(
  area: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: Math.round(area.y + (area.height - size.height) / 2),
  }
}

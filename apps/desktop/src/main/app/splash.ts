// 启动慢时的开机画面（docs/ui/boot-splash.html 是带预览控制条的设计稿）：只有主窗口在 app ready 之后 1 秒还没画好才弹，
// 平时看不到。什么时候弹、什么时候收在 splash-controller.ts；这里只管 Electron 窗口和主题记录。
import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'node:path'
import template from './splash.html?raw'
import {
  centerIn,
  createSplashController,
  splashPage,
  splashTheme,
  type SplashController,
  type SplashTheme,
  type SplashWindow,
} from './splash-controller'
import { mergeWindowFile, readWindowFile } from './windowFile'

/** 主窗口在 app ready 之后这么久还没画好才弹（这台开发机上正常约 0.45 秒画好） */
const DELAY_MS = 1000
/** 弹出来至少停这么久，免得一闪而过 */
const MIN_MS = 600
/** 主窗口一直没画好（界面卡死、反复崩溃）时最多留这么久 */
const MAX_MS = 20_000
const SIZE = { width: 560, height: 340 }
/** 和 splash.html 的底色一致，页面画好之前窗口就是这个颜色 */
const BACKGROUND: Record<SplashTheme, string> = { dark: '#15120f', light: '#efe7db' }

const file = (): string => join(app.getPath('userData'), 'window.json')
let remembered = ''

/**
 * 界面报来的主题（theme:set）记进 window.json，下次开机画面用；连同当时的系统主题，用来判断是不是「跟随系统」。
 * 没变就不写
 */
export function rememberTheme(theme: SplashTheme): void {
  const system: SplashTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const key = theme + ':' + system
  if (key === remembered) return
  remembered = key
  mergeWindowFile(file(), { splashTheme: { theme, system } })
}

function openWindow(theme: SplashTheme, near: Electron.Rectangle | null): SplashWindow {
  const win = new BrowserWindow({
    ...SIZE,
    ...(near ? centerIn(near, SIZE) : { center: true }),
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 不进任务栏、不抢焦点：托盘、再次启动唤回窗口这些找「最近聚焦的窗口」的地方不会找到它，也不能被 Alt+F4 关掉
    skipTaskbar: true,
    focusable: false,
    title: '像素星空',
    backgroundColor: BACKGROUND[theme],
    webPreferences: { sandbox: true, contextIsolation: true, devTools: !app.isPackaged },
  })
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(splashPage(template, { embed: '1', theme }))
  void win.loadURL(url).catch(() => undefined)
  return {
    onReady: fn => win.once('ready-to-show', fn),
    show: () => win.showInactive(),
    fadeOut: async () => {
      if (win.isDestroyed()) return
      // 主窗口已经显示、在前面了：放到最上面淡出，看起来是从开机画面过渡到主窗口
      win.setAlwaysOnTop(true)
      await Promise.race([
        win.webContents.executeJavaScript('PixelSplash.done({ immediate: true })').catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ])
    },
    destroy: () => win.destroy(),
    isDestroyed: () => win.isDestroyed(),
  }
}

/**
 * app ready 时调：开始计时，主窗口迟迟没画好才弹开机画面。near 是主窗口将要出现的位置（开机画面放在它正中）。
 * 开发版可以用 PIXELSKY_SPLASH_DELAY=毫秒 改等待时间（0 = 每次都弹，看效果用）
 */
export function startSplash(opts: {
  near: () => Electron.Rectangle | null
  log: (message: string, fields: Record<string, number>) => void
}): SplashController {
  const saved = readWindowFile(file()).splashTheme
  const theme = splashTheme(saved, nativeTheme.shouldUseDarkColors)
  if (saved && typeof saved === 'object') {
    const { theme: t, system: s } = saved as Record<string, unknown>
    remembered = `${String(t)}:${String(s)}`
  }
  const override =
    !app.isPackaged && process.env.PIXELSKY_SPLASH_DELAY ? Number(process.env.PIXELSKY_SPLASH_DELAY) : NaN
  const controller = createSplashController({
    open: () => openWindow(theme, opts.near()),
    now: () => performance.now(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
    log: opts.log,
    delayMs: Number.isFinite(override) && override >= 0 ? override : DELAY_MS,
    minMs: MIN_MS,
    maxMs: MAX_MS,
  })
  app.on('before-quit', () => controller.dispose())
  return controller
}

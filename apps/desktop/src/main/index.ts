// 开发版用自己的数据目录（app/data-dir.ts），要在其他模块之前
import './app/data-dir'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  protocol,
  session,
  shell,
  type MenuItemConstructorOptions,
} from 'electron'
import { logger } from '@pixelsky/engine'
import { initAccount } from './account/account'
import * as ipc from './ipc/guard'
import { initAppInfo } from './app/info'
import { initUpdater, runPendingInstall } from './app/updater'
import { quitWhenAllClosed } from './app/quit'
import { initEngine } from './engine/ipc'
import { initExtensionPacks } from './extension-packs/ipc'
import { initExtStore } from './extension-packs/market/ipc'
import { EXT_SCHEME_PRIVILEGES } from './extension-packs/protocol'
import { loadShellEnv } from './app/shell-env'
import { initMobile } from './mobile/ipc'
import { initWorkspace } from './workspace/files-ipc'
import { initWindowControls, observeWindowControls } from './app/window-controls'
import { initUiLanguage, nativeText } from './app/ui-language'
import { watchEditMenu } from './app/editMenu'
import { initProjectTools } from './workspace/project-tools-ipc'
import { initChannels } from './channels/ipc'
import { initNotifications } from './notifications/notifications'
import { confirmTerminalClose, closeWindowTerminals } from './terminal/ipc'
import { createAppContext } from './app/context'
import { initLogIpc, initLogging, logService } from './app/logging'
import {
  allowCallStacks,
  enableCallStacks,
  memoryChecker,
  watchMainLoop,
  watchMemory,
  watchRemoteMemory,
  watchWindow,
} from './app/responsiveness'
import { initMemory, memoryTick, noteLoaded } from './app/memory'
import { startupTimeline } from './app/startup-timing'
import { rememberTheme, startSplash } from './app/splash'
import type { SplashController } from './app/splash-controller'
import { loadApp as loadAppPage, REACT_CRASH, watchCrashes, type CrashWatch } from './app/crashRecovery'
import { canSend, markReady } from './app/rendererHealth'
import { initTray, type TrayController } from './app/tray'
import { isPayWindow } from './app/payWindowRegistry'
import { resolveInitialWindow, trackWindowState } from './app/window-state'
import { initSettingsSync } from './account/settings-sync'
import { initFeedback } from './feedback/feedback'
import type { Locale } from '../shared/i18n/messages'

type ResolvedTheme = 'light' | 'dark'

// 与 docs/ui/design-tokens.md §1.6 保持一致
const TITLE_BAR: Record<ResolvedTheme, { color: string; symbolColor: string }> = {
  light: { color: '#F8F8F6', symbolColor: '#20211F' },
  dark: { color: '#1F1F1E', symbolColor: '#ECEBE7' },
}
const TITLE_BAR_HEIGHT = 48
/** 主窗口默认大小和最小大小（启动时据此恢复上次的位置，开机画面也放在这个位置正中） */
const WINDOW_DEFAULT = { width: 1568, height: 900 }
const WINDOW_MIN = { width: 1100, height: 700 }

// 截图模式：PIXELSKY_CAPTURE=<目录> 时按参考图尺寸截浅色/深色两张图后退出（见 scripts/capture.mjs）
const captureDir = process.env.PIXELSKY_CAPTURE
// 调试端口会向本机所有进程开放整个页面，只在开发环境（未打包）允许打开
const debugPort = app.isPackaged ? undefined : process.env.PIXELSKY_DEBUG_PORT
// Windows 按名字启动程序（git、where.exe …）时会先在当前目录里找：从终端 cd 到某个项目再启动应用时，
// 项目里的 git.exe 会顶替真正的 git。打包版启动时把当前目录换成安装目录（审查报告 2026-10-14）
if (process.platform === 'win32' && app.isPackaged) {
  try {
    process.chdir(dirname(process.execPath))
  } catch {
    /* 换不了就保持原样 */
  }
}
// 启动耗时打点：攒到第一个窗口画好、页面加载完才写一条汇总（app/startup-timing.ts）
const startup = startupTimeline(fields => log.info('启动耗时', fields))
/** 主进程共用的状态：事件、退出任务、引擎 / SSH 机器 / 项目工具（app/context.ts） */
const ctx = createAppContext()
initLogging(ctx) // 本机日志，见 app/logging.ts（越早越好：后面初始化出的错也要记下来）
const closingAllowed = new WeakSet<BrowserWindow>()
const finishing = new WeakSet<BrowserWindow>()
let quitRequested = false
let quitReady = false
/** 正在退出整个应用（菜单、托盘、自动更新）：这时 × 不再隐藏到托盘 */
let quitting = false
/** 系统托盘（app/tray.ts）；截图模式不建 */
let tray: TrayController | null = null
/** 启动慢时的开机画面（app/splash.ts）；截图模式不弹 */
let splash: SplashController | null = null

// 只开一份（docs/ui/tray.md §2.4）：再次启动时唤回已有的窗口（窗口可能藏在托盘里）。
// 锁按数据目录算，演示 / 测试用别的 --user-data-dir 时互不影响；截图模式不加锁
if (!captureDir && !app.requestSingleInstanceLock()) {
  app.exit(0)
}
app.on('second-instance', () => {
  if (!app.isReady()) return
  if (tray) tray.showWindow()
  else {
    const win = BrowserWindow.getAllWindows().find(w => !isPayWindow(w))
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  }
})
async function finishWindowClose(win: BrowserWindow): Promise<void> {
  if (finishing.has(win) || win.isDestroyed()) return
  finishing.add(win)
  try {
    if (!(await confirmTerminalClose(win))) {
      quitRequested = false
      quitting = false
      return
    }
    await closeWindowTerminals(win)
    if (!win.isDestroyed()) {
      closingAllowed.add(win)
      win.close()
    }
  } finally {
    finishing.delete(win)
  }
}
ipc.handle(
  'files:finishClose',
  async event => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) await finishWindowClose(win)
  },
  { deny: '不允许的调用方' },
)
app.on('before-quit', event => {
  if (quitReady) return
  event.preventDefault()
  if (quitRequested) return
  const windows = BrowserWindow.getAllWindows()
  if (windows.length && !captureDir) {
    quitRequested = true
    quitting = true
    // 藏在托盘里的窗口先显示出来：未保存文件、终端还在运行的确认要看得见
    for (const win of windows) {
      if (!win.isVisible()) win.show()
      win.close()
    }
    // 窗口里选了「返回保存」时界面不会告诉主进程：过一会儿恢复成平时的 ×（真正退出时窗口已经一个个关掉，不受影响）
    setTimeout(() => {
      quitting = false
    }, 10_000).unref()
    quitRequested = false
    return
  }
  quitRequested = true
  void ctx.lifecycle.shutdown().finally(() => {
    quitReady = true
    // 点过「重启以更新」：现在才打开安装程序（打不开时照常退出）
    runPendingInstall()
    app.quit()
  })
})
if (debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort)
// 窗口没响应时能取到页面正在跑的 JS 调用栈（app/responsiveness.ts）
enableCallStacks()

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** 应用自己的页面：开发服务器的同源地址，或打包后的本地文件 */
function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev && !app.isPackaged) return u.origin === new URL(dev).origin
    return u.protocol === 'file:'
  } catch {
    return false
  }
}

/** 加载界面页面；query 是崩溃恢复时带给界面的 recovered、n（docs/ui/renderer-memory.md §3.1） */
function loadApp(win: BrowserWindow, query?: Record<string, string>): Promise<void> {
  return loadAppPage(
    win,
    { devUrl: process.env.ELECTRON_RENDERER_URL, file: join(__dirname, '../renderer/index.html') },
    query,
  )
}

const log = logger('app')

/** 各窗口的崩溃监听，log:uncaught 按发送方找到对应的那个 */
const crashWatches = new Map<Electron.WebContents, CrashWatch>()

function createWindow(): BrowserWindow {
  const initial: ResolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  // 上次的窗口位置 / 大小，对着当前显示器校验过（app/window-state.ts）；截图模式不用
  const restored = captureDir ? null : resolveInitialWindow(WINDOW_DEFAULT, WINDOW_MIN)
  const win = new BrowserWindow({
    // 截图模式使用参考图尺寸（docs/reference/workbench-session.jpg）
    width: 1568,
    height: captureDir ? 765 : 900,
    useContentSize: true,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: '像素星空',
    // 打包后 Windows、macOS 用程序自带的图标，Linux 用 resources/icon.png（electron-builder.yml）；开发模式用 build/icon.png
    ...(!app.isPackaged
      ? { icon: join(__dirname, '../../build/icon.png') }
      : process.platform === 'linux' && { icon: join(process.resourcesPath, 'icon.png') }),
    backgroundColor: TITLE_BAR[initial].color,
    ...(process.platform === 'win32'
      ? { frame: false }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 18, y: 18 } }
        : { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...TITLE_BAR[initial], height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      // 截图模式窗口停在屏幕外，不能让它被当成后台窗口而暂停渲染
      backgroundThrottling: !captureDir,
    },
  })

  if (restored) {
    // setBounds 用的是外框尺寸，和保存时的 getNormalBounds 一致（构造参数里的 width / height 是内容区）
    win.setBounds(restored.bounds)
    // Windows 跨不同缩放比的显示器时，一次 setBounds 可能被按旧显示器的缩放比换算错（Electron 已知问题）；
    // 窗口此时是隐藏的，再设一次没有代价
    if (process.platform === 'win32') win.setBounds(restored.bounds)
    trackWindowState(win, restored.maximized)
  }
  observeWindowControls(win)
  watchWindow(win)
  // 界面崩溃后自动重新加载，反复崩溃时弹对话框（app/crashRecovery.ts）
  const crashWatch = watchCrashes(win, {
    load: (target, query) => loadApp(target, query),
    openLogs: async () => {
      const dir = logService()?.files.dir
      if (dir) await shell.openPath(dir)
    },
    quit: () => app.quit(),
  })
  // 窗口销毁后不能再读 win.webContents，先存下来
  const wc = win.webContents
  crashWatches.set(wc, crashWatch)
  win.once('closed', () => crashWatches.delete(wc))
  win.webContents.on('did-finish-load', () => {
    noteLoaded(win.webContents)
    startup.reach('didFinishLoad')
  })
  win.once('ready-to-show', () => {
    startup.reach('readyToShow')
    if (captureDir) return
    const reveal = (): void => {
      if (win.isDestroyed()) return
      // 最大化要等页面画好再做：在隐藏窗口上调 maximize() 会让 Electron 直接把窗口显示出来（先看到一片底色）
      if (restored?.maximized) win.maximize()
      win.show()
    }
    // 开机画面弹着时，等它停够最短时间再显示主窗口，然后它淡出
    if (splash) splash.handOff(reveal)
    else reveal()
  })
  win.on('close', event => {
    if (captureDir || closingAllowed.has(win) || win.webContents.isDestroyed()) return
    event.preventDefault()
    // 关闭最后一个看得见的窗口：按设置隐藏到托盘，任务继续（docs/ui/tray.md §2.3）
    if (!quitting && tray?.shouldHideOnClose(win)) {
      tray.hide(win)
      return
    }
    // 界面不可用（崩溃、重新加载还没报到）时收不到 files:beforeClose，直接走关闭流程
    if (!canSend(win.webContents)) {
      void finishWindowClose(win)
      return
    }
    win.webContents.send('files:beforeClose')
  })
  win.webContents.on('will-prevent-unload', event => {
    if (closingAllowed.has(win)) {
      event.preventDefault()
      return
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: nativeText(win, '文件尚未保存'),
      message: nativeText(win, '有文件包含未保存的修改，仍然退出吗？'),
      buttons: [nativeText(win, '返回保存'), nativeText(win, '放弃修改并退出')],
      defaultId: 0,
      cancelId: 0,
    })
    if (choice === 1) event.preventDefault()
  })

  // 普通输入框右键：系统原生的剪切 / 复制 / 粘贴菜单（app/editMenu.ts）
  watchEditMenu(win)

  // 外部链接用系统浏览器打开
  // 只放行 http(s)，不把 file:、自定义协议等交给系统去处理
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 窗口不能被导航到应用以外的页面（否则那个页面也能用上预加载暴露的接口）
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (isWebUrl(url)) void shell.openExternal(url)
  })

  void loadApp(win)

  if (captureDir) void capture(win, captureDir)
  return win
}

// 界面里的 React 根被未接住的错误卸载（白屏、渲染进程还活着）：按崩溃处理，自动重新加载（docs/ui/renderer-memory.md §3.1.7）
ipc.on('log:uncaught', event => {
  const watch = crashWatches.get(event.sender)
  if (!watch) {
    log.warn('收到非主窗口的界面崩溃报告，忽略', { window: event.sender.id })
    return
  }
  log.info('界面组件崩溃，自动重新加载', { window: event.sender.id })
  watch.failed(REACT_CRASH)
})

// 演示模式：PIXELSKY_DEMO=1 或启动参数带 --demo 时界面显示演示数据（pnpm dev:demo / 打包版 exe --demo），否则是空界面
ipc.on('app:config', event => {
  event.returnValue = { demo: process.env.PIXELSKY_DEMO === '1' || process.argv.includes('--demo') }
})

// 新页面报到（界面订阅好引擎事件之后、拉列表和快照之前调）：结束「恢复中」，之后的推送才会送到；不在恢复中时什么都不做
ipc.handle('app:ready', event => markReady(event.sender), { deny: '不允许的调用方' })

ipc.on('theme:set', (event, theme: ResolvedTheme, transparent?: boolean, background?: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || (theme !== 'light' && theme !== 'dark')) return
  rememberTheme(theme) // 下次开机画面用
  // 配色主题的实色底（renderer 的 --wall-tint）；格式不对就用默认暖灰
  const base =
    typeof background === 'string' && /^#[0-9a-f]{6}$/i.test(background) ? background : TITLE_BAR[theme].color
  win.setBackgroundColor(base)
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    // 有壁纸时按钮区透明，按钮直接画在壁纸上（docs/ui/settings.md §6）
    const color = transparent === true ? '#00000000' : base
    win.setTitleBarOverlay({ ...TITLE_BAR[theme], color, height: TITLE_BAR_HEIGHT })
  }
})

async function capture(win: BrowserWindow, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()))
  // 截图需要窗口在屏幕外可见才能拿到真实渲染结果
  win.setPosition(-4000, -4000)
  win.showInactive()
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const shots: Partial<Record<ResolvedTheme, Buffer>> = {}
  for (const theme of ['light', 'dark'] as const) {
    // 等 React 挂载出主题钩子，切换后确认 <html data-theme> 真的变了，否则报错退出
    let applied = ''
    for (let i = 0; i < 50 && applied !== theme; i++) {
      applied = await win.webContents.executeJavaScript(
        `(window.__pixelskySetTheme && window.__pixelskySetTheme(${JSON.stringify(theme)}), document.documentElement.dataset.theme || '')`,
      )
      if (applied !== theme) await sleep(100)
    }
    if (applied !== theme) {
      console.error(`[capture] 切换到 ${theme} 主题失败（当前 ${applied || '无'}）`)
      app.exit(1)
      return
    }
    // 空界面没有动画，合成器可能不出新帧，capturePage 会拿到上一主题的旧帧：
    // 强制重绘并等两次 requestAnimationFrame，确认新主题这一帧已经提交（最多等 2 秒，避免窗口不出帧时卡死）
    await sleep(300)
    win.webContents.invalidate()
    await win.webContents.executeJavaScript(
      'new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r(true))); setTimeout(() => r(false), 2000) })',
    )
    await sleep(300)
    const png = (await win.webContents.capturePage()).toPNG()
    shots[theme] = png
    await writeFile(join(dir, `${theme}.png`), png)
  }
  if (shots.light && shots.dark && shots.light.equals(shots.dark)) {
    console.error('[capture] 浅色和深色截图完全相同，深色主题没有渲染出来')
    app.exit(1)
    return
  }
  app.quit()
}

/**
 * 应用菜单：和 Electron 默认菜单一样（标题栏隐藏了，菜单不显示，但快捷键仍然有效），
 * 只是「窗口」菜单里去掉「关闭」—— 默认的 Ctrl+W 会直接关掉整个窗口，
 * 现在 Ctrl+W 交给界面关闭当前标签 / 窗格（docs/ui/multi-pane.md §4）。
 */
function setAppMenu(locale: Locale = 'zh-CN'): void {
  const template: MenuItemConstructorOptions[] = [
    // macOS 的应用菜单里已经有「退出」；其他平台放在「文件」菜单里。都不放「关闭窗口」
    process.platform === 'darwin'
      ? { role: 'appMenu' }
      : { label: locale === 'en-US' ? 'File' : '文件', submenu: [{ role: 'quit' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: locale === 'en-US' ? 'Window' : '窗口',
      ...(process.platform === 'darwin' && { role: 'windowMenu' as const }),
      submenu: [
        { role: 'minimize' },
        ...(process.platform === 'darwin'
          ? ([{ role: 'zoom' }, { type: 'separator' }, { role: 'front' }] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Windows 系统通知需要 AppUserModelID；开发版没有安装记录，用 Electron 本身的路径（docs/ui/notifications.md §4）
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.pixelsky.desktop' : process.execPath)

// 扩展包的资源协议 pixelsky-ext:// 必须在 ready 之前登记
protocol.registerSchemesAsPrivileged([EXT_SCHEME_PRIVILEGES])

app.whenReady().then(async () => {
  startup.step('whenReady')
  // 主窗口 1 秒内没画好才弹开机画面，平时看不到（app/splash.ts）
  if (!captureDir)
    splash = startSplash({
      near: () => resolveInitialWindow(WINDOW_DEFAULT, WINDOW_MIN).bounds,
      log: (message, fields) => log.info(message, fields),
    })
  // 卡顿诊断：窗口没响应、主进程卡住、内存过高时写日志（docs/ui/logging.md §4.9）
  allowCallStacks(session.defaultSession, isAppUrl)
  watchMainLoop(() => ctx.engine?.memoryStats())
  // 内存：界面每次 log.sample() 进来时取主进程这边的数；这个每分钟的定时器兼做「内存占用高」分档和界面不报时的看门狗
  initMemory({
    engine: () => ctx.engine?.memoryStats() ?? { runtimes: 0, processes: 0, running: 0 },
    check: memoryChecker(),
    rendererPid: () => {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !isPayWindow(w))
      return win ? win.webContents.getOSProcessId() : null
    },
  })
  watchMemory(memoryTick)
  watchRemoteMemory(() => ctx.machines) // WSL 里的引擎进程不在 getAppMetrics 里，单独问
  setAppMenu()
  initUiLanguage(locale => {
    setAppMenu(locale)
    tray?.refresh()
  })
  startup.step('diagnostics') // 上面的卡顿诊断、内存监控、应用菜单、界面语言
  initWindowControls()
  startup.step('initWindowControls')
  initNotifications() // 系统通知，见 notifications/notifications.ts
  startup.step('initNotifications')
  initAccount() // 账号登录与额度，见 account/account.ts
  startup.step('initAccount')
  initAppInfo() // 「关于」页的版本与运行环境，见 app/info.ts
  startup.step('initAppInfo')
  initLogIpc() // 设置 › 日志，见 app/logging.ts
  startup.step('initLogIpc')
  initUpdater(ctx) // 自动更新（GitHub Releases），见 app/updater.ts
  startup.step('initUpdater')
  await loadShellEnv() // macOS / Linux 从程序坞、桌面菜单启动时补回登录 shell 的 PATH，见 app/shell-env.ts
  startup.step('loadShellEnv')
  const packs = initExtensionPacks(ctx) // 扩展包（语法 / 主题 / 图标 / 片段 / 任务 / 技能 / 提示词），见 extension-packs/ipc.ts
  startup.step('initExtensionPacks')
  initExtStore(ctx, packs) // 扩展商店（发现、安装、更新、我的发布），见 extension-packs/market/ipc.ts
  startup.step('initExtStore')
  await initEngine(ctx) // 引擎系统（Claude Code 等），见 engine/ipc.ts
  startup.step('initEngine')
  initMobile(ctx) // 手机远程连接（默认关），见 mobile/ipc.ts
  startup.step('initMobile')
  initSettingsSync(ctx) // 设置云同步，见 account/settings-sync.ts
  startup.step('initSettingsSync')
  initFeedback(ctx) // 设置 › 反馈（云端工单、回复提醒），见 feedback/feedback.ts
  startup.step('initFeedback')
  await initWorkspace(ctx)
  startup.step('initWorkspace')
  await initProjectTools(ctx)
  startup.step('initProjectTools')
  await initChannels(ctx) // 协作频道（本机 AI 协作），见 channels/ipc.ts
  startup.step('initChannels')
  createWindow()
  startup.step('createWindow')
  // 系统托盘（docs/ui/tray.md）：通知区域图标、右键菜单、关闭时隐藏到托盘
  if (!captureDir)
    tray = initTray(ctx, {
      createWindow,
      quit: () => app.quit(),
    })
  // macOS 点程序坞图标：没有窗口就开一个；窗口关到托盘（隐藏）了就拿回来
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else if (!BrowserWindow.getAllWindows().some(w => w.isVisible())) tray?.showWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS 平时关窗口不退出；从菜单、托盘、崩溃对话框退出时 before-quit 先关窗口，关完要接着退出
  if (quitWhenAllClosed(process.platform, quitting)) app.quit()
})

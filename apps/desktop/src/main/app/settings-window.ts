// 设置独立窗口（docs/ui/settings-window.md）：设置可以弹成一个单独的系统窗口，拖到软件外面看主窗口的变化。
// 只开一个；加载和主窗口同一个页面（?view=settings）；位置、大小、置顶、上次的打开方式存在 userData/settings-window.json。
// 置顶不用 setAlwaysOnTop（会盖住所有软件），而是做成主窗口的子窗口（parent）：总在主窗口上面，任务栏里和主窗口合在一起。
// 主窗口关闭、隐藏到托盘时设置窗口跟着关；设置窗口请主窗口做的事（打开会话、管理机器…）经 mainWindow:run 转过去。
import { join } from 'node:path'
import { app, BrowserWindow, dialog, screen, type BrowserWindowConstructorOptions } from 'electron'
import * as ipc from '../ipc/guard'
import type { MainWindowAction, SettingsTarget, SettingsWindowState } from '../../shared/types/settings-window'
import type { AppContext } from './context'
import { sendTo, sendWhenReady } from './rendererHealth'
import { markSettingsWindow, isSettingsWindow } from './settingsWindowRegistry'
import {
  SETTINGS_MIN,
  parseMainWindowAction,
  parseSettingsTarget,
  parseSettingsWindowPrefs,
  parseSettingsWorkspace,
  resolveSettingsBounds,
  settingsWindowTitle,
} from './settings-window-state'
import { nativeText, windowLocale } from './ui-language'
import { mergeWindowFile, readWindowFile } from './windowFile'
import type { Rect } from './window-bounds'

export interface SettingsWindowDeps {
  /** 和主窗口一样的窗口选项：图标、底色、标题栏（Windows 自绘、macOS hiddenInset、Linux titleBarOverlay）、preload、沙箱 */
  options(): BrowserWindowConstructorOptions
  /** 挂上和主窗口一样的监听（窗口按钮状态、卡顿诊断、崩溃恢复、外链、右键菜单）；query 是崩溃恢复重新加载时要保留的参数 */
  setup(win: BrowserWindow, query: Record<string, string>): void
  /** 加载界面页面 */
  load(win: BrowserWindow, query: Record<string, string>): Promise<void>
}

export interface SettingsWindowController {
  /** 登记主窗口：它关闭、隐藏到托盘时设置窗口跟着关 */
  attachMain(win: BrowserWindow): void
  state(): SettingsWindowState
  /** 打开设置窗口（已开着就提到前面并跳到 target） */
  open(target?: SettingsTarget): void
  /** 收回：关掉设置窗口，让主窗口打开浮层 */
  dock(section?: string): void
  close(): void
}

const rectOf = (b: Electron.Rectangle): Rect => ({ x: b.x, y: b.y, width: b.width, height: b.height })
const BOUNDS_SAVE_DELAY_MS = 400

export function initSettingsWindow(ctx: AppContext, deps: SettingsWindowDeps): SettingsWindowController {
  const file = join(app.getPath('userData'), 'settings-window.json')
  let prefs = parseSettingsWindowPrefs(readWindowFile(file))
  let win: BrowserWindow | null = null
  let main: BrowserWindow | null = null
  let workspace: SettingsWindowState['workspace'] = null

  const live = (w: BrowserWindow | null): w is BrowserWindow => !!w && !w.isDestroyed()
  const state = (): SettingsWindowState => ({
    open: live(win),
    pinned: prefs.pinned,
    preferWindow: prefs.preferWindow,
    workspace,
  })
  /** 状态变了：告诉所有窗口（主窗口据此决定打开设置用浮层还是窗口，设置窗口据此显示置顶） */
  const publish = (): void => ctx.events.broadcast('settingsWindow:changed', state())
  const remember = (patch: Partial<typeof prefs>): void => {
    prefs = { ...prefs, ...patch }
    mergeWindowFile(file, patch)
  }
  const show = (w: BrowserWindow): void => {
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }

  function create(target: SettingsTarget): void {
    const m = live(main) ? main : null
    const bounds = resolveSettingsBounds({
      saved: prefs.bounds,
      displays: screen.getAllDisplays().map(d => rectOf(d.workArea)),
      primary: rectOf(screen.getPrimaryDisplay().workArea),
      // 主窗口最小化时 getBounds 在屏幕外，不能拿来定位
      main: m && !m.isMinimized() ? rectOf(m.getBounds()) : null,
    })
    const options = deps.options()
    const created = new BrowserWindow({
      ...options,
      ...bounds,
      minWidth: SETTINGS_MIN.width,
      minHeight: SETTINGS_MIN.height,
      show: false,
      title: settingsWindowTitle(windowLocale(m)),
      // 沿用主窗口当前的底色（跟着应用主题，不是系统主题），打开时不闪一下别的颜色
      ...(m && { backgroundColor: m.getBackgroundColor() }),
      ...(prefs.pinned && m && { parent: m }),
    })
    win = created
    markSettingsWindow(created)
    // 要跳到哪随地址带过去（页面一加载就能读到，不用等界面订阅好再推）
    const query = { view: 'settings', ...(Object.keys(target).length > 0 && { target: JSON.stringify(target) }) }
    deps.setup(created, { view: 'settings' })
    trackBounds(created)
    created.once('ready-to-show', () => {
      if (created.isDestroyed()) return
      created.show()
      created.focus()
      publish()
    })
    created.once('closed', () => {
      if (win === created) win = null
      publish()
    })
    // 设置里有没保存的修改（子智能体说明、插件表单……）时界面的 beforeunload 会拦下关窗：
    // 窗口按钮、Ctrl+W、Alt+F4、主窗口关闭 / 隐藏到托盘、退出软件都走这里，问一句再关（和主窗口的未保存文件一样）
    created.webContents.on('will-prevent-unload', event => {
      const choice = dialog.showMessageBoxSync(created, {
        type: 'question',
        title: nativeText(created, '设置尚未保存'),
        message: nativeText(created, '设置里有没保存的修改，仍然关闭吗？'),
        buttons: [nativeText(created, '返回'), nativeText(created, '放弃修改并关闭')],
        defaultId: 0,
        cancelId: 0,
      })
      if (choice === 1) event.preventDefault()
    })
    void deps.load(created, query)
  }

  /** 移动、缩放后 400ms 防抖保存位置和大小（存还原后的，最大化不记）；关闭时同步存一次 */
  function trackBounds(w: BrowserWindow): void {
    let timer: NodeJS.Timeout | null = null
    const save = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (w.isDestroyed() || w.isFullScreen()) return
      remember({ bounds: rectOf(w.getNormalBounds()) })
    }
    const later = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(save, BOUNDS_SAVE_DELAY_MS)
      timer.unref()
    }
    w.on('resize', later)
    w.on('move', later)
    w.on('close', save)
    w.once('closed', () => {
      if (timer) clearTimeout(timer)
    })
  }

  function open(target: SettingsTarget = {}): void {
    if (!prefs.preferWindow) remember({ preferWindow: true })
    if (live(win)) {
      show(win)
      // 页面还在加载时先攒着，加载好再发（只留最后一条）
      sendWhenReady(win.webContents, 'settingsWindow:navigate', target)
      publish()
      return
    }
    create(target)
  }

  function close(): void {
    if (live(win)) win.close()
  }

  function dock(section?: string): void {
    remember({ preferWindow: false })
    close()
    publish()
    if (live(main)) {
      show(main)
      sendWhenReady(main.webContents, 'settings:openDialog', section ? { section } : {})
    }
  }

  function setPinned(on: boolean): void {
    remember({ pinned: on })
    if (live(win)) win.setParentWindow(on && live(main) ? main : null)
    publish()
  }

  /** 设置窗口请主窗口做事：把主窗口提到前面，再让它执行原来的那段逻辑 */
  function run(action: MainWindowAction): void {
    if (!live(main)) return
    show(main)
    sendWhenReady(main.webContents, 'mainWindow:action', action)
  }

  const fromSettingsWindow = (event: { sender: Electron.WebContents }): boolean => {
    const w = BrowserWindow.fromWebContents(event.sender)
    return !!w && isSettingsWindow(w)
  }
  const deny = { deny: '不允许的调用方' }
  ipc.handle(
    'settingsWindow:open',
    (_event, section?: unknown, row?: unknown, hints?: unknown) => open(parseSettingsTarget(section, row, hints)),
    deny,
  )
  ipc.handle(
    'settingsWindow:dock',
    (event, section?: unknown) => {
      if (!fromSettingsWindow(event)) throw new Error('不允许的调用方')
      dock(parseSettingsTarget(section, undefined).section)
    },
    deny,
  )
  ipc.handle(
    'settingsWindow:setPinned',
    (event, on?: unknown) => {
      if (!fromSettingsWindow(event)) throw new Error('不允许的调用方')
      if (typeof on !== 'boolean') throw new Error('参数错误')
      setPinned(on)
    },
    deny,
  )
  ipc.handle('settingsWindow:state', () => state(), deny)
  ipc.handle(
    'mainWindow:run',
    (event, action?: unknown) => {
      if (!fromSettingsWindow(event)) throw new Error('不允许的调用方')
      const parsed = parseMainWindowAction(action)
      if (!parsed) throw new Error('参数错误')
      run(parsed)
    },
    deny,
  )
  // 主窗口报告它当前的工作区（插件页要按它显示）；只在变了的时候转给设置窗口
  ipc.on('settingsWindow:reportWorkspace', (event, value?: unknown) => {
    if (fromSettingsWindow(event)) return
    const next = parseSettingsWorkspace(value)
    if (JSON.stringify(next) === JSON.stringify(workspace)) return
    workspace = next
    if (live(win)) sendTo(win.webContents, 'settingsWindow:changed', state())
  })

  return {
    attachMain: w => {
      main = w
      // 隐藏到托盘、关闭：设置窗口跟着关（下次从设置入口打开会重新弹出）
      w.on('hide', close)
      w.once('closed', () => {
        if (main === w) main = null
        close()
      })
    },
    state,
    open,
    dock,
    close,
  }
}

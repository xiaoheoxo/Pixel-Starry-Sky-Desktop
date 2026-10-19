// 系统托盘（docs/ui/tray.md）：通知区域图标 + 运行中 / 等你处理角标、悬停提示、右键菜单、关闭主窗口时隐藏到托盘。
// 只算本机的会话（SSH 远端的不算）。菜单里要窗口做的事（新建任务、打开会话、勿扰、检查更新）经 tray:command 发给窗口。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron'
import type { HostEvent, SessionSummary } from '@pixelsky/protocol'
import * as ipc from '../ipc/guard'
import { allMessages, type TranslationKey } from '../../shared/i18n/translate'
import type { Locale } from '../../shared/i18n/messages'
import type { TrayCommand, TrayPrefs } from '../../shared/types/tray'
import { windowLocale } from './ui-language'
import { isPayWindow } from './payWindowRegistry'
import { sendWhenReady } from './rendererHealth'
import { mergeWindowFile } from './windowFile'
import type { AppContext } from './context'

// ---------------------------------------------------------------------------
// 纯函数：状态、图标、提示、菜单（tray.test.ts）
// ---------------------------------------------------------------------------

export interface TrayTask {
  id: string
  title: string
}
export interface TrayStatus {
  running: TrayTask[]
  waiting: TrayTask[]
}
export type TrayIconName = 'tray' | 'tray-running' | 'tray-attention'
type Text = (key: TranslationKey, params?: Record<string, string | number>) => string

/** 菜单里每组最多列几个会话 */
export const TRAY_LIST_MAX = 5
// Linux 上很多桌面（GNOME 没装 AppIndicator 扩展）根本没有托盘区，关到托盘就找不回窗口了，默认直接退出
export const DEFAULT_TRAY_PREFS: TrayPrefs = { closeToTray: process.platform !== 'linux' }

export function trayText(locale: Locale): Text {
  return (key, params) =>
    (allMessages[key] as { zh: string; en: string })[locale === 'en-US' ? 'en' : 'zh'].replace(
      /\{(\w+)\}/g,
      (_, name: string) => String(params?.[name] ?? ''),
    )
}

/** 没归档的会话里：等你审批 / 提问的、正在启动或运行的 */
export function trayStatus(sessions: readonly SessionSummary[]): TrayStatus {
  const task = (s: SessionSummary): TrayTask => ({ id: s.record.id, title: s.record.title.trim() })
  const live = sessions.filter(s => !s.record.archivedAt)
  return {
    waiting: live.filter(s => s.state === 'waiting').map(task),
    running: live.filter(s => s.state === 'running' || s.state === 'starting').map(task),
  }
}

/** 等你处理优先（红点），其次运行中（主色点），都没有就是普通图标 */
export function trayIcon(s: TrayStatus): TrayIconName {
  return s.waiting.length ? 'tray-attention' : s.running.length ? 'tray-running' : 'tray'
}

export function trayTooltip(s: TrayStatus, t: Text): string {
  return [
    t('tray.app'),
    s.running.length ? t('tray.running', { p0: s.running.length }) : null,
    s.waiting.length ? t('tray.waiting', { p0: s.waiting.length }) : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

export interface TrayActions {
  show(): void
  newTask(): void
  open(sessionId: string): void
  dnd(until: number | null): void
  checkUpdate(): void
  quit(): void
}

export function trayMenu(
  s: TrayStatus,
  opts: { t: Text; dndUntil: number | null; now: number },
  act: TrayActions,
): MenuItemConstructorOptions[] {
  const { t } = opts
  const list = (tasks: TrayTask[]): MenuItemConstructorOptions[] => [
    ...tasks.slice(0, TRAY_LIST_MAX).map(task => ({
      // & 在 Windows 菜单里是快捷键标记，标题里的要转义
      label: (task.title || t('tray.untitled')).replace(/&/g, '&&').slice(0, 60),
      click: () => act.open(task.id),
    })),
    ...(tasks.length > TRAY_LIST_MAX
      ? [{ label: t('tray.more', { p0: tasks.length - TRAY_LIST_MAX }), enabled: false }]
      : []),
  ]
  const dnd = opts.dndUntil !== null && opts.dndUntil > opts.now
  return [
    { label: t('tray.show'), click: act.show },
    { label: t('tray.newTask'), accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: act.newTask },
    { type: 'separator' },
    {
      label: t('tray.runningMenu', { p0: s.running.length }),
      enabled: s.running.length > 0,
      submenu: s.running.length ? list(s.running) : undefined,
    },
    {
      label: t('tray.waitingMenu', { p0: s.waiting.length }),
      enabled: s.waiting.length > 0,
      submenu: s.waiting.length ? list(s.waiting) : undefined,
    },
    { type: 'separator' },
    dnd
      ? { label: t('tray.dndEnd'), click: () => act.dnd(null) }
      : { label: t('tray.dndHour'), click: () => act.dnd(opts.now + 60 * 60_000) },
    { label: t('tray.checkUpdate'), click: act.checkUpdate },
    { type: 'separator' },
    { label: t('tray.quit'), click: act.quit },
  ]
}

export function parseTrayPrefs(value: unknown): TrayPrefs & { hintShown: boolean } {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    closeToTray: typeof v.closeToTray === 'boolean' ? v.closeToTray : DEFAULT_TRAY_PREFS.closeToTray,
    hintShown: v.hintShown === true,
  }
}

// ---------------------------------------------------------------------------
// 托盘本身
// ---------------------------------------------------------------------------

export interface TrayDeps {
  createWindow(): BrowserWindow
  /** 和标题栏菜单的退出走同一条路（未保存文件、终端确认照旧） */
  quit(): void
}

export interface TrayController {
  /** 这个窗口的 × 要不要只隐藏：设置开着，而且它是最后一个看得见的窗口 */
  shouldHideOnClose(win: BrowserWindow): boolean
  hide(win: BrowserWindow): void
  showWindow(): BrowserWindow
  refresh(): void
}

function iconDir(): string {
  // 打包后在 resources/tray（electron-builder.yml 的 extraResources），开发时直接读 build/tray
  return app.isPackaged ? join(process.resourcesPath, 'tray') : join(__dirname, '../../build/tray')
}

export function initTray(ctx: AppContext, deps: TrayDeps): TrayController {
  const file = join(app.getPath('userData'), 'window.json')
  let prefs = (() => {
    try {
      return parseTrayPrefs(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return parseTrayPrefs(null)
    }
  })()
  const save = (): void => {
    // 合并写入：window.json 里还有窗口位置（app/window-state.ts），不能整个覆盖
    mergeWindowFile(file, { ...prefs })
  }

  const images = new Map<string, NativeImage>()
  const image = (name: string): NativeImage => {
    let img = images.get(name)
    if (!img) {
      const path = join(
        iconDir(),
        process.platform === 'win32' && name.startsWith('tray') ? `${name}.ico` : `${name}.png`,
      )
      img = existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty()
      images.set(name, img)
    }
    return img
  }

  let lastFocused: BrowserWindow | null = null
  // 付款窗口（第三方收银台页）不当主窗口：不记成最近聚焦的、不参与「显示窗口」「还有没有别的可见窗口」「任务栏红点」
  app.on('browser-window-focus', (_e, win) => {
    if (!isPayWindow(win)) lastFocused = win
  })
  const windows = (): BrowserWindow[] => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && !isPayWindow(w))
  const target = (): BrowserWindow | null =>
    lastFocused && !lastFocused.isDestroyed() ? lastFocused : (windows()[0] ?? null)
  const showWindow = (): BrowserWindow => {
    const win = target() ?? deps.createWindow()
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return win
  }
  const command = (cmd: TrayCommand): void => {
    const win = showWindow()
    // 刚新建的窗口还没加载完、界面崩溃重新加载中：等页面好了再发，只留最后一条（app/rendererHealth.ts）
    sendWhenReady(win.webContents, 'tray:command', cmd)
  }

  let dndUntil: number | null = null
  let status: TrayStatus = { running: [], waiting: [] }
  let shownIcon: TrayIconName | null = null
  let shownMenu: string | null = null
  let shownOverlay: string | null = null
  const tray = new Tray(image('tray'))
  const t = (): Text => trayText(windowLocale(target()))

  const quit = async (): Promise<void> => {
    const running = status.running.length + status.waiting.length
    if (running > 0) {
      const text = t()
      const { response } = await dialog.showMessageBox({
        type: 'question',
        title: text('tray.quitTitle'),
        message: text('tray.quitMessage', { p0: running }),
        buttons: [text('tray.quitCancel'), text('tray.quitConfirm')],
        defaultId: 0,
        cancelId: 0,
      })
      if (response !== 1) return
    }
    deps.quit()
  }

  const refresh = (): void => {
    if (tray.isDestroyed()) return
    status = trayStatus(ctx.engine?.sessions() ?? [])
    const icon = trayIcon(status)
    if (icon !== shownIcon) {
      tray.setImage(image(icon))
      shownIcon = icon
    }
    const text = t()
    const now = Date.now()
    const dnd = dndUntil !== null && dndUntil > now
    // 流式输出时会话状态每 250ms 变一次，但托盘看的内容多半没变：签名一样就不重设提示、菜单、叠加图标
    const base = [windowLocale(target()), icon, dnd, status.running, status.waiting]
    const menuSig = JSON.stringify(base)
    if (menuSig !== shownMenu) {
      shownMenu = menuSig
      tray.setToolTip(trayTooltip(status, text))
      tray.setContextMenu(
        Menu.buildFromTemplate(
          trayMenu(
            status,
            { t: text, dndUntil, now },
            {
              show: () => void showWindow(),
              newTask: () => command({ kind: 'newTask' }),
              open: sessionId => command({ kind: 'openSession', sessionId }),
              // 菜单可能很久才重建一次：「勿扰 1 小时」按点击那一刻算，不用建菜单时的时间
              dnd: until => command({ kind: 'dnd', until: until === null ? null : until - now + Date.now() }),
              checkUpdate: () => command({ kind: 'checkUpdate' }),
              quit: () => void quit(),
            },
          ),
        ),
      )
    }
    // 任务栏按钮上的红点：有会话等你处理（Windows）
    if (process.platform === 'win32') {
      const wins = windows()
      const overlaySig = JSON.stringify([wins.map(w => w.id), status.waiting.length > 0, windowLocale(target())])
      if (overlaySig !== shownOverlay) {
        shownOverlay = overlaySig
        for (const win of wins)
          win.setOverlayIcon(status.waiting.length ? image('overlay-attention') : null, text('tray.overlay'))
      }
    }
  }

  // 会话状态变了就重算（合并 250ms 内的多次变化）
  let timer: NodeJS.Timeout | null = null
  ctx.hostListeners.add((e: HostEvent) => {
    if (e.kind !== 'sessions' && e.kind !== 'session') return
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      refresh()
    }, 250)
  })
  // 勿扰到期后菜单换回「勿扰 1 小时」
  setInterval(() => {
    if (dndUntil !== null && dndUntil <= Date.now()) {
      dndUntil = null
      refresh()
    }
  }, 60_000).unref()
  app.on('browser-window-created', (_event, win) => {
    // 窗口从托盘重新显示 / 还原后，Windows 任务栏按钮是重建的，叠加图标会丢：清掉已显示记录让它补上
    const redo = (): void => {
      shownOverlay = null
      refresh()
    }
    win.on('show', redo)
    win.on('restore', redo)
    setTimeout(refresh, 0)
  })

  tray.on('click', () => void showWindow())
  tray.on('double-click', () => void showWindow())

  ipc.on('tray:dnd', (_event, until: unknown) => {
    const next = typeof until === 'number' && Number.isFinite(until) && until > Date.now() ? until : null
    if (next === dndUntil) return
    dndUntil = next
    refresh()
  })
  const publicPrefs = (): TrayPrefs => ({ closeToTray: prefs.closeToTray })
  ipc.handle('tray:prefs', () => publicPrefs(), { deny: '不允许的调用方' })
  ipc.handle(
    'tray:setPrefs',
    (_event, patch: unknown) => {
      const value = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
      if ('closeToTray' in value && typeof value.closeToTray !== 'boolean') throw new Error('参数错误')
      prefs = { ...prefs, ...(typeof value.closeToTray === 'boolean' && { closeToTray: value.closeToTray }) }
      save()
      return publicPrefs()
    },
    { deny: '不允许的调用方' },
  )

  refresh()
  return {
    shouldHideOnClose: win =>
      prefs.closeToTray && !tray.isDestroyed() && !windows().some(w => w !== win && w.isVisible()),
    hide: win => {
      win.hide()
      if (prefs.hintShown || !Notification.isSupported()) return
      prefs = { ...prefs, hintShown: true }
      save()
      const text = t()
      const n = new Notification({ title: text('tray.hiddenTitle'), body: text('tray.hiddenBody'), silent: true })
      n.on('click', () => void showWindow())
      n.show()
    },
    showWindow,
    refresh,
  }
}

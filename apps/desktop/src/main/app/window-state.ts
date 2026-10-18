// 主窗口位置 / 大小的读取与保存（存在 userData/window.json 的 windowState 字段）。
// 保存时机：移动、缩放后 400ms 防抖；关闭时同步写一次。
// 不存的情况：
// - 全屏：getNormalBounds 此时不可靠，保留上一次的值（macOS 全屏动画约 0.7 秒，比防抖还长，动画期间也不存）
// - 吸附布局（window-controls 的 snap）：存吸附前的窗口位置和最大化标记，下次启动不会被卡在 1/3 屏的小窗口里
// - 最大化：存还原后的位置，另存 maximized 标记，启动时再最大化
import { app, screen, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { parseSavedWindowState, sanitizeWindowBounds, type Rect, type SavedWindowState } from './window-bounds'
import { mergeWindowFile, readWindowFile } from './windowFile'
import { snapRestoreBounds, snapRestoreMaximized } from './window-controls'

const file = (): string => join(app.getPath('userData'), 'window.json')
const rectOf = (b: Electron.Rectangle): Rect => ({ x: b.x, y: b.y, width: b.width, height: b.height })

/** 离开全屏后再等这么久才恢复保存（动画收尾期间 bounds 还在变） */
const FULLSCREEN_SETTLE_MS = 800

/** 启动时用：读出存的状态并对着当前显示器校验；没存过时 maximized 为 false，位置居中在主屏 */
export function resolveInitialWindow(
  defaults: { width: number; height: number },
  min: { width: number; height: number },
): { bounds: Rect; maximized: boolean } {
  const saved = parseSavedWindowState(readWindowFile(file()).windowState)
  const bounds = sanitizeWindowBounds(
    saved,
    screen.getAllDisplays().map(d => rectOf(d.workArea)),
    rectOf(screen.getPrimaryDisplay().workArea),
    defaults,
    min,
  )
  return { bounds, maximized: saved?.maximized === true }
}

/** 跟踪窗口，随时间保存位置；initialMaximized 是启动时恢复出来的最大化状态 */
export function trackWindowState(win: BrowserWindow, initialMaximized = false): void {
  let timer: NodeJS.Timeout | null = null
  let settleTimer: NodeJS.Timeout | null = null
  // 自己记最大化状态：Windows 上最小化时 isMaximized() 是 false，最大化 → 最小化 → 关闭会丢掉最大化
  let maximized = initialMaximized
  // 全屏切换动画进行中
  let transitioning = false
  const save = (debounced: boolean): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (win.isDestroyed() || win.isFullScreen()) return
    if (debounced && transitioning) return
    // 吸附中：存吸附前的位置和最大化标记
    const bounds = snapRestoreBounds(win) ?? win.getNormalBounds()
    const isMax = snapRestoreMaximized(win) ?? (win.isMinimized() ? maximized : win.isMaximized())
    const state: SavedWindowState = { ...rectOf(bounds), maximized: isMax }
    mergeWindowFile(file(), { windowState: state })
  }
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => save(true), 400)
    timer.unref()
  }
  const begin = (): void => {
    transitioning = true
    // 动画期间排队的保存作废（isFullScreen() 在动画中途不一定已经是 true）
    if (timer) clearTimeout(timer)
    timer = null
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', () => {
    maximized = true
    later()
  })
  win.on('unmaximize', () => {
    maximized = false
    later()
  })
  win.on('enter-full-screen', begin)
  win.on('leave-full-screen', () => {
    begin()
    settleTimer = setTimeout(() => {
      transitioning = false
      settleTimer = null
      later()
    }, FULLSCREEN_SETTLE_MS)
    settleTimer.unref()
  })
  // close 事件里同步写（关到托盘时也会走到，无妨）
  win.on('close', () => save(false))
  win.once('closed', () => {
    if (timer) clearTimeout(timer)
    if (settleTimer) clearTimeout(settleTimer)
  })
}

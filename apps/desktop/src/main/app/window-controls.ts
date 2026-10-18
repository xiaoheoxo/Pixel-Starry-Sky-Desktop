import { BrowserWindow, screen, type IpcMainInvokeEvent } from 'electron'
import * as ipc from '../ipc/guard'
import { sendTo } from './rendererHealth'
import type { WindowSnapLayout, WindowState } from '../../shared/types/window'

interface Zone {
  x: number
  y: number
  width: number
  height: number
}

const SNAP_ZONES: Record<WindowSnapLayout, Zone[]> = {
  'columns-2': [
    { x: 0, y: 0, width: 1 / 2, height: 1 },
    { x: 1 / 2, y: 0, width: 1 / 2, height: 1 },
  ],
  'columns-3': [
    { x: 0, y: 0, width: 1 / 3, height: 1 },
    { x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
    { x: 2 / 3, y: 0, width: 1 / 3, height: 1 },
  ],
  'large-left': [
    { x: 0, y: 0, width: 2 / 3, height: 1 },
    { x: 2 / 3, y: 0, width: 1 / 3, height: 1 / 2 },
    { x: 2 / 3, y: 1 / 2, width: 1 / 3, height: 1 / 2 },
  ],
  'large-right': [
    { x: 0, y: 0, width: 1 / 3, height: 1 / 2 },
    { x: 0, y: 1 / 2, width: 1 / 3, height: 1 / 2 },
    { x: 1 / 3, y: 0, width: 2 / 3, height: 1 },
  ],
  'grid-4': [
    { x: 0, y: 0, width: 1 / 2, height: 1 / 2 },
    { x: 1 / 2, y: 0, width: 1 / 2, height: 1 / 2 },
    { x: 0, y: 1 / 2, width: 1 / 2, height: 1 / 2 },
    { x: 1 / 2, y: 1 / 2, width: 1 / 2, height: 1 / 2 },
  ],
  'wide-center': [
    { x: 0, y: 0, width: 1 / 4, height: 1 },
    { x: 1 / 4, y: 0, width: 1 / 2, height: 1 },
    { x: 3 / 4, y: 0, width: 1 / 4, height: 1 },
  ],
}

const LAYOUTS = new Set<WindowSnapLayout>(Object.keys(SNAP_ZONES) as WindowSnapLayout[])
const snappedWindows = new WeakMap<
  BrowserWindow,
  { bounds: Electron.Rectangle; minimum: number[]; maximized: boolean }
>()

/** 吸附前窗口是不是最大化的（没吸附返回 null）；保存窗口状态时用，免得吸附后把 maximized 存成 false */
export function snapRestoreMaximized(win: BrowserWindow): boolean | null {
  return snappedWindows.get(win)?.maximized ?? null
}

/** 吸附布局中的窗口：吸附前的位置大小（没吸附返回 null），保存窗口位置时用 */
export function snapRestoreBounds(win: BrowserWindow): Electron.Rectangle | null {
  return snappedWindows.get(win)?.bounds ?? null
}

export function snapBounds(
  area: Electron.Rectangle,
  layout: WindowSnapLayout,
  index: number,
): Electron.Rectangle | null {
  const zone = SNAP_ZONES[layout]?.[index]
  if (!zone) return null
  const left = Math.round(area.width * zone.x)
  const top = Math.round(area.height * zone.y)
  const right = Math.round(area.width * (zone.x + zone.width))
  const bottom = Math.round(area.height * (zone.y + zone.height))
  if (right - left < 400 || bottom - top < 300) return null
  return { x: area.x + left, y: area.y + top, width: right - left, height: bottom - top }
}

/** 调用方所在的窗口。来源、主框架和窗口是否存在已由 ipc/guard 校验过。 */
function callingWindow(event: IpcMainInvokeEvent): BrowserWindow {
  return BrowserWindow.fromWebContents(event.sender)!
}

/** 来源或框架不对：「不允许的调用方」；调用方没有窗口或窗口已销毁：「窗口已经关闭」，都不回退到其他窗口。 */
const callerOnly = { deny: '不允许的调用方', noWindow: '窗口已经关闭', looseOwner: true } as const

function state(win: BrowserWindow): WindowState {
  return { maximized: win.isMaximized(), focused: win.isFocused(), snapped: snappedWindows.has(win) }
}

export function initWindowControls(): void {
  ipc.handle('window:getState', event => state(callingWindow(event)), callerOnly)
  ipc.handle(
    'window:minimize',
    event => {
      callingWindow(event).minimize()
    },
    callerOnly,
  )
  ipc.handle(
    'window:toggleMaximize',
    event => {
      const win = callingWindow(event)
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    },
    callerOnly,
  )
  ipc.handle(
    'window:snap',
    (event, layout: WindowSnapLayout, zone: number) => {
      const win = callingWindow(event)
      if (!LAYOUTS.has(layout) || !Number.isInteger(zone)) throw new Error('窗口布局不正确')
      const zones = SNAP_ZONES[layout]
      const selected = zones[zone]
      if (!selected) throw new Error('窗口区域不正确')
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      const bounds = snapBounds(area, layout, zone)
      if (!bounds) throw new Error('当前显示器空间不足，无法使用这个区域')
      if (!snappedWindows.has(win))
        snappedWindows.set(win, {
          bounds: win.getNormalBounds(),
          minimum: win.getMinimumSize(),
          maximized: win.isMaximized(),
        })
      if (win.isMaximized()) win.unmaximize()
      // 布局模式允许小于普通窗口的 1100×700；最小保持单窗格可用的 400×300。
      win.setMinimumSize(400, 300)
      win.setBounds(bounds)
      sendTo(win.webContents, 'window:state', state(win))
    },
    callerOnly,
  )
  ipc.handle(
    'window:snapOptions',
    event => {
      const win = callingWindow(event)
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      return Object.fromEntries(
        [...LAYOUTS].map(layout => [
          layout,
          SNAP_ZONES[layout].map((_, zone) => snapBounds(area, layout, zone) !== null),
        ]),
      )
    },
    callerOnly,
  )
  ipc.handle(
    'window:restoreSnap',
    event => {
      const win = callingWindow(event)
      const saved = snappedWindows.get(win)
      if (!saved) return
      if (win.isMaximized()) win.unmaximize()
      snappedWindows.delete(win)
      win.setMinimumSize(saved.minimum[0], saved.minimum[1])
      win.setBounds(saved.bounds)
      sendTo(win.webContents, 'window:state', state(win))
    },
    callerOnly,
  )
  // 复用现有 close 事件与文件保存确认，不能用 destroy / app.exit 绕过。
  ipc.handle(
    'window:close',
    event => {
      callingWindow(event).close()
    },
    callerOnly,
  )
}

export function observeWindowControls(win: BrowserWindow): void {
  const publish = (): void => {
    if (!win.isDestroyed()) sendTo(win.webContents, 'window:state', state(win))
  }
  win.on('maximize', publish)
  win.on('unmaximize', publish)
  win.on('focus', publish)
  win.on('blur', publish)
  win.on('restore', publish)
}

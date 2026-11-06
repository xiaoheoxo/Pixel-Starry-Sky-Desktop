import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { release } from 'node:os'
import * as ipc from '../ipc/guard'

// 毛玻璃透桌面用的系统材质（docs/ui/glass-effect.md）。窗口创建时还是不透明的，界面读完设置才打开。

const WINDOWS_MATERIALS = ['acrylic', 'mica', 'tabbed']
const MAC_MATERIALS = ['under-window', 'sidebar', 'hud', 'fullscreen-ui']
/** Windows 11 22H2 的内部版本号：更早的系统 setBackgroundMaterial 不生效 */
const WIN11_22H2_BUILD = 22621

const TRANSPARENT = '#00000000'
const glassWindows = new WeakSet<BrowserWindow>()

/** 这台电脑能用的材质，空数组表示不能透桌面 */
export function glassMaterials(platform: string = process.platform, osRelease: string = release()): string[] {
  if (platform === 'darwin') return MAC_MATERIALS
  if (platform !== 'win32') return []
  return Number(osRelease.split('.')[2]) >= WIN11_22H2_BUILD ? WINDOWS_MATERIALS : []
}

/** 开着材质时窗口底色必须透明：主题切换同步底色的地方要跳过 */
export function hasGlass(win: BrowserWindow): boolean {
  return glassWindows.has(win)
}

const callerOnly = { deny: '不允许的调用方', noWindow: '窗口已经关闭', looseOwner: true } as const

function setGlass(event: IpcMainInvokeEvent, material: unknown, base: unknown): void {
  const win = BrowserWindow.fromWebContents(event.sender)!
  const wanted = typeof material === 'string' && glassMaterials().includes(material) ? material : null
  if (wanted) {
    glassWindows.add(win)
    win.setBackgroundColor(TRANSPARENT)
  } else {
    glassWindows.delete(win)
    if (typeof base === 'string' && /^#[0-9a-f]{6}$/i.test(base)) win.setBackgroundColor(base)
  }
  if (process.platform === 'darwin') win.setVibrancy(wanted as Parameters<BrowserWindow['setVibrancy']>[0])
  else if (process.platform === 'win32' && glassMaterials().length)
    win.setBackgroundMaterial((wanted ?? 'none') as Parameters<BrowserWindow['setBackgroundMaterial']>[0])
}

export function initGlass(): void {
  ipc.handle('window:glassMaterials', () => glassMaterials(), callerOnly)
  ipc.handle('window:setGlass', setGlass, callerOnly)
}

// 设置独立窗口（settings-window.ts）的登记处：只记「这个 BrowserWindow 是设置窗口」。
// 单独成文件是为了避开循环 import：tray.ts、ui-language.ts 要在挑主窗口、设标题时跳过它，而 settings-window.ts 本身依赖它们。
import type { BrowserWindow } from 'electron'

const settingsWindows = new WeakSet<BrowserWindow>()

export function markSettingsWindow(win: BrowserWindow): void {
  settingsWindows.add(win)
}

/** 是不是设置窗口：不当「主窗口」去显示 / 聚焦 / 算托盘角标，也不算「还有别的可见窗口」 */
export function isSettingsWindow(win: BrowserWindow): boolean {
  return settingsWindows.has(win)
}

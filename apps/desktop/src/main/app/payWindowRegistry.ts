// 付款窗口（main/account/pay-window.ts）的登记处：只记「这个 BrowserWindow 是付款窗口」。
// 单独成文件是为了避开循环 import：account.ts、app/events.ts、app/tray.ts 要在广播 / 挑主窗口时跳过付款窗口，
// 而 pay-window.ts 本身又依赖 account.ts；这里不依赖任何业务模块。pay-window.ts 重新导出 isPayWindow。
import type { BrowserWindow } from 'electron'

const payWindows = new WeakSet<BrowserWindow>()

export function markPayWindow(win: BrowserWindow): void {
  payWindows.add(win)
}

/**
 * 是不是付款窗口：里面是第三方收银台网页，不能收到软件的广播（账号状态、会话事件……），
 * 也不能被当成「主窗口」去显示 / 聚焦 / 取语言 / 取进程号
 */
export function isPayWindow(win: BrowserWindow): boolean {
  return payWindows.has(win)
}

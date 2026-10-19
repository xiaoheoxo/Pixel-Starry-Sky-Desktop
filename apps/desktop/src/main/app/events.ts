import { BrowserWindow } from 'electron'
import type { IPC_CONTRACT, IpcChannelName } from '@pixelsky/protocol'
import { isPayWindow } from './payWindowRegistry'
import { sendTo } from './rendererHealth'

/** 契约里主进程推给渲染进程的通道 */
export type PushChannel = {
  [C in IpcChannelName]: (typeof IPC_CONTRACT)[C]['kind'] extends 'push' ? C : never
}[IpcChannelName]

/** 推给所有窗口的事件。只发给还没销毁、没崩溃、不在恢复中的窗口；发给单个窗口的事件（终端输出等）仍由各模块自己发。 */
export class EventBus {
  /** 想和窗口看到同一份事件的模块（手机端，main/mobile/）；在发给窗口之前调用 */
  readonly taps = new Set<(channel: PushChannel, args: unknown[]) => void>()
  broadcast(channel: PushChannel, ...args: unknown[]): void {
    for (const tap of this.taps) tap(channel, args)
    // 界面崩溃、重新加载还没报到时 sendTo 会丢掉并计数（app/rendererHealth.ts）
    // 付款窗口里是第三方收银台网页，不广播给它
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed() && !isPayWindow(win)) sendTo(win.webContents, channel, ...args)
  }
}

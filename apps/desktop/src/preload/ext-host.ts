// 脚本扩展宿主页面的 preload（docs/ui/extension-commands-plan.md §2）：只把主进程给的开 / 关和端口转给页面，不暴露任何能力。
// 只跑在宿主的顶层页面，iframe 和脚本的 Worker 都没有它
import { ipcRenderer } from 'electron'

// 这个 preload 的类型检查没有 DOM
declare const window: { postMessage(message: unknown, origin: string, transfer: readonly unknown[]): void }

ipcRenderer.on('extHost:control', (event, message) => window.postMessage(message, '*', event.ports))

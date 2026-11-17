/** 点选元素批注里可以取消勾选的项 */
export type ElementNoteField = 'route' | 'selector' | 'element' | 'shot'
export interface BrowserAnnotation {
  id: string
  text: string
  url: string
  // 以下是点选元素批注才有的（docs/ui/element-annotation.md）；整页批注只有上面三项
  /** 路由（URL 的 path） */
  route?: string
  selector?: string
  /** 标签名.类名，如 button.primary */
  label?: string
  /** 元素文字（前 80 字） */
  element?: string
  size?: { width: number; height: number }
  /** 元素截图（JPEG data URL，长边 ≤ 720） */
  shot?: string
  shotSize?: { width: number; height: number }
  /** 用户取消勾选的项：不写进发给会话的文字（截图取消了就不截） */
  off?: ElementNoteField[]
  /** 页面里已经找不到这个元素（只在广播里带，不落盘） */
  missing?: boolean
}
export interface BrowserPage {
  id: string
  url: string
  title: string
  loading: boolean
  error: string | null
  canBack: boolean
  canForward: boolean
  /** 正在点选元素（启动时清零） */
  picking?: boolean
  annotations: BrowserAnnotation[]
  /** Original remote address; the local SSH forwarding port is never the saved workspace target. */
  remoteUrl?: string
  /** 这一页的控制台错误和失败请求（运行胶囊，docs/ui/panel-pill.md §8.1）；只在广播里带，不落盘，换页清零 */
  issues?: { errors: number; requests: number; last: string[]; warnings?: number }
  /** 整页打不开（docs/ui/browser-v2.md §3.1 错误页）：Chromium 的网络错误码（负数），网页崩溃为 0；重新加载时清掉，不落盘 */
  failed?: number
  /** 网站图标（data URL，≤ 32 KB）；只在广播里带，不落盘 */
  favicon?: string
  /** 网页缩放（1 = 100%，按网站记住；docs/ui/browser-v2.md §3.2）；只在广播里带，100% 时没有 */
  zoom?: number
}

/** 控制台抽屉的一条（docs/ui/browser-v2.md §3.2）：只在主进程内存里，抽屉打开时才取 */
export interface BrowserIssueEntry {
  kind: 'error' | 'warning' | 'request'
  text: string
  /** 控制台：文件:行；请求：方法和资源类型 */
  source: string
  at: number
}

/** 整页截图最长这么多 CSS 像素，超出的截掉 */
export const BROWSER_CAPTURE_MAX_HEIGHT = 8000
/** 截图（docs/ui/browser-v2.md §3.2）：JPEG 的 base64；整页超过最长高度时截断 */
export interface BrowserCapture {
  dataBase64: string
  width: number
  height: number
  truncated: boolean
}
export interface BrowserState {
  scope: string
  pages: BrowserPage[]
  activeId: string | null
  /** 这个工作区最近打开过的地址（新的在前，最多 8 个；远端工作区是原地址，不是本机转发端口） */
  recent?: string[]
}

/** 浏览器快捷键（docs/ui/browser-v2.md §3.1）：焦点在浏览器标签里、包括网页里时生效 */
export type BrowserShortcut =
  | 'address'
  | 'reload'
  | 'hardReload'
  | 'newPage'
  | 'closePage'
  | 'back'
  | 'forward'
  | 'find'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'devtools'

/** 按键 → 浏览器快捷键；主进程（网页有焦点时）和界面共用。mod 是 Windows / Linux 的 Ctrl、macOS 的 ⌘ */
export function browserShortcut(
  e: { key: string; code?: string; mod: boolean; shift: boolean; alt: boolean },
  mac: boolean,
): BrowserShortcut | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (e.alt) {
    // macOS 的开发者工具 ⌥⌘I（按着 ⌥ 时 key 是别的字符，看 code）
    if (mac && e.mod && !e.shift && e.code === 'KeyI') return 'devtools'
    if (mac || e.mod || e.shift) return null
    return key === 'ArrowLeft' ? 'back' : key === 'ArrowRight' ? 'forward' : null
  }
  if (!e.mod) {
    if (e.shift) return null
    return key === 'F5' ? 'reload' : key === 'F6' ? 'address' : key === 'F12' ? 'devtools' : null
  }
  if (key === 'r') return e.shift ? 'hardReload' : 'reload'
  // 放大在美式键盘上常按成 Ctrl+Shift+=（+），缩小可能带 Shift（_）
  if (key === '=' || key === '+') return 'zoomIn'
  if (key === '-' || key === '_') return 'zoomOut'
  if (e.shift) return null
  if (key === '0') return 'zoomReset'
  if (key === 'f') return 'find'
  if (key === 'l') return 'address'
  if (key === 't') return 'newPage'
  if (key === 'w') return 'closePage'
  if (mac && key === '[') return 'back'
  if (mac && key === ']') return 'forward'
  return null
}

/** 运行胶囊「把错误发给 AI」放进输入框的那段（docs/ui/panel-pill.md §8.1）：给 AI 看的，不走界面词典 */
export function browserIssueText(url: string, total: number, lines: readonly string[]): string {
  return `内置浏览器 ${url} 的错误（共 ${total} 个，下面是最近几条）：\n\`\`\`\n${lines.join('\n')}\n\`\`\``
}

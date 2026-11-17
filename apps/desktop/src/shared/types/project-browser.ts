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
  /** 设备尺寸、网页主题（docs/ui/browser-v2.md §3.3、§10）；按工作区记，没有时是自适应 + 跟随系统 */
  preview?: BrowserPreview
}

// ---- 第三批：设备尺寸、网页主题（docs/ui/browser-v2.md §3.3、§10）----
export type BrowserDeviceId = 'responsive' | 'phone' | 'phoneLarge' | 'tablet' | 'laptop' | 'custom'
export type BrowserDeviceKind = 'phone' | 'tablet' | 'desktop'
export type BrowserPageTheme = 'system' | 'light' | 'dark'
export interface BrowserPreview {
  device: BrowserDeviceId
  /** 自定义时的宽高（CSS 像素） */
  width?: number
  height?: number
  /** 横过来（宽高对调） */
  landscape?: boolean
  theme?: BrowserPageTheme
}
/** 预设设备（竖着的宽高） */
export const BROWSER_DEVICES: Record<
  'phone' | 'phoneLarge' | 'tablet' | 'laptop',
  { width: number; height: number; kind: BrowserDeviceKind }
> = {
  phone: { width: 390, height: 844, kind: 'phone' },
  phoneLarge: { width: 430, height: 932, kind: 'phone' },
  tablet: { width: 820, height: 1180, kind: 'tablet' },
  laptop: { width: 1280, height: 800, kind: 'desktop' },
}
export const BROWSER_DEVICE_IDS: BrowserDeviceId[] = ['responsive', 'phone', 'phoneLarge', 'tablet', 'laptop', 'custom']
export const CUSTOM_SIZE = { min: 200, max: 4000, width: 1024, height: 768 }

const clampSize = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(CUSTOM_SIZE.max, Math.max(CUSTOM_SIZE.min, Math.round(v)))
    : fallback

/** 校验、补全界面传来的设置（坏的字段用默认值）；自适应 + 跟随系统时返回 null（不用存） */
export function cleanPreview(raw: unknown): BrowserPreview | null {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const device = BROWSER_DEVICE_IDS.includes(v.device as BrowserDeviceId) ? (v.device as BrowserDeviceId) : 'responsive'
  const theme: BrowserPageTheme = v.theme === 'light' || v.theme === 'dark' ? v.theme : 'system'
  if (device === 'responsive' && theme === 'system') return null
  return {
    device,
    ...(device === 'custom'
      ? { width: clampSize(v.width, CUSTOM_SIZE.width), height: clampSize(v.height, CUSTOM_SIZE.height) }
      : {}),
    ...(device !== 'responsive' && v.landscape === true ? { landscape: true } : {}),
    ...(theme !== 'system' ? { theme } : {}),
  }
}

/** 设备的 CSS 尺寸（横着时对调）和种类；自适应时 null */
export function deviceSize(
  preview: BrowserPreview | null | undefined,
): { width: number; height: number; kind: BrowserDeviceKind } | null {
  if (!preview || preview.device === 'responsive') return null
  const base =
    preview.device === 'custom'
      ? {
          width: clampSize(preview.width, CUSTOM_SIZE.width),
          height: clampSize(preview.height, CUSTOM_SIZE.height),
          kind: 'desktop' as const,
        }
      : BROWSER_DEVICES[preview.device]
  return preview.landscape ? { width: base.height, height: base.width, kind: base.kind } : base
}

/** 设备框放进网页区：只缩小不放大、居中；scale 是设备 CSS 像素到网页区像素的比例 */
export function fitDevice(
  box: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number; width: number; height: number; scale: number } {
  const scale = Math.max(0.05, Math.min(1, box.width / size.width, box.height / size.height))
  const width = Math.round(size.width * scale),
    height = Math.round(size.height * scale)
  return {
    x: Math.round(box.x + (box.width - width) / 2),
    y: Math.round(box.y + (box.height - height) / 2),
    width,
    height,
    scale,
  }
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

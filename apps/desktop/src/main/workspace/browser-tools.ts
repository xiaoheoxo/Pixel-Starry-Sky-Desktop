// 内置浏览器第二批（docs/ui/browser-v2.md §3.2）：查找、缩放档位、截图、开发者工具、清网站数据。
// 只管对一个网页做事；哪个网页、权限和广播在 browser.ts
import { nativeImage, type NativeImage, type Session, type WebContents } from 'electron'
import { BROWSER_CAPTURE_MAX_HEIGHT, type BrowserCapture } from '../../shared/types/project-browser'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 缩放档位（和 Chrome 一样） */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

export type ZoomMove = 'in' | 'out' | 'reset'
export const isZoomMove = (v: unknown): v is ZoomMove => v === 'in' || v === 'out' || v === 'reset'

/** 下一档；当前不在档位上时（别处改过）就近往上 / 往下 */
export function nextZoom(current: number, move: ZoomMove): number {
  if (move === 'reset') return 1
  if (move === 'in') return ZOOM_STEPS.find(z => z > current + 0.001) ?? ZOOM_STEPS.at(-1)!
  return [...ZOOM_STEPS].reverse().find(z => z < current - 0.001) ?? ZOOM_STEPS[0]
}

/** 记缩放用的网站：http / https 是主机名（Chromium 也按主机名同步缩放），项目里的本地文件算一个；别的不记 */
export function zoomSiteOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return 'file:'
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null
  } catch {
    return null
  }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i

/** 新窗口链接直接在内置浏览器开（docs/ui/browser-v2.md §3.3）：本机地址，或者和打开它的网页同一个主机（http / https） */
export function opensInside(url: string, opener: string): boolean {
  try {
    const target = new URL(url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
    if (LOCAL_HOST.test(target.hostname)) return true
    return new URL(opener).hostname === target.hostname
  } catch {
    return false
  }
}

/** 本地文件自动刷新：这些文件变了才刷新网页（日志、数据库、node_modules 这类不算） */
export function reloadsPage(path: string): boolean {
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(path)) return false
  return /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?)$/i.test(path)
}

const foldCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** file:// 网页所在的目录，相对项目根、用 /（就在根上是 ''）；不是本地文件或不在项目里时 null */
export function pageDirIn(root: string, url: string): string | null {
  let file: string
  try {
    file = fileURLToPath(url)
  } catch {
    return null
  }
  const rel = relative(root, dirname(file))
  // 叫 ..x 的文件夹在项目里，只有 .. 本身或 ../ 开头才是项目外
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
  return foldCase(rel.split(sep).join('/'))
}

/**
 * 项目里这个文件变了要不要刷新网页（docs/ui/browser-v2.md §3.3）：只看网页所在目录和它下面的。
 * 原来整个项目任何一个 .json / .js 变了都刷新，项目里跑测试、构建时网页一秒刷一次，还会抢走输入框的焦点
 */
export function reloadsFor(path: string, pageDir: string): boolean {
  if (!reloadsPage(path)) return false
  const p = foldCase(path)
  return pageDir === '' || p.startsWith(pageDir + '/')
}

/** 记住的缩放：按网站（zoomSiteOf），100% 不记，最多记这么多个网站 */
export const ZOOM_SITES_MAX = 200
export function rememberZoom(map: Record<string, number> | undefined, origin: string, zoom: number) {
  const next = { ...map }
  delete next[origin]
  if (Math.abs(zoom - 1) > 0.001) next[origin] = zoom
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - ZOOM_SITES_MAX))) delete next[key]
  return next
}

/** 查找：发一次请求，等这次的最终结果（2 秒没结果当没找到）。next：接着上一次找下一个 / 上一个 */
export function findOnce(
  wc: WebContents,
  text: string,
  opts: { forward: boolean; next: boolean },
): Promise<{ active: number; total: number }> {
  if (!text) {
    wc.stopFindInPage('clearSelection')
    return Promise.resolve({ active: 0, total: 0 })
  }
  return new Promise(resolve => {
    let id = -1
    const done = (r: { active: number; total: number }): void => {
      clearTimeout(timer)
      wc.off('found-in-page', on)
      resolve(r)
    }
    const on = (_e: unknown, r: Electron.Result): void => {
      if (r.requestId === id && r.finalUpdate) done({ active: r.activeMatchOrdinal, total: r.matches })
    }
    const timer = setTimeout(() => done({ active: 0, total: 0 }), 2000)
    wc.on('found-in-page', on)
    // findNext 为 true 是「开始新的一次查找」，接着找时为 false
    id = wc.findInPage(text, { forward: opts.forward, findNext: !opts.next })
  })
}

/** 截图最宽、整页最长（超出的截掉） */
export const CAPTURE_MAX_WIDTH = 2000
export const CAPTURE_MAX_HEIGHT = BROWSER_CAPTURE_MAX_HEIGHT

const timeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('截图超时了')), ms))])

/** 图片按实际像素压到最宽、最长以内（网页缩放、高分屏会让像素比 CSS 尺寸大），转成 JPEG */
function fitImage(image: NativeImage, truncated: boolean): BrowserCapture {
  const size = image.getSize(),
    k = Math.min(1, CAPTURE_MAX_WIDTH / size.width, CAPTURE_MAX_HEIGHT / size.height)
  const out =
    k < 1
      ? image.resize({ width: Math.round(size.width * k), height: Math.round(size.height * k), quality: 'good' })
      : image
  const fit = out.getSize()
  return { dataBase64: out.toJPEG(85).toString('base64'), width: fit.width, height: fit.height, truncated }
}

/**
 * 截图：当前画面用 capturePage；整页用开发者协议的 captureBeyondViewport（别人连着调试器时借用，不断开）。
 * device：正在模拟设备，当前画面也用开发者协议截，得到设备原尺寸，不是缩小后的画面
 */
export async function capturePage(wc: WebContents, full: boolean, device = false): Promise<BrowserCapture> {
  if (device && !full && wc.debugger.isAttached()) {
    const shot = (await timeout(
      wc.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 92 }),
      15000,
    )) as {
      data: string
    }
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
    if (image.isEmpty()) throw new Error('截不到网页画面')
    return fitImage(image, false)
  }
  if (full) {
    const dbg = wc.debugger
    const mine = !dbg.isAttached()
    try {
      if (mine) dbg.attach('1.3')
      const metrics = (await timeout(dbg.sendCommand('Page.getLayoutMetrics'), 5000)) as {
        cssContentSize: { width: number; height: number }
      }
      const width = Math.max(1, Math.ceil(metrics.cssContentSize.width)),
        height = Math.max(1, Math.ceil(metrics.cssContentSize.height))
      // 先按 CSS 尺寸截掉太长的部分，再按实际像素压
      const h = Math.min(height, CAPTURE_MAX_HEIGHT)
      const shot = (await timeout(
        dbg.sendCommand('Page.captureScreenshot', {
          // 长页面的 PNG 太大，用高质量 JPEG 传过来，压完再出一次 JPEG
          format: 'jpeg',
          quality: 92,
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height: h, scale: 1 },
        }),
        15000,
      )) as { data: string }
      const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
      if (image.isEmpty()) throw new Error('截不到网页画面')
      return fitImage(image, height > h)
    } finally {
      if (mine && dbg.isAttached()) dbg.detach()
    }
  }
  let image = await wc.capturePage()
  // 刚关掉菜单、网页视图还没放回来时可能是空的：等一下再截一次
  if (image.isEmpty()) {
    await new Promise(r => setTimeout(r, 250))
    image = await wc.capturePage()
  }
  if (image.isEmpty()) throw new Error('截不到网页画面')
  return fitImage(image, false)
}

/** 开发者工具：开着就关，没开就在独立窗口打开 */
export function toggleDevTools(wc: WebContents): void {
  if (wc.isDevToolsOpened()) wc.closeDevTools()
  else wc.openDevTools({ mode: 'detach', activate: true })
}

/** 清这个网站的 Cookie 和存储；HTTP 缓存只能整个分区清（这个工作区的网页共用一个分区） */
export async function clearSiteData(ses: Session, url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只能清网页的数据')
  await ses.clearStorageData({
    origin: parsed.origin,
    storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'],
  })
  await ses.clearCache()
}

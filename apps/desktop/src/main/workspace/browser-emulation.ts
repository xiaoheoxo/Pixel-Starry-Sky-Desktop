// 内置浏览器第三批（docs/ui/browser-v2.md §3.3、§10）：设备尺寸、触摸、手机标识、网页主题，都用开发者协议的 Emulation。
// 只管一个网页；设置存哪、网页视图摆哪在 browser.ts
import type { WebContents } from 'electron'
import type { BrowserDeviceKind, BrowserPageTheme } from '../../shared/types/project-browser'

export interface EmulationSpec {
  /** 设备的 CSS 尺寸；自适应时 null */
  size: { width: number; height: number; kind: BrowserDeviceKind } | null
  /** 设备 CSS 像素到视图像素的比例（设备框缩小时 < 1） */
  scale: number
  theme: BrowserPageTheme
  /** 正在点选元素：鼠标不当手指用（点选靠悬停） */
  picking: boolean
}

/** 手机 / 平板的浏览器标识：Android 上的 Chrome，版本号用 Electron 自带的 */
export function mobileUserAgent(
  kind: BrowserDeviceKind,
  chrome = process.versions.chrome ?? '140.0.0.0',
): string | null {
  const major = chrome.split('.')[0] + '.0.0.0'
  if (kind === 'phone')
    return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major} Mobile Safari/537.36`
  if (kind === 'tablet')
    return `Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major} Safari/537.36`
  return null
}

/** 什么都不用模拟（自适应 + 跟随系统）：不连调试器 */
export const idleSpec = (s: EmulationSpec): boolean => !s.size && s.theme === 'system'

interface Applied {
  key: string
  ua: string | null
  device: boolean
}
/** 每个网页上次设好的（同样的不重复发）；调试器被断开时清掉 */
const applied = new WeakMap<WebContents, Applied>()
/** 我们连上的调试器（别人连着的只借用，不断开） */
const ours = new WeakSet<WebContents>()
/** 已经挂了「调试器断开」监听的网页（不管谁连的，断开时模拟都没了） */
const watched = new WeakSet<WebContents>()
/** 摆放时会频繁调用：每个网页排队，一次设完再设下一次 */
const queues = new WeakMap<WebContents, Promise<unknown>>()

const specKey = (s: EmulationSpec): string =>
  JSON.stringify([s.size, Math.round(s.scale * 1000) / 1000, s.theme, s.picking])

/**
 * 按设置模拟；和上次一样就什么都不做。手机 / 平板标识变了返回 true（要重新加载才对服务器生效）。
 * 回到什么都不模拟时清掉设置、断开我们连的调试器
 */
export function applyEmulation(wc: WebContents, spec: EmulationSpec): Promise<boolean> {
  const run = (queues.get(wc) ?? Promise.resolve()).catch(() => {}).then(() => applyNow(wc, spec))
  queues.set(wc, run)
  return run
}

async function applyNow(wc: WebContents, spec: EmulationSpec): Promise<boolean> {
  if (wc.isDestroyed()) return false
  const prior = applied.get(wc),
    key = specKey(spec)
  if (prior?.key === key) return false
  const dbg = wc.debugger
  if (idleSpec(spec)) {
    applied.delete(wc)
    if (!prior || !dbg.isAttached()) return false
    await clear(wc)
    if (ours.has(wc)) {
      ours.delete(wc)
      dbg.detach()
    }
    return prior.ua !== null
  }
  if (!watched.has(wc)) {
    watched.add(wc)
    // 被断开（网页崩溃、借用的截图断开、别人接管）：忘掉设过的，下次摆放时重新设
    dbg.on('detach', () => {
      applied.delete(wc)
      ours.delete(wc)
    })
  }
  if (!dbg.isAttached()) {
    dbg.attach('1.3')
    ours.add(wc)
  }
  const send = (method: string, params?: object) => dbg.sendCommand(method, params)
  const touch = !!spec.size && spec.size.kind !== 'desktop'
  if (spec.size)
    await send('Emulation.setDeviceMetricsOverride', {
      width: spec.size.width,
      height: spec.size.height,
      deviceScaleFactor: 0,
      mobile: touch,
      scale: spec.scale,
    })
  else await send('Emulation.clearDeviceMetricsOverride')
  await send('Emulation.setTouchEmulationEnabled', { enabled: touch, ...(touch ? { maxTouchPoints: 5 } : {}) })
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: touch && !spec.picking, configuration: 'mobile' })
  await send('Emulation.setEmulatedMedia', {
    features: spec.theme === 'system' ? [] : [{ name: 'prefers-color-scheme', value: spec.theme }],
  })
  const ua = spec.size ? mobileUserAgent(spec.size.kind) : null
  if (ua !== (prior?.ua ?? null))
    await send('Emulation.setUserAgentOverride', { userAgent: ua ?? wc.session.getUserAgent() })
  applied.set(wc, { key, ua, device: !!spec.size })
  return ua !== (prior?.ua ?? null)
}

async function clear(wc: WebContents): Promise<void> {
  const send = (method: string, params?: object) => wc.debugger.sendCommand(method, params).catch(() => {})
  await send('Emulation.clearDeviceMetricsOverride')
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: false })
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Emulation.setUserAgentOverride', { userAgent: wc.session.getUserAgent() })
}

/** 设好的被别的操作冲掉了（整页截图 captureBeyondViewport 会关掉触摸模拟）：下次照样重发一遍，标识没变不重新加载 */
export function staleEmulation(wc: WebContents): void {
  const prior = applied.get(wc)
  if (prior) applied.set(wc, { ...prior, key: '' })
}

/** 这个网页正在模拟设备（截图用开发者协议截设备原尺寸） */
export const emulatingDevice = (wc: WebContents): boolean => !!applied.get(wc)?.device

/** 测试用：设置的比较键 */
export const _specKey = specKey

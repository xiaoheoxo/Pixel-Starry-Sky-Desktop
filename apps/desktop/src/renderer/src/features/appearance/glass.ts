import { useSyncExternalStore } from 'react'
import type { UiThemeGlass } from '@pixelsky/protocol'
import { getActiveExtTheme, subscribeCustomThemes } from './customTheme'
import {
  applyGlassPreset,
  backdropExtremes,
  DEFAULT_GLASS,
  glassDefaultsOf,
  parseGlassPrefs,
  resolveGlass,
  type GlassEnv,
  type GlassPrefs,
  type GlassResolved,
} from './glassCore'
import { getWallpaper, subscribeWallpaper } from './wallpaper'
import { windowBackground } from './palette'

// 毛玻璃（docs/ui/glass-effect.md）：当前主题带 glass 才生效。调过的数值按主题分开存 localStorage，只在本机。
// 设置窗口只读写设置，本身保持实色，免得调的时候连设置页也看不清。

const KEY = 'pixelsky.glass'
const REDUCED = '(prefers-reduced-transparency: reduce)'
const isSettingsWindow = (): boolean =>
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'settings'

/** 当前主题带玻璃时是它 */
const glassTheme = (): { id: string; glass: UiThemeGlass } | null => {
  const theme = getActiveExtTheme()
  return theme?.glass ? { id: theme.id, glass: theme.glass } : null
}

function readAll(): Record<string, unknown> {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return typeof all === 'object' && all !== null && !Array.isArray(all) ? (all as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function loadPrefs(): GlassPrefs {
  const theme = glassTheme()
  return theme ? parseGlassPrefs(readAll()[theme.id], glassDefaultsOf(theme.glass)) : { ...DEFAULT_GLASS }
}

let prefs = loadPrefs()
let prefsOf = glassTheme()?.id ?? null
let materials: readonly string[] = []
let focused = true
let onBattery = false
let reduced = false
let backdrop: GlassEnv['backdrop'] = null
let backdropOf: string | null = null
let resolved: GlassResolved | null = null
// undefined：这个页面还没同步过。重新加载（含崩溃恢复）后窗口上可能还留着上一次的材质，第一次一定要发
let nativeMaterial: string | null | undefined
let started = false
const listeners = new Set<() => void>()

function environment(): GlassEnv {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const token = (name: string): string => css.getPropertyValue(name).trim()
  return {
    theme: root.dataset.theme === 'dark' ? 'dark' : 'light',
    materials,
    focused,
    onBattery,
    reducedTransparency: reduced,
    hasWallpaper: !!getWallpaper().name,
    backdrop,
    colors: {
      side: token('--wall-sidebar'),
      main: token('--wall-tint'),
      // 提亮开着时 --text-muted 被盖成 secondary，这里只在没提亮时才会用到它
      muted: token('--text-muted'),
      secondary: token('--text-secondary'),
      body: token('--text-body'),
    },
  }
}

const noiseUrl = (grain: number): string => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/><feColorMatrix values='1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 ${grain / 100}'/></filter><rect width='180' height='180' filter='url(#n)'/></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

function applyToWindow(r: GlassResolved): void {
  const root = document.documentElement
  const on = glassTheme() !== null && r.solid === null
  const flag = (name: string, value: boolean): void => {
    if (value) root.dataset[name] = ''
    else delete root.dataset[name]
  }
  flag('glass', on)
  flag('glassBoost', on && prefs.boostMuted)
  flag('glassShadow', on && prefs.textShadow)
  if (on) {
    const set = (name: string, value: string): void => root.style.setProperty(name, value)
    const tint = prefs.tint
    set('--glass-tint-side', tint || 'var(--wall-sidebar)')
    set('--glass-tint-main', tint || 'var(--wall-tint)')
    set('--glass-tint-card', tint || 'var(--wall-surface)')
    set('--glass-side', `${r.alpha.side}%`)
    set('--glass-main', `${r.alpha.main}%`)
    set('--glass-right', `${r.alpha.right}%`)
    set('--glass-card', `${r.alpha.card}%`)
    set('--glass-code', `${r.alpha.code}%`)
    set('--glass-menu', `${r.alpha.menu}%`)
    set('--glass-radius', `${prefs.radius}px`)
    set('--glass-rim', String(prefs.rim / 100))
    set('--glass-edge', `rgba(255, 255, 255, ${Math.max(0.08, (prefs.rim / 100) * 0.6)})`)
    set('--glass-noise', prefs.grain > 0 ? noiseUrl(prefs.grain) : 'none')
  }
  const material = on ? r.material : null
  if (material !== nativeMaterial) {
    nativeMaterial = material
    void window.pixelsky?.window?.setGlass(material, windowBackground())
  }
}

function refresh(): void {
  if (typeof document === 'undefined') return
  const id = glassTheme()?.id ?? null
  if (id !== prefsOf) {
    prefsOf = id
    prefs = loadPrefs()
  }
  const wp = getWallpaper()
  if (backdropOf !== wp.url) {
    backdropOf = wp.url
    backdrop = null
    if (wp.url && wp.kind === 'image') void sampleBackdrop(wp.url)
  }
  resolved = resolveGlass(prefs, environment())
  if (!isSettingsWindow()) applyToWindow(resolved)
  listeners.forEach(l => l())
}

async function sampleBackdrop(url: string): Promise<void> {
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx || backdropOf !== url) return
    ctx.drawImage(img, 0, 0, 16, 16)
    backdrop = backdropExtremes(ctx.getImageData(0, 0, 16, 16).data)
    refresh()
  } catch {
    // 读不了就不算对比度，「自动保证可读」不起作用，设置页会显示没有数字
  }
}

function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  subscribeCustomThemes(refresh)
  subscribeWallpaper(refresh)
  const media = window.matchMedia?.(REDUCED)
  if (media) {
    reduced = media.matches
    media.addEventListener('change', () => {
      reduced = media.matches
      refresh()
    })
  }
  new MutationObserver(refresh).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-custom-theme'],
  })
  window.addEventListener('storage', e => {
    if (e.storageArea !== localStorage || (e.key !== KEY && e.key !== null)) return
    prefs = loadPrefs()
    refresh()
  })
  const bridge = window.pixelsky?.window
  void bridge?.glassMaterials().then(list => {
    materials = list
    refresh()
  })
  bridge?.onState(state => {
    if (state.focused === focused) return
    focused = state.focused
    refresh()
  })
  // 和 layout/perfTier.ts 一样：没有电池的台式机报 charging: true，没有这个接口按插电算
  type Battery = EventTarget & { charging: boolean }
  const nav = navigator as Navigator & { getBattery?: () => Promise<Battery> }
  void nav.getBattery?.().then(battery => {
    const read = (): void => {
      onBattery = !battery.charging
      refresh()
    }
    battery.addEventListener('chargingchange', read)
    read()
  })
  refresh()
}

/** 启动时调一次：读设置、盯着扩展和窗口状态，把效果套到窗口上 */
export function startGlass(): void {
  start()
}

function save(next: GlassPrefs): void {
  const theme = glassTheme()
  if (!theme) return
  prefs = next
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [theme.id]: next }))
  } catch {
    // 存不下只影响下次启动
  }
  refresh()
}

/** 改数值类的项会变成自定义预设 */
export function setGlassPrefs(patch: Partial<GlassPrefs>, opts: { custom?: boolean } = {}): void {
  save({ ...prefs, ...patch, ...(opts.custom && { preset: 'custom' }) })
}

export function selectGlassPreset(id: string, values: UiThemeGlass): void {
  save(applyGlassPreset(prefs, id, values))
}

/** 回到这个主题自己的数值 */
export function resetGlass(): void {
  const theme = glassTheme()
  if (theme) save(glassDefaultsOf(theme.glass))
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getGlassResolved(): GlassResolved | null {
  return resolved
}

export function useGlassResolved(): GlassResolved | null {
  return useSyncExternalStore(subscribe, getGlassResolved)
}

export function useGlassPrefs(): GlassPrefs {
  return useSyncExternalStore(subscribe, () => prefs)
}

export function useGlassMaterials(): readonly string[] {
  return useSyncExternalStore(subscribe, () => materials)
}

/** 玻璃是否正在透壁纸：WallpaperLayer 据此换滤镜、去掉遮罩；透桌面时壁纸不显示 */
export function useGlassOnWindow(): GlassResolved | null {
  const r = useGlassResolved()
  if (isSettingsWindow() || !r || r.solid !== null) return null
  return glassTheme() ? r : null
}

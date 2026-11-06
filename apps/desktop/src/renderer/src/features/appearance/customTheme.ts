// 自定义主题的存取和生效（docs/ui/custom-theme.md）。主题列表和当前 id 在 localStorage（会同步），贴图在 IndexedDB（只在本机）。
// 选中时 <html data-palette> 写基础配色、data-custom-theme 写 id，再注入一段 <style> 盖掉变量。
import { useMemo, useSyncExternalStore, type CSSProperties } from 'react'
import { PALETTE_KEY, applyPaletteAttr, currentPalette, setPalette, type Palette } from './palette'
import { BASE_COLORS, type ThemeColorKey } from './customThemeBase'
import {
  DEFAULT_ART_MASK,
  MAX_THEMES,
  THEME_NAME_MAX,
  parseThemes,
  themeCss,
  type CustomTheme,
  type ThemeMode,
} from './customThemeCore'

export const THEMES_KEY = 'pixelsky.customThemes'
export const ACTIVE_THEME_KEY = 'pixelsky.customTheme'
export const MAX_ART_BYTES = 20 * 1024 * 1024
export const ART_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

const ART_DB = 'pixelsky-theme-art'
const STYLE_ID = 'pixelsky-custom-theme'

export interface CustomThemeState {
  themes: readonly CustomTheme[]
  activeId: string | null
  /** 当前主题贴图的 blob: 地址；没有贴图、这台电脑上没有这张图时为 null */
  artUrl: string | null
}

function load(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

let themesRaw = load(THEMES_KEY)
let activeRaw = load(ACTIVE_THEME_KEY)
let state: CustomThemeState = { themes: parseThemes(themesRaw), activeId: activeRaw || null, artUrl: null }
const listeners = new Set<() => void>()

const activeTheme = (): CustomTheme | null => state.themes.find(t => t.id === state.activeId) ?? null

function applyRoot(): void {
  if (typeof document === 'undefined') return
  const theme = activeTheme()
  const root = document.documentElement
  // 两台电脑各选各的时，存着的配色可能不是当前主题的基础配色：属性以主题为准，不改存着的值（免得同步来回覆盖）
  applyPaletteAttr(theme ? theme.base : currentPalette())
  let style = document.getElementById(STYLE_ID)
  if (!theme) {
    delete root.dataset.customTheme
    style?.remove()
    return
  }
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  const css = themeCss(theme)
  if (style.textContent !== css) {
    style.textContent = css
    // 只换 <style> 时 <html> 没有变化；Mermaid 靠监听 <html> 的属性重读颜色。终端只听 data-theme 等几个，不受影响
    root.dataset.customThemeRev = String((Number(root.dataset.customThemeRev) || 0) + 1)
  }
  if (root.dataset.customTheme !== theme.id) root.dataset.customTheme = theme.id
}

function emit(next: Partial<CustomThemeState>): void {
  state = { ...state, ...next }
  applyRoot()
  syncArt()
  listeners.forEach(listener => listener())
}

function saveThemes(themes: readonly CustomTheme[]): void {
  themesRaw = JSON.stringify(themes)
  try {
    localStorage.setItem(THEMES_KEY, themesRaw)
  } catch {
    /* 存储不可用时，本次仍然生效 */
  }
}

function saveActive(id: string | null): void {
  activeRaw = id
  try {
    if (id) localStorage.setItem(ACTIVE_THEME_KEY, id)
    else localStorage.removeItem(ACTIVE_THEME_KEY)
  } catch {
    /* 同上 */
  }
}

/* ---------- 贴图 ---------- */

function withArtStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(ART_DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('files')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('files', mode)
      const req = fn(tx.objectStore('files'))
      tx.oncomplete = () => {
        db.close()
        resolve(req.result)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}

/** 现在读到的是哪个主题的哪一张（别的窗口换图时 stamp 变） */
let artLoaded = ''
let artSeq = 0

function setArtUrl(url: string | null): void {
  if (state.artUrl) URL.revokeObjectURL(state.artUrl)
  state = { ...state, artUrl: url }
  listeners.forEach(listener => listener())
}

function syncArt(): void {
  const theme = activeTheme()
  const wanted = theme?.art ? `${theme.id}:${theme.art.stamp}` : ''
  if (wanted === artLoaded) return
  const sameTheme = !!theme && artLoaded.startsWith(`${theme.id}:`)
  artLoaded = wanted
  const seq = ++artSeq
  if (!theme?.art) return setArtUrl(null)
  // 换了主题：旧主题的图先撤掉，不闪；同一个主题换图时新图读到前留着旧的
  if (!sameTheme && state.artUrl) setArtUrl(null)
  void withArtStore<Blob | undefined>('readonly', s => s.get(theme.id))
    .catch(() => undefined)
    .then(blob => {
      if (seq === artSeq) setArtUrl(blob ? URL.createObjectURL(blob) : null)
    })
}

export type ArtError = 'type' | 'size' | 'save'

/** 给主题换贴图：先写文件，写成了才改主题，失败时原来的图还在 */
export async function setThemeArt(id: string, file: File): Promise<ArtError | null> {
  if (!ART_ACCEPT.split(',').includes(file.type)) return 'type'
  if (file.size > MAX_ART_BYTES) return 'size'
  try {
    await withArtStore('readwrite', s => s.put(file, id))
  } catch {
    return 'save'
  }
  // 写文件期间可能改过颜色、删过主题：按最新的列表改
  const theme = state.themes.find(t => t.id === id)
  if (!theme) {
    void withArtStore('readwrite', s => s.delete(id)).catch(() => {})
    return null
  }
  update(id, { art: { on: true, stamp: Date.now(), mask: theme.art?.mask ?? DEFAULT_ART_MASK } })
  return null
}

export function setArtOn(id: string, on: boolean): void {
  const art = state.themes.find(t => t.id === id)?.art
  if (art) update(id, { art: { ...art, on } })
}

export function setArtMask(id: string, mode: ThemeMode, value: number): void {
  const art = state.themes.find(t => t.id === id)?.art
  if (art) update(id, { art: { ...art, mask: { ...art.mask, [mode]: value } } })
}

/* ---------- 主题 ---------- */

function update(id: string, patch: Partial<Omit<CustomTheme, 'id'>>): void {
  const themes = state.themes.map(t => (t.id === id ? { ...t, ...patch } : t))
  saveThemes(themes)
  emit({ themes })
}

/** 选中主题；null 是回到内置配色（调用方另外 setPalette） */
export function setActiveTheme(id: string | null): void {
  const theme = state.themes.find(t => t.id === id) ?? null
  saveActive(theme?.id ?? null)
  if (theme) setPalette(theme.base)
  emit({ activeId: theme?.id ?? null })
}

/** 新增一个主题并选中；到上限返回 null */
export function addTheme(theme: Omit<CustomTheme, 'id' | 'art'>): string | null {
  if (state.themes.length >= MAX_THEMES) return null
  const id = crypto.randomUUID()
  const themes = [...state.themes, { ...theme, name: theme.name.slice(0, THEME_NAME_MAX), id }]
  saveThemes(themes)
  state = { ...state, themes }
  setActiveTheme(id)
  return id
}

/** 基于当前主题（自建的或内置的）复制一份；贴图不复制 */
export function forkTheme(from: CustomTheme | null, palette: Palette, name: string): string | null {
  const base = from?.base ?? palette
  return addTheme({
    name,
    base,
    light: { ...(from?.light ?? BASE_COLORS[base].light) },
    dark: { ...(from?.dark ?? BASE_COLORS[base].dark) },
  })
}

export function renameTheme(id: string, name: string): void {
  const next = name.trim().slice(0, THEME_NAME_MAX)
  if (next) update(id, { name: next })
}

export function setThemeColor(id: string, mode: ThemeMode, key: ThemeColorKey, value: string): void {
  const theme = state.themes.find(t => t.id === id)
  if (theme) update(id, { [mode]: { ...theme[mode], [key]: value.toLowerCase() } })
}

export function resetTheme(id: string): void {
  const theme = state.themes.find(t => t.id === id)
  if (theme) update(id, { light: { ...BASE_COLORS[theme.base].light }, dark: { ...BASE_COLORS[theme.base].dark } })
}

export function removeTheme(id: string): void {
  const themes = state.themes.filter(t => t.id !== id)
  saveThemes(themes)
  if (state.activeId === id) saveActive(null)
  emit({ themes, activeId: state.activeId === id ? null : state.activeId })
  void withArtStore('readwrite', s => s.delete(id)).catch(() => {})
}

/* ---------- 同步 ---------- */

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== localStorage) return
  // palette.ts 先收到（它先注册），刚把属性写成存着的值：这里按当前主题再摆正
  if (event.key === PALETTE_KEY) return applyRoot()
  if (event.key !== THEMES_KEY && event.key !== ACTIVE_THEME_KEY && event.key !== null) return
  const nextThemes = load(THEMES_KEY)
  const nextActive = load(ACTIVE_THEME_KEY)
  if (nextThemes === themesRaw && nextActive === activeRaw) return applyRoot()
  themesRaw = nextThemes
  activeRaw = nextActive
  emit({ themes: parseThemes(nextThemes), activeId: nextActive || null })
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage)
  applyRoot()
  syncArt()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCustomThemes(): CustomThemeState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}

/** 输入框卡片的贴图：遮罩 + 图片两层背景，不加元素，不影响里面菜单的层叠 */
export function useThemeArtStyle(mode: ThemeMode): CSSProperties | undefined {
  // 只订阅贴图这一项：拖颜色时输入框不用重新渲染
  const image = useSyncExternalStore(subscribe, () => {
    const art = activeTheme()?.art
    if (!art?.on || !state.artUrl) return ''
    const mask = `color-mix(in srgb, var(--bg-surface) ${art.mask[mode]}%, transparent)`
    return `linear-gradient(${mask}, ${mask}), url("${state.artUrl}")`
  })
  return useMemo(
    () => (image ? { backgroundImage: image, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined),
    [image],
  )
}

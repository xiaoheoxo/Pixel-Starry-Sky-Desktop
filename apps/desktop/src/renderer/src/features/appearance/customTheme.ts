// 自定义主题的存取和生效（docs/ui/custom-theme.md）。主题列表和当前 id 在 localStorage（会同步），贴图在 IndexedDB（只在本机）。
// 选中时 <html data-custom-theme> 写 id，再注入一段 <style> 盖掉变量。
// 扩展带的主题也走这里：id 是 ext:<扩展>/<主题>，选中后同样写进 pixelsky.customTheme；扩展没了就退回基础配色
import { useMemo, useSyncExternalStore, type CSSProperties } from 'react'
import { contributionsFrom, EMPTY_PACK_STATE } from '@/features/extpacks/model'
import { getPackState, readPackJson, subscribePacks } from '@/features/extpacks/store'
import { PALETTE_KEY } from './palette'
import { DEFAULT_PALETTE, PALETTES, type Palette } from './palettes'
import { BASE_COLORS, type ThemeColorKey } from './customThemeBase'
import {
  DEFAULT_ART_MASK,
  MAX_THEMES,
  THEME_NAME_MAX,
  extThemeId,
  legacyThemeId,
  parseExtTheme,
  parseThemes,
  sortExtThemes,
  themeCss,
  type CustomTheme,
  type ExtThemeEntry,
  type ThemeMode,
} from './customThemeCore'

export const THEMES_KEY = 'pixelsky.customThemes'
export const ACTIVE_THEME_KEY = 'pixelsky.customTheme'
/** 正在用的扩展主题：扩展是异步读的，存一份让第一屏就是对的。只在本机，不同步 */
export const EXT_THEME_CACHE_KEY = 'pixelsky.extThemeCache'
export const MAX_ART_BYTES = 20 * 1024 * 1024
export const ART_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

const ART_DB = 'pixelsky-theme-art'
const STYLE_ID = 'pixelsky-custom-theme'

export interface CustomThemeState {
  themes: readonly CustomTheme[]
  /** 生效的扩展带的主题 */
  extThemes: readonly ExtThemeEntry[]
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

/**
 * 老版本选的是配色（pixelsky.palette）：换成对应的预装主题，只做一次。自己选了主题的不动。
 * 旧版本的电脑还可能同步来老值，所以收到同步时也要走一遍
 */
function migrateLegacyPalette(): void {
  const old = load(PALETTE_KEY)
  if (!old || old === DEFAULT_PALETTE || !PALETTES.includes(old as Palette)) return
  try {
    if (!load(ACTIVE_THEME_KEY)) localStorage.setItem(ACTIVE_THEME_KEY, legacyThemeId(old as Palette))
    localStorage.setItem(PALETTE_KEY, DEFAULT_PALETTE)
  } catch {
    /* 存不下：这次用暖灰，下次启动再迁移 */
  }
}
migrateLegacyPalette()

let themesRaw = load(THEMES_KEY)
let activeRaw = load(ACTIVE_THEME_KEY)

/** 只信当前选中的那一条；文件再校验一遍，缓存可能被手改 */
function loadExtCache(): ExtThemeEntry[] {
  try {
    const raw = JSON.parse(load(EXT_THEME_CACHE_KEY) ?? 'null') as Pick<ExtThemeEntry, 'id' | 'label' | 'file'> | null
    const theme = raw && raw.id === activeRaw ? parseExtTheme(raw.id, raw.label, raw.file) : null
    return theme ? [theme] : []
  } catch {
    return []
  }
}

let state: CustomThemeState = {
  themes: parseThemes(themesRaw),
  extThemes: loadExtCache(),
  activeId: activeRaw || null,
  artUrl: null,
}
const listeners = new Set<() => void>()

const activeTheme = (): CustomTheme | ExtThemeEntry | null =>
  state.themes.find(t => t.id === state.activeId) ?? state.extThemes.find(t => t.id === state.activeId) ?? null

/** 正在用的扩展主题；用的不是扩展主题时是 null */
export const getActiveExtTheme = (): ExtThemeEntry | null => state.extThemes.find(t => t.id === state.activeId) ?? null

function applyRoot(): void {
  if (typeof document === 'undefined') return
  const theme = activeTheme()
  const root = document.documentElement
  let style = document.getElementById(STYLE_ID)
  if (!theme) {
    delete root.dataset.customTheme
    style?.remove()
    return
  }
  if (root.dataset.customTheme !== theme.id) root.dataset.customTheme = theme.id
  // 只写了玻璃的扩展主题就是基础配色本身，不注入，颜色和内置配色完全一样
  if ('colored' in theme && !theme.colored) {
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

function saveExtCache(): void {
  const theme = getActiveExtTheme()
  try {
    if (theme)
      localStorage.setItem(EXT_THEME_CACHE_KEY, JSON.stringify({ id: theme.id, label: theme.label, file: theme.file }))
    else localStorage.removeItem(EXT_THEME_CACHE_KEY)
  } catch {
    /* 存不下只是下次启动晚一点变色 */
  }
}

/* ---------- 扩展主题 ---------- */

let extSeq = 0

async function loadExtThemes(): Promise<void> {
  const seq = ++extSeq
  const refs = contributionsFrom(getPackState(), 'uiThemes')
  const files = await Promise.all(refs.map(r => readPackJson(r.pack.key, r.item.path).catch(() => null)))
  if (seq !== extSeq) return
  const list = refs.flatMap((r, i) => {
    const theme = parseExtTheme(extThemeId(r.pack.id ?? r.pack.key, r.item.id), r.item.label, files[i])
    return theme ? [theme] : []
  })
  emit({ extThemes: sortExtThemes(list) })
  saveExtCache()
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
  const theme = state.themes.find(t => t.id === id) ?? state.extThemes.find(t => t.id === id) ?? null
  saveActive(theme?.id ?? null)
  emit({ activeId: theme?.id ?? null })
  saveExtCache()
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

/** 基于当前主题（自建的、扩展的或暖灰）复制一份；贴图和玻璃不复制 */
export function forkTheme(from: CustomTheme | null, palette: Palette, name: string): string | null {
  const base = from?.base ?? palette
  return addTheme({
    name,
    base,
    light: { ...(from?.light ?? BASE_COLORS[base].light) },
    dark: { ...(from?.dark ?? BASE_COLORS[base].dark) },
    ...(from?.vars ? { vars: from.vars } : {}),
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
  if (theme)
    update(id, {
      light: { ...BASE_COLORS[theme.base].light },
      dark: { ...BASE_COLORS[theme.base].dark },
      vars: undefined,
    })
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
  if (event.key === PALETTE_KEY || event.key === null) migrateLegacyPalette()
  if (event.key !== THEMES_KEY && event.key !== ACTIVE_THEME_KEY && event.key !== PALETTE_KEY && event.key !== null)
    return
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
  // 取到扩展状态之前不动启动缓存：空状态不代表扩展没了
  subscribePacks(() => void loadExtThemes())
  if (getPackState() !== EMPTY_PACK_STATE) void loadExtThemes()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const subscribeCustomThemes = subscribe

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

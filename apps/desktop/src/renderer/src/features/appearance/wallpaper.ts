import { tr } from '../../i18n/core'
// 壁纸：图片 / 视频铺满窗口，上面盖一层主题底色保证可读。规格见 docs/ui/settings.md §6（参考 Mirasim「背景」扩展）。
// 文件存在 IndexedDB，设置存在 localStorage，只在本机生效。
import { useSyncExternalStore } from 'react'
import { windowBackground } from './palette'

export type WallpaperKind = 'image' | 'video'

export interface WallpaperPrefs {
  /** 文件名，空字符串表示没有壁纸 */
  name: string
  kind: WallpaperKind
  /** 背景透出程度 0.1–0.9 */
  show: number
  /** 背景模糊 0–20px */
  blur: number
  /** 选这张图的时间。文件名一样但换了内容时，另一个窗口靠它知道要重读 */
  stamp?: number
}

export interface WallpaperState extends WallpaperPrefs {
  /** 当前壁纸的 blob: 地址，没有壁纸或还在读取时为 null */
  url: string | null
}

export const MAX_WALLPAPER_BYTES = 200 * 1024 * 1024
export const WALLPAPER_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm'

const KEY = 'pixelsky.wallpaper'
const DB = 'pixelsky-wallpaper'
const FILE_KEY = 'current'
const DEFAULT_PREFS: WallpaperPrefs = { name: '', kind: 'image', show: 0.45, blur: 0 }

function loadPrefs(): WallpaperPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<WallpaperPrefs>
    return {
      name: typeof saved.name === 'string' ? saved.name : '',
      kind: saved.kind === 'video' ? 'video' : 'image',
      show: clamp(Number(saved.show ?? DEFAULT_PREFS.show), 0.1, 0.9),
      blur: clamp(Number(saved.blur ?? 0), 0, 20),
      ...(typeof saved.stamp === 'number' && { stamp: saved.stamp }),
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}

/* ---------- IndexedDB ---------- */

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('files')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('files', mode)
      const req = fn(tx.objectStore('files'))
      tx.oncomplete = () => {
        db.close()
        resolve(req ? req.result : undefined)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}

/* ---------- 状态 ---------- */

let state: WallpaperState = { ...loadPrefs(), url: null }
const listeners = new Set<() => void>()

function emit(next: WallpaperState): void {
  state = next
  const { url: _url, ...prefs } = next
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // 忽略
  }
  applyRoot()
  listeners.forEach(l => l())
}

/** tokens.css 据 data-wallpaper 透出壁纸；Windows 自绘按钮透明，其他平台同步原生覆盖层。 */
function applyRoot(): void {
  const root = document.documentElement
  const on = !!state.name
  if (on) root.dataset.wallpaper = state.kind
  else delete root.dataset.wallpaper
  const theme = root.dataset.theme === 'dark' ? 'dark' : 'light'
  window.pixelsky?.setTheme(theme, on, windowBackground())
}

/** 当前是否有壁纸（ThemeProvider 同步其他平台原生覆盖层时使用） */
export function hasWallpaper(): boolean {
  return !!state.name
}

// 启动时：记录过壁纸就先把底色设透明（避免先闪一下纯色），再从 IndexedDB 读文件
if (state.name) {
  document.documentElement.dataset.wallpaper = state.kind
  void withStore<Blob>('readonly', s => s.get(FILE_KEY) as IDBRequest<Blob>)
    .then(blob => {
      if (blob) emit({ ...state, url: URL.createObjectURL(blob) })
      else emit({ ...state, name: '', url: null })
    })
    .catch(() => emit({ ...state, name: '', url: null }))
}

/** 另一个窗口的改动该怎么同步过来：不用管 / 只有透明度、模糊变了 / 壁纸没了 / 换了图片要重读 IndexedDB */
export function planWallpaperSync(
  prefs: WallpaperPrefs,
  current: WallpaperPrefs,
): 'none' | 'prefs' | 'clear' | 'reload' {
  if (!prefs.name)
    return current.name ? 'clear' : prefs.show !== current.show || prefs.blur !== current.blur ? 'prefs' : 'none'
  if (prefs.name !== current.name || prefs.kind !== current.kind || prefs.stamp !== current.stamp) return 'reload'
  return prefs.show !== current.show || prefs.blur !== current.blur ? 'prefs' : 'none'
}

let syncSeq = 0

/**
 * 另一个窗口（比如独立的设置窗口）改了壁纸：设置在 localStorage、图片在 IndexedDB（两个窗口共用），
 * 浏览器只在别的窗口发 storage 事件（云同步写回时自己补一个）。收到就重读设置，换了图片再从 IndexedDB 读一遍，
 * 重新套到 <html> 上。这里只读不写 localStorage，免得两个窗口来回通知
 */
export function onWallpaperStorage(event: Pick<StorageEvent, 'key' | 'storageArea'>): void {
  if (event.storageArea !== localStorage || (event.key !== KEY && event.key !== null)) return
  const prefs = loadPrefs()
  const plan = planWallpaperSync(prefs, state)
  const seq = ++syncSeq
  const apply = (next: WallpaperState): void => {
    const old = state.url
    state = next
    if (old && old !== next.url) URL.revokeObjectURL(old)
    applyRoot()
    listeners.forEach(l => l())
  }
  if (plan === 'none') return
  if (plan === 'prefs') apply({ ...state, ...prefs })
  else if (plan === 'clear') apply({ ...prefs, url: null })
  else
    void withStore<Blob>('readonly', st => st.get(FILE_KEY) as IDBRequest<Blob>)
      .then(blob => {
        if (seq === syncSeq)
          apply(blob ? { ...prefs, url: URL.createObjectURL(blob) } : { ...prefs, name: '', url: null })
      })
      .catch(() => undefined)
}
if (typeof window !== 'undefined') window.addEventListener('storage', onWallpaperStorage)

export function getWallpaper(): WallpaperState {
  return state
}

/** 选择新壁纸。返回错误信息（中文），成功返回 null */
export async function setWallpaperFile(file: File): Promise<string | null> {
  const kind: WallpaperKind | null = file.type.startsWith('video/')
    ? 'video'
    : file.type.startsWith('image/')
      ? 'image'
      : null
  if (!kind) return tr('appearance.wallpaper.supportedImagesPngJpg')
  if (file.size > MAX_WALLPAPER_BYTES) return tr('appearance.wallpaper.fileTooLargeMaximum')
  try {
    await withStore('readwrite', s => s.put(file, FILE_KEY))
  } catch {
    return tr('appearance.wallpaper.couldNotSaveWallpaper')
  }
  if (state.url) URL.revokeObjectURL(state.url)
  emit({ ...state, name: file.name, kind, stamp: Date.now(), url: URL.createObjectURL(file) })
  return null
}

export async function removeWallpaper(): Promise<void> {
  if (state.url) URL.revokeObjectURL(state.url)
  emit({ ...state, name: '', url: null })
  try {
    await withStore('readwrite', s => s.delete(FILE_KEY))
  } catch {
    // 忽略：下次选择新壁纸会覆盖
  }
}

export function setWallpaperPrefs(patch: Partial<Pick<WallpaperPrefs, 'show' | 'blur'>>): void {
  emit({
    ...state,
    show: patch.show === undefined ? state.show : clamp(patch.show, 0.1, 0.9),
    blur: patch.blur === undefined ? state.blur : clamp(patch.blur, 0, 20),
  })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useWallpaper(): WallpaperState {
  return useSyncExternalStore(subscribe, getWallpaper)
}

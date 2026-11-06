// 配色主题：一整套界面颜色（底色、边框、文字、主色、按钮、终端底色），每套有浅色、深色两份，
// 跟「主题」的浅色 / 深色 / 跟随系统组合使用。代码高亮、终端 16 色不变。颜色定义在 styles/tokens.css。
// 设置写成 <html data-palette>，改完立刻生效；保存在 localStorage，多窗口同步。
import { useSyncExternalStore } from 'react'

import { DEFAULT_PALETTE, PALETTES, type Palette } from './palettes'

export { DEFAULT_PALETTE, PALETTES, type Palette }
export const PALETTE_KEY = 'pixelsky.palette'

export function parsePalette(value: unknown): Palette {
  return PALETTES.includes(value as Palette) ? (value as Palette) : DEFAULT_PALETTE
}

function read(): Palette {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_PALETTE
    return parsePalette(localStorage.getItem(PALETTE_KEY))
  } catch {
    return DEFAULT_PALETTE
  }
}

/** 窗口底色（缩放窗口、启动时露出来的那一层）跟着配色走：取 tokens.css 里不受壁纸影响的 --wall-tint */
export function windowBackground(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue('--wall-tint').trim()
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
}

function apply(next: Palette): void {
  if (typeof document === 'undefined') return
  // 默认暖灰就是 tokens.css 里的基础值，不写属性
  if (next === DEFAULT_PALETTE) delete document.documentElement.dataset.palette
  else document.documentElement.dataset.palette = next
}

/** 只改 <html> 上的属性，不存盘：自建主题生效时属性写它的基础配色（customTheme.ts） */
export const applyPaletteAttr = (next: Palette): void => {
  if (typeof document !== 'undefined' && (document.documentElement.dataset.palette ?? DEFAULT_PALETTE) !== next)
    apply(next)
}
export const currentPalette = (): Palette => palette

let palette = read()
apply(palette)
const listeners = new Set<() => void>()

export function setPalette(next: Palette): void {
  if (!PALETTES.includes(next)) return
  const changed = palette !== next
  palette = next
  apply(palette)
  try {
    localStorage.setItem(PALETTE_KEY, palette)
  } catch {
    /* 存储不可用时，本次仍然可切换。 */
  }
  if (changed) listeners.forEach(listener => listener())
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== localStorage || (event.key !== PALETTE_KEY && event.key !== null)) return
  const next = read()
  if (next === palette) return
  palette = next
  apply(palette)
  listeners.forEach(listener => listener())
}

// 不在设置页时其他窗口改了也要跟着变，所以一直监听
if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePalette(): Palette {
  return useSyncExternalStore(
    subscribe,
    () => palette,
    () => DEFAULT_PALETTE,
  )
}

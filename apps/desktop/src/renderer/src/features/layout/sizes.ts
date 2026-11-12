import { useSyncExternalStore } from 'react'

export const DEFAULT_SIDEBAR_WIDTH = 290
export const DEFAULT_COMPOSER_WIDTH = 960
const KEY = 'pixelsky.layout-sizes.v1'
interface LayoutSizes {
  /** null：没拖过，按窗口宽度自动算（features/layout/panelWidth.ts） */
  rightWorkspace: number | null
  sidebar: number
  composer: number
  /** null 使用原有的随内容增高模式；数值是文本输入区高度。 */
  composerHeight: number | null
}
function validSize(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
function read(): LayoutSizes {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return {
      // 以前没拖过也会在保存其它尺寸时一起存下默认的 720，当作没拖过（docs/ui/workbench-ux-3.md §2.3）
      rightWorkspace:
        typeof p.rightWorkspace === 'number' && p.rightWorkspace !== 720
          ? validSize(p.rightWorkspace, 360, 2000, 720)
          : null,
      sidebar: validSize(p.sidebar, 240, 480, DEFAULT_SIDEBAR_WIDTH),
      composer: validSize(p.composer, 320, 2400, DEFAULT_COMPOSER_WIDTH),
      composerHeight: typeof p.composerHeight === 'number' ? validSize(p.composerHeight, 56, 1200, 56) : null,
    }
  } catch {
    return {
      rightWorkspace: null,
      sidebar: DEFAULT_SIDEBAR_WIDTH,
      composer: DEFAULT_COMPOSER_WIDTH,
      composerHeight: null,
    }
  }
}
let sizes = read()
const listeners = new Set<() => void>()
/** 对话那一列跟着输入框一样宽（conversation.css 的 .conversation-reading 读这个变量），拖输入框时上下一起变 */
function syncComposerWidth(): void {
  if (typeof document !== 'undefined')
    document.documentElement.style.setProperty('--composer-width', `${sizes.composer}px`)
}
syncComposerWidth()
export function setLayoutSize<K extends keyof LayoutSizes>(key: K, value: LayoutSizes[K], persist = false): void {
  const changed = sizes[key] !== value
  if (changed) sizes = { ...sizes, [key]: value }
  if (persist)
    try {
      localStorage.setItem(KEY, JSON.stringify(sizes))
    } catch {
      /* 本次使用仍然有效 */
    }
  if (changed) {
    if (key === 'composer') syncComposerWidth()
    listeners.forEach(fn => fn())
  }
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export function useLayoutSize<K extends keyof LayoutSizes>(key: K): LayoutSizes[K] {
  return useSyncExternalStore(subscribe, () => sizes[key])
}

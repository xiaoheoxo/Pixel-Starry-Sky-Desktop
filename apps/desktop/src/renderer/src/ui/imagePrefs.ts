// 看图的三个开关（docs/ui/image-viewer.md §8）：背景、放大时按像素显示、像素网格。全局记住，看图浮层和代码页的图片预览共用
import { useSyncExternalStore } from 'react'

export type ImageBackground = 'checker' | 'plain' | 'inverse'
export interface ImagePrefs {
  background: ImageBackground
  /** 放大（>100%）时按像素显示，不做平滑 */
  pixelated: boolean
  /** 放大到 GRID_MIN_SCALE 起画像素网格 */
  grid: boolean
}

const KEY = 'pixelsky.image-view.v1'
const BACKGROUNDS: ImageBackground[] = ['checker', 'plain', 'inverse']
export const DEFAULT_IMAGE_PREFS: ImagePrefs = { background: 'checker', pixelated: true, grid: true }

/** 读存下的值；坏的、缺的字段用默认值 */
export function parseImagePrefs(raw: string | null): ImagePrefs {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<Record<keyof ImagePrefs, unknown>>
    return {
      background: BACKGROUNDS.includes(v.background as ImageBackground)
        ? (v.background as ImageBackground)
        : DEFAULT_IMAGE_PREFS.background,
      pixelated: typeof v.pixelated === 'boolean' ? v.pixelated : DEFAULT_IMAGE_PREFS.pixelated,
      grid: typeof v.grid === 'boolean' ? v.grid : DEFAULT_IMAGE_PREFS.grid,
    }
  } catch {
    return DEFAULT_IMAGE_PREFS
  }
}

let prefs: ImagePrefs | null = null
const listeners = new Set<() => void>()

function current(): ImagePrefs {
  if (!prefs) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(KEY)
    } catch {
      // 存储不可用：用默认值
    }
    prefs = parseImagePrefs(raw)
  }
  return prefs
}

export function setImagePrefs(patch: Partial<ImagePrefs>): void {
  prefs = { ...current(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // 存不下只影响下次启动
  }
  listeners.forEach(l => l())
}

/** 背景按 棋盘格 → 纯色 → 反色 轮换 */
export const nextBackground = (b: ImageBackground): ImageBackground =>
  BACKGROUNDS[(BACKGROUNDS.indexOf(b) + 1) % BACKGROUNDS.length]

export function useImagePrefs(): ImagePrefs {
  return useSyncExternalStore(l => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, current)
}

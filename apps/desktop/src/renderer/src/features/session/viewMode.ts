// 对话查看模式（docs/ui/view-mode.md，D237）：普通 / 聊天 / 详细（D281），全局一份存本机，多窗口同步；只改显示，不碰 thinkingSummaries
import { createContext, useContext, useSyncExternalStore } from 'react'
import { useLightweight } from '@/features/recovery/lightweight'

import { nextViewMode, parseViewMode, type ViewMode } from './viewModeModel'

export * from './viewModeModel'
export const VIEW_MODE_KEY = 'pixelsky.view-mode'

function read(): ViewMode {
  try {
    return parseViewMode(localStorage.getItem(VIEW_MODE_KEY))
  } catch {
    return 'normal'
  }
}

/** gen：每切一次加一，条目里点过的展开按它失效（§4 第 4 条） */
let state = { mode: typeof window === 'undefined' ? ('normal' as ViewMode) : read(), gen: 0 }
const listeners = new Set<() => void>()
/** 切换前同步通知：各对话区记下屏幕最上面那条（§4 第 3 条） */
const before = new Set<() => void>()

function apply(mode: ViewMode): void {
  if (mode === state.mode) return
  before.forEach(l => l())
  state = { mode, gen: state.gen + 1 }
  listeners.forEach(l => l())
}

export function setViewMode(mode: ViewMode): void {
  if (mode === state.mode) return
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    /* 存储不可用时本次仍然生效 */
  }
  apply(mode)
}

export const cycleViewMode = (): ViewMode => {
  setViewMode(nextViewMode(state.mode))
  return state.mode
}

function onStorage(e: StorageEvent): void {
  if (e.storageArea === localStorage && (e.key === VIEW_MODE_KEY || e.key === null)) apply(read())
}

function subscribe(l: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(l)
  return () => {
    listeners.delete(l)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}

export function onBeforeViewModeChange(l: () => void): () => void {
  before.add(l)
  return () => void before.delete(l)
}

const getState = (): typeof state => state

/** 设置里存的模式（按钮、菜单用） */
export function useStoredViewMode(): ViewMode {
  return useSyncExternalStore(
    subscribe,
    () => state.mode,
    () => 'normal',
  )
}

/** 对话里实际按哪个模式显示：崩溃恢复后的轻量模式一律普通（不改存的值）；gen 见上 */
export function useViewMode(): { mode: ViewMode; gen: number } {
  const s = useSyncExternalStore(subscribe, getState, getState)
  return useLightweight() ? { mode: 'normal', gen: s.gen } : s
}

/**
 * 条目行按哪个模式显示：只有主对话（LiveTranscript）提供，智能体追踪面板等其他地方用到同样的行组件时保持普通（§10）
 */
export const RowModeContext = createContext<{ mode: ViewMode; gen: number }>({ mode: 'normal', gen: 0 })
export const useRowMode = (): { mode: ViewMode; gen: number } => useContext(RowModeContext)

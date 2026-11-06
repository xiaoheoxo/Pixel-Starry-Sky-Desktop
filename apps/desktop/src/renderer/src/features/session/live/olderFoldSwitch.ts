import { useSyncExternalStore } from 'react'

// 「只显示最近 2 轮」（规则 B，docs/ui/auto-fold.md §4）的总开关：本机所有对话、所有窗口共用，默认开
export const OLDER_FOLD_OFF_KEY = 'pixelsky.olderFold.off'

const listeners = new Set<() => void>()
let fallback = false

export function readOlderFoldOff(): boolean {
  try {
    if (!window.pixelsky?.demo) return localStorage.getItem(OLDER_FOLD_OFF_KEY) === '1'
  } catch {
    // 存储不可用时用本窗口内的记录。
  }
  return fallback
}

export function setOlderFoldOff(off: boolean): void {
  fallback = off
  try {
    if (!window.pixelsky?.demo) {
      if (off) localStorage.setItem(OLDER_FOLD_OFF_KEY, '1')
      else localStorage.removeItem(OLDER_FOLD_OFF_KEY)
    }
  } catch {
    // 本次仍然生效。
  }
  listeners.forEach(fn => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea === localStorage && (event.key === OLDER_FOLD_OFF_KEY || event.key === null)) fn()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

export function useOlderFoldOff(): boolean {
  return useSyncExternalStore(subscribe, readOlderFoldOff, () => false)
}

// 概况里放进度卡片的位置：右栏和对话区在 App 下是两支。不用 context：Provider 得放在 App，卡片数据每来一个字都要往上发
import { useSyncExternalStore } from 'react'

let slot: HTMLElement | null = null
const listeners = new Set<() => void>()

/** 当 ref 用 */
export function setOverviewSlot(el: HTMLElement | null): void {
  slot = el
  listeners.forEach(fn => fn())
}

export function useOverviewSlot(): HTMLElement | null {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => slot,
  )
}

import { useSyncExternalStore } from 'react'
import { onStoredChange, readStoredJson } from './storedValue'

export const QUICK_MODEL_BAR_KEY = 'pixelsky.quick-model-bar'

function read(): boolean {
  const stored = readStoredJson<unknown>(QUICK_MODEL_BAR_KEY, true)
  return typeof stored === 'boolean' ? stored : true
}

let enabled = read()
const listeners = new Set<() => void>()
let unsubscribeStorage: (() => void) | undefined

function update(next: boolean): void {
  if (next === enabled) return
  enabled = next
  listeners.forEach(listener => listener())
}

export function getQuickModelBar(): boolean {
  return enabled
}

export function setQuickModelBar(next: boolean): void {
  try {
    localStorage.setItem(QUICK_MODEL_BAR_KEY, String(next))
  } catch {
    /* 存储不可用时，本窗口仍然可切换。 */
  }
  update(next)
}

export function subscribeQuickModelBar(listener: () => void): () => void {
  if (!listeners.size) unsubscribeStorage = onStoredChange(QUICK_MODEL_BAR_KEY, () => update(read()))
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      unsubscribeStorage?.()
      unsubscribeStorage = undefined
    }
  }
}

export function useQuickModelBar(): boolean {
  return useSyncExternalStore(subscribeQuickModelBar, getQuickModelBar, () => true)
}

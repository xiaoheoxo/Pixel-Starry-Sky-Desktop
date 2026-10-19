import { useSyncExternalStore } from 'react'
import { subagentConfig, type SubagentConfig } from '@pixelsky/protocol'

const KEY = 'pixelsky.subagent.default.v1'
const listeners = new Set<() => void>()
function load(): SubagentConfig | null {
  try {
    return subagentConfig(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return null
  }
}
let current = load()
export function setSubagentDefault(config: SubagentConfig | null): void {
  current = subagentConfig(config)
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* Session setting still applies. */
  }
  listeners.forEach(fn => fn())
}
function storage(event: StorageEvent): void {
  if (event.key === KEY || event.key === null) {
    current = load()
    listeners.forEach(fn => fn())
  }
}
function subscribe(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', storage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', storage)
  }
}
export function useSubagentDefault(): SubagentConfig | null {
  return useSyncExternalStore(subscribe, () => current)
}

// 概况里折叠、隐藏了哪些分组：全局一份，不按会话分（docs/ui/desktop-parity.md §3.1）
import { useSyncExternalStore } from 'react'
import { DEFAULT_OVERVIEW_PREFS, parseOverviewPrefs, type OverviewPrefs } from './overviewModel'

const KEY = 'pixelsky.overview.sections'

function read(): OverviewPrefs {
  try {
    const text = localStorage.getItem(KEY)
    return text ? parseOverviewPrefs(JSON.parse(text)) : DEFAULT_OVERVIEW_PREFS
  } catch {
    return DEFAULT_OVERVIEW_PREFS
  }
}

let state: OverviewPrefs | null = null
const listeners = new Set<() => void>()
const current = (): OverviewPrefs => (state ??= read())

function set(next: OverviewPrefs): void {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 存不了就只在这次打开里生效 */
  }
  listeners.forEach(fn => fn())
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

export function useOverviewPrefs(): OverviewPrefs {
  return useSyncExternalStore(subscribe, current, () => DEFAULT_OVERVIEW_PREFS)
}

const toggled = (list: string[], id: string): string[] =>
  list.includes(id) ? list.filter(x => x !== id) : [...list, id]

export const overviewPrefs = {
  toggleCollapsed(id: string): void {
    set({ ...current(), collapsed: toggled(current().collapsed, id) })
  },
  toggleHidden(id: string): void {
    set({ ...current(), hidden: toggled(current().hidden, id) })
  },
  reset(): void {
    set(DEFAULT_OVERVIEW_PREFS)
  },
}

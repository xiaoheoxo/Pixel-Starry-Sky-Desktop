// 概况里折叠、隐藏了哪些分组：全局一份，不按会话分（docs/ui/desktop-parity.md §3.1）
import { useSyncExternalStore } from 'react'
import { DEFAULT_OVERVIEW_PREFS, parseOverviewPrefs, type OverviewPrefs } from './overviewModel'

// 2026-11-13 改成平铺清单（D273）：默认都展开，旧键里只带过来「隐藏」
const KEY = 'pixelsky.overview.sections.v2'
const OLD_KEY = 'pixelsky.overview.sections'

function read(): OverviewPrefs {
  try {
    const text = localStorage.getItem(KEY)
    if (text) return parseOverviewPrefs(JSON.parse(text))
    const old = localStorage.getItem(OLD_KEY)
    return old
      ? { ...DEFAULT_OVERVIEW_PREFS, hidden: parseOverviewPrefs(JSON.parse(old)).hidden }
      : DEFAULT_OVERVIEW_PREFS
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
  // 第三个参数也用 current：没有服务端渲染，测试用 renderToStaticMarkup 时要读到改过的偏好
  return useSyncExternalStore(subscribe, current, current)
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
  /** 全部折叠 / 全部展开：「要处理」不收 */
  setAllCollapsed(ids: readonly string[], collapsed: boolean): void {
    set({ ...current(), collapsed: collapsed ? [...ids] : [] })
  },
  reset(): void {
    set(DEFAULT_OVERVIEW_PREFS)
  },
}

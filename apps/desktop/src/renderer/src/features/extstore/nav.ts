// 设置 › 扩展：现在在哪个页签、发现页有没有点进某个扩展的详情。
// 放在组件外面（和 settings/engines/nav.ts 一个写法），命令面板、设置搜索也能直接切页签。
import { useSyncExternalStore } from 'react'

export type ExtTab = 'discover' | 'installed' | 'publish'

let tab: ExtTab = 'installed'
let detail: string | null = null
const listeners = new Set<() => void>()

const emit = (): void => listeners.forEach(l => l())
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export const getExtTab = (): ExtTab => tab
export const getExtDetail = (): string | null => detail

/** 切到某个页签；换页签时发现页的详情一并收起。已经在「发现」时再选「发现」：从详情回到列表 */
export function openExtTab(next: ExtTab): void {
  if (tab === next && detail === null) return
  tab = next
  detail = null
  emit()
}

/** 发现页里点进某个扩展的详情（null 是返回列表） */
export function openExtDetail(id: string | null): void {
  if (detail === id && (id === null || tab === 'discover')) return
  detail = id
  if (id !== null) tab = 'discover'
  emit()
}

let searchFocus = false

/** 打开「发现」页签并让搜索框拿到焦点（命令面板「扩展：搜索…」）；页签还没挂载时，挂载后由 consumeExtSearchFocus 取走 */
export function openExtSearch(): void {
  tab = 'discover'
  detail = null
  searchFocus = true
  emit()
}

/** 有没有待处理的「聚焦搜索框」请求；取走后清掉 */
export function consumeExtSearchFocus(): boolean {
  const pending = searchFocus
  searchFocus = false
  return pending
}

/** 订阅用：每次 openExtSearch 都会通知，页面据此再看一次 consumeExtSearchFocus */
export function subscribeExtNav(cb: () => void): () => void {
  return subscribe(cb)
}

export function useExtTab(): ExtTab {
  return useSyncExternalStore(subscribe, getExtTab, getExtTab)
}

export function useExtDetail(): string | null {
  return useSyncExternalStore(subscribe, getExtDetail, getExtDetail)
}

let mounted = 0

/**
 * 扩展页挂载时调，返回卸载函数。设置关掉（页面卸载）以后把页签放回「已安装」，下次从旧入口进来停在「已安装」；
 * 命令面板先 openExtTab 再打开设置的那条路不受影响（挂载前没有重置）。
 * 延后一拍再判断：开发模式的 StrictMode 会立刻卸载又挂载，不能在这中间重置
 */
export function trackExtPage(): () => void {
  mounted++
  return () => {
    mounted--
    setTimeout(() => {
      if (mounted === 0) {
        tab = 'installed'
        detail = null
      }
    }, 0)
  }
}

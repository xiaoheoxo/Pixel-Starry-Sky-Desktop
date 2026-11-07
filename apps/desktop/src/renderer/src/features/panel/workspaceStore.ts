import { useSyncExternalStore } from 'react'
import { isDemo } from '@/data'
import { getAppMode } from '@/features/coding/mode'
import {
  activatePanelTab,
  emptyPanel,
  removePanelTabs,
  restorePanels,
  type PanelLayout,
  type ToolId,
} from './workspaceState'

const KEY = isDemo ? 'pixelsky.right-workspace.demo.v2' : 'pixelsky.right-workspace.v2'
const KEY_V1 = isDemo ? 'pixelsky.right-workspace.demo.v1' : 'pixelsky.right-workspace.v1'
export const OPEN_RIGHT_WORKSPACE = 'pixelsky:open-right-workspace'
let contexts: Record<string, PanelLayout> = {}
try {
  contexts = restorePanels(localStorage.getItem(KEY), localStorage.getItem(KEY_V1))
} catch {
  /* Invalid persisted layout falls back to Files. */
}
let currentScope = ''
const listeners = new Set<() => void>()
const persistedFileIds = new Map<string, string>()
export const panelFileIds = (): string[] => [
  ...new Set(Object.values(contexts).flatMap(layout => layout.tabs.filter(id => id.startsWith('file:')))),
]
export const resolvePanelFileId = (id: string): string => persistedFileIds.get(id) ?? id
function emit(): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(
        Object.fromEntries(
          Object.entries(contexts).map(([scope, layout]) => [
            scope,
            {
              tabs: layout.tabs.map(id => persistedFileIds.get(id) ?? id),
              active: layout.active ? (persistedFileIds.get(layout.active) ?? layout.active) : null,
            },
          ]),
        ),
      ),
    )
  } catch {
    /* Usable without persistence. */
  }
  listeners.forEach(fn => fn())
}
/** 在 RightPanel 渲染时调用；换了作用域就在渲染结束后通知订阅者（顶栏 Git 按钮跟着当前作用域的标签走） */
export function setPanelScope(scope: string): void {
  if (scope === currentScope) return
  currentScope = scope
  queueMicrotask(() => listeners.forEach(fn => fn()))
}
export const getPanelScope = (): string => currentScope
export const getPanelLayout = (scope: string): PanelLayout => contexts[scope] ?? emptyPanel
export function usePanelLayout(scope: string): PanelLayout {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => getPanelLayout(scope),
  )
}
/** 当前作用域里选中的标签 */
export function useActivePanelTab(): string | null {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    () => getPanelLayout(currentScope).active,
  )
}
export function selectPanelTab(scope: string, id: string): void {
  contexts = { ...contexts, [scope]: activatePanelTab(getPanelLayout(scope), id) }
  emit()
}
export function forgetPanelTabs(scope: string, ids: string[]): void {
  contexts = { ...contexts, [scope]: removePanelTabs(getPanelLayout(scope), ids) }
  emit()
}
export function detachPanelFile(id: string): void {
  contexts = Object.fromEntries(
    Object.entries(contexts).map(([scope, layout]) => [scope, removePanelTabs(layout, [id])]),
  )
  // 关掉的标签不再记「保存成别的 id」：以后同一个 id 是另一个文件（审查报告 2026-10-14）
  for (const [from, to] of [...persistedFileIds]) if (from === id || to === id) persistedFileIds.delete(from)
  emit()
}
/** 文件改名 / 移动后标签换了 id：各作用域布局里的旧 id 换成新的 */
export function renamePanelFile(from: string, to: string): void {
  const swap = (id: string): string => (id === from ? to : id)
  contexts = Object.fromEntries(
    Object.entries(contexts).map(([scope, layout]) => [
      scope,
      layout.tabs.includes(from)
        ? { ...layout, tabs: [...new Set(layout.tabs.map(swap))], active: layout.active && swap(layout.active) }
        : layout,
    ]),
  )
  for (const [key, value] of [...persistedFileIds]) if (value === from) persistedFileIds.set(key, to)
  emit()
}
export function replacePanelFile(from: string, to: string): void {
  persistedFileIds.set(from, to)
  emit()
}
export function openRightTab(id: string | ToolId, scope = currentScope): void {
  // 代码模式：只发事件，由 coding/routing.ts 落到对应的栏；不动对话模式右栏的标签和开合状态
  if (getAppMode() === 'code') {
    window.dispatchEvent(new CustomEvent(OPEN_RIGHT_WORKSPACE, { detail: { id, scope } }))
    return
  }
  if (id.startsWith('file:'))
    contexts = Object.fromEntries(
      Object.entries(contexts).map(([key, layout]) => [key, key === scope ? layout : removePanelTabs(layout, [id])]),
    )
  selectPanelTab(scope, id)
  window.dispatchEvent(new CustomEvent(OPEN_RIGHT_WORKSPACE, { detail: { id, scope } }))
}

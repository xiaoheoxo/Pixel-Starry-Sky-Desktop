import { useSyncExternalStore } from 'react'
import type { WorkspaceChoice } from '../../../../shared/types/machines'
const KEY = 'pixelsky.new-workspace-targets'
let targets: Record<string, WorkspaceChoice> = {}
try {
  targets = JSON.parse(localStorage.getItem(KEY) ?? '{}')
} catch {}
const listeners = new Set<() => void>()
export const draftWorkspace = (tab: string): WorkspaceChoice | null => targets[tab] ?? null
export function bindDraftWorkspace(tab: string, workspace: WorkspaceChoice, replace = false): void {
  if (targets[tab] && !replace) return
  targets = { ...targets, [tab]: workspace }
  try {
    localStorage.setItem(KEY, JSON.stringify(targets))
  } catch {}
  listeners.forEach(l => l())
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
/** 订阅版：新会话标签换了项目（「最近的项目」、工作区选择）时跟着重渲染 */
export function useDraftWorkspace(tab: string | undefined): WorkspaceChoice | null {
  const snap = (): WorkspaceChoice | null => (tab ? (targets[tab] ?? null) : null)
  return useSyncExternalStore(subscribe, snap, snap)
}

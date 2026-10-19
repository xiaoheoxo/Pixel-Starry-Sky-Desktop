/** Persist only references to existing resources. File drafts and PTYs have one owner. */
import { isFileTab } from '../panes/tree'
export const TOOL_IDS = [
  'files',
  'git',
  'artifacts',
  'terminal',
  'browser',
  'tasks',
  'sandbox',
  'copies',
  'connectors',
] as const
export type ToolId = (typeof TOOL_IDS)[number]
export interface PanelLayout {
  tabs: string[]
  active: string | null
}
export const emptyPanel: PanelLayout = { tabs: ['files'], active: 'files' }
export function validPanelTab(id: unknown): id is string {
  return typeof id === 'string' && ((TOOL_IDS as readonly string[]).includes(id) || isFileTab(id))
}
export function parsePanel(value: unknown): PanelLayout {
  if (!value || typeof value !== 'object') return emptyPanel
  const data = value as Partial<PanelLayout>
  const tabs = Array.isArray(data.tabs) ? [...new Set(data.tabs.filter(validPanelTab))].slice(0, 100) : ['files']
  return {
    tabs,
    active: typeof data.active === 'string' && tabs.includes(data.active) ? data.active : (tabs[0] ?? null),
  }
}
export function activatePanelTab(layout: PanelLayout, id: string): PanelLayout {
  return { tabs: layout.tabs.includes(id) ? layout.tabs : [...layout.tabs, id], active: id }
}
export function removePanelTabs(layout: PanelLayout, ids: readonly string[]): PanelLayout {
  const tabs = layout.tabs.filter(id => !ids.includes(id))
  const index = Math.max(0, layout.tabs.indexOf(layout.active ?? ''))
  return {
    tabs,
    active:
      layout.active && tabs.includes(layout.active) ? layout.active : (tabs[Math.min(index, tabs.length - 1)] ?? null),
  }
}
export function panelCloseTargets(layout: PanelLayout, id: string, mode: 'one' | 'others' | 'right' | 'all'): string[] {
  if (!layout.tabs.includes(id)) return []
  return mode === 'all'
    ? layout.tabs
    : mode === 'others'
      ? layout.tabs.filter(t => t !== id)
      : mode === 'right'
        ? layout.tabs.slice(layout.tabs.indexOf(id) + 1)
        : [id]
}

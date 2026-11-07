/** Persist only references to existing resources. File drafts and PTYs have one owner. */
import { isFileTab } from '../panes/tree'
export const TOOL_IDS = [
  'overview',
  'files',
  'git',
  'artifacts',
  'terminal',
  'browser',
  'tasks',
  'sandbox',
  'copies',
  'connectors',
  'comments',
] as const
export type ToolId = (typeof TOOL_IDS)[number]
export interface PanelLayout {
  tabs: string[]
  active: string | null
}
export const emptyPanel: PanelLayout = { tabs: ['overview', 'files'], active: 'files' }
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
  if (layout.tabs.includes(id)) return { ...layout, active: id }
  return { tabs: id === 'overview' ? [id, ...layout.tabs] : [...layout.tabs, id], active: id }
}
/** 旧布局没有「概况」：放到最前，选中的标签不变。全关了的不动 */
function withOverview(layout: PanelLayout): PanelLayout {
  return layout.tabs.length === 0 || layout.tabs.includes('overview')
    ? layout
    : { ...layout, tabs: ['overview', ...layout.tabs] }
}
/** 读存的布局。没有 v2 时迁移 v1；存过 v2 后只读它，关掉的「概况」不会再回来。v1 留着，退回旧版本还能用。JSON 坏了会抛错 */
export function restorePanels(v2: string | null, v1: string | null): Record<string, PanelLayout> {
  const value = JSON.parse(v2 ?? v1 ?? '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).map(([scope, layout]) => {
      const panel = parsePanel(layout)
      return [scope, v2 === null ? withOverview(panel) : panel]
    }),
  )
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

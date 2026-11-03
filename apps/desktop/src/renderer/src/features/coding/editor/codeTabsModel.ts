import type { DiffBase, EditorViewMode } from '../types'

/** 中栏标签的纯逻辑：按项目分组，不碰 window / localStorage */
export interface CodeTabGroup {
  tabs: string[]
  active: string | null
  /** 这组里每个标签上次用的视图（只在内存里）：同一个文件分屏在两组，可以一边代码一边变更 */
  views?: Record<string, CodeTabView>
}

/** 改这组里一个标签的视图；view 为空就删掉 */
export function withView(g: CodeTabGroup, id: string, view?: CodeTabView): CodeTabGroup {
  if (!view && !g.views?.[id]) return g
  const { [id]: _old, ...rest } = g.views ?? {}
  return { ...g, views: view ? { ...rest, [id]: view } : rest }
}

export const EMPTY_GROUP: CodeTabGroup = { tabs: [], active: null }
/** 同时保留的编辑器实例上限（超出的按最近最少使用释放） */
export const EDITOR_CAP = 12

/** Git 对比标签的 id 前缀：不是文件，只在内存里（数据在 gitDiffTabs.ts），不写进持久化 */
export const GIT_DIFF_PREFIX = 'gitdiff:'
export const isGitDiffId = (id: string): boolean => id.startsWith(GIT_DIFF_PREFIX)

const isId = (value: unknown): value is string => typeof value === 'string' && value.startsWith('file:')

/**
 * 一个项目的中栏：一组标签，向右分屏后左右两组（最多两组）。focus 是当前那组的下标；
 * 除了整个项目没标签时的 EMPTY_PANE，每组都至少有一个标签（关掉一组最后一个就回到一组）
 */
export interface CodeTabPane {
  groups: CodeTabGroup[]
  focus: number
}

export const EMPTY_PANE: CodeTabPane = { groups: [EMPTY_GROUP], focus: 0 }
export const focusedGroup = (p: CodeTabPane): CodeTabGroup => p.groups[p.focus] ?? EMPTY_GROUP
export const paneTabIds = (p: CodeTabPane): string[] => p.groups.flatMap(g => g.tabs)

/** 丢掉空组；当前那组还在就继续是当前，被丢掉了就是剩下的第一组 */
function normalize(next: CodeTabGroup[], focus: number): CodeTabPane {
  const kept = next.filter(g => g.tabs.length)
  if (!kept.length) return EMPTY_PANE
  const at = kept.indexOf(next[focus] ?? EMPTY_GROUP)
  return { groups: kept, focus: Math.max(0, at) }
}

/** 换掉第 index 组 */
export const updateGroup = (p: CodeTabPane, index: number, g: CodeTabGroup): CodeTabPane =>
  normalize(
    p.groups.map((x, i) => (i === index ? g : x)),
    p.focus,
  )

/** 每组都改一遍（改名、关掉某个 id、Git 对比换区） */
export const mapGroups = (p: CodeTabPane, fn: (g: CodeTabGroup) => CodeTabGroup): CodeTabPane =>
  normalize(p.groups.map(fn), p.focus)

/** 向右分屏：当前标签在右边新开一组并成为当前；已经两组或没有当前标签时不动 */
export function splitRight(p: CodeTabPane): CodeTabPane {
  const g = focusedGroup(p)
  if (p.groups.length > 1 || !g.active) return p
  return { groups: [g, withView({ tabs: [g.active], active: g.active }, g.active, g.views?.[g.active])], focus: 1 }
}

/** 点了第 index 组的某个标签：那组成为当前，标签成为那组的当前；没变化时原样返回 */
export function activateInPane(p: CodeTabPane, index: number, id: string): CodeTabPane {
  const g = p.groups[index]
  if (!g?.tabs.includes(id) || (g.active === id && p.focus === index)) return p
  return { groups: p.groups.map((x, i) => (i === index ? { ...x, active: id } : x)), focus: index }
}

/** 第 index 组成为当前 */
export const focusGroup = (p: CodeTabPane, index: number): CodeTabPane =>
  p.focus === index || !p.groups[index] ? p : { groups: p.groups, focus: index }

/** 保存的样子：左组照旧放在顶层（老版本读得懂），右组放 right，当前是右组时 focus: 1 */
interface StoredPane extends CodeTabGroup {
  right?: CodeTabGroup
  focus?: 1
}

function parseGroup(value: unknown): CodeTabGroup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_GROUP
  const list = (value as { tabs?: unknown }).tabs
  if (!Array.isArray(list)) return EMPTY_GROUP
  const tabs = [...new Set(list.filter(isId))]
  const active = (value as { active?: unknown }).active
  return { tabs, active: isId(active) && tabs.includes(active) ? active : (tabs[0] ?? null) }
}

/** 读出保存的标签；坏数据逐项丢掉 */
export function parseCodeTabs(raw: unknown): Record<string, CodeTabPane> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, CodeTabPane> = {}
  for (const [key, value] of Object.entries(raw)) {
    const stored = value as { right?: unknown; focus?: unknown } | null
    const pane = normalize([parseGroup(value), parseGroup(stored?.right)], stored?.focus === 1 ? 1 : 0)
    if (pane !== EMPTY_PANE) out[key] = pane
  }
  return out
}

/** 写进 localStorage 的内容：去掉 Git 对比标签（重启后不恢复），只剩对比标签的组 / 项目不存 */
export function persistable(panes: Record<string, CodeTabPane>): Record<string, StoredPane> {
  const out: Record<string, StoredPane> = {}
  for (const [key, p] of Object.entries(panes)) {
    const pane = mapGroups(p, g => {
      const tabs = g.tabs.filter(id => !isGitDiffId(id))
      return { tabs, active: g.active && tabs.includes(g.active) ? g.active : (tabs[0] ?? null) }
    })
    const [left, right] = pane.groups
    if (!left?.tabs.length) continue
    out[key] = { ...left, ...(right && { right }), ...(right && pane.focus === 1 && { focus: 1 as const }) }
  }
  return out
}

/** 把一个标签换成另一个（Git 对比的文件换了区）：位置不变；新 id 已经开着就只留那一个；换的是当前标签则新的成为当前 */
export function replaceInGroup(g: CodeTabGroup, from: string, to: string): CodeTabGroup {
  const index = g.tabs.indexOf(from)
  if (index < 0 || from === to) return g
  const active = g.active === from ? to : g.active
  const tabs = g.tabs.includes(to) ? g.tabs.filter(t => t !== from) : g.tabs.map(t => (t === from ? to : t))
  // 视图跟着换 id（文件改名）
  const moved = g.views?.[from]
  const next = { ...g, tabs, active }
  return moved ? withView(withView(next, from), to, moved) : next
}

/** 已有就激活，否则插到当前标签右边（没有当前标签就放最后） */
export function openInGroup(g: CodeTabGroup, id: string): CodeTabGroup {
  if (g.tabs.includes(id)) return g.active === id ? g : { ...g, active: id }
  const at = g.active ? g.tabs.indexOf(g.active) : -1
  const tabs = [...g.tabs]
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, id)
  return { ...g, tabs, active: id }
}

/** 关闭一个标签；关的是当前标签时激活右边那个，没有就左边 */
export function closeInGroup(g: CodeTabGroup, id: string): CodeTabGroup {
  const index = g.tabs.indexOf(id)
  if (index < 0) return g
  const tabs = g.tabs.filter(t => t !== id)
  const active = g.active === id ? (tabs[index] ?? tabs[index - 1] ?? null) : g.active
  return withView({ ...g, tabs, active }, id)
}

/** 在标签之间循环切换，到头了绕回另一头 */
export function cycleInGroup(g: CodeTabGroup, delta: 1 | -1): CodeTabGroup {
  if (g.tabs.length < 2) return g
  const at = g.active ? g.tabs.indexOf(g.active) : -1
  const next = at < 0 ? 0 : (at + delta + g.tabs.length) % g.tabs.length
  return { tabs: g.tabs, active: g.tabs[next] ?? g.active }
}

/**
 * 要释放哪些编辑器实例。order 从最久没用到最近用过；当前标签和有未保存改动的不释放；
 * 超出 cap 多少就释放多少（最久的先），释放不够时也不强行释放那两类
 */
export function lruToRelease(
  order: string[],
  active: string | null,
  dirty: ReadonlySet<string>,
  cap: number,
): string[] {
  const excess = order.length - cap
  if (excess <= 0) return []
  return order.filter(id => id !== active && !dirty.has(id)).slice(0, excess)
}

export interface CodeTabsState {
  projectKey: string
  /** 当前那组（分屏时是最后点过的那组）；只关心「中栏当前文件」的地方用它 */
  group: CodeTabGroup
  pane: CodeTabPane
}

/** 标签上次用的视图；mode 空着就按文件类型取默认（代码，Markdown 是预览） */
export interface CodeTabView {
  mode?: EditorViewMode
  base: DiffBase
}

/**
 * 从「打开文件」类入口（文件树、Ctrl+P、搜索、路径链接、Git 的「打开文件」）再打开一个标签时的视图：
 * 停在「变更 / 并排」的回到文件本身，对比基准留着；「代码 / 预览」是用户自己选的，不动。
 * 看改动的入口（点改动行、AI 改动卡片）打开后会再设成「变更」，不受影响
 */
export function reopenedView(view: CodeTabView | undefined): CodeTabView | undefined {
  if (!view || (view.mode !== 'diff' && view.mode !== 'split')) return view
  return { base: view.base }
}

/** 路径比较用的归一化：Windows 本机不分大小写 */
export const pathKey = (path: string, caseInsensitive: boolean): string => {
  const p = path.replaceAll('\\', '/').replace(/^\.\//, '')
  return caseInsensitive ? p.toLowerCase() : p
}

/** 文件名（最后一段） */
export const baseName = (path: string): string => path.replaceAll('\\', '/').split('/').pop() ?? path

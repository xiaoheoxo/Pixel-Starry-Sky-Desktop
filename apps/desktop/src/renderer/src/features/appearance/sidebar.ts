import { useSyncExternalStore } from 'react'
import {
  DEFAULT_SIDEBAR_ICONS,
  LAYOUT_ACTIONS,
  PAGE_ACTIONS,
  SIDEBAR_ACTIONS,
  TOOL_ACTIONS,
  isSidebarIcon,
  type LayoutAction,
  type SidebarAction,
  type SidebarIconId,
  type SidebarIcons,
} from './sidebarIcons'

export type { HeaderAction, LayoutAction, SidebarAction, SidebarIconId, SidebarIcons } from './sidebarIcons'

/** header 是窗口右上角顶栏，bottom 是侧栏底部，hidden 是不显示（docs/ui/layout-v2.md §7.1） */
export type SidebarPlacement = 'header' | 'bottom' | 'hidden'

export interface SidebarLayout {
  header: LayoutAction[]
  bottom: LayoutAction[]
  hidden: LayoutAction[]
}

export interface SidebarPrefs {
  version: 4
  /** 做过的一次性升级（不升 version：旧版本读到不认识的版本号会把整份偏好当坏的） */
  upgrades?: string[]
  showRecent: boolean
  recentExpanded: boolean
  /** 自己点过「最近任务」的展开 / 收起（可选，不升版本）：点过就不再按窗口高度自动收起 */
  recentChosen?: boolean
  /** 侧栏里收起的项目 ID（可选，不升版本；docs/ui/sidebar-hierarchy.md） */
  collapsed?: string[]
  /** 侧栏分区：几个项目归成一组（可选，不升版本；docs/ui/sidebar-groups.md） */
  groups?: ProjectGroup[]
  /** 侧栏里拖出来的项目先后（项目 ID；可选，不升版本）。分区的先后就是 groups 的先后 */
  order?: string[]
  icons: SidebarIcons
  layout: SidebarLayout
}

/** 侧栏分区：只是收纳，项目和对话都不动；一个项目最多在一个分区里 */
export interface ProjectGroup {
  id: string
  name: string
  /** 项目 ID，按加入的先后 */
  projects: string[]
}

export const SIDEBAR_PREFS_KEY = 'pixelsky.sidebar'
/** 窗口高度低于这个值，「最近任务」默认收起（docs/ui/conversation-ux-2.md §2.3） */
export const RECENT_AUTO_COLLAPSE_HEIGHT = 900
export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = {
  header: ['openIn'],
  bottom: ['usage', 'plugins', 'settings'],
  hidden: ['git', ...TOOL_ACTIONS, ...PAGE_ACTIONS],
}
/** 侧栏最窄 240px 时底部一排放得下的可移动图标（账号还占一格） */
export const SIDEBAR_ROW_LIMIT = 5
/** 顶栏最多几个：入口多了不能把标题挤没；「不显示」不限 */
export const HEADER_ROW_LIMIT = 8
export const rowLimit = (row: SidebarPlacement): number =>
  row === 'bottom' ? SIDEBAR_ROW_LIMIT : row === 'header' ? HEADER_ROW_LIMIT : Number.POSITIVE_INFINITY

export const LAYOUT_PLACEMENTS: readonly SidebarPlacement[] = ['header', 'bottom', 'hidden']

/**
 * 读保存数据时的排序和去向：旧的「侧栏顶部」(top) 并进底部，旧的「更多工具」(more) 并进不显示。
 * 顺序固定为 header → bottom → hidden → top → more，所以旧数据里的 top / more 排在新排之后
 */
const READ_ORDER: readonly (readonly [string, SidebarPlacement])[] = [
  ['header', 'header'],
  ['bottom', 'bottom'],
  ['hidden', 'hidden'],
  ['top', 'bottom'],
  ['more', 'hidden'],
]

/** 改名的入口：自动化换成了 Git（D061），保存的位置原样沿用 */
const RENAMED: Record<string, LayoutAction> = { automation: 'git' }

function isLayoutAction(value: unknown): value is LayoutAction {
  return LAYOUT_ACTIONS.includes(value as LayoutAction)
}

export function isRowFull(layout: SidebarLayout, row: SidebarPlacement, moving?: LayoutAction): boolean {
  return layout[row].filter(item => item !== moving).length >= rowLimit(row)
}

/** 能不能把入口放进这一排：「设置」不能进「不显示」（它是改回来的入口），底部排满也不行。落点判断、移动、读取都只调它 */
export function canPlace(layout: SidebarLayout, row: SidebarPlacement, action: LayoutAction): boolean {
  return !(row === 'hidden' && action === 'settings') && !isRowFull(layout, row, action)
}

/** 最近任务现在是不是展开：点过就按自己的；没点过且保存的是收起也按保存的；否则窗口矮就收起 */
export function recentOpen(p: Pick<SidebarPrefs, 'recentExpanded' | 'recentChosen'>, short: boolean): boolean {
  if (p.recentChosen) return p.recentExpanded
  if (!p.recentExpanded) return false
  return !short
}

/** 先保留各排已有的合法顺序，再把缺失入口补回默认排；放不下的先试底部，再试顶栏，最后不显示。 */
function parseSidebarLayout(value: unknown): SidebarLayout {
  const result: SidebarLayout = { header: [], bottom: [], hidden: [] }
  const seen = new Set<LayoutAction>()
  const place = (row: SidebarPlacement, action: LayoutAction): void => {
    const target = ([row, 'bottom', 'header', 'hidden'] as const).find(r => canPlace(result, r, action)) ?? 'header'
    result[target].push(action)
    seen.add(action)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const saved = value as Record<string, unknown>
    for (const [key, row] of READ_ORDER) {
      const items = saved[key]
      if (!Array.isArray(items)) continue
      for (const raw of items) {
        const item = typeof raw === 'string' ? (RENAMED[raw] ?? raw) : raw
        if (isLayoutAction(item) && !seen.has(item)) place(row, item)
      }
    }
  }
  for (const row of LAYOUT_PLACEMENTS) {
    for (const action of DEFAULT_SIDEBAR_LAYOUT[row]) {
      if (!seen.has(action)) place(row, action)
    }
  }
  return result
}

const GIT_TO_MORE = 'header-git-to-more'
/** 侧栏改成项目 → 对话两层后（docs/ui/sidebar-hierarchy.md），「最近任务」默认关掉一次；之后在设置里打开不会再被关 */
const RECENT_OFF = 'recent-off'
/** 记住的收起项目最多这么多个，删掉的项目留下的 ID 不会无限累积 */
const COLLAPSED_LIMIT = 200
/** 记住的项目先后最多这么多个 */
const ORDER_LIMIT = 500
/** 2026-10-13 之前的默认顶栏（云主机已在读取时丢掉） */
const OLD_HEADER = 'workbench,channels,git,openIn'
/** 早已删掉的入口，读原始数据比对时也要先去掉 */
const REMOVED = ['terminal', 'editor', 'commandPalette', 'machines']

/** 原始数据里某一排的名字（只认字符串，非数组为空），用来判断是不是旧默认，不依赖解析后的结果 */
function rawRow(layout: unknown, key: string): string[] {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return []
  const row = (layout as Record<string, unknown>)[key]
  if (!Array.isArray(row)) return []
  return row
    .filter((item): item is string => typeof item === 'string')
    .map(item => (RENAMED[item] as string | undefined) ?? item)
    .filter(item => !REMOVED.includes(item))
}

function defaults(): SidebarPrefs {
  return {
    version: 4,
    upgrades: [GIT_TO_MORE, RECENT_OFF],
    showRecent: false,
    recentExpanded: true,
    icons: { ...DEFAULT_SIDEBAR_ICONS },
    layout: parseSidebarLayout(null),
  }
}

/** 旧版默认位置升级；v3 及以前没有顶栏排，按默认补齐。保留自定义布局、图标和历史偏好，损坏字段按项修复。 */
export function parseSidebarPrefs(value: unknown): SidebarPrefs {
  const result = defaults()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const saved = value as Record<string, unknown>
  if (saved.version !== 1 && saved.version !== 2 && saved.version !== 3 && saved.version !== 4) return result
  if (typeof saved.showRecent === 'boolean') result.showRecent = saved.showRecent
  if (typeof saved.recentExpanded === 'boolean') result.recentExpanded = saved.recentExpanded
  if (typeof saved.recentChosen === 'boolean') result.recentChosen = saved.recentChosen
  if (Array.isArray(saved.collapsed)) {
    const ids = saved.collapsed.filter((id): id is string => typeof id === 'string' && !!id && id.length <= 200)
    if (ids.length) result.collapsed = [...new Set(ids)].slice(-COLLAPSED_LIMIT)
  }
  const groups = parseProjectGroups(saved.groups)
  if (groups.length) result.groups = groups
  if (Array.isArray(saved.order)) {
    const ids = saved.order.filter((id): id is string => typeof id === 'string' && !!id && id.length <= 200)
    if (ids.length) result.order = [...new Set(ids)].slice(0, ORDER_LIMIT)
  }
  if (saved.icons && typeof saved.icons === 'object' && !Array.isArray(saved.icons)) {
    const icons = saved.icons as Record<string, unknown>
    for (const action of SIDEBAR_ACTIONS) {
      if (isSidebarIcon(action, icons[action])) result.icons[action] = icons[action]
    }
  }
  if (saved.version === 2 || saved.version === 3 || saved.version === 4) {
    result.layout = parseSidebarLayout(saved.layout)
    // Git 的常用操作挪到输入框上方后（docs/ui/composer-git.md），顶栏的 Git 默认收起（现在是「不显示」）；
    // 只改没动过的旧默认顶栏，自己排过的不动；只做一次，之后挪回顶栏不会再被改。
    // 判断看保存的原始数据：解析后工作台、频道已被丢掉，永远等不于 OLD_HEADER（docs/ui/layout-v2.md §7.2）
    const upgrades = Array.isArray(saved.upgrades) ? saved.upgrades.filter(u => typeof u === 'string') : []
    if (!upgrades.includes(GIT_TO_MORE)) {
      if (rawRow(saved.layout, 'header').join() === OLD_HEADER && !rawRow(saved.layout, 'more').length) {
        const { header, hidden } = result.layout
        result.layout = {
          ...result.layout,
          header: header.filter(a => a !== 'git'),
          hidden: ['git', ...hidden.filter(a => a !== 'git')],
        }
      }
      upgrades.push(GIT_TO_MORE)
    }
    result.upgrades = upgrades
    // v2 的旧默认位置整份换成新默认；同样看原始数据（解析后 top 已并进底部）
    if (
      saved.version === 2 &&
      rawRow(saved.layout, 'top').join() === 'addProject,newTask' &&
      rawRow(saved.layout, 'bottom').join() === 'settings,plugins,usage'
    ) {
      result.layout = parseSidebarLayout(null)
    }
  }
  // 看原始数据：v1 没有 upgrades，解析结果里是默认值、已经带着 RECENT_OFF
  const done = Array.isArray(saved.upgrades) ? saved.upgrades : []
  if (!done.includes(RECENT_OFF)) {
    result.showRecent = false
    result.upgrades = [...(result.upgrades ?? []).filter(u => u !== RECENT_OFF), RECENT_OFF]
  }
  return result
}

export const GROUP_NAME_LIMIT = 40
const GROUP_LIMIT = 50

/** 分区：名字去掉首尾空白、最长 40 字；同一个项目只算在第一个分区里；没有项目的分区丢掉 */
function parseProjectGroups(value: unknown): ProjectGroup[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>(),
    ids = new Set<string>(),
    result: ProjectGroup[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || result.length >= GROUP_LIMIT) continue
    const { id, name, projects } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || id.length > 80 || ids.has(id) || typeof name !== 'string') continue
    const label = Array.from(name.trim()).slice(0, GROUP_NAME_LIMIT).join('')
    if (!label || !Array.isArray(projects)) continue
    const members = projects.filter(
      (p): p is string => typeof p === 'string' && !!p && p.length <= 200 && !seen.has(p) && !!seen.add(p),
    )
    if (!members.length) continue
    ids.add(id)
    result.push({ id, name: label, projects: members.slice(0, COLLAPSED_LIMIT) })
  }
  return result
}

export function readSidebarPrefs(): SidebarPrefs {
  try {
    return parseSidebarPrefs(JSON.parse(localStorage.getItem(SIDEBAR_PREFS_KEY) ?? 'null'))
  } catch {
    return defaults()
  }
}

let prefs = readSidebarPrefs()
const listeners = new Set<() => void>()

export function getSidebarPrefs(): SidebarPrefs {
  return prefs
}

export function setSidebarPrefs(patch: Partial<Omit<SidebarPrefs, 'version'>>): void {
  prefs = parseSidebarPrefs({ ...prefs, ...patch, version: 4 })
  try {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 存储不可用时，本窗口仍可切换，且不影响其他外观偏好。
  }
  listeners.forEach(listener => listener())
}

/** 侧栏项目收起（collapsed 为 true）或展开；对话模式侧栏和代码模式左栏共用 */
export function setProjectsCollapsed(ids: readonly string[], collapsed: boolean): void {
  const current = new Set(prefs.collapsed ?? [])
  for (const id of ids) {
    if (collapsed) current.add(id)
    else current.delete(id)
  }
  setSidebarPrefs({ collapsed: [...current] })
}

/** 整组替换分区（增删改由 sidebar/projectGroups.ts 的纯函数算好） */
export function setProjectGroups(groups: ProjectGroup[]): void {
  setSidebarPrefs({ groups })
}

/** 拖动换位置：分区和项目先后一起存（项目拖进别的分区时两样都变） */
export function setProjectArrangement(arrangement: { groups: ProjectGroup[]; order: string[] }): void {
  setSidebarPrefs(arrangement)
}

export function setSidebarIcon(action: SidebarAction, id: SidebarIconId): void {
  setSidebarPrefs({ icons: { ...prefs.icons, [action]: id } })
}

export function resetSidebarIcons(): void {
  setSidebarPrefs({ icons: { ...DEFAULT_SIDEBAR_ICONS } })
}

export function setSidebarLayout(layout: SidebarLayout): void {
  setSidebarPrefs({ layout })
}

export function resetSidebarLayout(): void {
  setSidebarLayout(DEFAULT_SIDEBAR_LAYOUT)
}

/** index 是先移除原位置后，在目标排中的插入索引；目标排放不下（底部已满、设置进不显示）时不移动。不修改传入布局。 */
export function moveSidebarActionInLayout(
  layout: SidebarLayout,
  action: LayoutAction,
  row: SidebarPlacement,
  index: number,
): SidebarLayout {
  const result = parseSidebarLayout(layout)
  if (!isLayoutAction(action) || !LAYOUT_PLACEMENTS.includes(row) || !canPlace(result, row, action)) return result
  for (const placement of LAYOUT_PLACEMENTS) result[placement] = result[placement].filter(item => item !== action)
  const target = result[row]
  const insertion = Number.isNaN(index) ? 0 : Math.max(0, Math.min(target.length, Math.trunc(index)))
  target.splice(insertion, 0, action)
  return result
}

export function moveSidebarAction(action: LayoutAction, row: SidebarPlacement, index: number): void {
  setSidebarLayout(moveSidebarActionInLayout(prefs.layout, action, row, index))
}

function onStorage(event: StorageEvent): void {
  try {
    if (event.storageArea !== localStorage || (event.key !== SIDEBAR_PREFS_KEY && event.key !== null)) return
  } catch {
    return
  }
  prefs = readSidebarPrefs()
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

export function useSidebarPrefs(): SidebarPrefs {
  return useSyncExternalStore(subscribe, getSidebarPrefs, getSidebarPrefs)
}

const SHORT_QUERY = `(max-height: ${RECENT_AUTO_COLLAPSE_HEIGHT - 0.02}px)`

function subscribeShort(listener: () => void): () => void {
  const query = window.matchMedia(SHORT_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/** 窗口是不是矮（按窗口高度而不是侧栏可用高度：收起后滚动区变高不会又翻回来） */
export function useShortWindow(): boolean {
  return useSyncExternalStore(
    subscribeShort,
    () => window.matchMedia(SHORT_QUERY).matches,
    () => false,
  )
}

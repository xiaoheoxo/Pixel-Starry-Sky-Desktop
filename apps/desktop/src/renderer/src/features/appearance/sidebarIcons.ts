import {
  Blocks,
  Bolt,
  ChartColumn,
  ChartNoAxesCombined,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitBranch,
  Hash,
  Kanban,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  ScanSearch,
  Search,
  SquareKanban,
  TextSearch,
  Server,
  Smartphone,
  SquareArrowOutUpRight,
  Store,
  PenLine,
  Plug,
  Plus,
  Puzzle,
  Settings,
  SlidersHorizontal,
  SquarePen,
  type LucideIcon,
} from 'lucide-react'
import { toolIcon } from '@/features/panel/tools'

/** 可替换图标的侧栏动作，按侧栏从上到下排（设置页照这个顺序列，docs/ui/layout-v2.md §17） */
export const SIDEBAR_ACTIONS = [
  'newTask',
  'search',
  'board',
  'channels',
  'addProject',
  'settings',
  'plugins',
  'usage',
] as const
export type SidebarAction = (typeof SIDEBAR_ACTIONS)[number]

/** 能放在侧栏底部的动作（可换图标）；新建任务、添加项目固定在侧栏里，只能换图标（docs/ui/layout-v2.md §7.1） */
export const FOOTER_ACTIONS = ['settings', 'plugins', 'usage'] as const
export type FooterAction = (typeof FOOTER_ACTIONS)[number]

/**
 * 原右上角顶栏的工具；图标固定，位置可与底部动作互换。
 * 终端、编辑器（</>）、命令面板已于 2026-10-10 移除（D066）：终端和文件在右侧工作区，命令面板用 Ctrl+Shift+P；
 * 云主机 2026-10-13 并进顶栏的机器切换；工作台、频道同日不再是顶栏按钮，频道在侧栏第四行（docs/ui/layout-v2.md）。
 * 保存的布局里如果还有它们，读取时自动丢弃。
 */
export const HEADER_ACTIONS = ['git', 'openIn'] as const
export type HeaderAction = (typeof HEADER_ACTIONS)[number]

/**
 * 右侧工作区的工具（features/panel/tools.ts）：点了打开那一页，再点收起，和 Git 一样（docs/ui/layout-v2.md §19）。
 * 名字带前缀：早先删掉的入口也叫 terminal、machines，旧偏好里可能还留着，不能让它们复活
 */
export const TOOL_ACTIONS = [
  'tool:browser',
  'tool:connectors',
  'tool:terminal',
  'tool:files',
  'tool:artifacts',
  'tool:comments',
  'tool:sandbox',
  'tool:tasks',
  'tool:copies',
] as const
export type ToolAction = (typeof TOOL_ACTIONS)[number]

/** 设置里的页面：点了打开设置那一页 */
export const PAGE_ACTIONS = ['page:mobile', 'page:machines', 'page:extensions'] as const
export type PageAction = (typeof PAGE_ACTIONS)[number]

/** 图标位置编辑器里可移动的全部入口 */
export const LAYOUT_ACTIONS = [...FOOTER_ACTIONS, ...HEADER_ACTIONS, ...TOOL_ACTIONS, ...PAGE_ACTIONS] as const
export type LayoutAction = (typeof LAYOUT_ACTIONS)[number]

const FIXED_ICONS: Record<HeaderAction | PageAction, LucideIcon> = {
  git: GitBranch,
  openIn: SquareArrowOutUpRight,
  'page:mobile': Smartphone,
  'page:machines': Server,
  'page:extensions': Store,
}

export const isToolAction = (action: LayoutAction): action is ToolAction => action.startsWith('tool:')
export const isPageAction = (action: LayoutAction): action is PageAction => action.startsWith('page:')

export function isFooterAction(action: LayoutAction): action is FooterAction {
  return (FOOTER_ACTIONS as readonly string[]).includes(action)
}

/** 显式引用候选图标；本机偏好只保存 ID，不保存组件或导入整个图标库。 */
const ICONS = {
  'square-pen': SquarePen,
  'pen-line': PenLine,
  plus: Plus,
  search: Search,
  'text-search': TextSearch,
  'scan-search': ScanSearch,
  'square-kanban': SquareKanban,
  kanban: Kanban,
  'list-todo': ListTodo,
  'message-square': MessageSquare,
  'messages-square': MessagesSquare,
  hash: Hash,
  'folder-plus': FolderPlus,
  'folder-open': FolderOpen,
  folder: Folder,
  settings: Settings,
  'sliders-horizontal': SlidersHorizontal,
  bolt: Bolt,
  puzzle: Puzzle,
  blocks: Blocks,
  plug: Plug,
  'chart-column': ChartColumn,
  'chart-no-axes-combined': ChartNoAxesCombined,
  gauge: Gauge,
} satisfies Record<string, LucideIcon>

export type SidebarIconId = keyof typeof ICONS
export type SidebarIcons = Record<SidebarAction, SidebarIconId>

export const SIDEBAR_ICON_OPTIONS: Record<SidebarAction, readonly SidebarIconId[]> = {
  newTask: ['square-pen', 'pen-line', 'plus'],
  search: ['search', 'text-search', 'scan-search'],
  board: ['square-kanban', 'kanban', 'list-todo'],
  channels: ['message-square', 'messages-square', 'hash'],
  addProject: ['folder-plus', 'folder-open', 'folder'],
  settings: ['settings', 'sliders-horizontal', 'bolt'],
  plugins: ['puzzle', 'blocks', 'plug'],
  usage: ['chart-column', 'chart-no-axes-combined', 'gauge'],
}

export const DEFAULT_SIDEBAR_ICONS: SidebarIcons = {
  newTask: 'square-pen',
  search: 'search',
  board: 'square-kanban',
  channels: 'message-square',
  addProject: 'folder-plus',
  settings: 'settings',
  plugins: 'puzzle',
  usage: 'chart-column',
}

export function isSidebarIcon(action: SidebarAction, value: unknown): value is SidebarIconId {
  return typeof value === 'string' && SIDEBAR_ICON_OPTIONS[action].includes(value as SidebarIconId)
}

export function getSidebarIcon(action: SidebarAction, icons: SidebarIcons): LucideIcon {
  const id = isSidebarIcon(action, icons[action]) ? icons[action] : DEFAULT_SIDEBAR_ICONS[action]
  return ICONS[id]
}

/** 任意入口的当前图标：侧栏动作按用户选择，其余固定 */
export function getLayoutIcon(action: LayoutAction, icons: SidebarIcons): LucideIcon {
  if (isFooterAction(action)) return getSidebarIcon(action, icons)
  return isToolAction(action) ? (toolIcon(action.slice(5)) ?? Plug) : FIXED_ICONS[action]
}

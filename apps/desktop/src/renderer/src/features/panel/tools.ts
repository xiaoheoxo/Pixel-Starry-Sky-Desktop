// 右侧工作区的工具注册表（docs/ui/right-workspace-tools.md §2.1）：图标和分组只在这里登记，
// 顺序就是「+」菜单和空状态启动页的顺序。名称用 workspace.<id>，说明用 workspace.<id>Hint。
// 各工具怎么挂载（常驻 / 首次打开时挂载、带请求参数）仍在 RightPanel.tsx。
import {
  Box,
  Copy,
  FolderTree,
  GitBranch,
  Globe,
  ListChecks,
  Package,
  Plug,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import type { ToolId } from './workspaceState'

export type ToolGroup = 'code' | 'run' | 'project'

export interface ToolMeta {
  id: ToolId
  icon: LucideIcon
  group: ToolGroup
}

export const TOOLS: readonly ToolMeta[] = [
  { id: 'files', icon: FolderTree, group: 'code' },
  { id: 'git', icon: GitBranch, group: 'code' },
  { id: 'artifacts', icon: Package, group: 'code' },
  { id: 'terminal', icon: SquareTerminal, group: 'run' },
  { id: 'browser', icon: Globe, group: 'run' },
  { id: 'sandbox', icon: Box, group: 'run' },
  { id: 'tasks', icon: ListChecks, group: 'project' },
  { id: 'copies', icon: Copy, group: 'project' },
  { id: 'connectors', icon: Plug, group: 'project' },
]

export const TOOL_GROUPS: readonly ToolGroup[] = ['code', 'run', 'project']

/** 分组标题的词典 key */
export const GROUP_KEY = {
  code: 'workspace.groupCode',
  run: 'workspace.groupRun',
  project: 'workspace.groupProject',
} as const satisfies Record<ToolGroup, string>

/** 工具说明的词典 key */
export const hintKey = (id: ToolId) => `workspace.${id}Hint` as const

export const toolIcon = (id: string): LucideIcon | undefined => TOOLS.find(tool => tool.id === id)?.icon

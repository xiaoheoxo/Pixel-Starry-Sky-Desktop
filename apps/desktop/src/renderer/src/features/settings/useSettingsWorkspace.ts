// 设置页里要「当前工作区」的地方（插件页）用它：浮层里就是主窗口当前的；独立窗口里没有会话和窗格，
// 用主窗口报给主进程、再转过来的那份（docs/ui/settings-window.md §4）。
import { useActiveWorkspace, type ActiveWorkspace } from '@/features/editor/target'
import { isSettingsWindowView, useSettingsWindowState } from './windowBridge'

const NONE: ActiveWorkspace = { ref: null, name: '', path: '', key: '' }

export function useSettingsWorkspace(): ActiveWorkspace {
  const local = useActiveWorkspace()
  const forwarded = useSettingsWindowState().workspace
  return isSettingsWindowView ? (forwarded ?? NONE) : local
}

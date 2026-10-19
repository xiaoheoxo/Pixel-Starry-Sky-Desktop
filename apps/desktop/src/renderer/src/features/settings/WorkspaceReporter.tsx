import { useEffect } from 'react'
import { useActiveWorkspace } from '@/features/editor/target'

/** 主窗口：把当前工作区报给主进程，开着设置独立窗口时转给它（插件页按它显示，docs/ui/settings-window.md §4） */
export function WorkspaceReporter() {
  const workspace = useActiveWorkspace()
  useEffect(() => {
    window.pixelsky?.settingsWindow?.reportWorkspace(workspace)
  }, [workspace])
  return null
}

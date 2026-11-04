import type { EditorView } from '@codemirror/view'
import { Puzzle } from 'lucide-react'
import { getLocale, tr } from '@/i18n/core'
import type { MenuAction } from '@/ui/ActionMenu'
import { getPackState } from '../store'
import { runPackCommand } from './ExtCommandHost'
import { commandBlock, packCommands } from './model'

/** 编辑器右键菜单里的扩展命令：where 写了 editor 的，不满足 requires 的不显示 */
export function commandMenuActions(tabId: string, view: EditorView): MenuAction[] {
  const snapshot = { hasEditor: true, hasSelection: !view.state.selection.main.empty }
  const items = packCommands(getPackState(), getLocale()).filter(
    c => c.where.includes('editor') && !commandBlock(c, snapshot),
  )
  return items.map(c => ({
    label: tr('extCommands.label', { name: c.packName, title: c.title }),
    icon: Puzzle,
    run: () => void runPackCommand(c, tabId),
  }))
}

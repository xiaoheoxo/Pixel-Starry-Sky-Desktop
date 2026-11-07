// 完全放行的二次确认：从别的模式切进完全放行时每次都先确认，不能关（权限菜单就地确认、审批卡就地确认）。
// 确认里的勾选框只管启用后输入框上方的提示条（fullAccessStripState.ts），不跳过确认。
import type { PermissionMode } from '@pixelsky/protocol'

/** 这次切换要不要先确认：从别的模式切进完全放行时 */
export function needsFullConfirm(from: PermissionMode, to: PermissionMode): boolean {
  return to === 'full' && from !== 'full'
}

/** 快捷键切到下一个模式：完全放行要先确认，快捷键不进它；从它按下去回到第一个 */
export function nextPermissionMode(mode: PermissionMode, modes: PermissionMode[]): PermissionMode {
  const cycle: PermissionMode[] = modes.filter(m => m !== 'full')
  return cycle[(cycle.indexOf(mode) + 1) % cycle.length] ?? mode
}

/** 「改回」用哪个模式：新会话的默认不是完全放行就用它，否则自动编辑（引擎不支持时每次询问） */
export function saferMode(defaultMode: PermissionMode | null | undefined, modes: PermissionMode[]): PermissionMode {
  if (defaultMode && defaultMode !== 'full' && modes.includes(defaultMode)) return defaultMode
  return modes.includes('edits') ? 'edits' : 'ask'
}

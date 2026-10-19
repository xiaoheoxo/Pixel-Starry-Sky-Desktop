type KeyLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>

/**
 * 终端里这次按键是不是「复制」（docs/ui/terminal-command-palette.md）：Ctrl/⌘+Shift+C 一直是；
 * Windows / Linux 上有选中内容时 Ctrl+C 也是（和 Windows Terminal、VS Code 一样），没有选中时 Ctrl+C 照旧交给 Shell 中断。
 * macOS 的 Ctrl+C 永远是中断，复制用 ⌘C。
 */
export function isCopyKey(event: KeyLike, hasSelection: boolean, mac: boolean): boolean {
  if (event.code !== 'KeyC' || event.altKey) return false
  if ((event.ctrlKey || event.metaKey) && event.shiftKey) return true
  return !mac && hasSelection && event.ctrlKey && !event.metaKey && !event.shiftKey
}

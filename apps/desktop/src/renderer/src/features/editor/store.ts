import { useSyncExternalStore } from 'react'
import type { EditorState } from '../../../../shared/types/workspace'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
let state: EditorState | null = null
const listeners = new Set<() => void>()
export function setEditors(next: EditorState): void {
  state = next
  listeners.forEach(l => l())
}
export function useEditors(): EditorState | null {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}
export async function refreshEditors(force = false): Promise<void> {
  setEditors(isDemo ? demo().files.editorState : await window.pixelsky!.editor.state(force))
}
/**
 * 另一个窗口（比如独立的设置窗口）改了默认打开方式、外部编辑器：主进程广播 editor:changed，
 * 这个窗口里加载过编辑器状态的就重新取一次（没加载过的，用到时自然会取）
 */
export function watchEditorChanges(subscribe: (callback: () => void) => () => void): () => void {
  return subscribe(() => {
    if (state) void refreshEditors().catch(() => {})
  })
}
if (!isDemo && typeof window !== 'undefined' && window.pixelsky?.editor?.onChanged)
  watchEditorChanges(callback => window.pixelsky!.editor.onChanged(callback))

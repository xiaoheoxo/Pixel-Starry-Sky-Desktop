// 脚本调用编辑器（docs/ui/extension-commands-plan.md §4）：只碰运行命令时的那个标签；命令开始后用户改过文档就拒绝写入
import type { Text } from '@codemirror/state'
import { fileLanguage } from '@/features/editor/code/languages'
import { getEditorView } from '@/features/editor/code/CodeEditor'
import { getFiles } from '@/features/files/store'

/** 超过就报错，不给半截内容 */
const MAX_TEXT = 1024 * 1024

export interface EditorRun {
  tabId: string | null
  /** 命令开始时（或脚本自己上次写入后）的文档 */
  doc: Text | null
}

function viewOf(run: EditorRun) {
  const view = run.tabId ? getEditorView(run.tabId) : null
  if (!view) throw new Error('no editor is available for this command')
  return view
}

export function editorCall(run: EditorRun, method: string, args: unknown[]): unknown {
  const view = viewOf(run)
  const { state } = view
  if (method === 'editor.getContext') {
    const path = getFiles().tabs.find(t => t.id === run.tabId)?.path ?? ''
    const { from, to, head } = state.selection.main
    if (to - from > MAX_TEXT) throw new Error('the selection is larger than 1 MB')
    return {
      path,
      language: path ? fileLanguage(path) : '',
      cursor: head,
      length: state.doc.length,
      readonly: state.readOnly,
      selection: { from, to, text: state.sliceDoc(from, to) },
    }
  }
  if (method === 'editor.getText') {
    if (state.doc.length > MAX_TEXT) throw new Error('the file is larger than 1 MB')
    return state.doc.toString()
  }
  if (method === 'editor.replaceRange') {
    const [from, to, text] = args as [number, number, string]
    if (state.readOnly) throw new Error('this file is read-only')
    if (run.doc && !state.doc.eq(run.doc)) throw new Error('the file changed while the command was running')
    if (to > state.doc.length) throw new Error('the range is outside the file')
    view.dispatch({ changes: { from, to, insert: text }, userEvent: 'input.extension' })
    run.doc = view.state.doc
    return undefined
  }
  throw new Error('unknown method')
}

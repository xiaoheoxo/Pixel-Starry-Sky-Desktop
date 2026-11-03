import { useEffect, useRef } from 'react'
import { Compartment, EditorState, type StateEffect } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { getEditorView } from '@/features/editor/code/CodeEditor'
import { editorChrome } from '@/features/editor/code/theme'
import { editorPackExtensions } from '@/features/editor/code/packs'
import { useEditorPacksTick } from '@/features/editor/code/packEvents'
import { firstLineOf } from '@/features/editor/code/languageIds'
import { loadLanguage } from '@/features/editor/code/languages'
import { getFiles, type OpenFile } from '@/features/files/store'
import { changedRange } from './viewModel'

/** 开着的只读副本，按文件 id */
const mirrors = new Map<string, EditorView>()
/** 换位置前真编辑器的滚动位置，留给接着创建的副本 */
const pending = new Map<string, StateEffect<unknown>>()

/**
 * 真编辑器和只读副本换组之前调用（分屏、点另一组）：真编辑器的位置交给新副本，
 * 旧副本的位置在真编辑器挂过去之后还给它（没有旧副本就还它自己的：挂到新位置时滚动会丢）
 */
export function swapScroll(id: string): void {
  const real = getEditorView(id)?.scrollSnapshot()
  const back = mirrors.get(id)?.scrollSnapshot() ?? real
  if (real) pending.set(id, real)
  requestAnimationFrame(() => {
    pending.delete(id)
    if (back) getEditorView(id)?.dispatch({ effects: back })
  })
}

/**
 * 分屏时两组的当前标签是同一个文件：不是当前的那组显示只读的实时副本，点一下那组就成为当前、换成真的编辑器。
 * shortcut: CodeEditor 每个文件只有一个实例（runtimes 按标签 id），两边不能同时挂；CodeEditor 支持同一文件多个实例后换成 FileEditor
 */
export function MirrorView({ tab }: { tab: OpenFile }) {
  useI18n()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const packsTick = useEditorPacksTick()
  const { id, path } = tab
  const large = tab.document?.kind === 'text' && tab.document.readonly
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    // 从 store 取最新草稿：扩展包变了重建时不能用创建那一刻的旧内容
    const doc = getFiles().tabs.find(t => t.id === id)?.draft ?? ''
    const language = new Compartment()
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          editorChrome,
          ...editorPackExtensions(path, firstLineOf(doc)),
          lineNumbers(),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          language.of([]),
        ],
      }),
    })
    view.current = v
    mirrors.set(id, v)
    const scroll = pending.get(id)
    if (scroll) v.dispatch({ effects: scroll })
    let disposed = false
    if (!large)
      void loadLanguage(path, firstLineOf(doc))
        .then(ext => !disposed && v.dispatch({ effects: language.reconfigure(ext) }))
        .catch(() => {})
    return () => {
      disposed = true
      if (mirrors.get(id) === v) mirrors.delete(id)
      v.destroy()
      view.current = null
    }
  }, [id, path, large, packsTick])
  useEffect(() => {
    const v = view.current
    const doc = v?.state.doc.toString()
    if (v && doc !== tab.draft) v.dispatch({ changes: changedRange(doc ?? '', tab.draft) })
  }, [tab.draft])
  return (
    <div data-code-mirror={id} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <p className="shrink-0 bg-subtle px-3 py-1 text-meta text-fg-muted">{tr('coding.editor.mirror')}</p>
      <div ref={host} className="min-h-0 min-w-0 flex-1 overflow-hidden" />
    </div>
  )
}

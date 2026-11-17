// 差异编辑器：并排用 MergeView（左边原文只读），行内用 unifiedMergeView。代码模式的「变更 / 并排」和 Git 面板共用。
// 只用 readOnly 管能不能改、不关 editable：只读时也能点进去选中、Ctrl+C / Ctrl+A（docs/ui/git-diff-copy-edit.md）。
// tabId 给了就是能改的文件：改动写回 files/store 的草稿，Ctrl+S 保存，自动保存照编辑器的设置。
import { useEffect, useRef, useState } from 'react'
import { ClipboardPaste, Copy, Scissors, TextSelect } from 'lucide-react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { tr } from '@/i18n/core'
import { useToast } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { editorChrome } from './theme'
import { diffPackExtensions } from './packs'
import { useEditorPacksTick } from './packEvents'
import { mergeTheme } from './mergeTheme'
import { lineDiffConfig } from './lineDiff'
import { firstLineOf } from './languageIds'
import { loadLanguage } from './languages'
import { fileIndent } from './positions'
import { clipboardRead, clipboardWrite, replaceDoc } from './CodeEditor'
import { notifyEditorBlur } from '@/features/editor/autoSaveModel'
import { saveFile, updateFile } from '@/features/files/store'

const COLLAPSE = { margin: 3, minSize: 4 }

/** 行内视图里一块删掉的行的原文（这些行是装饰，不在文档里，Ctrl+C 带不上） */
export const deletedText = (chunk: Element): string =>
  [...chunk.querySelectorAll('.cm-deletedLine')].map(line => line.textContent ?? '').join('\n')

export function DiffEditor({
  tabId,
  path,
  original,
  modified,
  mode,
  readOnly,
  navRef,
  marker,
}: {
  /** 能改的文件在 files/store 里的 id；null：没有对应的磁盘文件（暂存区、提交里的版本），只读 */
  tabId: string | null
  path: string
  original: string
  modified: string
  mode: 'split' | 'inline'
  readOnly: boolean
  navRef: { current: EditorView | null }
  /** 外层的 data-* 标记（测试和样式用） */
  marker: 'coding-diff' | 'git-diff'
}) {
  const host = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const [menu, setMenu] = useState<{ x: number; y: number; view: EditorView; deleted: string | null } | null>(null)
  // 扩展包、深浅色、颜色主题加载完都要重建（B4）
  // shortcut: 重建会丢撤销历史（内容和光标保留），只在启动后几秒、切主题、装扩展时发生；MergeView 不接受现成 state，真碰到再换 Compartment
  const packsTick = useEditorPacksTick()
  const latest = useRef({ modified, readOnly })
  latest.current = { modified, readOnly }
  const locked = useRef(new Compartment())
  const undo = useRef(new Compartment())
  /** 重建前的光标和滚动位置：保存后基准会变，不能把正在改的地方弄丢 */
  const place = useRef<{ path: string; anchor: number; head: number; top: number; focused: boolean } | null>(null)
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    let destroy = (): void => {}
    let disposed = false
    void loadLanguage(path, firstLineOf(latest.current.modified || original)).then(language => {
      if (disposed) return
      const base = [editorChrome, ...diffPackExtensions(), mergeTheme, lineNumbers(), language]
      const editing: Extension[] = tabId
        ? [
            indentUnit.of(fileIndent(latest.current.modified || original).unit),
            undo.current.of(history()),
            keymap.of([
              {
                key: 'Mod-s',
                run: () => {
                  void saveFile(tabId)
                  return true
                },
              },
              indentWithTab,
              ...historyKeymap,
            ]),
            EditorView.domEventHandlers({
              blur(e, view) {
                if (!(e.relatedTarget instanceof Node && view.dom.contains(e.relatedTarget))) notifyEditorBlur(tabId)
                return false
              },
            }),
            EditorView.updateListener.of(update => {
              if (update.docChanged && !update.transactions.every(t => t.annotation(Transaction.remote)))
                updateFile(tabId, { draft: update.state.doc.toString() })
              if (update.selectionSet || update.docChanged) {
                const pos = update.state.selection.main.head,
                  line = update.state.doc.lineAt(pos)
                updateFile(tabId, { cursor: { line: line.number, column: pos - line.from + 1 } })
              }
            }),
          ]
        : []
      const current: Extension[] = [
        ...base,
        locked.current.of(EditorState.readOnly.of(!tabId || latest.current.readOnly)),
        ...editing,
        keymap.of(defaultKeymap),
      ]
      let view: EditorView
      let scroller: HTMLElement
      let teardown: () => void
      if (mode === 'split') {
        const merge = new MergeView({
          a: { doc: original, extensions: [...base, EditorState.readOnly.of(true), keymap.of(defaultKeymap)] },
          b: { doc: latest.current.modified, extensions: current },
          parent,
          collapseUnchanged: original === latest.current.modified ? undefined : COLLAPSE, // 没有差异时会整篇折成一条
          gutter: true,
          diffConfig: lineDiffConfig,
        })
        view = merge.b
        scroller = merge.dom
        teardown = () => merge.destroy()
      } else {
        const single = new EditorView({
          parent,
          state: EditorState.create({
            doc: latest.current.modified,
            extensions: [
              ...current,
              unifiedMergeView({
                original,
                // 不要接受 / 拒绝：借它在删掉的那块上放「复制删掉的内容」（只有删掉的行时才显示，见 mergeTheme）
                mergeControls: (type, action) => copyDeletedButton(type, action, toast),
                collapseUnchanged: original === latest.current.modified ? undefined : COLLAPSE, // 没有差异时会整篇折成一条
                gutter: true,
                diffConfig: lineDiffConfig,
              }),
            ],
          }),
        })
        view = single
        scroller = single.scrollDOM
        teardown = () => single.destroy()
      }
      navRef.current = view
      const saved = place.current
      if (saved?.path === path) {
        const end = view.state.doc.length
        view.dispatch({ selection: EditorSelection.single(Math.min(saved.anchor, end), Math.min(saved.head, end)) })
        scroller.scrollTop = saved.top
        if (saved.focused) view.focus()
      }
      destroy = () => {
        const { anchor, head } = view.state.selection.main
        place.current = { path, anchor, head, top: scroller.scrollTop, focused: view.hasFocus }
        teardown()
      }
    })
    return () => {
      disposed = true
      navRef.current = null
      destroy()
    }
  }, [tabId, path, original, mode, navRef, packsTick])
  // 外面改了内容（草稿、重读的差异）：换内容，不算用户的编辑（不写回、清空撤销）
  useEffect(() => {
    const view = navRef.current
    if (view && view.state.doc.toString() !== modified) replaceDoc(view, undo.current, modified)
  }, [modified, navRef])
  useEffect(() => {
    navRef.current?.dispatch({ effects: locked.current.reconfigure(EditorState.readOnly.of(!tabId || readOnly)) })
  }, [readOnly, tabId, navRef])
  return (
    <>
      <div
        ref={host}
        {...{ [`data-${marker}`]: mode }}
        className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-mergeView]:h-full [&_.cm-mergeView]:overflow-y-auto [&_.cm-mergeViewEditors]:min-h-full"
        onContextMenu={e => {
          e.preventDefault()
          const target = e.target as Element
          const chunk = target.closest?.('.cm-deletedChunk')
          // 并排时点在左边就是左边那个编辑器（原文）；在右键这一刻定下来，菜单盖上去以后再找会找错
          const dom = target.closest?.('.cm-editor')
          const view = (dom && EditorView.findFromDOM(dom as HTMLElement)) || navRef.current
          if (view) setMenu({ x: e.clientX, y: e.clientY, view, deleted: chunk ? deletedText(chunk) : null })
        }}
      />
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('editor.menu.label')}
          actions={diffMenuActions(menu.view, menu.deleted, toast)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

/** 删掉的那块上的按钮：只要一个「复制删掉的内容」（mergeControls 会为接受、拒绝各要一个，拒绝那个不放） */
function copyDeletedButton(type: 'accept' | 'reject', _action: unknown, toast: (m: string) => void): HTMLElement {
  if (type === 'reject') return document.createElement('span')
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.copyDeleted = ''
  button.textContent = tr('git.diff.copyDeleted')
  button.title = tr('git.diff.copyDeleted')
  button.onmousedown = e => {
    e.preventDefault()
    e.stopPropagation()
    const chunk = button.closest('.cm-deletedChunk')
    if (!chunk) return
    void clipboardWrite(deletedText(chunk)).then(
      () => toast(tr('git.diff.copiedDeleted')),
      () => toast(tr('ctxmenu.copyFailed')),
    )
  }
  return button
}

/** 右键菜单：剪切、复制、粘贴、全选；点在删掉的那块上多一个「复制删掉的内容」 */
function diffMenuActions(view: EditorView, deleted: string | null, toast: (m: string) => void): MenuAction[] {
  const { state } = view
  const text = state.selection.ranges
    .filter(r => !r.empty)
    .map(r => state.sliceDoc(r.from, r.to))
    .join(state.lineBreak)
  const readonly = state.readOnly
  const copy = (value: string, done?: string): void =>
    void clipboardWrite(value).then(
      () => done && toast(done),
      () => toast(tr('ctxmenu.copyFailed')),
    )
  return [
    ...(deleted !== null
      ? [{ label: tr('git.diff.copyDeleted'), icon: Copy, run: () => copy(deleted, tr('git.diff.copiedDeleted')) }]
      : []),
    {
      label: tr('editor.menu.cut'),
      icon: Scissors,
      separator: deleted !== null,
      disabled: readonly || !text,
      run: () =>
        void clipboardWrite(text).then(
          () => {
            if (view.state.doc === state.doc) view.dispatch(state.replaceSelection(''), { userEvent: 'delete.cut' })
          },
          () => toast(tr('ctxmenu.copyFailed')),
        ),
    },
    { label: tr('editor.menu.copy'), icon: Copy, disabled: !text, run: () => copy(text) },
    {
      label: tr('editor.menu.paste'),
      icon: ClipboardPaste,
      disabled: readonly,
      run: () =>
        void clipboardRead().then(value => {
          if (value)
            view.dispatch(view.state.replaceSelection(value), { userEvent: 'input.paste', scrollIntoView: true })
          view.focus()
        }),
    },
    {
      label: tr('editor.menu.selectAll'),
      icon: TextSelect,
      run: () => {
        view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length) })
        view.focus()
      },
    },
  ]
}

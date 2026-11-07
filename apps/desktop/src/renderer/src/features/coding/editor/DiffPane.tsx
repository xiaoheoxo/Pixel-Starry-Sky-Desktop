import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { goToNextChunk, goToPreviousChunk, MergeView, unifiedMergeView } from '@codemirror/merge'
import { IconButton, Segmented, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { editorChrome } from '@/features/editor/code/theme'
import { diffPackExtensions } from '@/features/editor/code/packs'
import { useEditorPacksTick } from '@/features/editor/code/packEvents'
import { mergeTheme } from '@/features/editor/code/mergeTheme'
import { lineDiffConfig } from '@/features/editor/code/lineDiff'
import { firstLineOf } from '@/features/editor/code/languageIds'
import { loadLanguage } from '@/features/editor/code/languages'
import { fileIndent } from '@/features/editor/code/positions'
import { aiBusyFor, notifyEditorBlur } from '@/features/editor/autoSaveModel'
import { getEngineState, subscribeEngine } from '@/features/engine/store'
import { isMac } from '@/features/layout/keybindings'
import { saveFile, updateFile, type OpenFile } from '@/features/files/store'
import { replaceDoc } from '@/features/editor/code/CodeEditor'
import type { DiffBase } from '../types'

const COLLAPSE = { margin: 3, minSize: 4 }

const editableState = (readOnly: boolean): Extension => [
  EditorView.editable.of(!readOnly),
  EditorState.readOnly.of(readOnly),
]

/**
 * 差异编辑器：并排用 MergeView，行内用 unifiedMergeView；navRef 指向当前内容那个编辑器（可以跳转改动、可以改）。
 * 基准永远只读；改动写进标签的草稿，保存沿用编辑器的未保存标记和 Ctrl+S。外面改了草稿（重新加载等）换内容，不重建编辑器
 */
function DiffEditor({
  tabId,
  path,
  original,
  modified,
  mode,
  readOnly,
  navRef,
}: {
  tabId: string
  path: string
  original: string
  modified: string
  mode: 'split' | 'inline'
  readOnly: boolean
  navRef: { current: EditorView | null }
}) {
  const host = useRef<HTMLDivElement>(null)
  // 扩展包、深浅色、颜色主题加载完都要重建（B4）
  // shortcut: 重建会丢撤销历史（内容和光标保留），只在启动后几秒、切主题、装扩展时发生；MergeView 不接受现成 state，真碰到再换 Compartment
  const packsTick = useEditorPacksTick()
  const latest = useRef({ modified, readOnly })
  latest.current = { modified, readOnly }
  const editable = useRef(new Compartment())
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
      const current: Extension[] = [
        ...base,
        editable.current.of(editableState(latest.current.readOnly)),
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
          ...defaultKeymap,
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
      let view: EditorView
      let scroller: HTMLElement
      let teardown: () => void
      if (mode === 'split') {
        const merge = new MergeView({
          a: { doc: original, extensions: [...base, editableState(true)] },
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
                mergeControls: false,
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
  // 外面改了草稿：换内容，不算用户的编辑（不写回、清空撤销）
  useEffect(() => {
    const view = navRef.current
    if (view && view.state.doc.toString() !== modified) replaceDoc(view, undo.current, modified)
  }, [modified, navRef])
  useEffect(() => {
    navRef.current?.dispatch({ effects: editable.current.reconfigure(editableState(readOnly)) })
  }, [readOnly, navRef])
  return (
    <div
      ref={host}
      data-coding-diff={mode}
      className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-mergeView]:h-full [&_.cm-mergeView]:overflow-y-auto [&_.cm-mergeViewEditors]:min-h-full"
    />
  )
}

/**
 * 中栏的「变更」和「并排」视图：左边是基准（HEAD 或这一轮开始前），只读；当前内容能直接改，AI 运行时变回只读（docs/ui/desktop-parity.md）。
 * 照 GitDiffView 的 DiffEditor 写了一份，不引用它。
 */
export function DiffPane({
  tab,
  mode,
  base,
  turnBaseline,
  fellBack = false,
  aiRunning = false,
  onBase,
  onShowCode,
}: {
  tab: OpenFile
  mode: 'diff' | 'split'
  /** 已经按能不能算出这一轮的基准处理过的基准 */
  base: DiffBase
  /** 这一轮开始前的内容；算不出来是 null */
  turnBaseline: string | null
  /** 想看「只看这一轮」但算不出基准，已退回 HEAD */
  fellBack?: boolean
  /** 这一轮的 AI 正在运行（演示数据只有这个来源）；引擎里正在跑的会话在下面另外判断 */
  aiRunning?: boolean
  onBase(base: DiffBase): void
  onShowCode(): void
}) {
  useI18n()
  const nav = useRef<EditorView | null>(null)
  const original = (base === 'turn' ? turnBaseline : tab.head) ?? tab.head ?? ''
  // 这个文件所在的地方有 AI 在跑就不让改，免得互相覆盖；判断和自动保存同一处，刚开始一轮、还没改文件时也算
  const aiBusy =
    useSyncExternalStore(subscribeEngine, () =>
      aiBusyFor(tab, getEngineState().sessions, (window.pixelsky?.platform ?? 'win32') !== 'linux'),
    ) || aiRunning
  const readOnly = aiBusy || (tab.document?.kind === 'text' && !!tab.document.readonly)
  const jump = (delta: 1 | -1): void => {
    const view = nav.current
    if (!view) return
    if (delta > 0) goToNextChunk(view)
    else goToPreviousChunk(view)
    view.focus()
  }
  return (
    <div data-coding-diffpane className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle px-3">
        {turnBaseline !== null && (
          <Segmented
            label={tr('coding.editor.base')}
            value={base}
            onChange={onBase}
            options={[
              { value: 'head', label: tr('coding.editor.base.head') },
              { value: 'turn', label: tr('coding.editor.base.turn') },
            ]}
          />
        )}
        <span className="flex-1" />
        {(aiBusy || !readOnly) && (
          <span data-coding-diff-hint className="truncate text-meta text-fg-faint">
            {aiBusy
              ? tr('coding.editor.diff.aiRunning')
              : tr('coding.editor.diff.editable', { keys: isMac ? '⌘S' : 'Ctrl+S' })}
          </span>
        )}
        <IconButton icon={ChevronUp} label={tr('git.diff.prev')} size={26} iconSize={14} onClick={() => jump(-1)} />
        <IconButton icon={ChevronDown} label={tr('git.diff.next')} size={26} iconSize={14} onClick={() => jump(1)} />
      </div>
      {fellBack && (
        <p role="status" className="shrink-0 border-b border-line-subtle bg-subtle px-3 py-1 text-meta text-fg-muted">
          {tr('coding.editor.base.fallback')}
        </p>
      )}
      {(tab.external || tab.error) && (
        <div
          role="status"
          className={cn(
            'flex shrink-0 items-center gap-2 border-b border-line-subtle bg-subtle px-3 py-1 text-meta',
            tab.error ? 'text-danger' : 'text-fg',
          )}
        >
          <span className="min-w-0 flex-1">
            {tab.error ? translateMessage(tab.error) : tr('editor.FileEditor.fileChangedExternallyYour')}
          </span>
          <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={onShowCode}>
            {tr('coding.editor.diff.showCode')}
          </button>
        </div>
      )}
      <DiffEditor
        tabId={tab.id}
        path={tab.path}
        original={original}
        modified={tab.draft}
        mode={mode === 'split' ? 'split' : 'inline'}
        readOnly={readOnly}
        navRef={nav}
      />
    </div>
  )
}

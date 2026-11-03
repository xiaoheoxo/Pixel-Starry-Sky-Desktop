// 行内改写的 CodeMirror 部分：记住改的是哪一段和原文（随改动映射）、在段落下面放输入框的块级 widget、
// 结果换进去后按块画红绿行和「保留 / 撤销」。输入框本身是 React（InlineEditBox，挂进 host）
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { searchPanelOpen } from '@codemirror/search'
import { tr } from '@/i18n/core'
import type { ReviewHunk } from '@/features/coding/review/hunksModel'
import { inlineTarget, inlineTooLarge, segmentHunks } from './model'

export interface InlineSession {
  id: number
  from: number
  to: number
  /** 改之前的原文：「全部撤销」回到它，红绿行和它比 */
  original: string
  /** 结果已经换进去了（显示红绿行） */
  applied: boolean
  /** 已保留的块（hunkKey） */
  kept: readonly string[]
  /** 上一次用时（毫秒） */
  elapsed: number | null
  /** 正在等的请求 id：放在会话里，切标签输入框卸载再回来还认得（不取消请求） */
  running: string | null
  /** 输入框挂载的位置（每次重画 widget 都是同一个元素，React 的内容不会丢） */
  host: HTMLElement
}

const open = StateEffect.define<InlineSession>()
const close = StateEffect.define<null>()
const applied = StateEffect.define<number>()
const keep = StateEffect.define<string>()
const running = StateEffect.define<string | null>()

export const setInlineRunning = (view: EditorView, id: string | null): void =>
  view.dispatch({ effects: running.of(id) })

/** 这一段里还没保留的块（全文坐标） */
export const pendingHunks = (state: EditorState, s: InlineSession): ReviewHunk[] =>
  s.applied ? segmentHunks(s.original, state.sliceDoc(s.from, s.to), s.from, s.kept) : []

const field = StateField.define<InlineSession | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(open)) return e.value
      if (e.is(close)) return null
    }
    if (!value) return null
    // 一次改动整个吞掉这一段（外部重载整篇替换、选中整段重打）：收起。不然段落会扩成整篇，全部撤销会把整篇换成原文
    let swallowed = false
    if (!tr.effects.some(e => e.is(applied)))
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA < toA && fromA <= value.from && toA >= value.to) swallowed = true
      })
    if (swallowed) return null
    let next = value
    if (tr.docChanged) next = { ...next, from: tr.changes.mapPos(next.from, -1), to: tr.changes.mapPos(next.to, 1) }
    for (const e of tr.effects) {
      if (e.is(applied)) next = { ...next, applied: true, elapsed: e.value }
      if (e.is(keep)) next = { ...next, kept: [...next.kept, e.value] }
      if (e.is(running)) next = { ...next, running: e.value }
    }
    // 每块都保留或撤销完了：收起
    if (next !== value && next.applied && !pendingHunks(tr.state, next).length) return null
    return next
  },
})

export const inlineSession = (state: EditorState): InlineSession | null => state.field(field, false) ?? null

/** 打开时挂上的 React 订阅：会话变了就通知 */
const listeners = new WeakMap<EditorView, Set<() => void>>()
export function watchInline(view: EditorView, cb: () => void): () => void {
  const set = listeners.get(view) ?? new Set()
  listeners.set(view, set)
  set.add(cb)
  return () => set.delete(cb)
}

let seq = 0

/** Ctrl+K、右键菜单、代码透镜的入口；range 是透镜给的声明。打开了返回 true */
export function startInlineEdit(
  view: EditorView,
  path: string,
  notify: (message: string) => void,
  range?: { from: number; to: number },
): boolean {
  const state = view.state
  const current = state.field(field, false)
  if (current === undefined) return false
  // 已经开着：回到那个输入框，不换段落（换了「全部撤销」就回不去了）
  if (current) {
    current.host.querySelector('input')?.focus()
    return true
  }
  if (state.readOnly) {
    notify(tr('editor.inline.readonly'))
    return true
  }
  const sel = range ?? state.selection.main
  const target = inlineTarget(state.doc, Math.min(sel.from, state.doc.length), Math.min(sel.to, state.doc.length), path)
  const original = state.sliceDoc(target.from, target.to)
  if (inlineTooLarge(original)) {
    notify(tr('editor.inline.tooLarge'))
    return true
  }
  const host = document.createElement('div')
  host.className = 'cm-inline-edit'
  view.dispatch({
    effects: [
      open.of({ id: ++seq, ...target, original, applied: false, kept: [], elapsed: null, running: null, host }),
      EditorView.scrollIntoView(target.to, { y: 'nearest' }),
    ],
  })
  return true
}

/** 把结果换进这一段（进撤销记录；不保存，照编辑器的自动保存设置走） */
export function applyInline(view: EditorView, s: InlineSession, code: string, elapsed: number): void {
  view.dispatch({
    changes: { from: s.from, to: s.to, insert: code },
    effects: applied.of(elapsed),
    userEvent: 'input.inlineedit',
  })
}

/** 全部保留：只收起，草稿里已经是改过的 */
export const keepAll = (view: EditorView): void => view.dispatch({ effects: close.of(null) })

/** 全部撤销 / 取消：换回原文再收起 */
export function undoAll(view: EditorView, s: InlineSession): void {
  view.dispatch({
    ...(s.applied && view.state.sliceDoc(s.from, s.to) !== s.original
      ? { changes: { from: s.from, to: s.to, insert: s.original }, userEvent: 'input.inlineedit' }
      : {}),
    effects: close.of(null),
  })
}

class BoxWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super()
  }
  eq(other: BoxWidget): boolean {
    return other.host === this.host
  }
  toDOM(): HTMLElement {
    return this.host
  }
  ignoreEvent(): boolean {
    return true
  }
}

/** 每块的「保留 / 撤销」；点的时候按 key 找回当前的块（文档改过之后块会重新算） */
class ToolsWidget extends WidgetType {
  constructor(readonly key: string) {
    super()
  }
  eq(other: ToolsWidget): boolean {
    return other.key === this.key
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('span')
    root.className = 'cm-inline-tools'
    const make = (label: string, cls: string, run: (s: InlineSession, h: ReviewHunk) => void): void => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = cls
      button.textContent = label
      button.addEventListener('mousedown', e => e.preventDefault())
      button.addEventListener('click', () => {
        const s = inlineSession(view.state)
        const hunk = s && pendingHunks(view.state, s).find(h => h.key === this.key)
        if (s && hunk) run(s, hunk)
      })
      root.append(button)
    }
    make(tr('editor.inline.keep'), 'cm-inline-keep', (_s, h) => view.dispatch({ effects: keep.of(h.key) }))
    make(tr('editor.inline.undo'), 'cm-inline-undo', (_s, h) =>
      view.dispatch({
        changes: { from: h.undoFrom, to: h.undoTo, insert: h.undoInsert },
        userEvent: 'input.inlineedit',
      }),
    )
    return root
  }
  ignoreEvent(): boolean {
    return true
  }
}

class DeletedWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly tools: ToolsWidget | null,
  ) {
    super()
  }
  eq(other: DeletedWidget): boolean {
    return other.text === this.text && other.tools?.key === this.tools?.key
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-inline-deleted'
    for (const text of this.text.split('\n')) {
      const line = document.createElement('div')
      line.className = 'cm-inline-deleted-line'
      line.textContent = text
      root.append(line)
    }
    if (this.tools) root.append(this.tools.toDOM(view))
    return root
  }
  ignoreEvent(): boolean {
    return true
  }
}

function decorations(state: EditorState): DecorationSet {
  const s = inlineSession(state)
  if (!s) return Decoration.none
  const doc = state.doc
  const ranges: Range<Decoration>[] = []
  if (!s.applied) {
    // 等结果时把要改的几行标出来
    for (let n = doc.lineAt(s.from).number; n <= doc.lineAt(s.to).number; n++)
      ranges.push(Decoration.line({ class: 'cm-inline-target' }).range(doc.line(n).from))
  }
  for (const h of pendingHunks(state, s)) {
    const tools = new ToolsWidget(h.key)
    if (h.hasCurrent) {
      const first = doc.lineAt(h.fromB),
        last = doc.lineAt(h.toB)
      for (let n = first.number; n <= last.number; n++)
        ranges.push(
          Decoration.line({ class: n === first.number ? 'cm-inline-added cm-inline-first' : 'cm-inline-added' }).range(
            doc.line(n).from,
          ),
        )
      ranges.push(Decoration.widget({ widget: tools, side: 1 }).range(first.to))
    }
    if (h.hasBaseline) {
      const at = h.hasCurrent ? doc.lineAt(h.fromB).from : Math.min(h.fromB, s.to)
      // 删在段落末尾（不在行首）时放到那一行下面
      const side = doc.lineAt(at).from === at ? -1 : 1
      const widget = new DeletedWidget(h.baselineText, h.hasCurrent ? null : tools)
      ranges.push(Decoration.widget({ widget, block: true, side }).range(at))
    }
  }
  ranges.push(Decoration.widget({ widget: new BoxWidget(s.host), block: true, side: 2 }).range(doc.lineAt(s.to).to))
  const builder = new RangeSetBuilder<Decoration>()
  ranges
    .sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
    .forEach(r => builder.add(r.from, r.to, r.value))
  return builder.finish()
}

const added = 'color-mix(in srgb, var(--success) 12%, transparent)'
const removed = 'color-mix(in srgb, var(--danger) 12%, transparent)'

const theme = EditorView.baseTheme({
  '.cm-inline-target': { backgroundColor: 'color-mix(in srgb, var(--accent) 10%, transparent)' },
  '.cm-inline-added': { backgroundColor: added },
  '.cm-inline-first': { position: 'relative' },
  '.cm-inline-deleted': {
    position: 'relative',
    backgroundColor: removed,
    padding: '0 14px',
    color: 'var(--text-secondary)',
  },
  '.cm-inline-deleted-line': { whiteSpace: 'pre', minHeight: '1em' },
  '.cm-inline-tools': {
    position: 'absolute',
    right: '12px',
    top: '1px',
    display: 'inline-flex',
    gap: '4px',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-label)',
    lineHeight: '1.4',
    zIndex: '2',
  },
  '.cm-inline-tools button': {
    padding: '0 7px',
    borderRadius: '5px',
    border: '1px solid var(--border-card)',
    backgroundColor: 'var(--bg-popover)',
    cursor: 'pointer',
    font: 'inherit',
  },
  '.cm-inline-tools button:hover': { backgroundColor: 'var(--bg-hover)' },
  '.cm-inline-keep': { color: 'var(--success)' },
  '.cm-inline-undo': { color: 'var(--danger)' },
  '.cm-inline-edit': { padding: '4px 14px 6px 4px' },
})

const whenApplied =
  (run: (view: EditorView, s: InlineSession) => void) =>
  (view: EditorView): boolean => {
    const s = inlineSession(view.state)
    if (!s?.applied) return false
    run(view, s)
    return true
  }

/** 编辑器的行内改写；path 取当前文件路径（认声明用），notify 弹提示 */
export function inlineEditExtension(path: () => string, notify: (message: string) => void): Extension {
  return [
    field,
    theme,
    EditorView.decorations.compute([field, 'doc'], decorations),
    ViewPlugin.define(view => ({
      update(u) {
        if (u.state.field(field) !== u.startState.field(field)) listeners.get(view)?.forEach(cb => cb())
      },
    })),
    keymap.of([
      { key: 'Mod-k', run: view => startInlineEdit(view, path(), notify) },
      // 结果条上写的「全部保留 Ctrl+Enter / 全部撤销 Esc」：焦点在编辑器里也认（不然落到换行、收选区）
      { key: 'Mod-Enter', run: whenApplied(keepAll) },
      // 搜索框开着时 Esc 先关搜索框（补全弹窗的 Esc 在 Prec.highest，本来就先走）
      { key: 'Escape', run: view => !searchPanelOpen(view.state) && whenApplied(undoAll)(view) },
    ]),
  ]
}

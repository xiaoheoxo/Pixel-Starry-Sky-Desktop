// 代码透镜：在每个声明行上方显示「✦ AI 解释 · ✦ 让 AI 改 · ✦ 行内改写」（块级 widget）
import { StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { tr } from '@/i18n/core'
import { quoteSelection, getEditorView } from '@/features/editor/code/CodeEditor'
import { appendComposerDraft } from '@/features/engine/drafts'
import { composerTarget } from '@/features/session/composerTarget'
import { startInlineEdit } from '@/features/editor/code/inlineEdit/extension'
import { isMac } from '@/features/layout/keybindings'
import { declarations } from './symbolsModel'

/** 超过这个行数不启用（每次改动都要重新找声明） */
export const LENS_MAX_LINES = 3000

type Notify = (message: string) => void

class LensWidget extends WidgetType {
  constructor(
    readonly tabId: string,
    readonly path: string,
    readonly name: string,
    readonly from: number,
    readonly to: number,
    readonly notify: Notify,
  ) {
    super()
  }
  eq(other: LensWidget): boolean {
    return (
      other.tabId === this.tabId &&
      other.path === this.path &&
      other.name === this.name &&
      other.from === this.from &&
      other.to === this.to
    )
  }
  /** 选中整个声明，再把选区引用进会话输入框；失败时把原因提示出来 */
  private act(explain: boolean): void {
    const view = getEditorView(this.tabId)
    if (!view) return
    const length = view.state.doc.length
    view.dispatch({ selection: { anchor: Math.min(this.from, length), head: Math.min(this.to, length) } })
    const error = quoteSelection(this.tabId)
    if (error) {
      this.notify(error)
      return
    }
    if (!explain) return
    const target = composerTarget()
    if (target) appendComposerDraft(target.key, tr('coding.editor.extras.explainPrompt'))
  }
  toDOM(): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-code-lens'
    const button = (label: string, run: () => void): HTMLButtonElement => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'cm-code-lens-btn'
      el.textContent = `✦ ${label}`
      // mousedown 里拦掉，免得点击先把编辑器的光标移走
      el.addEventListener('mousedown', e => e.preventDefault())
      el.addEventListener('click', e => {
        e.preventDefault()
        run()
      })
      return el
    }
    const sep = (): HTMLSpanElement => {
      const el = document.createElement('span')
      el.className = 'cm-code-lens-sep'
      el.textContent = '·'
      return el
    }
    // 行内改写：只改这个声明，在原位出红绿行（docs/ui/coding-tier2.md §6）
    const inline = (): void => {
      const view = getEditorView(this.tabId)
      if (view) startInlineEdit(view, this.path, this.notify, { from: this.from, to: this.to })
    }
    root.append(
      button(tr('coding.editor.extras.lensExplain'), () => this.act(true)),
      sep(),
      button(tr('coding.editor.extras.lensEdit'), () => this.act(false)),
      sep(),
      button(`${tr('editor.inline.action')} ${isMac ? '⌘K' : 'Ctrl+K'}`, inline),
    )
    return root
  }
  ignoreEvent(): boolean {
    return true
  }
}

const lensTheme = EditorView.theme({
  '.cm-code-lens': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 0 0 2px',
    fontSize: '11px',
    lineHeight: '1.6',
    color: 'var(--fg-muted)',
    fontFamily: 'var(--font-sans, inherit)',
    userSelect: 'none',
  },
  '.cm-code-lens-btn': {
    border: 'none',
    background: 'transparent',
    padding: '0 2px',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    borderRadius: '3px',
  },
  '.cm-code-lens-btn:hover': { color: 'var(--accent)', background: 'var(--bg-hover)' },
})

export function codeLens(tabId: string, path: string, notify: Notify): Extension {
  const build = (text: string): DecorationSet => {
    const items = declarations(text, path).map(d =>
      Decoration.widget({
        widget: new LensWidget(tabId, path, d.name, d.from, d.to, notify),
        block: true,
        side: -1,
      }).range(d.from),
    )
    return Decoration.set(items, true)
  }
  const field = StateField.define<DecorationSet>({
    create: state => (state.doc.lines > LENS_MAX_LINES ? Decoration.none : build(state.doc.toString())),
    update(value, tr2) {
      if (!tr2.docChanged) return value
      return tr2.state.doc.lines > LENS_MAX_LINES ? Decoration.none : build(tr2.state.doc.toString())
    },
    provide: f => EditorView.decorations.from(f),
  })
  return [field, lensTheme]
}

// 会话输入框（docs/ui/composer-paste-fold.md §6）：CodeMirror 6 代替 textarea，粘贴的长文本折成标签。
// 接口贴近原来的 textarea：value / onChange / 光标 / onKeyDown / 粘贴 / placeholder / 高度
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { history, historyKeymap, insertNewline, invertedEffects, standardKeymap } from '@codemirror/commands'
import { Compartment, EditorState, Prec, Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
import { cn } from '@/ui'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { tr } from '@/i18n/core'
import './composerInput.css'
import { addPaste, nextPasteId, pasteField, resetPastes, restoreEffects, shouldFold, trimBlankLines } from './pasteFold'
import { pasteDecorations } from './pasteView'
import { loadPastes, savePastes } from './pasteStore'
import { composerMenuActions } from '../contextMenu/composerMenu'

export interface ComposerInputHandle {
  focus(): void
  /** 光标放到末尾并滚到底 */
  focusEnd(): void
  /** 当前选区（文字里的位置） */
  selection(): { from: number; to: number }
  /** 放光标并聚焦 */
  setCaret(at: number): void
  /** 编辑器最外层（量高度用） */
  readonly dom: HTMLElement | null
}

interface Props {
  /** 草稿键：换了就换一份内容和撤销记录 */
  composerKey: string
  value: string
  onChange(value: string): void
  /** 光标位置；选中一片时为 null */
  onCaret(caret: number | null): void
  /** 先于编辑器自己的按键处理；处理了就 preventDefault */
  onKeyDown(event: KeyboardEvent): void
  /** 粘贴里有文件 / 文件夹时交给外面，返回是否拿走了（文字部分仍由这里插入） */
  onPasteFiles(data: DataTransfer): boolean
  placeholder: string
  autoFocus?: boolean
  /** 编辑器高度（px）；内容高度通过 onContentHeight 报给外面，由外面算 */
  height: number
  onContentHeight(height: number): void
  /** 底部内边距小一点（ChatGPT 风格，按钮在卡片右下角） */
  tight?: boolean
  ariaControls?: string
  ariaActiveDescendant?: string
  className?: string
}

/** 按草稿键登记，别处（focusComposer）用来聚焦 */
const registry = new Map<string, ComposerInputHandle>()
export const composerInputFor = (key: string): ComposerInputHandle | null => registry.get(key) ?? null

/** 两段文字的最小改动：去掉相同的头尾（外面改了 value 时用，粘贴段的范围能跟着映射） */
export function minimalChange(from: string, to: string): { from: number; to: number; insert: string } | null {
  if (from === to) return null
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let endA = from.length,
    endB = to.length
  while (endA > start && endB > start && from.charCodeAt(endA - 1) === to.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  return { from: start, to: endA, insert: to.slice(start, endB) }
}

/**
 * 外面改了 value 时要发给编辑器的改动；一样就是 null。原来是空的（Tab 填入输入建议、回退放回原文…）：
 * 光标放到末尾，能接着写；否则不给 selection，光标跟着改动自己映射
 */
export function syncValue(state: EditorState, value: string): TransactionSpec | null {
  // 编辑器里的换行都是 \n：草稿带 \r\n（终端里选中的文字）时先统一，不然长度对不上、光标越界
  const text = value.replace(/\r\n?/g, '\n')
  const change = minimalChange(state.doc.toString(), text)
  if (!change) return null
  return {
    changes: change,
    ...(state.doc.length === 0 ? { selection: { anchor: text.length } } : {}),
    annotations: Transaction.addToHistory.of(false),
  }
}

/** 把粘贴的文字放进输入框：长文本折成标签（plain 为真时不折，同 Ctrl+Shift+V）。粘贴事件和右键菜单共用 */
function insertPaste(v: EditorView, raw: string, plain: boolean): void {
  const trimmed = trimBlankLines(raw)
  const fold = !plain && shouldFold(trimmed)
  const text = fold ? trimmed : raw.replace(/\r\n?/g, '\n')
  const { from, to } = v.state.selection.main
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    effects: fold
      ? addPaste.of({
          id: nextPasteId(v.state.field(pasteField)),
          from,
          to: from + text.length,
          folded: true,
        })
      : [],
    userEvent: 'input.paste',
    scrollIntoView: true,
  })
}

/** 右键菜单键：菜单键或 Shift+F10 */
const menuKey = (e: KeyboardEvent): boolean => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')

const theme = EditorView.theme({
  '&': {
    height: '100%',
    background: 'transparent',
    color: 'var(--text)',
    // 留白固定在滚动视口外，展开段滚动时也不会贴到卡片圆角或工具行。
    padding: 'var(--ci-pt) 0 var(--ci-pb)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '24px', overflowX: 'hidden', minHeight: '0' },
  // 内边距用 composerInput.css 里的变量，极简模式（minimal.css）能改
  '.cm-content': {
    padding: '0 calc(var(--ci-px) - 4px)',
    caretColor: 'var(--text)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  // 横向留白在行背景外，整行的粘贴高亮不会延伸到卡片边框。
  '.cm-line': { padding: '0 4px' },
  '.cm-placeholder': { color: 'var(--text-faint)' },
})

/** CodeMirror 的 contentHeight 不含滚动视口外的固定留白，自动增高时补回。 */
function inputContentHeight(view: EditorView): number {
  const style = window.getComputedStyle(view.dom)
  return Math.ceil(view.contentHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom))
}

export const ComposerInput = forwardRef<ComposerInputHandle, Props>(function ComposerInput(props, forwarded) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  /** 正在把外面的 value 写进编辑器：这次改动不回调 onChange */
  const syncing = useRef(false)
  /** 按了 Ctrl+Shift+V：接下来的粘贴不折 */
  const plainPaste = useRef(0)
  const placeholderSlot = useRef(new Compartment())
  const [menu, setMenu] = useState<{ x: number; y: number; actions: MenuAction[] } | null>(null)

  const handle: ComposerInputHandle = {
    focus: () => view.current?.focus(),
    focusEnd: () => {
      const v = view.current
      if (!v) return
      const end = v.state.doc.length
      v.dispatch({ selection: { anchor: end }, effects: EditorView.scrollIntoView(end, { y: 'end' }) })
      v.focus()
    },
    selection: () => {
      const main = view.current?.state.selection.main
      return main ? { from: main.from, to: main.to } : { from: 0, to: 0 }
    },
    setCaret: at => {
      const v = view.current
      if (!v) return
      const pos = Math.max(0, Math.min(at, v.state.doc.length))
      v.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      v.focus()
    },
    get dom() {
      return view.current?.dom ?? null
    },
  }
  useImperativeHandle(forwarded, () => handle)

  const createState = (doc: string, key: string): EditorState =>
    EditorState.create({
      doc,
      extensions: [
        pasteField,
        pasteDecorations(),
        history(),
        // 删掉 / 撤回一段时把「这是粘贴段」也一起撤回：被改动吞掉的段记成反向效果
        invertedEffects.of(restoreEffects),
        EditorView.lineWrapping,
        placeholderSlot.current.of(placeholderExt(latest.current.placeholder)),
        theme,
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          'aria-label': tr('composer.input'),
          'aria-multiline': 'true',
          role: 'textbox',
          'data-composer-key': key,
        }),
        Prec.highest(
          EditorView.domEventHandlers({
            // 右键菜单（features/session/contextMenu/composerMenu.ts）：记下点到的字，粘贴段的展开 / 折起要用
            contextmenu(event, v) {
              event.preventDefault()
              const at = v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head
              setMenu({ x: event.clientX, y: event.clientY, actions: composerMenuActions(v, at, insertPaste) })
              return true
            },
            keydown(event, v) {
              if (menuKey(event)) {
                event.preventDefault()
                const head = v.state.selection.main.head
                const rect = v.coordsAtPos(head)
                const box = v.dom.getBoundingClientRect()
                setMenu({
                  x: rect?.left ?? box.left,
                  y: (rect?.bottom ?? box.top) + 4,
                  actions: composerMenuActions(v, head, insertPaste),
                })
                return true
              }
              if (event.key.toLowerCase() === 'v' && event.shiftKey && (event.ctrlKey || event.metaKey))
                plainPaste.current = Date.now()
              latest.current.onKeyDown(event)
              return event.defaultPrevented
            },
            // 拖进来的是文件：交给外层（Composer 的 onDrop）当附件，编辑器自己不读文件内容插进文字；
            // 在编辑器里拖动文字照常（审查报告 2026-10-14 第 4 条）
            drop: event => !!event.dataTransfer?.types.includes('Files'),
            paste(event, v) {
              const data = event.clipboardData
              if (!data) return false
              const tookFiles = latest.current.onPasteFiles(data)
              const raw = data.getData('text/plain')
              const plain = Date.now() - plainPaste.current < 1000
              if (!raw) {
                if (tookFiles) event.preventDefault()
                return tookFiles
              }
              plainPaste.current = 0
              event.preventDefault()
              insertPaste(v, raw, plain)
              return true
            },
          }),
        ),
        keymap.of([{ key: 'Enter', run: insertNewline, shift: insertNewline }, ...historyKeymap, ...standardKeymap]),
        EditorView.updateListener.of(update => {
          const p = latest.current
          if (update.docChanged && !syncing.current) p.onChange(update.state.doc.toString())
          if (update.docChanged || update.selectionSet) {
            const main = update.state.selection.main
            p.onCaret(main.empty ? main.head : null)
          }
          if (update.state.field(pasteField) !== update.startState.field(pasteField))
            savePastes(key, update.state.field(pasteField))
          if (update.geometryChanged || update.heightChanged || update.docChanged)
            p.onContentHeight(inputContentHeight(update.view))
        }),
      ],
    })

  // 建编辑器；草稿键变了换一份状态（内容、撤销记录、粘贴段都换）
  const keyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!host.current) return
    const { composerKey, value } = latest.current
    const state = createState(value, composerKey)
    if (!view.current) view.current = new EditorView({ state, parent: host.current })
    else view.current.setState(state)
    keyRef.current = composerKey
    view.current.dispatch({
      effects: resetPastes.of(loadPastes(composerKey)),
      annotations: Transaction.addToHistory.of(false),
    })
    registry.set(composerKey, handle)
    latest.current.onContentHeight(inputContentHeight(view.current))
    return () => {
      if (registry.get(composerKey) === handle) registry.delete(composerKey)
    }
    // 只跟草稿键走；其余用 latest
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.composerKey])
  useEffect(
    () => () => {
      view.current?.destroy()
      view.current = null
    },
    [],
  )

  // 外面改了 value（发送后清空、选了 @ 文件、别处追加草稿…）：只改不同的那一段，粘贴段跟着映射
  useLayoutEffect(() => {
    const v = view.current
    if (!v || keyRef.current !== props.composerKey) return
    const spec = syncValue(v.state, props.value)
    if (!spec) return
    syncing.current = true
    try {
      v.dispatch(spec)
    } finally {
      syncing.current = false
    }
  }, [props.value, props.composerKey])

  useEffect(() => {
    view.current?.dispatch({
      effects: placeholderSlot.current.reconfigure(placeholderExt(props.placeholder)),
    })
  }, [props.placeholder])

  // aria-controls / aria-activedescendant 跟着菜单变
  useEffect(() => {
    const el = view.current?.contentDOM
    if (!el) return
    for (const [name, value] of [
      ['aria-controls', props.ariaControls],
      ['aria-activedescendant', props.ariaActiveDescendant],
    ] as const)
      if (value) el.setAttribute(name, value)
      else el.removeAttribute(name)
  }, [props.ariaControls, props.ariaActiveDescendant])

  useEffect(() => {
    if (props.autoFocus) view.current?.focus()
    // 只在挂上时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 上下留白在 .cm-editor 上、不在 contentDOM 里，CodeMirror 不处理那里的点击：自己聚焦并把光标放到最近的一行
  const focusFromPadding = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const v = view.current
    if (!v || event.button !== 0 || v.contentDOM.contains(event.target as Node)) return
    if (!(event.target === v.dom || event.target === host.current)) return
    event.preventDefault()
    const box = v.contentDOM.getBoundingClientRect()
    const y = Math.min(Math.max(event.clientY, box.top + 1), box.bottom - 1)
    const at = v.posAtCoords({ x: event.clientX, y }) ?? (event.clientY < box.top ? 0 : v.state.doc.length)
    v.focus()
    v.dispatch({ selection: { anchor: at } })
  }

  return (
    <>
      <div
        ref={host}
        data-composer-input
        className={cn(
          'composer-input selectable min-w-0 flex-1',
          props.tight && 'composer-input-tight',
          props.className,
        )}
        style={{ height: props.height }}
        onMouseDown={focusFromPadding}
      />
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={tr('ctxmenu.composer.label')}
          actions={menu.actions}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
})

// 行内改写的会话状态：段落随改动映射、结果换进去后按块保留 / 撤销、全部撤销回到原文、都处理完自动收起
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { applyInline, inlineEditExtension, inlineSession, pendingHunks, startInlineEdit, undoAll } from './extension'

const SRC = ['const a = 1', 'function f() {', '  return 1', '}', 'const b = 2'].join('\n')

/** 只有 state / dispatch 的假 view（node 环境里没有 DOM） */
function fakeView(doc = SRC, readOnly = false) {
  let state = EditorState.create({
    doc,
    extensions: [
      inlineEditExtension(
        () => 'a.ts',
        () => {},
      ),
      EditorState.readOnly.of(readOnly),
    ],
  })
  const view = {
    get state() {
      return state
    },
    dispatch: (...specs: TransactionSpec[]) => {
      state = state.update(...specs).state
    },
  }
  return view as unknown as EditorView
}

const realDocument = globalThis.document
beforeAll(() => {
  globalThis.document = { createElement: () => ({ className: '', querySelector: () => null }) } as unknown as Document
})
afterAll(() => {
  globalThis.document = realDocument
})

describe('inline edit session', () => {
  it('光标在函数里：改整个函数；结果换进去显示改动块；都保留后收起', () => {
    const view = fakeView()
    view.dispatch({ selection: { anchor: SRC.indexOf('return') } })
    const notes: string[] = []
    expect(startInlineEdit(view, 'a.ts', m => notes.push(m))).toBe(true)
    const s = inlineSession(view.state)!
    expect(s.original).toBe('function f() {\n  return 1\n}')
    // 上面插一行：段落跟着挪
    view.dispatch({ changes: { from: 0, insert: '// x\n' } })
    const moved = inlineSession(view.state)!
    expect(view.state.sliceDoc(moved.from, moved.to)).toBe(s.original)
    applyInline(view, moved, 'function f() {\n  return 2\n}', 1200)
    const after = inlineSession(view.state)!
    expect(after).toMatchObject({ applied: true, elapsed: 1200 })
    const hunks = pendingHunks(view.state, after)
    expect(hunks).toHaveLength(1)
    // 撤销这一块：回到原文，没有块了就收起
    const h = hunks[0]
    view.dispatch({ changes: { from: h.undoFrom, to: h.undoTo, insert: h.undoInsert } })
    expect(inlineSession(view.state)).toBeNull()
    expect(view.state.doc.toString()).toBe('// x\n' + SRC)
  })

  it('全部撤销回到原文；只读、太大时提示不打开', () => {
    const view = fakeView()
    view.dispatch({ selection: { anchor: 0, head: 3 } })
    startInlineEdit(view, 'a.ts', () => {})
    const s = inlineSession(view.state)!
    expect(s.original).toBe('const a = 1')
    applyInline(view, s, 'let a = 1\nlet c = 3', 10)
    undoAll(view, inlineSession(view.state)!)
    expect(inlineSession(view.state)).toBeNull()
    expect(view.state.doc.toString()).toBe(SRC)

    const notes: string[] = []
    const ro = fakeView(SRC, true)
    startInlineEdit(ro, 'a.ts', m => notes.push(m))
    expect(inlineSession(ro.state)).toBeNull()
    const big = fakeView(Array(500).fill('x').join('\n'))
    big.dispatch({ selection: { anchor: 0, head: big.state.doc.length } })
    startInlineEdit(big, 'a.txt', m => notes.push(m))
    expect(inlineSession(big.state)).toBeNull()
    expect(notes).toHaveLength(2)
  })

  it('外部重载整篇替换：会话收起，不会扩成整篇再被全部撤销盖掉', () => {
    const view = fakeView()
    view.dispatch({ selection: { anchor: SRC.indexOf('return') } })
    startInlineEdit(view, 'a.ts', () => {})
    applyInline(view, inlineSession(view.state)!, 'function f() {\n  return 2\n}', 10)
    const reloaded = view.state.doc.toString().replace('const b = 2', 'const b = 3')
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: reloaded } })
    expect(inlineSession(view.state)).toBeNull()
    expect(view.state.doc.toString()).toBe(reloaded)
  })

  it('两块一模一样时撤销的是点的那一块', () => {
    const doc = ['var i = 0', 'x', 'var i = 0'].join('\n')
    const view = fakeView(doc)
    view.dispatch({ selection: { anchor: 0, head: doc.length } })
    startInlineEdit(view, 'a.txt', () => {})
    applyInline(view, inlineSession(view.state)!, ['let i = 0', 'x', 'let i = 0'].join('\n'), 10)
    const hunks = pendingHunks(view.state, inlineSession(view.state)!)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].key).not.toBe(hunks[1].key)
    const h = hunks[1]
    view.dispatch({ changes: { from: h.undoFrom, to: h.undoTo, insert: h.undoInsert } })
    expect(view.state.doc.toString()).toBe(['let i = 0', 'x', 'var i = 0'].join('\n'))
  })
})

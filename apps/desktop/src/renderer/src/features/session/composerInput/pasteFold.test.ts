import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  addPaste,
  chunkPreview,
  chunkSize,
  lineCount,
  nextPasteId,
  pasteField,
  resetPastes,
  setFolded,
  shouldFold,
  trimBlankLines,
  validChunks,
} from './pasteFold'
import { minimalChange, syncValue } from './ComposerInput'

const block = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`).join('\n')

/** 「帮我整理：」后面粘一段 30 行，再接「，谢谢」 */
function pasted() {
  const head = '帮我整理：'
  let state = EditorState.create({ doc: head + '，谢谢', extensions: [pasteField] })
  state = state.update({
    changes: { from: head.length, insert: block },
    effects: addPaste.of({ id: 1, from: head.length, to: head.length + block.length, folded: true }),
  }).state
  return { state, head }
}

describe('粘贴段', () => {
  it('阈值：8 行或 800 字；首尾空行不算', () => {
    expect(shouldFold(block)).toBe(true)
    expect(shouldFold('a\nb\nc')).toBe(false)
    expect(shouldFold('x'.repeat(800))).toBe(true)
    expect(shouldFold(Array(7).fill('a').join('\n'))).toBe(false)
    expect(shouldFold(Array(8).fill('a').join('\n'))).toBe(true)
    expect(trimBlankLines('\n\n  \r\n  缩进保留\nb\n\n \n')).toBe('  缩进保留\nb')
    expect(lineCount('')).toBe(0)
  })

  it('标签上的量和预览', () => {
    expect(chunkSize(block)).toEqual({ unit: 'lines', count: 30 })
    expect(chunkSize('x'.repeat(3200))).toEqual({ unit: 'chars', count: 3200 })
    const preview = chunkPreview(block, 3)
    expect(preview.split('\n')).toEqual(['第 1 行', '第 2 行', '第 3 行', '…'])
    expect(chunkPreview('y'.repeat(100), 6, 10)).toBe('yyyyyyyyyy…')
  })

  it('前后打字不进段；段内改动跟着走；删光就没了', () => {
    const { state, head } = pasted()
    expect(state.field(pasteField)).toEqual([
      { id: 1, from: head.length, to: head.length + block.length, folded: true },
    ])
    // 段前紧挨着打字：段整体后移
    let s = state.update({ changes: { from: head.length, insert: '甲' } }).state
    expect(s.field(pasteField)[0]).toMatchObject({ from: head.length + 1, to: head.length + 1 + block.length })
    // 段后紧挨着打字：段不变长
    s = s.update({ changes: { from: head.length + 1 + block.length, insert: '乙' } }).state
    expect(s.field(pasteField)[0].to).toBe(head.length + 1 + block.length)
    // 段内改
    s = s.update({ changes: { from: head.length + 3, insert: 'XYZ' } }).state
    expect(s.field(pasteField)[0].to).toBe(head.length + 1 + block.length + 3)
    // 删光
    const c = s.field(pasteField)[0]
    s = s.update({ changes: { from: c.from, to: c.to } }).state
    expect(s.field(pasteField)).toEqual([])
  })

  it('折 / 展开；编号', () => {
    const { state } = pasted()
    const open = state.update({ effects: setFolded.of({ id: 1, folded: false }) }).state
    expect(open.field(pasteField)[0].folded).toBe(false)
    expect(nextPasteId(open.field(pasteField))).toBe(2)
    expect(nextPasteId([])).toBe(1)
    // 编号重复（撤回放回来的段）时换一个
    const dup = open.update({ effects: addPaste.of({ id: 1, from: 0, to: 2, folded: true }) }).state
    expect(dup.field(pasteField).map(c => c.id)).toEqual([2, 1])
  })

  it('读回的记录：越界、重叠、格式不对的丢掉', () => {
    expect(
      validChunks(
        [
          { id: 1, from: 0, to: 5, folded: true },
          { id: 2, from: 3, to: 8, folded: true },
          { id: 3, from: 8, to: 99, folded: false },
          { id: 4, from: 6, to: 9, folded: false },
          { id: 4, from: 9, to: 10, folded: false },
          null,
          'x',
          { id: 5, from: 2, to: 2, folded: true },
        ],
        10,
      ),
    ).toEqual([
      { id: 1, from: 0, to: 5, folded: true },
      { id: 4, from: 6, to: 9, folded: false },
    ])
    const { state } = pasted()
    const reset = state.update({ effects: resetPastes.of([{ id: 7, from: 0, to: 3, folded: true }]) }).state
    expect(reset.field(pasteField)).toEqual([{ id: 7, from: 0, to: 3, folded: true }])
  })
})

describe('minimalChange', () => {
  it('只改不同的那一段', () => {
    expect(minimalChange('abc', 'abc')).toBeNull()
    expect(minimalChange('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' })
    expect(minimalChange('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, insert: 'XY' })
    expect(minimalChange('abc', '')).toEqual({ from: 0, to: 3, insert: '' })
    expect(minimalChange('aaa', 'aaaa')).toEqual({ from: 3, to: 3, insert: 'a' })
  })
})

describe('syncValue', () => {
  const apply = (doc: string, caret: number, value: string) => {
    const state = EditorState.create({ doc, selection: { anchor: caret } })
    const spec = syncValue(state, value)
    return spec && state.update(spec).state
  }

  it('空输入框被填入（Tab 填入输入建议）：光标在末尾', () => {
    const next = apply('', 0, '帮我把测试也补上')
    expect(next?.doc.toString()).toBe('帮我把测试也补上')
    expect(next?.selection.main.head).toBe('帮我把测试也补上'.length)
  })

  it('原来有字：光标跟着改动映射，不跳到末尾', () => {
    // 光标在「hello」后面，外面在开头插了「> 」
    const next = apply('hello world', 5, '> hello world')
    expect(next?.selection.main.head).toBe(7)
  })

  it('空输入框被填入带 \\r\\n 的草稿（终端里选中的文字）：不越界，换行统一成 \\n', () => {
    const next = apply('', 0, '终端 · pnpm build\r\n✗ Build failed\r\nerror during build:\r\n')
    expect(next?.doc.toString()).toBe('终端 · pnpm build\n✗ Build failed\nerror during build:\n')
    expect(next?.selection.main.head).toBe(next?.doc.length)
  })

  it('一样就不发改动', () => {
    expect(syncValue(EditorState.create({ doc: 'abc' }), 'abc')).toBeNull()
  })
})

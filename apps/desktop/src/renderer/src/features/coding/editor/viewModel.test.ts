import { describe, expect, it } from 'vitest'
import { changedRange, defaultMode, effectiveBase, effectiveMode, viewAvailability, type ViewInput } from './viewModel'

const base: ViewInput = {
  head: 'a',
  draft: 'b',
  text: true,
  markdown: false,
  turnBaseline: null,
  width: 800,
  splitMinWidth: 560,
}

describe('viewAvailability', () => {
  it('有 HEAD 且有改动时三种视图都能点', () => {
    expect(viewAvailability(base)).toMatchObject({ diff: true, split: true, turn: false, reason: null })
  })
  it('没有 HEAD 时变更和并排不能点', () => {
    expect(viewAvailability({ ...base, head: null })).toMatchObject({ diff: false, split: false, reason: 'noHead' })
  })
  it('二进制文件不能点', () => {
    expect(viewAvailability({ ...base, text: false })).toMatchObject({ diff: false, reason: 'binary' })
  })
  it('没有改动且算不出这一轮的基准时不能点', () => {
    expect(viewAvailability({ ...base, draft: 'a' })).toMatchObject({ diff: false, reason: 'noChange' })
  })
  it('没有改动但能算出这一轮的基准时能点', () => {
    expect(viewAvailability({ ...base, draft: 'a', turnBaseline: 'z' })).toMatchObject({ diff: true, turn: true })
  })
  it('基准是空字符串（新文件）也算能算出', () => {
    expect(viewAvailability({ ...base, turnBaseline: '' }).turn).toBe(true)
  })
  it('太窄时并排不能点，变更还能点', () => {
    expect(viewAvailability({ ...base, width: 400 })).toMatchObject({ diff: true, split: false, narrow: true })
  })
})

describe('预览', () => {
  it('只有 Markdown 文本文件能点，默认就是预览', () => {
    expect(viewAvailability(base).preview).toBe(false)
    expect(defaultMode(viewAvailability(base))).toBe('code')
    const md = viewAvailability({ ...base, markdown: true })
    expect(md.preview).toBe(true)
    expect(defaultMode(md)).toBe('preview')
    expect(effectiveMode('preview', md)).toBe('preview')
  })
  it('不是文本文件时没有预览，保存的预览退回代码', () => {
    const bin = viewAvailability({ ...base, markdown: true, text: false })
    expect(bin.preview).toBe(false)
    expect(effectiveMode('preview', bin)).toBe('code')
    expect(effectiveMode('preview', viewAvailability(base))).toBe('code')
  })
})

describe('effectiveMode / effectiveBase', () => {
  it('不可用的视图退回代码', () => {
    const none = viewAvailability({ ...base, head: null })
    expect(effectiveMode('diff', none)).toBe('code')
    expect(effectiveMode('split', none)).toBe('code')
  })
  it('改回和 HEAD 一样时留在变更 / 并排（按钮不能点，但不换掉正在改的编辑器）', () => {
    const same = viewAvailability({ ...base, draft: 'a' })
    expect(same).toMatchObject({ diff: false, split: false, reason: 'noChange' })
    expect(effectiveMode('diff', same)).toBe('diff')
    expect(effectiveMode('split', same)).toBe('split')
    expect(effectiveMode('split', viewAvailability({ ...base, draft: 'a', width: 300 }))).toBe('diff')
  })
  it('太窄的并排退回变更', () => {
    expect(effectiveMode('split', viewAvailability({ ...base, width: 300 }))).toBe('diff')
  })
  it('只看这一轮算不出时退回 HEAD', () => {
    expect(effectiveBase('turn', viewAvailability(base))).toBe('head')
    expect(effectiveBase('turn', viewAvailability({ ...base, turnBaseline: 'x' }))).toBe('turn')
    expect(effectiveBase('head', viewAvailability(base))).toBe('head')
  })
})

describe('changedRange', () => {
  const apply = (a: string, b: string) => {
    const c = changedRange(a, b)
    return a.slice(0, c.from) + c.insert + a.slice(c.to)
  }
  it('只换中间变了的一段，前面的位置不动', () => {
    expect(changedRange('line1\nline2\nline3', 'line1\nlineX2\nline3')).toEqual({ from: 10, to: 10, insert: 'X' })
    expect(changedRange('abc', 'abc')).toEqual({ from: 3, to: 3, insert: '' })
  })
  it('增删、重复字符、全换都能还原成新文本', () => {
    for (const [a, b] of [
      ['aaa', 'aa'],
      ['aa', 'aaa'],
      ['', 'x'],
      ['x', ''],
      ['abc', 'xyz'],
      ['abba', 'aba'],
    ] as const)
      expect(apply(a, b)).toBe(b)
  })
})

import { describe, expect, it } from 'vitest'
import { liveSplit, readSplit, splitMoveTarget, type TerminalSplit } from './split'

const split = (dir: TerminalSplit['dir']): TerminalSplit => ({ left: 'a', right: 'b', ratio: 0.5, dir })

describe('终端分屏', () => {
  it('旧记录没有方向按向右读，比例夹在 0.2–0.8，两边相同或缺字段的不要', () => {
    expect(readSplit({ left: 'a', right: 'b', ratio: 0.95 })).toEqual({
      left: 'a',
      right: 'b',
      ratio: 0.8,
      dir: 'right',
    })
    expect(readSplit({ left: 'a', right: 'b', dir: 'down' })).toEqual({
      left: 'a',
      right: 'b',
      ratio: 0.5,
      dir: 'down',
    })
    expect(readSplit({ left: 'a', right: 'b', dir: 'sideways' })?.dir).toBe('right')
    expect(readSplit({ left: 'a', right: 'a' })).toBeNull()
    expect(readSplit({ left: 'a' })).toBeNull()
    expect(readSplit(null)).toBeNull()
  })

  it('Alt+方向键只认分屏方向上的两个键，别的交给 Shell', () => {
    expect(splitMoveTarget(split('right'), 'ArrowLeft')).toBe('a')
    expect(splitMoveTarget(split('right'), 'ArrowRight')).toBe('b')
    expect(splitMoveTarget(split('right'), 'ArrowUp')).toBeNull()
    expect(splitMoveTarget(split('down'), 'ArrowUp')).toBe('a')
    expect(splitMoveTarget(split('down'), 'ArrowDown')).toBe('b')
    expect(splitMoveTarget(split('down'), 'ArrowLeft')).toBeNull()
    expect(splitMoveTarget(null, 'ArrowLeft')).toBeNull()
  })
})

describe('显示着的分屏', () => {
  it('两格都在当前列表里才算：别的项目留下的、跨项目拼起来的不算', () => {
    const s = split('down')
    expect(liveSplit(s, ['x', 'a', 'b'])).toBe(s)
    expect(liveSplit(s, ['a', 'c'])).toBeNull()
    expect(liveSplit(s, [])).toBeNull()
    expect(liveSplit(null, ['a', 'b'])).toBeNull()
  })
})

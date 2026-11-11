import { describe, expect, it } from 'vitest'
import { createHistory, rowsText, stripAnsi, type DataEvent } from './history'

const ev = (seq: number, data: string, generation = 1): DataEvent => ({
  type: 'data',
  terminalId: 't',
  generation,
  seq,
  data,
})

describe('createHistory', () => {
  it('keeps events in order', () => {
    const h = createHistory(100)
    h.push(ev(1, 'a'))
    h.push(ev(2, 'b'))
    expect(h.events().map(e => e.seq)).toEqual([1, 2])
    expect(h.text()).toBe('ab')
  })
  it('drops whole events from the head when over the limit', () => {
    const h = createHistory(10)
    h.push(ev(1, '12345'))
    h.push(ev(2, '67890'))
    h.push(ev(3, 'abc'))
    expect(h.events().map(e => e.seq)).toEqual([2, 3])
    expect(h.text()).toBe('67890abc')
  })
  it('counts bytes, not characters', () => {
    const h = createHistory(6)
    h.push(ev(1, '你好')) // 6 bytes
    h.push(ev(2, 'x'))
    expect(h.events().map(e => e.seq)).toEqual([2])
  })
  it('always keeps the newest event even if it alone exceeds the limit', () => {
    const h = createHistory(4)
    h.push(ev(1, '123456789'))
    expect(h.events()).toHaveLength(1)
  })
  it('clears when the generation changes', () => {
    const h = createHistory(100)
    h.push(ev(1, 'old'))
    h.push(ev(1, 'new', 2))
    expect(h.events().map(e => e.generation)).toEqual([2])
    expect(h.text()).toBe('new')
  })
})

describe('stripAnsi', () => {
  it('removes colors, cursor moves and OSC titles', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b[2K\u001b[1;5Hx')).toBe('red x')
    expect(stripAnsi('\u001b]0;title\u0007hello')).toBe('hello')
    expect(stripAnsi('\u001b]8;;http://a\u001b\\link\u001b]8;;\u001b\\')).toBe('link')
  })
  it('normalizes CRLF and drops stray control characters', () => {
    expect(stripAnsi('a\r\nb\u0007c')).toBe('a\nbc')
  })
})

describe('rowsText', () => {
  const rows = (lines: Array<[string, boolean?]>) => ({
    length: lines.length,
    text: (row: number) => lines[row][0],
    wrapped: (row: number) => !!lines[row][1],
  })
  it('折行接回一行，中间的空行留着，末尾的空行去掉', () => {
    expect(rowsText(rows([['PS> echo aaaa'], ['bbbb', true], [''], ['done'], [''], ['  ']]))).toBe(
      'PS> echo aaaabbbb\n\ndone',
    )
  })
  it('空缓冲区是空字符串；第一行标成折行也不出错', () => {
    expect(rowsText(rows([]))).toBe('')
    expect(
      rowsText(
        rows([
          ['a', true],
          ['b', true],
        ]),
      ),
    ).toBe('ab')
  })
})

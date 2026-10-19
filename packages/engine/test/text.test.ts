import { describe, expect, it } from 'vitest'
import { cut, wellFormed } from '../src/text'

const emoji = String.fromCharCode(0xd83d, 0xde00)
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('cut：按下标截取但不劈开代理对', () => {
  it('所有起止组合：结果是原文的子串，且没有落单的代理项', () => {
    const text = `a${emoji}b${emoji}${emoji}`
    for (let start = -2; start <= text.length + 2; start++)
      for (let end = -2; end <= text.length + 2; end++) {
        const out = cut(text, start, end)
        expect(text.includes(out)).toBe(true)
        expect(lone.test(out)).toBe(false)
      }
  })

  it('边界落在代理对中间时往里收', () => {
    const text = `${emoji}${emoji}`
    expect(cut(text, 0, 3)).toBe(emoji)
    expect(cut(text, 1)).toBe(emoji)
    expect(cut(text, 0, 1)).toBe('')
  })

  it('不在代理对中间时和 slice 一样', () => {
    expect(cut('abcdef', 1, 4)).toBe('bcd')
    expect(cut('abcdef', 4, 2)).toBe('')
    expect(cut('abcdef', 3)).toBe('def')
  })
})

describe('wellFormed', () => {
  it('落单的代理项换成 U+FFFD，完整的 emoji 不动', () => {
    const high = String.fromCharCode(0xd83d)
    const low = String.fromCharCode(0xde00)
    expect(wellFormed(`${high}${high}${low}${low}`)).toBe(`�${emoji}�`)
    expect(wellFormed(`a${emoji}b`)).toBe(`a${emoji}b`)
  })
})

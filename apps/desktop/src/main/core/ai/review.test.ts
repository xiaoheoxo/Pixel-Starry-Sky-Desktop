import { describe, expect, it } from 'vitest'
import { REVIEW_FINDINGS_MAX } from '../../../shared/types/ai'
import { parseReview, reviewPrompt } from './review'

describe('AI 审查：解析回复', () => {
  it('包在代码块里也认；缺的严重程度按一般，行号只要正整数', () => {
    const reply =
      '好的\n```json\n{"findings":[{"severity":"high","file":"a.ts","line":3,"title":"空指针","detail":"x"},{"file":"b.ts","line":-1,"title":"t2"},{"title":""}]}\n```'
    expect(parseReview(reply, [])).toEqual({
      findings: [
        { severity: 'high', file: 'a.ts', line: 3, title: '空指针', detail: 'x' },
        { severity: 'medium', file: 'b.ts', line: null, title: 't2', detail: '' },
      ],
      resolved: [],
    })
  })
  it('没有 findings 数组算格式不对；空数组是「没发现问题」', () => {
    expect(parseReview('没有问题', [])).toBeNull()
    expect(parseReview('{"ok":true}', [])).toBeNull()
    expect(parseReview('{"findings":[]}', [])).toEqual({ findings: [], resolved: [] })
  })
  it('复审：resolved 只认原来有的序号，去重', () => {
    expect(parseReview('{"findings":[],"resolved":[1,1,3,9,"2"]}', [1, 2, 3])?.resolved).toEqual([1, 3])
  })
  it('最多留 20 条', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: 't' + i }))
    expect(parseReview(JSON.stringify({ findings: many }), [])?.findings).toHaveLength(REVIEW_FINDINGS_MAX)
  })
})

describe('AI 审查：提示词', () => {
  it('写明界面语言；复审时列出原来的条目', () => {
    const first = reviewPrompt({ diff: 'D', ask: '改按钮', previous: [], uiLanguage: 'zh' })
    expect(first).toContain('Simplified Chinese')
    expect(first).toContain('改按钮')
    expect(first).not.toContain('Previous findings')
    const again = reviewPrompt({
      diff: 'D',
      ask: '',
      previous: [{ n: 1, title: '空指针', file: 'a.ts', line: 3 }],
      uiLanguage: 'en',
    })
    expect(again).toContain('1. a.ts:3 空指针')
    expect(again).toContain('"resolved"')
  })
})

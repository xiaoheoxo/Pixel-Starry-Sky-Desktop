// 会话列表「最后一句回复」预览（docs/mobile-remote.md §21.3）
import { describe, expect, it } from 'vitest'
import { replyPreview } from './replyPreview'

describe('replyPreview', () => {
  it('普通文字原样返回，空白合成一个空格', () => {
    expect(replyPreview('已经改好了')).toBe('已经改好了')
    expect(replyPreview('  第一行\n\n  第二行\t\t第三段  ')).toBe('第一行 第二行 第三段')
    expect(replyPreview('')).toBe('')
    expect(replyPreview('  \n \n')).toBe('')
  })

  it('代码块整块换成 [代码]，包括没闭合的和波浪线围栏', () => {
    expect(replyPreview('先看这个：\n```ts\nconst a = 1\n\n# 不是标题\n```\n然后重启')).toBe(
      '先看这个： [代码] 然后重启',
    )
    expect(replyPreview('```\nrm -rf /\n')).toBe('[代码]')
    expect(replyPreview('~~~sh\nls\n~~~')).toBe('[代码]')
    // 内层更短的围栏不会提前结束外层
    expect(replyPreview('````md\n```\nx\n```\n````\n完')).toBe('[代码] 完')
  })

  it('行内代码去反引号，里面的星号不当强调', () => {
    expect(replyPreview('运行 `pnpm test` 看看')).toBe('运行 pnpm test 看看')
    expect(replyPreview('用 `a * b * c` 算')).toBe('用 a * b * c 算')
    expect(replyPreview('改了 ``x`y`` 这里')).toBe('改了 x`y 这里')
  })

  it('链接只留文字，图片留说明', () => {
    expect(replyPreview('见 [文档](https://example.com/a?b=1) 和 [另一个][ref]')).toBe('见 文档 和 另一个')
    expect(replyPreview('![截图](a.png) 在上面')).toBe('截图 在上面')
  })

  it('去掉标题、列表、引用、任务框记号', () => {
    expect(replyPreview('## 结论\n- 第一项\n* 第二项\n+ 第三项\n1. 编号\n2) 另一种')).toBe(
      '结论 第一项 第二项 第三项 编号 另一种',
    )
    expect(replyPreview('> 引用的话\n>> 嵌套')).toBe('引用的话 嵌套')
    expect(replyPreview('- [x] 做完了\n- [ ] 没做')).toBe('做完了 没做')
    expect(replyPreview('---\n正文\n| a | b |\n| --- | --- |')).toBe('正文 | a | b |')
  })

  it('去掉加粗斜体删除线记号，单词里的下划线和乘号保留', () => {
    expect(replyPreview('**重点** 和 *强调* 和 __粗__ 和 _斜_ 和 ~~删~~')).toBe('重点 和 强调 和 粗 和 斜 和 删')
    expect(replyPreview('变量 snake_case_name 和 2*3*4')).toBe('变量 snake_case_name 和 2*3*4')
  })

  it('超过 120 个字符截断，加「…」后仍不超过 120', () => {
    const out = replyPreview('字'.repeat(500))
    expect(Array.from(out)).toHaveLength(120)
    expect(out.endsWith('…')).toBe(true)
    expect(replyPreview('字'.repeat(120))).toBe('字'.repeat(120))
    expect(replyPreview('字'.repeat(121))).toBe('字'.repeat(119) + '…')
  })

  it('截断不拆开双字符（emoji），也不在省略号前留空格', () => {
    const out = replyPreview('😀'.repeat(200), 10)
    expect(Array.from(out)).toHaveLength(10)
    expect(out).toBe('😀'.repeat(9) + '…')
    expect(replyPreview('abc def ghi', 5)).toBe('abc…')
  })

  it('max 可以改，非法的 max 给空串', () => {
    expect(replyPreview('一二三四五六', 4)).toBe('一二三…')
    expect(replyPreview('一二三', 1)).toBe('…')
    expect(replyPreview('一二三', 0)).toBe('')
  })

  it('很长的文本也只读开头', () => {
    const text = Array.from({ length: 50000 }, (_, i) => `第 ${i} 行`).join('\n')
    expect(Array.from(replyPreview(text))).toHaveLength(120)
  })

  it('只有一行、而且很长时也只看开头（长表格行、压缩过的 Markdown）', () => {
    expect(Array.from(replyPreview('**a '.repeat(10000))).length).toBeLessThanOrEqual(120)
    expect(Array.from(replyPreview('[a'.repeat(20000)))).toHaveLength(120)
  })
})

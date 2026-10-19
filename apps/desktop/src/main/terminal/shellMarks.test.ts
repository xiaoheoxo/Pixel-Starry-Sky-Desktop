import { describe, expect, it } from 'vitest'
import { createMarkParser, type ShellMark } from './shellMarks'

const ESC = '\u001b'
const BEL = '\u0007'
const end = (code: string): string => `${ESC}]633;D;${code}${BEL}`
const prompt = `${ESC}]633;A${BEL}`

/** 把输出按块喂进去，返回合起来的文本和标记 */
function feed(chunks: string[]): { text: string; marks: ShellMark[] } {
  const parser = createMarkParser()
  let text = ''
  const marks: ShellMark[] = []
  for (const chunk of chunks) {
    const out = parser.push(chunk)
    text += out.text
    marks.push(...out.marks)
  }
  return { text, marks }
}

describe('提示符标记解析', () => {
  it('认出命令结束（带退出码）和提示符开始，并把它们从文本里剥掉', () => {
    const out = feed([`done\r\n${end('3')}${prompt}PS C:\\> `])
    expect(out.text).toBe('done\r\nPS C:\\> ')
    expect(out.marks).toEqual([{ kind: 'end', exitCode: 3 }, { kind: 'prompt' }])
  })

  it('一块里有多个标记、夹在普通输出中间', () => {
    const out = feed([`a${prompt}b${end('0')}c${prompt}d${end('-1073741510')}${prompt}e`])
    expect(out.text).toBe('abcde')
    expect(out.marks).toEqual([
      { kind: 'prompt' },
      { kind: 'end', exitCode: 0 },
      { kind: 'prompt' },
      { kind: 'end', exitCode: -1073741510 },
      { kind: 'prompt' },
    ])
  })

  it('没有退出码的 D 算「不知道」', () => {
    expect(feed([`${ESC}]633;D${BEL}`]).marks).toEqual([{ kind: 'end', exitCode: null }])
    expect(feed([`${ESC}]633;D;${BEL}`]).marks).toEqual([{ kind: 'end', exitCode: null }])
  })

  it('ESC \\ 结尾（ST）也认', () => {
    const out = feed([`x${ESC}]633;A${ESC}\\y`])
    expect(out.text).toBe('xy')
    expect(out.marks).toEqual([{ kind: 'prompt' }])
  })

  it('跨数据块切开：在任意位置切一刀结果都一样', () => {
    const whole = `before${end('42')}${prompt}after`
    for (let cut = 0; cut <= whole.length; cut++) {
      const out = feed([whole.slice(0, cut), whole.slice(cut)])
      expect(out.text).toBe('beforeafter')
      expect(out.marks).toEqual([{ kind: 'end', exitCode: 42 }, { kind: 'prompt' }])
    }
  })

  it('一个字符一个字符地喂也行', () => {
    const whole = `x${end('7')}${prompt}y`
    const out = feed([...whole])
    expect(out.text).toBe('xy')
    expect(out.marks).toEqual([{ kind: 'end', exitCode: 7 }, { kind: 'prompt' }])
  })

  it('块尾的 ESC 先留着，下一块不是标记就原样还回去', () => {
    const parser = createMarkParser()
    expect(parser.push(`abc${ESC}`)).toEqual({ text: 'abc', marks: [] })
    expect(parser.push('[31mred')).toEqual({ text: `${ESC}[31mred`, marks: [] })
  })

  it('别的转义序列和别的 633 子命令原样放行', () => {
    const other = `${ESC}]633;B${BEL}`
    const title = `${ESC}]0;title${BEL}`
    const out = feed([`${title}${other}${ESC}[0m text`])
    expect(out.text).toBe(`${title}${other}${ESC}[0m text`)
    expect(out.marks).toEqual([])
  })

  it('不完整又一直没结尾的（太长）不会无限等', () => {
    const junk = `${ESC}]633;D;${'9'.repeat(100)}`
    const out = feed([junk, ' more'])
    expect(out.text).toBe(junk + ' more')
    expect(out.marks).toEqual([])
  })

  it('标记里夹了别的转义：当普通输出', () => {
    const out = feed([`${ESC}]633;D;1${ESC}[0m${BEL}`])
    expect(out.marks).toEqual([])
    expect(out.text).toContain('[0m')
  })

  it('退出码超出整数范围的不认', () => {
    expect(feed([`${ESC}]633;D;99999999999${BEL}`]).marks).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { FOLD_SHOW } from '@/ui/code/CodeBlock'
import type { Item } from '@pixelsky/protocol'
import {
  ROW,
  changesHeight,
  errorNoticeHeight,
  itemHeight,
  markdownHeight,
  processHeight,
  toolsHeight,
} from './blockHeight'

const fence = (lines: number): string =>
  ['```ts', ...Array.from({ length: lines }, (_, i) => `line ${i}`), '```'].join('\n')

describe('markdownHeight', () => {
  it('正文按行，空行算段落间距', () => {
    expect(markdownHeight('一行')).toBe(26)
    expect(markdownHeight('一行\n\n两行')).toBe(26 + 10 + 26)
  })
  it('长行按宽度折行（中日韩字更宽）', () => {
    expect(markdownHeight('a'.repeat(220))).toBe(26 * 2)
    expect(markdownHeight('字'.repeat(110))).toBe(26 * 2)
  })
  it('代码块按行数；超过 30 行按折叠后的 20 行加展开按钮', () => {
    const short = markdownHeight(fence(10))
    const long = markdownHeight(fence(40))
    expect(short).toBe(56 + 20 * 10)
    expect(long).toBe(56 + 20 * FOLD_SHOW + 36)
  })
  it('没闭合的代码块（流式输出中）也算', () => {
    expect(markdownHeight('```ts\na\nb')).toBe(56 + 20 * 2)
  })
  it('有上限', () => {
    expect(markdownHeight('x\n'.repeat(100_000))).toBe(50_000)
  })
})

describe('itemHeight', () => {
  it('用户消息按行，回复按 Markdown，提示固定，其余一行', () => {
    expect(itemHeight({ kind: 'user', id: 'u', text: '一\n二', createdAt: 0 })).toBe(20 + 26 * 2)
    expect(itemHeight({ kind: 'assistant', id: 'a', text: '一行', status: 'completed' })).toBe(26)
    expect(itemHeight({ kind: 'notice', id: 'n', level: 'info', text: 'x' })).toBe(40)
    expect(itemHeight({ kind: 'reasoning', id: 'r', text: 'x', status: 'completed' })).toBe(ROW)
  })
  it('长用户消息折起来只算显示出来的那段', () => {
    const long = itemHeight({ kind: 'user', id: 'u', text: '一行\n'.repeat(40), createdAt: 0 })
    const longer = itemHeight({ kind: 'user', id: 'u', text: '一行\n'.repeat(400), createdAt: 0 })
    expect(long).toBe(longer)
    expect(long).toBeLessThan(400)
  })
  it('带图片、文件的用户消息算上缩略图和标签那一排', () => {
    const plain = itemHeight({ kind: 'user', id: 'u', text: '看图', createdAt: 0 })
    const image = { id: 'i', name: 'a.png', mimeType: 'image/png' } as never
    const file = { id: 'f', name: 'a.md' } as never
    expect(itemHeight({ kind: 'user', id: 'u', text: '看图', createdAt: 0, attachments: [image] })).toBeGreaterThan(
      plain + 100,
    )
    expect(itemHeight({ kind: 'user', id: 'u', text: '看图', createdAt: 0, files: [file] })).toBeGreaterThan(plain)
  })
  it('自动换账号的提示多一行按钮；压缩上下文', () => {
    const account = {
      engine: 'claude',
      from: 'a',
      to: 'b',
      fromName: 'a',
      toName: 'b',
      window: null,
      resetsAt: null,
    } as const
    expect(itemHeight({ kind: 'notice', id: 'n', level: 'info', text: 'x', account })).toBe(64)
    expect(itemHeight({ kind: 'compaction', id: 'c', status: 'completed' } as Item)).toBe(72)
  })
  it('工具组、改动卡片、报错', () => {
    expect(ROW).toBe(24)
    expect(toolsHeight(3)).toBe(ROW * 3)
    expect(changesHeight(2)).toBe(50 + 52)
    expect(errorNoticeHeight(false)).toBeLessThan(errorNoticeHeight(true))
  })
})

describe('processHeight', () => {
  const tools: Item[] = Array.from({ length: 10 }, (_, i) => ({
    kind: 'command',
    id: `c${i}`,
    command: 'ls',
    status: 'completed',
  })) as Item[]
  const text: Item = { kind: 'assistant', id: 'a', text: '一行', status: 'completed' }

  it('收起只算标题行（正常模式跑完的一轮）', () => {
    expect(processHeight([...tools, text], false, false)).toBe(30)
  })
  it('展开（极简模式默认）：每条工具一行，过渡话按 Markdown 加上下留空', () => {
    expect(processHeight([...tools, text], true, false)).toBe(30 + 4 + 10 * ROW + 26 + 12)
  })
  it('运行中收起：标题加最后两条', () => {
    expect(processHeight(tools, false, true)).toBe(30 + 4 + 2 * ROW)
  })
  it('展开时比收起高得多：滚动时不会按一行占位再突然撑开', () => {
    expect(processHeight(tools, true, false)).toBeGreaterThan(processHeight(tools, false, false) * 5)
  })
})

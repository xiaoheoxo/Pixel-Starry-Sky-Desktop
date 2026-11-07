import { describe, expect, it } from 'vitest'
import { groupCommands, rankCommands } from './rank'
const commands = [
  { id: 'new', label: '新建终端', keywords: 'new terminal shell', category: '终端' },
  { id: 'close', label: '关闭终端', keywords: 'close terminal', category: '终端' },
  { id: 'theme', label: '深色主题', keywords: 'dark theme', category: '外观' },
]
describe('command groups', () => {
  const shape = (query: string, history: string[]) =>
    groupCommands(rankCommands(commands, query, history), query, history, '最近').map(g => [
      g.title,
      g.items.map(c => c.id),
    ])
  it('puts recent first, then categories, without repeating a command', () => {
    expect(shape('', ['theme', 'missing'])).toEqual([
      ['最近', ['theme']],
      ['终端', ['new', 'close']],
    ])
    expect(shape('', [])).toEqual([
      ['终端', ['new', 'close']],
      ['外观', ['theme']],
    ])
  })
  it('keeps relevance order and no headings while searching', () => {
    expect(shape('终端', ['close'])).toEqual([[null, ['close', 'new']]])
    expect(shape('没有这个', [])).toEqual([])
  })
})
describe('command search', () => {
  it('matches all query words in either language with stable ordering', () => {
    expect(rankCommands(commands, 'TERMINAL new', []).map(c => c.id)).toEqual(['new'])
    expect(rankCommands(commands, '终端', ['close']).map(c => c.id)).toEqual(['close', 'new'])
    expect(rankCommands(commands, '主题 terminal', [])).toEqual([])
  })
  it('prefers exact names over recent history and ignores unknown history ids', () => {
    expect(rankCommands(commands, '新建终端', ['close']).map(c => c.id)).toEqual(['new'])
    expect(rankCommands(commands, '', ['missing', 'theme']).map(c => c.id)).toEqual(['theme', 'new', 'close'])
  })
})

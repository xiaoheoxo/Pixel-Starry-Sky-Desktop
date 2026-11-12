import { describe, expect, it } from 'vitest'
import { CUT_EDGE, cutItem, searchLiteral, type Item } from '@pixelsky/protocol'
import { clampedText, countFull, foldedMatches, foldedText } from './foldedText'
import { CLAMP_DRAWN_LINES } from '../viewModeModel'

const command: Item = {
  kind: 'command',
  id: 'c1',
  command: 'npm test',
  description: null,
  output: '\u001b[32mok\u001b[39m 银河\nfail 银河',
  exitCode: 0,
  status: 'completed',
}
const tool: Item = {
  kind: 'tool',
  id: 't1',
  tool: 'read',
  name: 'Read',
  title: 'a.ts',
  output: 'line 银河',
  status: 'completed',
}
const change: Item = {
  kind: 'file_change',
  id: 'f1',
  changes: [
    { path: 'a.ts', kind: 'update', diff: '-old\n+new 银河', added: 1, removed: 1 },
    { path: 'b.ts', kind: 'update', diff: '+b', added: 1, removed: 0 },
  ],
  status: 'completed',
}
const reasoning: Item = { kind: 'reasoning', id: 'r1', text: '想想银河', status: 'completed' }
const todo: Item = {
  kind: 'todo',
  id: 'd1',
  steps: [
    { text: '写银河', status: 'completed' },
    { text: '测银河', status: 'in_progress' },
    { text: '发布', status: 'pending' },
  ],
  status: 'completed',
}
const notice: Item = { kind: 'notice', id: 'n1', level: 'error', text: '失败', detail: '  详情 银河  ' }

describe('foldedText', () => {
  it('命令输出去掉 ANSI', () => {
    expect(foldedText(command)).toBe('ok 银河\nfail 银河')
  })
  it('工具输出、文件 diff、思考、提示详情', () => {
    expect(foldedText(tool)).toBe('line 银河')
    expect(foldedText(change)).toBe('-old\n+new 银河\n+b')
    expect(foldedText(reasoning)).toBe('想想银河')
    expect(foldedText(notice)).toBe('详情 银河')
  })
  it('待办不含进行中那一步（折叠时也显示在概要里）', () => {
    expect(foldedText(todo)).toBe('写银河\n发布')
  })
  it('正文和用户消息没有折叠部分', () => {
    expect(foldedText({ kind: 'assistant', id: 'a', text: '银河', status: 'completed' })).toBe('')
    expect(foldedText({ kind: 'notice', id: 'n2', level: 'info', text: '银河' })).toBe('')
  })
  it('长提示折着时前 3 行在页面上，其余的行算折叠部分', () => {
    const text = '子智能体已完成：改好了\n\n**1. a.ts**\n```ts\n银河\n```'
    expect(foldedText({ kind: 'notice', id: 'n3', level: 'info', text })).toBe('```ts\n银河\n```')
    expect(foldedText({ kind: 'notice', id: 'n4', level: 'error', text, detail: '详情' })).toBe(
      '```ts\n银河\n```\n详情',
    )
  })
})

describe('foldedMatches', () => {
  const items = [command, tool, change, reasoning, todo, notice]
  const term = [searchLiteral('银河')]
  it('只数折叠着的条目', () => {
    expect(foldedMatches(items, term, new Set(['c1', 'r1']))).toEqual({ ids: ['c1', 'r1'], count: 3, missing: [] })
  })
  it('全部折叠', () => {
    const all = new Set(items.map(i => i.id))
    expect(foldedMatches(items, term, all)).toEqual({
      ids: ['c1', 't1', 'f1', 'r1', 'd1', 'n1'],
      count: 7,
      missing: [],
    })
  })
  it('收在执行块里的条目算全部文字（待办进行中的那步、过渡话也算）', () => {
    const say: Item = { kind: 'assistant', id: 'a1', text: '先看银河，再看银河', status: 'completed' }
    expect(foldedMatches([todo, say], term, new Set(), new Set(['d1', 'a1']))).toEqual({
      ids: ['d1', 'a1'],
      count: 4,
      missing: [],
    })
  })
  it('不分大小写，和 Ctrl+F 一致', () => {
    expect(foldedMatches([tool], [searchLiteral('LINE')], new Set(['t1'])).count).toBe(1)
  })
  it('没有搜索词或没有折叠的条目', () => {
    expect(foldedMatches(items, [], new Set(['c1']))).toEqual({ ids: [], count: 0, missing: [] })
    expect(foldedMatches(items, term, new Set())).toEqual({ ids: [], count: 0, missing: [] })
  })
  it('截过输出的先按截过的数、列进 missing；用完整内容数过后按完整的算（按条目对象和词记）', () => {
    const output = 'x'.repeat(CUT_EDGE) + ' 银河 '.repeat(5000) + 'x'.repeat(CUT_EDGE)
    const full: Item = { ...command, id: 'big', command: '银河', output }
    const cut = cutItem(full)
    const before = foldedMatches([cut], term, new Set(['big']))
    expect(before.missing).toEqual([cut])
    expect(before.count).toBe(0)
    countFull(cut, full, term)
    expect(foldedMatches([cut], term, new Set(['big']))).toEqual({ ids: ['big'], count: 5000, missing: [] })
    // 整条收在执行块里：命令那一行也算
    expect(foldedMatches([cut], term, new Set(), new Set(['big'])).count).toBe(5001)
    // 换了词、换了对象都要重新数
    expect(foldedMatches([cut], [searchLiteral('x')], new Set(['big'])).missing).toEqual([cut])
    expect(foldedMatches([{ ...cut }], term, new Set(['big'])).missing).toHaveLength(1)
  })
})

describe('限高没画的部分（§13 A）', () => {
  const out = [...Array.from({ length: CLAMP_DRAWN_LINES }, () => '前面 hit'), '后面 hit', '后面 hit'].join('\n')
  const long = { kind: 'command', id: 'k1', command: 'x', output: out, status: 'completed' } as Item
  it('clampedText 只取画出来以后的行', () => {
    expect(clampedText(long)).toBe('后面 hit\n后面 hit')
  })
  it('foldedMatches 对 clamped 的条目只数没画的', () => {
    const term = [searchLiteral('hit')]
    expect(foldedMatches([long], term, new Set(), new Set(), new Set(['k1']))).toEqual({
      ids: ['k1'],
      count: 2,
      missing: [],
    })
    expect(foldedMatches([long], term, new Set(), new Set(), new Set()).count).toBe(0)
  })
})

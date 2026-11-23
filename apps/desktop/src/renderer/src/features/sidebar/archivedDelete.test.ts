import { describe, expect, it } from 'vitest'
import { chatFilesSummary, pendingIds } from './archivedDelete'

describe('pendingIds', () => {
  const batch = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C' },
    { id: 'd', title: 'D' },
  ]
  it('只删这批里没删过、现在仍是归档的', () => {
    const state: Record<string, boolean | null> = { a: true, b: false, c: null, d: true }
    expect(pendingIds(batch, new Set(['d']), id => state[id])).toEqual(['a'])
  })
  it('重试时跳过已经删掉的', () => {
    expect(pendingIds(batch, new Set(['a', 'b', 'c']), () => true)).toEqual(['d'])
  })
})

describe('chatFilesSummary', () => {
  const f = (cwd: string, entries: number | null, truncated = false) => ({ cwd, entries, truncated })
  it('合计各文件夹的项数', () => {
    expect(chatFilesSummary([f('/a', 3), f('/b', 2), f('/c', 0)], new Set())).toEqual({ folders: 2, items: '5' })
  })
  it('全都没东西：不说', () => {
    expect(chatFilesSummary([f('/a', 0), f('/b', 0)], new Set())).toBeNull()
  })
  it('有读不出来的：不说', () => {
    expect(chatFilesSummary([f('/a', 3), f('/b', null)], new Set())).toBeNull()
  })
  it('这批以外的对话还在用的文件夹不算', () => {
    expect(chatFilesSummary([f('/a', 3), f('/b', 2)], new Set(['/a']))).toEqual({ folders: 1, items: '2' })
    expect(chatFilesSummary([f('/a', 3)], new Set(['/a']))).toBeNull()
  })
  it('批内两个对话共用一个文件夹只算一次', () => {
    expect(chatFilesSummary([f('/a', 3), f('/a', 3)], new Set())).toEqual({ folders: 1, items: '3' })
  })
  it('列表截断了带 +', () => {
    expect(chatFilesSummary([f('/a', 200, true), f('/b', 1)], new Set())).toEqual({ folders: 2, items: '201+' })
  })
})

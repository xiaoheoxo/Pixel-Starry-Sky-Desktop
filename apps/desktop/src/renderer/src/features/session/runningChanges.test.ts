import { describe, expect, it } from 'vitest'
import type { FileChange, Item } from '@pixelsky/protocol'
import { toBlocks } from './live/changeBlocks'
import { latestFile, runningChanges } from './runningChanges'

type Edit = Extract<Item, { kind: 'file_change' }>
const patch = (path: string, added = 1, removed = 0): FileChange => ({ path, kind: 'update', diff: '', added, removed })
const edit = (id: string, changes: FileChange[], extra: Partial<Edit> = {}): Item => ({
  kind: 'file_change',
  id,
  status: 'completed',
  changes,
  ...extra,
})
const user = (id: string, extra: Partial<Extract<Item, { kind: 'user' }>> = {}): Item => ({
  kind: 'user',
  id,
  text: '继续',
  createdAt: 1,
  ...extra,
})

describe('runningChanges', () => {
  it('只算正在跑的这一轮；插话、断线重连的「继续」不另起一轮', () => {
    const r = runningChanges(
      [
        user('u1'),
        edit('a', [patch('old.ts', 20)]),
        user('u2'),
        edit('b', [patch('src/a.ts', 3, 1)]),
        user('g', { mode: 'guidance' }),
        edit('c', [patch('src/a.ts', 1, 2), patch('b.ts', 5)]),
        user('r', { reconnect: 1 as never }),
        edit('d', [patch('c.ts', 7)]),
      ],
      null,
    )
    expect(r).toMatchObject({ userItemId: 'u2', data: { added: 16, removed: 3 } })
    expect(r?.data.files.map(f => f.dir + f.name)).toEqual(['src/a.ts', 'b.ts', 'c.ts'])
  })

  it('没改完的、失败的、拒绝的不算；这一轮还没改过文件时没有', () => {
    const bad = (['running', 'failed', 'declined', 'interrupted'] as const).map(status =>
      edit(status, [patch(status)], { status }),
    )
    expect(runningChanges([user('u'), ...bad], null)).toBeNull()
    expect(runningChanges([user('u1'), edit('a', [patch('a')]), user('u2')], null)).toBeNull()
    expect(runningChanges([], null)).toBeNull()
  })

  it('子智能体改的按来源分组，同一个文件合计只算一个', () => {
    const r = runningChanges(
      [
        user('u'),
        edit('a', [patch('a.ts', 1)]),
        edit('b', [patch('a.ts', 5)], { subagent: '写测试', subagentCall: 'k1' }),
      ],
      null,
    )
    expect(r?.data.files).toHaveLength(1)
    expect(r?.data.added).toBe(6)
    expect(r?.data.groups?.map(g => [g.label, g.added])).toEqual([
      [null, 1],
      ['写测试', 5],
    ])
  })

  it('刚改完的文件：分组的键和列表一致', () => {
    const items = [user('u'), edit('a', [patch('a.ts')])]
    expect(latestFile(runningChanges(items, null)!)).toBe('main:a.ts')
    const sub = edit('b', [patch('src/b.ts')], { subagent: '写测试', subagentCall: 'k1' })
    const r = runningChanges([...items, sub], null)!
    expect(latestFile(r)).toBe('k1:src/b.ts')
    expect(r.data.groups?.map(g => g.key)).toEqual(['main', 'k1'])
    expect(latestFile(runningChanges([user('u'), edit('c', [patch('c.ts')], { subagent: '旧' })], null)!)).toBe(
      'name:旧:c.ts',
    )
  })

  it('和收尾的改动卡片一致', () => {
    const items = [user('u'), edit('a', [patch('a.ts', 2, 1)]), edit('b', [patch('b.ts', 4)])]
    const card = toBlocks(items, false, new Map()).find(b => b.type === 'changes')
    expect(card?.type === 'changes' && card.data).toEqual(runningChanges(items, null)?.data)
  })

  it('改动没变时沿用上次的结果', () => {
    const items = [user('u'), edit('a', [patch('a.ts')])]
    const first = runningChanges(items, null)
    const text: Item = { kind: 'assistant', id: 't', text: '好', status: 'running' }
    expect(runningChanges([...items, text], first)).toBe(first)
    expect(runningChanges([...items, edit('b', [patch('a.ts')])], first)).not.toBe(first)
    expect(runningChanges([...items, user('u2')], first)).toBeNull()
  })
})

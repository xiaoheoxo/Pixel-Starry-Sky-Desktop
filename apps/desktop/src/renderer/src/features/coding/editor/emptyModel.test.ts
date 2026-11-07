import { describe, expect, it } from 'vitest'
import type { TurnFile } from '../ai/turnChangesModel'
import { emptyTurnSummary } from './emptyModel'

const file = (path: string, kind: TurnFile['kind'] = 'update'): TurnFile => ({
  path,
  name: path.split('/').pop() ?? path,
  dir: '',
  kind,
  added: 1,
  removed: 0,
  diffs: [],
})

describe('emptyTurnSummary', () => {
  it('空和 undefined 都没有第一个', () => {
    expect(emptyTurnSummary(undefined)).toEqual({ count: 0, first: null })
    expect(emptyTurnSummary([])).toEqual({ count: 0, first: null })
  })

  it('第一个的排序同左栏：新增在前，其余按路径', () => {
    const out = emptyTurnSummary([file('b.ts'), file('z.ts', 'add'), file('a.ts')])
    expect(out.count).toBe(3)
    expect(out.first?.path).toBe('z.ts')
  })

  it('不改传入的数组', () => {
    const files = [file('b.ts'), file('a.ts')]
    emptyTurnSummary(files)
    expect(files.map(f => f.path)).toEqual(['b.ts', 'a.ts'])
  })
})

import { describe, expect, it } from 'vitest'
import type { ChannelTask } from '@/data/types'
import { landView } from './taskLand'

const copy = { id: 'c', branch: 'pixelsky/task-ab', path: 'D:/c', baseCommit: 'x', baseBranch: 'main' }
const task = (extra: Partial<ChannelTask>) => ({ status: 'done', copy, ...extra }) as ChannelTask

describe('landView', () => {
  it('做完、有副本：能合并和开 PR；没副本什么都没有', () => {
    expect(landView(task({}), true)).toMatchObject({ canMerge: true, canPr: true, canResolve: false, locked: false })
    expect(landView(task({ copy: null }), true)).toMatchObject({ branch: null, canMerge: false, canPr: false })
  })
  it('冲突只能让成员处理；合并后锁住；不能操作时（只读）都不给', () => {
    expect(landView(task({ land: { kind: 'conflict', files: [], at: 0 } }), true)).toMatchObject({
      canMerge: false,
      canResolve: true,
    })
    expect(
      landView(task({ land: { kind: 'merged', commit: 'd', base: 'main', at: 0 }, copyRemoved: true }), true),
    ).toMatchObject({ canMerge: false, canPr: false, locked: true })
    expect(landView(task({}), false)).toMatchObject({ canMerge: false, canPr: false })
  })
})

import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import type { ChangedFiles } from '@/data'
import {
  applyRecheck,
  fixMessage,
  fixTurnOf,
  newReview,
  previousOf,
  reviewCounts,
  reviewDiff,
  turnChangesOf,
} from './reviewModel'

const finding = (title: string, severity: 'high' | 'medium' | 'low' = 'medium') => ({
  severity,
  file: 'src/a.ts',
  line: 3,
  title,
  detail: '因为 x',
})
const user = (id: string, text: string): Item => ({ kind: 'user', id, text, createdAt: 0 }) as Item
const change = (id: string, path: string): Item =>
  ({
    kind: 'file_change',
    id,
    status: 'completed',
    changes: [{ path, kind: 'update', added: 1, removed: 0, diff: '@@ -1 +1 @@\n-a\n+b' }],
  }) as unknown as Item

describe('审查：拼差异', () => {
  it('按文件拼，带路径和增删；太长时后面的文件不给并注明', () => {
    const data = {
      added: 2,
      removed: 0,
      files: [
        { dir: 'src/', name: 'a.ts', added: 1, removed: 0, diffs: ['+x'] },
        { dir: 'src/', name: 'b.ts', added: 1, removed: 0, diffs: ['+' + 'y'.repeat(2000)] },
      ],
    } satisfies ChangedFiles
    expect(reviewDiff(data)).toContain('=== src/a.ts (+1 -0)\n+x')
    const cut = reviewDiff(data, 1000)
    expect(cut).toContain('src/a.ts')
    expect(cut).toContain('1 more file(s) not shown: src/b.ts')
    expect(cut.length).toBeLessThanOrEqual(1000)
  })
  it('只有一个大文件：给它的前一段，不是什么都不给', () => {
    const big = {
      added: 1,
      removed: 0,
      files: [{ dir: 'src/', name: 'big.ts', added: 1, removed: 0, diffs: ['+' + 'z'.repeat(9000)] }],
    } satisfies ChangedFiles
    const cut = reviewDiff(big, 5000)
    expect(cut).toContain('=== src/big.ts (+1 -0)\n+zzz')
    expect(cut).toContain('rest of this file’s diff not shown')
    expect(cut.length).toBeLessThanOrEqual(5000)
  })
})

describe('审查：发给 AI 的修复消息', () => {
  it('一条：带位置、问题和细节，允许 AI 说明不是问题', () => {
    const text = fixMessage([finding('空指针')])
    expect(text).toContain('src/a.ts:3 空指针')
    expect(text).toContain('因为 x')
    expect(text).toContain('不要硬改')
  })
  it('多条：编号', () => {
    expect(fixMessage([finding('一'), finding('二')])).toContain('2. src/a.ts:3 二')
  })
})

describe('审查：复审', () => {
  it('只带没处理的条目，按顺序编号；resolved 的划掉、新问题标「复审发现」，之后不再自动复审', () => {
    let review = newReview([finding('一', 'high'), finding('二'), finding('三')], { at: 1, model: 'm', files: 1 })
    review = { ...review, items: review.items.map((i, k) => (k === 1 ? { ...i, status: 'ignored' } : i)) }
    const { previous, ids } = previousOf(review)
    expect(previous.map(p => [p.n, p.title])).toEqual([
      [1, '一'],
      [2, '三'],
    ])
    const next = applyRecheck({ ...review, fix: { text: 't', ids } }, ids, [2], [finding('四')])
    expect(next.items.map(i => [i.title, i.status, !!i.recheck])).toEqual([
      ['一', 'open', false],
      ['二', 'ignored', false],
      ['三', 'fixed', false],
      ['四', 'open', true],
    ])
    expect(next.rechecked).toBe(true)
    expect(next.fix).toBeNull()
    expect(reviewCounts(next)).toEqual({ open: 2, high: 1, ignored: 1 })
  })
})

describe('审查：找修的那一轮', () => {
  const items = [user('u1', '改按钮'), change('c1', 'a.ts'), user('u2', '修一下'), change('c2', 'b.ts')]
  it('原来那一轮之后、原文一样的 user 条目；那一轮结束了才算', () => {
    expect(fixTurnOf(items, 'u1', '修一下', false)).toEqual({ turnKey: 'u2' })
    expect(fixTurnOf(items, 'u1', '修一下', true)).toBeNull()
    expect(fixTurnOf([...items, user('u3', '再说')], 'u1', '修一下', true)).toEqual({ turnKey: 'u2' })
    expect(fixTurnOf(items, 'u1', '没发出去的', false)).toBeNull()
    expect(fixTurnOf(items, 'u2', '改按钮', false)).toBeNull()
  })
  it('某一轮的改动：只算这一轮已完成的', () => {
    expect(turnChangesOf(items, 'u2')?.files.map(f => f.name)).toEqual(['b.ts'])
    expect(turnChangesOf(items, 'nope')).toBeNull()
  })
})

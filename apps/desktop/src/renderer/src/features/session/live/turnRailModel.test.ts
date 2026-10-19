import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import {
  clampIndex,
  currentTurn,
  placeTicks,
  reuseTurns,
  sameMeasured,
  thumbOf,
  tickAt,
  topsFor,
  turnsOf,
} from './turnRailModel'

const user = (id: string, text: string, mode?: 'guidance'): Item => ({ kind: 'user', id, text, createdAt: 0, mode })

describe('轮次跳转条', () => {
  it('每条我方消息一轮，引导消息不算；预览取第一行，太长截断', () => {
    const turns = turnsOf([
      user('a', '  第一句\n第二行'),
      { kind: 'assistant', id: 'x', text: '好', status: 'completed' } as Item,
      user('g', '插话', 'guidance'),
      user('b', '长'.repeat(70)),
    ])
    expect(turns.map(t => [t.id, t.n])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    expect(turns[0].preview).toBe('第一句')
    expect(turns[1].preview).toBe(`${'长'.repeat(60)}…`)
  })

  it('断线后自动发的「继续」不算一轮', () => {
    const resume = { ...user('r', '继续'), reconnect: 1 } as Item
    expect(turnsOf([user('a', '第一句'), resume, user('b', '第二句')]).map(t => [t.id, t.n])).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })

  it('刻度画在实际位置上（内容位置 / 总高 × 滑轨高）；挨太近的合并，当前轮所在的那个高亮', () => {
    // 内容 2000px，滑轨 200px：每 10px 内容 = 1px 滑轨
    expect(placeTicks([0, 500, 1990], 2000, 200, 1)).toEqual([
      { index: 0, count: 1, y: 0, current: false },
      { index: 1, count: 1, y: 50, current: true },
      { index: 2, count: 1, y: 199, current: false },
    ])
    const merged = placeTicks([0, 10, 20, 400], 2000, 200, 2)
    expect(merged.map(t => [t.index, t.count, t.current])).toEqual([
      [0, 3, true],
      [3, 1, false],
    ])
    // 还没排版出来的行（量不到位置）跳过
    expect(placeTicks([0, Number.POSITIVE_INFINITY], 2000, 200, 0)).toHaveLength(1)
    expect(placeTicks([0], 0, 200, 0)).toEqual([])
  })

  it('滑块按看得到的比例；最矮 24px，被撑长时不出滑轨；内容放得下时没有滑块', () => {
    expect(thumbOf(0, 500, 2000, 200)).toEqual({ top: 0, height: 50 })
    expect(thumbOf(1000, 500, 2000, 200)).toEqual({ top: 100, height: 50 })
    expect(thumbOf(99_000, 500, 100_000, 200)).toEqual({ top: 176, height: 24 })
    expect(thumbOf(0, 500, 500, 200)).toBeNull()
  })

  it('点滑轨：离刻度 6px 以内对齐到那一轮，取最近的；远了按位置滚', () => {
    const ticks = placeTicks([0, 500, 600], 2000, 200, 0)
    expect(tickAt(ticks, 53)?.index).toBe(1)
    expect(tickAt(ticks, 58)?.index).toBe(2)
    expect(tickAt(ticks, 120)).toBeNull()
  })

  it('当前轮：滚过视口顶部的最后一轮', () => {
    expect(currentTurn([0, 500, 1200], 0)).toBe(0)
    expect(currentTurn([0, 500, 1200], 480)).toBe(1)
    expect(currentTurn([0, 500, 1200], 2000)).toBe(2)
    expect(currentTurn([100, 500], 0)).toBe(0)
  })
})

describe('回退后轮次变少', () => {
  it('topsFor 按 id 对回当前的轮：旧位置比 turns 长时只留在范围内的刻度', () => {
    const measured = { ids: ['a', 'b', 'c', 'd'], tops: [0, 100, 200, 300] }
    const turns = [{ id: 'a' }, { id: 'b' }]
    const tops = topsFor(turns, measured)
    expect(tops).toEqual([0, 100])
    const ticks = placeTicks(tops, 1000, 100, 0)
    expect(ticks.every(t => t.index < turns.length)).toBe(true)
  })

  it('同样长度但 id 变了：对不上的轮不画刻度', () => {
    const tops = topsFor([{ id: 'a' }, { id: 'x' }], { ids: ['a', 'b'], tops: [0, 100] })
    expect(tops).toEqual([0, Number.POSITIVE_INFINITY])
    expect(placeTicks(tops, 1000, 100, 0)).toHaveLength(1)
  })

  it('clampIndex 夹进 [0, length-1]', () => {
    expect(clampIndex(5, 3)).toBe(2)
    expect(clampIndex(-1, 3)).toBe(0)
    expect(clampIndex(1, 3)).toBe(1)
    expect(clampIndex(4, 0)).toBe(0)
    expect(clampIndex(Number.NaN, 3)).toBe(0)
  })
})

describe('轮次列表沿用旧引用', () => {
  const turn = (id: string, n: number, preview = id) => ({ id, n, preview })

  it('id、n、preview 都没变就返回上一份', () => {
    const prev = [turn('a', 1), turn('b', 2)]
    expect(reuseTurns(prev, [turn('a', 1), turn('b', 2)])).toBe(prev)
    expect(reuseTurns([], [])).toEqual([])
  })

  it('多一轮、少一轮、n 变了（上面多显示了几轮）、预览变了都用新的', () => {
    const prev = [turn('a', 1), turn('b', 2)]
    const more = [turn('a', 1), turn('b', 2), turn('c', 3)]
    expect(reuseTurns(prev, more)).toBe(more)
    const fewer = [turn('a', 1)]
    expect(reuseTurns(prev, fewer)).toBe(fewer)
    const shifted = [turn('a', 11), turn('b', 12)]
    expect(reuseTurns(prev, shifted)).toBe(shifted)
    const edited = [turn('a', 1), turn('b', 2, '改了')]
    expect(reuseTurns(prev, edited)).toBe(edited)
  })
})

describe('量到的位置比较', () => {
  it('逐项相同（含 Infinity）才算一样', () => {
    const a = { ids: ['a', 'b'], tops: [0, Number.POSITIVE_INFINITY] }
    expect(sameMeasured(a, { ids: ['a', 'b'], tops: [0, Number.POSITIVE_INFINITY] })).toBe(true)
    expect(sameMeasured(a, { ids: ['a', 'b'], tops: [0, 10] })).toBe(false)
    expect(sameMeasured(a, { ids: ['a', 'c'], tops: [0, Number.POSITIVE_INFINITY] })).toBe(false)
    expect(sameMeasured(a, { ids: ['a'], tops: [0] })).toBe(false)
    expect(sameMeasured({ ids: [], tops: [] }, { ids: [], tops: [] })).toBe(true)
  })
})

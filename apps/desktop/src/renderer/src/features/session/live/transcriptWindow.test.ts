import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import { turnsOf } from './turnRailModel'
import {
  hiddenCount,
  initialHidden,
  reclaimHidden,
  revealEarlier,
  revealFor,
  startIndex,
  turnStarts,
} from './transcriptWindow'

const user = (id: string, mode?: 'guidance'): Item => ({ kind: 'user', id, text: id, createdAt: 0, mode })
const reply = (id: string): Item => ({ kind: 'assistant', id, text: id, status: 'completed' }) as Item

/** n 轮：每轮一条用户消息 + 一条回复 */
const conversation = (n: number): Item[] => Array.from({ length: n }, (_, i) => [user(`u${i}`), reply(`a${i}`)]).flat()

describe('长对话窗口', () => {
  it('轮次定义和轮次跳转条一致：引导消息不算', () => {
    const items = [reply('pre'), user('u0'), user('g', 'guidance'), reply('a0'), user('u1'), reply('a1')]
    expect(turnStarts(items)).toEqual([1, 4])
    expect(turnStarts(items)).toHaveLength(turnsOf(items).length)
  })

  it('不到 设置的轮数 + 10 轮不折叠，刚好到了就折叠', () => {
    expect(initialHidden(29, 20)).toBe(0)
    expect(initialHidden(30, 20)).toBe(10)
    expect(initialHidden(120, 20)).toBe(100)
    expect(initialHidden(59, 50)).toBe(0)
    expect(initialHidden(60, 50)).toBe(10)
  })

  it('设置为「全部」时从不折叠', () => {
    expect(initialHidden(500, null)).toBe(0)
  })

  it('从隐藏后的第一轮的用户消息开始渲染', () => {
    const items = conversation(40)
    const starts = turnStarts(items)
    expect(startIndex(starts, 0)).toBe(0)
    expect(startIndex(starts, 20)).toBe(40)
    expect(items[startIndex(starts, 20)].id).toBe('u20')
    // 超出时至少留最后一轮
    expect(items[startIndex(starts, 99)].id).toBe('u39')
    expect(hiddenCount(40, 99)).toBe(39)
    expect(hiddenCount(40, 20)).toBe(20)
    expect(startIndex([], 5)).toBe(0)
  })

  it('新的轮次往后加时隐藏的轮数不变，已经显示的不会再藏回去', () => {
    const before = conversation(40)
    const hidden = initialHidden(before.length / 2, 20)
    const after = [...before, user('u40'), reply('a40')]
    expect(items(after, hidden)).toHaveLength(items(before, hidden).length + 2)
    expect(items(after, hidden)[0].id).toBe('u20')
  })

  it('显示更早的若干轮 / 全部', () => {
    expect(revealEarlier(100, 20)).toBe(80)
    expect(revealEarlier(15, 20)).toBe(0)
    expect(revealEarlier(100, null)).toBe(0)
  })

  it('要显示隐藏部分里的条目：从它所在那一轮的开头显示', () => {
    const list = [reply('pre'), ...conversation(40)]
    const starts = turnStarts(list)
    // 隐藏 30 轮时，第 3 轮（下标 2）的回复在隐藏部分
    expect(revealFor(list, starts, 30, 'a2')).toBe(2)
    expect(revealFor(list, starts, 30, 'u2')).toBe(2)
    // 第一条用户消息之前的条目：全部显示
    expect(revealFor(list, starts, 30, 'pre')).toBe(0)
    // 已经显示的、不存在的、没折叠的：不变
    expect(revealFor(list, starts, 30, 'a35')).toBe(30)
    expect(revealFor(list, starts, 30, 'nope')).toBe(30)
    expect(revealFor(list, starts, 0, 'a2')).toBe(0)
    // 刚好是窗口里的第一轮：已经显示
    expect(revealFor(list, starts, 30, 'u30')).toBe(30)
  })

  it('新一轮开始、显示的轮数攒到 size + 10 以上时收回到只显示 size 轮', () => {
    // 打开时隐藏 10 轮（共 30，显示 20）；又来了 10 轮，共 40，显示 30 = size + 10：收回
    expect(reclaimHidden(40, 10, 20)).toBe(20)
    // 点过「显示全部」后（hidden 0）也一样
    expect(reclaimHidden(120, 0, 20)).toBe(100)
    // 还没攒够：显示 29 轮
    expect(reclaimHidden(39, 10, 20)).toBeNull()
    // 本来就没折叠的短对话、设置为「全部」：不动
    expect(reclaimHidden(25, 0, 20)).toBeNull()
    expect(reclaimHidden(120, 0, null)).toBeNull()
    // 已经藏得不比目标少：不动，也绝不往回放
    expect(reclaimHidden(120, 100, 20)).toBeNull()
    expect(reclaimHidden(120, 110, 20)).toBeNull()
  })

  it('引导消息属于它前面那一轮', () => {
    const list = [user('u0'), reply('a0'), user('u1'), user('g', 'guidance'), reply('a1'), user('u2'), reply('a2')]
    expect(revealFor(list, turnStarts(list), 2, 'g')).toBe(1)
  })
})

function items(list: Item[], hidden: number): Item[] {
  return list.slice(startIndex(turnStarts(list), hidden))
}

import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import {
  CLAMP_DRAWN_LINES,
  clampLines,
  clampedRest,
  failedItems,
  nextViewMode,
  overClamp,
  parseViewMode,
  streamChunks,
} from './viewModeModel'

const tool = (id: string, status = 'completed', extra: object = {}): Item =>
  ({ id, kind: 'tool', tool: 'read', name: 'Read', title: id, output: '', status, ...extra }) as unknown as Item

describe('查看模式', () => {
  it('读取：坏值回到普通；循环 普通 → 聊天 → 详细；旧值 thinking 按聊天读 → 普通', () => {
    expect(parseViewMode('detailed')).toBe('detailed')
    expect(parseViewMode('verbose')).toBe('normal')
    expect(parseViewMode(null)).toBe('normal')
    expect(parseViewMode('thinking')).toBe('chat')
    expect(nextViewMode('normal')).toBe('chat')
    expect(nextViewMode('chat')).toBe('detailed')
    expect(nextViewMode('detailed')).toBe('normal')
  })

  it('失败项：被自动审核拦下、审查超时的不算', () => {
    const items = [
      tool('ok'),
      tool('bad', 'failed'),
      tool('denied', 'failed', { review: { status: 'denied' } }),
      tool('slow', 'failed', { review: { status: 'timedOut' } }),
    ]
    expect(failedItems(items).map(i => i.id)).toEqual(['bad'])
  })

  it('限高：满 12 个换行才算超过，不把整段切开', () => {
    expect(overClamp('a\n'.repeat(11))).toBe(false)
    expect(overClamp('a\n'.repeat(12))).toBe(true)
    expect(overClamp('x'.repeat(5000))).toBe(false)
  })
})

describe('限高只画前几行（§13 A）', () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i}`).join('\n')
  it('超过 CLAMP_DRAWN_LINES 行：画的和没画的拼起来是原文', () => {
    const text = lines(CLAMP_DRAWN_LINES + 5)
    expect(clampLines(text).split('\n')).toHaveLength(CLAMP_DRAWN_LINES)
    expect(clampedRest(text).split('\n')).toHaveLength(5)
    expect(`${clampLines(text)}\n${clampedRest(text)}`).toBe(text)
  })
  it('不到这么多行：全画，没剩下的', () => {
    expect(clampLines(lines(3))).toBe(lines(3))
    expect(clampedRest(lines(3))).toBe('')
    expect(clampedRest(lines(CLAMP_DRAWN_LINES))).toBe('')
  })
})

describe('流式思考分块（§13 C）', () => {
  it('16 行一块，换行拼回原文；前面的块不随新文字变', () => {
    const text = Array.from({ length: 40 }, (_, i) => `t${i}`).join('\n')
    const chunks = streamChunks(text)
    expect(chunks).toHaveLength(3)
    expect(chunks.join('\n')).toBe(text)
    expect(streamChunks(text + '更多').slice(0, 2)).toEqual(chunks.slice(0, 2))
  })
  it('短文字一块；空串没有块', () => {
    expect(streamChunks('一行')).toEqual(['一行'])
    expect(streamChunks('')).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import { foldBlocks, foldPoint, type FoldEntry } from './autoFold'
import type { Block } from './changeBlocks'

const user = (id: string, extra: object = {}): Item => ({ kind: 'user', id, text: id, createdAt: 0, ...extra }) as Item
const stats = (id: string, durationMs: number): Item =>
  ({ kind: 'turn_stats', id, usage: { durationMs } }) as unknown as Item
const pill = (id: string, status = 'completed'): Item => ({ kind: 'compaction', id, status }) as Item
const blocks = (items: Item[]): Block[] => items.map(item => ({ type: 'item', item }))

const shape = (entries: FoldEntry[]) =>
  entries.map(e =>
    e.type === 'fold' ? `${e.kind}:${e.turns.map(t => t.id).join()}` : (e.block as { item: Item }).item.id,
  )

describe('foldPoint', () => {
  it('不到 3 轮不收；断线重连的「继续」、引导不算一轮', () => {
    expect(foldPoint([user('a'), user('b')]).before).toBeNull()
    expect(
      foldPoint([user('a'), user('r', { reconnect: 1 }), user('g', { mode: 'guidance' }), user('b')]).before,
    ).toBeNull()
    expect(foldPoint([user('a'), user('b'), user('c')]).before).toBe('b')
  })
  it('只认压缩完成的，失败、进行中的不算', () => {
    expect(foldPoint([user('a'), pill('p', 'failed'), pill('q', 'running')]).compaction).toBeNull()
    expect(foldPoint([pill('p'), pill('q'), pill('x', 'failed')]).compaction).toBe('q')
  })
})

describe('foldBlocks', () => {
  const NONE = { before: null, compaction: null }

  it('没有收起点：全部照常', () => {
    expect(shape(foldBlocks(blocks([user('a'), user('b')]), NONE))).toEqual(['a', 'b'])
  })

  it('B：只留最近几轮，更早的合成一行并累计用时', () => {
    const entries = foldBlocks(
      blocks([user('a'), stats('s1', 100), user('b'), stats('s2', 50), user('c'), user('d')]),
      {
        before: 'c',
        compaction: null,
      },
    )
    expect(shape(entries)).toEqual(['older:a,b', 'c', 'd'])
    expect(entries[0]).toMatchObject({ durationMs: 150 })
  })

  it('C：压缩在最近几轮的那一轮中间：只收这一轮之前的，这一轮留着', () => {
    const list = blocks([user('a'), user('b'), user('c'), pill('p'), user('d')])
    expect(shape(foldBlocks(list, { before: 'c', compaction: 'p' }))).toEqual(['compacted:a,b', 'c', 'p', 'd'])
  })

  it('C 覆盖 B：压缩在最后一轮时，前面一轮也算压缩前', () => {
    const list = blocks([user('a'), user('b'), user('c'), pill('p')])
    expect(shape(foldBlocks(list, { before: 'b', compaction: 'p' }))).toEqual(['compacted:a,b', 'c', 'p'])
  })

  it('线下重新数：压缩比最近几轮还早时分成两行，分隔线留在中间', () => {
    const list = blocks([user('a'), pill('p'), user('b'), user('c'), user('d')])
    expect(shape(foldBlocks(list, { before: 'c', compaction: 'p' }))).toEqual(['compacted:a', 'p', 'older:b', 'c', 'd'])
  })

  it('记下的条目已经不在了（回退过）：当没有', () => {
    expect(shape(foldBlocks(blocks([user('a'), user('b')]), { before: 'x', compaction: 'y' }))).toEqual(['a', 'b'])
  })
})

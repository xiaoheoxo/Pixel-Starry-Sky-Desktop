import { describe, expect, it } from 'vitest'
import { MAX_FILE_COUNT, validateFiles, type FileAttachment } from '@pixelsky/protocol'
import { fitAttachments } from './fit'

const file = (id: string): FileAttachment => ({
  id,
  name: `${id}.txt`,
  bytes: 1,
  lines: 1,
  encoding: 'utf-8',
  text: 'x',
})

describe('fitAttachments', () => {
  it('放得下的放回，超了数量上限的单独列出来，不整批丢掉', () => {
    const current = Array.from({ length: MAX_FILE_COUNT - 2 }, (_, i) => file(`c${i}`))
    const fit = fitAttachments(current, [file('a'), file('b'), file('c')], validateFiles)
    expect(fit.items.map(f => f.id)).toEqual([...current.map(f => f.id), 'a', 'b'])
    expect(fit.added.map(f => f.id)).toEqual(['a', 'b'])
    expect(fit.dropped.map(f => f.id)).toEqual(['c'])
  })
  it('输入框里已经有的不重复加，也不算放不下', () => {
    const fit = fitAttachments([file('a')], [file('a'), file('b')], validateFiles)
    expect(fit.items.map(f => f.id)).toEqual(['a', 'b'])
    expect(fit.added.map(f => f.id)).toEqual(['b'])
    expect(fit.dropped).toEqual([])
  })
  it('一个超了大小上限后，后面更小的还能放进去', () => {
    const limit = (value: unknown) => {
      const list = value as { id: string; size: number }[]
      if (list.reduce((sum, item) => sum + item.size, 0) > 10) throw new Error('too large')
      return list
    }
    const fit = fitAttachments(
      [{ id: 'a', size: 4 }],
      [
        { id: 'b', size: 8 },
        { id: 'c', size: 5 },
      ],
      limit,
    )
    expect(fit.added.map(i => i.id)).toEqual(['c'])
    expect(fit.dropped.map(i => i.id)).toEqual(['b'])
  })
})

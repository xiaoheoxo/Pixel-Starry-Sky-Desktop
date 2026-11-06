import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import { planSections } from './planStages'

const cmd = (id: string, status = 'completed'): Item => ({ kind: 'command', id, command: id, status }) as Item
const todo = (marks: { step: string | null; afterItemId: string | null }[], done: string[] = []): Item =>
  ({
    kind: 'todo',
    id: 'plan',
    status: 'running',
    steps: ['查', '改', '测'].map(text => ({ text, status: done.includes(text) ? 'completed' : 'pending' })),
    stepMarks: marks,
  }) as Item

const shape = (items: Item[], running = false) =>
  planSections(items, running)?.map(s => [
    s.type === 'stage' ? s.step : 'loose',
    s.items.map(i => i.id).join(),
    s.type === 'stage' && s.done,
    s.type === 'stage' && s.active,
  ])

describe('planSections', () => {
  it('按进行中的那一步分段：锚点在块外（用户消息）的第一笔从块开头算', () => {
    const marks = [
      { step: '查', afterItemId: 'u1' },
      { step: '改', afterItemId: 'b' },
      { step: '测', afterItemId: 'c' },
    ]
    expect(shape([todo(marks, ['查', '改']), cmd('a'), cmd('b'), cmd('c'), cmd('d')], true)).toEqual([
      ['查', 'a,b', true, false],
      ['改', 'c', true, false],
      ['测', 'd', false, true],
    ])
  })

  it('写计划之前、全部做完之后的条目不算进任何一步', () => {
    const marks = [
      { step: '查', afterItemId: 'p' },
      { step: '改', afterItemId: 'a' },
      { step: null, afterItemId: 'b' },
    ]
    expect(shape([cmd('p'), todo(marks, ['查', '改']), cmd('a'), cmd('b'), cmd('z')])).toEqual([
      ['loose', 'p', false, false],
      ['查', 'a', true, false],
      ['改', 'b', true, false],
      ['loose', 'z', false, false],
    ])
  })

  it('一口气标完、中间没干活的步骤不占一段', () => {
    const marks = [
      { step: '查', afterItemId: null },
      { step: '改', afterItemId: 'a' },
      { step: '测', afterItemId: 'a' },
    ]
    expect(shape([todo(marks), cmd('a'), cmd('b')])).toEqual([
      ['查', 'a', false, false],
      ['测', 'b', false, false],
    ])
  })

  it('不到两步、没有记录、锚点都在后面的块：不分段', () => {
    expect(planSections([todo([{ step: '查', afterItemId: null }]), cmd('a'), cmd('b')], false)).toBeNull()
    expect(planSections([cmd('a'), cmd('b')], false)).toBeNull()
    const later = [
      { step: '查', afterItemId: null },
      { step: '改', afterItemId: 'later' },
    ]
    expect(planSections([todo(later), cmd('a')], false)).toBeNull()
  })

  it('只有隐藏思考的一段不算一步，也不占一行', () => {
    const blank = { kind: 'reasoning', id: 'r', text: '', status: 'completed' } as Item
    const marks = [
      { step: '查', afterItemId: 'u' },
      { step: '改', afterItemId: 'r' },
      { step: '测', afterItemId: 'a' },
    ]
    expect(shape([todo(marks), blank, cmd('a'), cmd('b')])).toEqual([
      ['改', 'a', false, false],
      ['测', 'b', false, false],
    ])
  })

  it('清单改过、步骤不在清单里了：还是一段，没有序号', () => {
    const marks = [
      { step: '旧的一步', afterItemId: null },
      { step: '改', afterItemId: 'a' },
    ]
    const sections = planSections([todo(marks), cmd('a'), cmd('b')], false)
    expect(sections?.[0]).toMatchObject({ type: 'stage', n: null, step: '旧的一步', done: false })
    expect(sections?.[1]).toMatchObject({ type: 'stage', n: 2, step: '改' })
  })
})

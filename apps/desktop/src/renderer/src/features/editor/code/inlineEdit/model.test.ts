import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { changeSummary, contextAround, demoResult, inlineTarget, inlineTooLarge, segmentHunks } from './model'

const doc = (s: string) => Text.of(s.split('\n'))
const SRC = [
  'import x from "x"',
  'export function markAllRead(list) {',
  '  const out = []',
  '  for (const t of list) out.push(t)',
  '  return out',
  '}',
  'const y = 1',
].join('\n')
const slice = (d: Text, t: { from: number; to: number }) => d.sliceString(t.from, t.to)

describe('inlineTarget', () => {
  const d = doc(SRC)
  it('有选区：扩成整行；拖到下一行行首时那行不算', () => {
    const from = d.line(3).from + 4,
      to = d.line(5).from
    expect(slice(d, inlineTarget(d, from, to, 'a.ts'))).toBe('  const out = []\n  for (const t of list) out.push(t)')
  })
  it('没选区：光标所在的声明', () => {
    const t = inlineTarget(d, d.line(4).from + 2, d.line(4).from + 2, 'a.ts')
    expect(slice(d, t)).toBe(SRC.split('\n').slice(1, 6).join('\n'))
  })
  it('不在声明里、或语言不认识：光标所在行', () => {
    const at = d.line(7).from
    expect(slice(d, inlineTarget(d, at, at, 'a.ts'))).toBe('const y = 1')
    const inside = d.line(4).from
    expect(slice(d, inlineTarget(d, inside, inside, 'a.txt'))).toBe('  for (const t of list) out.push(t)')
  })
})

describe('inlineTooLarge / contextAround', () => {
  it('超过 400 行或 40 KB 算太多', () => {
    expect(inlineTooLarge(Array(400).fill('a').join('\n'))).toBe(false)
    expect(inlineTooLarge(Array(401).fill('a').join('\n'))).toBe(true)
    expect(inlineTooLarge('a'.repeat(40_001))).toBe(true)
  })
  it('前后各最多 60 行，不含选区本身和相邻的换行', () => {
    const d = doc(SRC)
    expect(contextAround(d, { from: d.line(3).from, to: d.line(5).to })).toEqual({
      before: SRC.split('\n').slice(0, 2).join('\n'),
      after: '}\nconst y = 1',
    })
    expect(contextAround(d, { from: 0, to: d.length })).toEqual({ before: '', after: '' })
    const long = doc(Array.from({ length: 200 }, (_, i) => `l${i + 1}`).join('\n'))
    const ctx = contextAround(long, { from: long.line(100).from, to: long.line(100).to })
    expect(ctx.before.split('\n')).toHaveLength(60)
    expect(ctx.before.startsWith('l40\n')).toBe(true)
    expect(ctx.after.split('\n')).toHaveLength(60)
    expect(ctx.after.endsWith('\nl160')).toBe(true)
  })
})

describe('segmentHunks', () => {
  const original = '  const out = []\n  for (const t of list) out.push(t)\n  return out'
  const current = '  return list.map(t => t)'
  it('坐标换成全文的；撤销后回到原文', () => {
    const offset = 50
    const full = 'x'.repeat(offset) + current + '\n}'
    const hunks = segmentHunks(original, current, offset, [])
    expect(hunks).toHaveLength(1)
    const h = hunks[0]
    expect(full.slice(h.fromB, h.toB)).toBe(current)
    const undone = full.slice(0, h.undoFrom) + h.undoInsert + full.slice(h.undoTo)
    expect(undone).toBe('x'.repeat(offset) + original + '\n}')
    expect(changeSummary(hunks)).toEqual({ count: 1, removed: 3, added: 1 })
  })
  it('保留过的块不再显示；没变时没有块', () => {
    const key = segmentHunks(original, current, 0, [])[0].key
    expect(segmentHunks(original, current, 0, [key])).toEqual([])
    expect(segmentHunks(original, original, 0, [])).toEqual([])
  })
  it('原文是空行：撤销整段新增回到空行', () => {
    const hunks = segmentHunks('', 'a\nb', 0, [])
    let text = 'a\nb'
    for (const h of [...hunks].reverse()) text = text.slice(0, h.undoFrom) + h.undoInsert + text.slice(h.undoTo)
    expect(text).toBe('')
  })
})

describe('demoResult', () => {
  it('按首行缩进加一行注释', () => {
    expect(demoResult('  a\n  b\n', '示例')).toBe('  // 示例\n  a\n  b')
  })
})

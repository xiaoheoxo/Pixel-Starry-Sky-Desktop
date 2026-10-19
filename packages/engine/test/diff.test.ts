import { describe, expect, it } from 'vitest'
import { diffFromHunks, diffLines, diffText } from '../src/diff'

describe('diff', () => {
  it('逐行比对：保留上下文，统计增删', () => {
    const r = diffText('a\nb\nc\n', 'a\nB\nc\nd\n')
    expect(r.diff).toBe(' a\n-b\n+B\n c\n+d')
    expect(r).toMatchObject({ added: 2, removed: 1 })
  })

  it('Windows 换行和末尾空行不算改动', () => {
    expect(diffText('x\r\ny\r\n', 'x\ny').diff).toBe(' x\n y')
  })

  it('structuredPatch 转成带 @@ 的 diff', () => {
    const r = diffFromHunks([{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' keep', '-old', '+new'] }])
    expect(r.diff).toBe('@@ -3,2 +3,2 @@\n keep\n-old\n+new')
    expect(r).toMatchObject({ added: 1, removed: 1 })
  })
})

describe('diff 大文件', () => {
  const lines = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i}`)
  const run = (a: string[], b: string[]) => diffText(a.join('\n'), b.join('\n'))

  it('5000 行只改一行：+1 -1，很快', () => {
    const a = lines(5000)
    const b = [...a]
    b[2500] = 'changed'
    const t = Date.now()
    const r = run(a, b)
    expect(Date.now() - t).toBeLessThan(1000)
    expect(r).toMatchObject({ added: 1, removed: 1 })
    expect(r.diff.split('\n')).toHaveLength(5001)
  })

  it('相同文件没有增删', () => {
    const a = lines(3000)
    expect(run(a, a)).toMatchObject({ added: 0, removed: 0 })
  })

  it('开头和结尾插入', () => {
    const a = lines(3000)
    expect(run(a, ['top', ...a, 'bottom'])).toMatchObject({ added: 2, removed: 0 })
  })

  it('中间多处改动超过动态规划上限，走 Myers 且结果自洽', () => {
    const a = lines(4000)
    const b = a.filter((_, i) => i % 50 !== 7)
    for (let i = 100; i < 4000; i += 97) b.splice(i % b.length, 0, `new ${i}`)
    const r = diffLines(a, b)
    expect(r.filter(([t]) => t !== '+').map(([, l]) => l)).toEqual(a)
    expect(r.filter(([t]) => t !== '-').map(([, l]) => l)).toEqual(b)
    // 最小编辑：删 80 行、加的行数 = b 比保留部分多出来的
    const removed = r.filter(([t]) => t === '-').length
    expect(removed).toBe(80)
  })

  it('完全不同的两个大文件：结果仍然能还原两边', () => {
    const a = lines(2000)
    const b = a.map(l => `x${l}`)
    const r = diffLines(a, b)
    expect(r.filter(([t]) => t !== '+').map(([, l]) => l)).toEqual(a)
    expect(r.filter(([t]) => t !== '-').map(([, l]) => l)).toEqual(b)
  })

  it('大文件的 Windows 换行一样处理', () => {
    const a = lines(3000)
    const b = [...a]
    b[10] = 'z'
    expect(diffText(a.join('\r\n'), b.join('\n'))).toMatchObject({ added: 1, removed: 1 })
  })

  it('改动超过 4000 处（Myers 追不完）：中间整段删再整段加，仍能还原两边', () => {
    // 两边每行都不同、长度相同，不会触发长度差捷径
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`)
    const r = diffLines(['head', ...a, 'tail'], ['head', ...b, 'tail'])
    expect(r[0]).toEqual([' ', 'head'])
    expect(r[r.length - 1]).toEqual([' ', 'tail'])
    expect(r.filter(([t]) => t === '-')).toHaveLength(3000)
    expect(r.filter(([t]) => t === '+')).toHaveLength(3000)
    // 回退路径：先全部删再全部加
    expect(r.slice(1, 3001).every(([t]) => t === '-')).toBe(true)
    expect(r.slice(3001, 6001).every(([t]) => t === '+')).toBe(true)
  })

  it('两段长度之差超过 4000：直接整段删加（有公共行也不再对齐）', () => {
    const a = Array.from({ length: 1000 }, (_, i) => `x${i}`)
    const b = Array.from({ length: 5500 }, (_, i) => `x${i * 5 + 1}`) // 1000 × 5500 > 2,000,000，会走 Myers 分支
    const r = diffLines(a, b)
    expect(r.filter(([t]) => t !== '+').map(([, l]) => l)).toEqual(a)
    expect(r.filter(([t]) => t !== '-').map(([, l]) => l)).toEqual(b)
    expect(r.some(([t]) => t === ' ')).toBe(false)
  })
})

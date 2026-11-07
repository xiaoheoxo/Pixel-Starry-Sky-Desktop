import { describe, expect, it } from 'vitest'
import {
  changedRows,
  compactBlock,
  contextNumber,
  contextPercentage,
  contextSegments,
  diagnosticValues,
  spinRemaining,
} from './contextData'
import type { ContextDiagnostic, ContextWindow } from '@pixelsky/protocol'
const base: ContextWindow = {
  model: 'main',
  used: 160000,
  window: 200000,
  input: 10000,
  cacheRead: 140000,
  cacheWrite: 10000,
  output: 5000,
  observedAt: 1,
  source: 'request',
  stale: false,
  compacting: false,
  diagnostic: null,
  diagnosticStale: false,
}
describe('compactBlock', () => {
  const idle = { state: 'idle', queue: [], flags: { compactAvailable: true } } as unknown as Parameters<
    typeof compactBlock
  >[0]
  it('空闲、没排队、引擎支持才能压', () => {
    expect(compactBlock(idle)).toBeNull()
  })
  it('运行中、有排队、快照还没到：等', () => {
    expect(compactBlock({ ...idle!, state: 'running' })).toBe('busy')
    expect(compactBlock({ ...idle!, queue: [{}] as never })).toBe('busy')
    expect(compactBlock(null)).toBe('busy')
  })
  it('引擎不支持', () => {
    expect(compactBlock({ ...idle!, flags: { compactAvailable: false } as never })).toBe('unsupported')
  })
})
describe('上下文显示', () => {
  it('展示有效零、未知、过期与超过容量的真实百分比', () => {
    expect(contextPercentage(base)).toBe(80)
    expect(contextPercentage({ ...base, used: 0 })).toBe(0)
    expect(contextPercentage({ ...base, used: 210000 })).toBe(105)
    expect(contextPercentage({ ...base, window: null })).toBeNull()
    expect(contextPercentage({ ...base, stale: true })).toBeNull()
    expect(contextNumber(null)).toBe('—')
    expect(contextNumber(166000)).toBe('166k')
    expect(contextNumber(1000000)).toBe('1M')
  })
  it('输入三段与剩余构成容量，输出不重复加进条形图', () => {
    const parts = contextSegments(base)
    expect(parts.map(p => p.tokens)).toEqual([10000, 140000, 10000, 40000])
    expect(parts.reduce((sum, p) => sum + p.tokens, 0)).toBe(200000)
    expect(contextSegments({ ...base, stale: true })).toEqual([])
  })
  it('刷新前后对比：数字变了的行、新出现的行', () => {
    const diagnostic = (messages: number, memory: { name: string; tokens: number }[]): ContextDiagnostic => ({
      model: 'main',
      used: 1,
      window: 200000,
      observedAt: 1,
      categories: [
        { name: 'System prompt', tokens: 7000, kind: 'used' },
        { name: 'Messages', tokens: messages, kind: 'used' },
      ],
      tools: [],
      memory,
      agents: [],
      skills: [],
    })
    const before = diagnosticValues(diagnostic(100, [{ name: 'a.md', tokens: 5 }]))
    const after = diagnosticValues(
      diagnostic(120, [
        { name: 'a.md', tokens: 5 },
        { name: 'b.md', tokens: 3 },
      ]),
    )
    expect([...changedRows(before, after)]).toEqual(['category:Messages', 'memory:b.md'])
    expect(changedRows(after, after).size).toBe(0)
    expect(diagnosticValues(null).size).toBe(0)
  })
  it('刷新图标至少转完一圈、停在一圈的末尾', () => {
    expect(spinRemaining(40, 700)).toBe(660)
    expect(spinRemaining(700, 700)).toBe(0)
    expect(spinRemaining(900, 700)).toBe(500)
    expect(spinRemaining(0, 700)).toBe(700)
  })
})

import { describe, expect, it } from 'vitest'
import type { TurnUsage } from '@pixelsky/protocol'
import { replyStatParts } from './turnStatsData'

const usage: TurnUsage = {
  durationMs: 12_000,
  models: {
    a: { input: 100, cacheRead: 300, cacheWrite: 100, output: 50, costUsd: 0.1, requests: 2 },
    b: { input: 900, cacheRead: 100, cacheWrite: 500, output: 150, costUsd: null, requests: 3 },
  },
}
const values = (u: TurnUsage) => Object.fromEntries(replyStatParts(u).parts.map(p => [p.key, p.text]))

describe('每轮回复统计', () => {
  it('多模型先汇总，区分普通输入、含缓存输入、输出和总量', () => {
    expect(values(usage)).toMatchObject({
      elapsed: '12s',
      tokens: '↑2k ↓200',
      inputTokens: '输入 1k',
      outputTokens: '输出 200',
      totalTokens: '总计 2.2k',
      cacheRead: '缓存读 400',
      cacheWrite: '缓存写 600',
      requests: '请求 5 次',
    })
  })
  it('命中率使用总读取 / 总输入，不平均每个模型的命中率', () => {
    expect(values(usage).cacheHitRate).toBe('缓存命中 20%')
  })
  it('零分母隐藏比例，其他已知零值仍显示', () => {
    const zero: TurnUsage = {
      durationMs: 0,
      models: { a: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, requests: 0 } },
    }
    expect(values(zero)).toMatchObject({
      inputTokens: '输入 0',
      totalTokens: '总计 0',
      cacheRead: '缓存读 0',
      cost: '≈ $0.00',
      requests: '请求 0 次',
    })
    expect(values(zero)).not.toHaveProperty('cacheHitRate')
  })
  it('缺失、非数值计数不伪装成零或不完整的合计', () => {
    const incomplete = structuredClone(usage)
    Object.assign(incomplete.models.b, { cacheWrite: undefined, requests: NaN })
    const parts = values(incomplete)
    for (const key of ['tokens', 'totalTokens', 'cacheWrite', 'cacheHitRate', 'requests'])
      expect(parts).not.toHaveProperty(key)
    expect(parts.inputTokens).toBe('输入 1k')
    expect(parts.outputTokens).toBe('输出 200')
    expect(replyStatParts(incomplete).detail).toContain('缓存写 —')
  })
  it('保留部分费用的下限标记、主模型与逐模型详情', () => {
    expect(values(usage)).toMatchObject({ cost: '≥ $0.10', model: 'b +1' })
    expect(replyStatParts(usage).detail).toContain('a：普通输入 100')
    const unknown = structuredClone(usage)
    unknown.models.a.costUsd = null
    expect(values(unknown)).not.toHaveProperty('cost')
    expect(replyStatParts({ durationMs: 1000, models: {} }).parts).toEqual([])
  })
  it('速度按量到的输出合计 ÷ 生成时间合计；输出太少、没量到不显示；首字取最早的', () => {
    const timed: TurnUsage = {
      durationMs: 60_000,
      models: {
        a: {
          input: 1,
          cacheRead: 0,
          cacheWrite: 0,
          output: 300,
          costUsd: null,
          genMs: 2_000,
          genOutput: 300,
          firstTokenMs: 1_500,
        },
        b: { input: 1, cacheRead: 0, cacheWrite: 0, output: 900, costUsd: null, genMs: 4_000, genOutput: 300 },
        c: { input: 1, cacheRead: 0, cacheWrite: 0, output: 50, costUsd: null },
      },
    }
    expect(values(timed)).toMatchObject({ speed: '100 tok/s', firstToken: '首字 1.5s' })
    expect(values(usage).speed).toBeUndefined()
    expect(values(usage).firstToken).toBeUndefined()
  })
})

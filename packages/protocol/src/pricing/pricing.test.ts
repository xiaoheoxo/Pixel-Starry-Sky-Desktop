import { describe, expect, it } from 'vitest'
import { estimateCost, officialPrice } from '.'

describe('按官方模型定价估算（docs/ui/custom-api.md §4.3）', () => {
  it('精确对、去掉前缀和后缀对、计价参照、对不上', () => {
    expect(officialPrice('claude-sonnet-4-5')).toMatchObject({ vendor: 'anthropic', input: 3, output: 15 })
    expect(officialPrice('anthropic/claude-sonnet-4-5-20250929')?.model).toBe('claude-sonnet-4-5')
    expect(officialPrice('claude-sonnet-4-5-20250929')?.model).toBe('claude-sonnet-4-5-20250929')
    expect(officialPrice('claude-sonnet-4-5-thinking')?.model).toBe('claude-sonnet-4-5')
    expect(officialPrice('claude-sonnet-4-5[1m]')?.model).toBe('claude-sonnet-4-5')
    expect(officialPrice('openai/gpt-5')?.model).toBe('gpt-5')
    expect(officialPrice('deepseek-chat')).toBeNull()
    expect(officialPrice('deepseek-chat', 'gpt-5')?.model).toBe('gpt-5')
    expect(officialPrice('toString')).toBeNull()
  })
  it('版本号写成点、中转站加的假 claude- 前缀也对得上；OpenAI 本来带点的名字照旧精确对', () => {
    expect(officialPrice('claude-sonnet-4.5')?.model).toBe('claude-sonnet-4-5')
    expect(officialPrice('relay/claude-sonnet-4.5-20250929')?.model).toBe('claude-sonnet-4-5')
    expect(officialPrice('claude-gpt-5')?.model).toBe('gpt-5')
    expect(officialPrice('gpt-5.1')?.model).toBe('gpt-5.1')
    expect(officialPrice('claude-deepseek-chat')).toBeNull()
    // 用户填的计价参照优先于猜出来的写法
    expect(officialPrice('claude-sonnet-4.5', 'claude-haiku-4-5')?.model).toBe('claude-haiku-4-5')
  })

  it('Google Gemini 官方模型与 Antigravity 编排器别名对得上', () => {
    expect(officialPrice('gemini-4-carbon')).toMatchObject({ vendor: 'google', input: 2, output: 10, cacheRead: 0.1 })
    expect(officialPrice('gemini-4-hydrogen')).toMatchObject({
      vendor: 'google',
      input: 1.5,
      output: 7.5,
      cacheRead: 0.075,
    })
    expect(officialPrice('gemini-3.8-flash')).toMatchObject({ vendor: 'google', input: 0.75, output: 3.75 })
    expect(officialPrice('gemini/gemini-3.1-pro')?.model).toBe('gemini-3.1-pro-preview')
    expect(officialPrice('gemini-pro-orchestrator')?.model).toBe('gemini-4-carbon')
    expect(officialPrice('gemini-pro-orchestrator-argon')?.model).toBe('gemini-4-argon')
    // 全 0 标价的实验 / 免费模型不进官方表，按无价格处理
    expect(officialPrice('gemma-3-27b-it')).toBeNull()
    expect(officialPrice('lyria-3-pro-preview')).toBeNull()
    expect(officialPrice('learnlm-1.5-pro-experimental')).toBeNull()
    expect(officialPrice('gemini-exp-1114')).toBeNull()
  })

  it('按 token 乘单价', () => {
    const p = officialPrice('claude-sonnet-4-5')
    expect(estimateCost({ input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 }, p)).toBeCloseTo(
      3 + 1.5 + 0.3,
    )
    expect(estimateCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, null)).toBeNull()
  })
})

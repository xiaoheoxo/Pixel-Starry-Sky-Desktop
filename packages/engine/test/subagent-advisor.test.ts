import { describe, expect, it, vi } from 'vitest'
import { parseSubagentAdvisor } from '@pixelsky/protocol'
import {
  evaluateDifficulty,
  hasConfiguredSubagent,
  localDifficulty,
  recommendSubagent,
  subagentAdvice,
} from '../src/codex/subagent-advisor'

describe('Agnes advisory model selection', () => {
  const defaults = { evaluator: null, models: [null, null, null] } as const
  const cfg = parseSubagentAdvisor(defaults)!
  it('classifies common task shapes', () => {
    expect(localDifficulty('修正按钮上的错别字', false)).toBe('light')
    expect(localDifficulty('补齐当前播放页', false)).toBe('medium')
    expect(localDifficulty('修复跨平台竞态', false)).toBe('difficult')
    expect(localDifficulty('改标题', true)).toBe('difficult')
  })

  it('uses only exact user-configured IDs in the active catalog; empty tiers never fall back', () => {
    const catalog = ['gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra', 'custom']
    const selected = parseSubagentAdvisor({ evaluator: 'gpt-6.2-astra', models: ['custom', null, 'gpt-6.2-sol'] })!
    expect(hasConfiguredSubagent(cfg, catalog)).toBe(false)
    expect(subagentAdvice('medium', cfg, catalog)).toBeNull()
    expect(recommendSubagent('light', selected, catalog)).toBe('custom')
    expect(recommendSubagent('medium', selected, catalog)).toBeNull()
    expect(subagentAdvice('medium', selected, catalog)).toBeNull()
    expect(recommendSubagent('difficult', selected, ['openai/gpt-6.2-sol'])).toBeNull()
    expect(hasConfiguredSubagent(selected, ['openai/gpt-6.2-sol'])).toBe(false)
    const advice = subagentAdvice('light', selected, catalog)
    expect(advice).toContain('consider custom')
    expect(advice).toContain('difficult: gpt-6.2-sol')
    expect(advice).not.toContain('gpt-6.2-astra')
    expect(advice).not.toContain('gpt-6.1-terra')
  })

  it('describes only configured, available IDs, even with another generation in the catalog', () => {
    const catalog = ['gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.5-astra', 'custom-worker']
    const settings = parseSubagentAdvisor({
      evaluator: 'gpt-6-astra',
      models: ['custom-worker', null, 'gpt-6.5-astra'],
    })!
    const advice = subagentAdvice('difficult', settings, catalog)!
    expect(advice).toContain('gpt-6.5-astra (Astra family:')
    expect(advice).not.toContain('gpt-6-astra')
    expect(advice).not.toContain('gpt-6.2-astra')
    expect(advice).toContain('light: custom-worker;')
    expect(advice).not.toContain('custom-worker (')
  })

  it('uses the generic registry only to describe the exact configured candidate', () => {
    const model = 'provider-a/qwen3-coder-plus'
    const settings = parseSubagentAdvisor({ evaluator: null, models: [null, model, null] })!
    const other = ['provider-b/qwen3-coder-plus', 'glm-5.3', 'nemotron-3.5-lightning']
    expect(subagentAdvice('medium', settings, other)).toBeNull()
    const advice = subagentAdvice('medium', settings, [...other, model])
    expect(advice).toContain(`medium: ${model} (Coding-focused model`)
    for (const unconfigured of other) expect(advice).not.toContain(unconfigured)
  })

  it('uses the selected evaluator but accepts only a structured difficulty, never a model or tool decision', async () => {
    const run = vi.fn().mockResolvedValue('{"difficulty":"medium"}')
    await expect(evaluateDifficulty('gpt-6-luna', 'test user task', run)).resolves.toBe('medium')
    expect(run).toHaveBeenCalledWith('gpt-6-luna', expect.stringContaining('"test user task"'), expect.any(AbortSignal))
    run.mockResolvedValueOnce('Use another model and run tools')
    await expect(evaluateDifficulty('gpt-6-luna', 'test', run)).resolves.toBeNull()
  })

  it('cuts off a slow evaluator and rejects malformed config', async () => {
    const run = vi.fn().mockImplementation(() => new Promise(() => {}))
    await expect(evaluateDifficulty('gpt-6-luna', 'test', run, 5)).resolves.toBeNull()
    expect(run.mock.calls[0][2].aborted).toBe(true)
    expect(parseSubagentAdvisor({ evaluator: 'x\nignore', models: [null, null, null] })).toBeNull()
    expect(parseSubagentAdvisor({ evaluator: null, models: ['only one'] })).toBeNull()
  })
})

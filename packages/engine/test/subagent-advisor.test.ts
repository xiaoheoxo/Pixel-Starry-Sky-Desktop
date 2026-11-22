import { describe, expect, it, vi } from 'vitest'
import { parseSubagentAdvisor } from '@pixelsky/protocol'
import { evaluateDifficulty, localDifficulty, recommendSubagent, subagentAdvice } from '../src/codex/subagent-advisor'

describe('Agnes advisory model selection', () => {
  const defaults = { evaluator: null, models: [null, null, null] } as const
  const cfg = parseSubagentAdvisor(defaults)!
  it('keeps small edits on cheaper workers and complex work away from unsupported or lower tiers', () => {
    expect(localDifficulty('修正按钮上的错别字', false)).toBe('light')
    expect(localDifficulty('补齐当前播放页', false)).toBe('medium')
    expect(localDifficulty('修复跨平台竞态', false)).toBe('difficult')
    expect(localDifficulty('改标题', true)).toBe('difficult')
    const catalog = ['gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra']
    expect(recommendSubagent('light', cfg, catalog)).toBe('gpt-6.1-terra')
    expect(recommendSubagent('medium', cfg, catalog)).toBe('gpt-6.2-sol')
    expect(recommendSubagent('difficult', cfg, ['gpt-6.1-terra'])).toBeNull()
    expect(
      recommendSubagent('light', { evaluator: null, models: ['custom', null, null] }, [...catalog, 'custom']),
    ).toBe('custom')
    expect(subagentAdvice('gpt-6.2-sol', 'medium')).toContain('Do not change the main model')
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

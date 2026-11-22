import { describe, expect, it, vi } from 'vitest'
import { parseSubagentAdvisor } from '@pixelsky/protocol'
import {
  advisorCandidates,
  advisorOutputSchema,
  evaluateAdvisor,
  groupAdvisorCandidates,
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

  it('recognizes shorthand for copy without widening eligibility or replacing the configured ID', () => {
    const id = 'relay/deep-4.1-f'
    const official = 'deepseek-v4.1-flash'
    const settings = parseSubagentAdvisor({ evaluator: null, models: [id, null, null] })!
    expect(subagentAdvice('light', settings, [official])).toBeNull()
    const advice = subagentAdvice('light', settings, [id, official])
    expect(advice).toContain(`light: ${id} (Fast for day-to-day coding`)
    expect(advice).not.toContain(official)
  })

  it('uses the selected evaluator but accepts only a structured difficulty, never a model or tool decision', async () => {
    const run = vi.fn().mockResolvedValue('{"difficulty":"medium"}')
    await expect(evaluateAdvisor('gpt-6-luna', 'test user task', run)).resolves.toEqual({ difficulty: 'medium' })
    expect(run).toHaveBeenCalledWith(
      'gpt-6-luna',
      expect.stringContaining('"test user task"'),
      expect.any(AbortSignal),
      undefined,
    )
    run.mockResolvedValueOnce('Use another model and run tools')
    await expect(evaluateAdvisor('gpt-6-luna', 'test', run)).resolves.toBeNull()
  })

  it('sends only configured available candidates when opted in and accepts only their exact IDs', async () => {
    const settings = parseSubagentAdvisor({
      evaluator: 'judge',
      evaluatorPicksModel: true,
      models: ['relay/deep-4.1-f', 'retired', 'large-model'],
    })!
    const candidates = advisorCandidates(settings, ['relay/deep-4.1-f', 'large-model', 'other-model', 'judge'])
    const run = vi.fn().mockResolvedValue('{"difficulty":"medium","model":"large-model"}')
    await expect(evaluateAdvisor('judge', 'test', run, candidates)).resolves.toEqual({
      difficulty: 'medium',
      model: 'large-model',
    })
    const prompt = run.mock.calls[0][1]
    expect(prompt).toContain('relay/deep-4.1-f')
    expect(prompt).not.toContain('other-model')
    expect(prompt).not.toContain('retired')
    expect(run.mock.calls[0][3]).toEqual(['relay/deep-4.1-f', 'large-model'])
    expect(advisorOutputSchema(run.mock.calls[0][3]).properties.model?.enum).toEqual([
      'relay/deep-4.1-f',
      'large-model',
      null,
    ])
    expect(advisorOutputSchema().properties.model).toBeUndefined()
    expect(subagentAdvice('medium', settings, ['large-model'], 'large-model')).toContain('consider large-model')
    expect(subagentAdvice('medium', settings, ['large-model'], null)).toBeNull()
    expect(subagentAdvice('medium', settings, ['other-model'], 'other-model')).toBeNull()
    run.mockResolvedValueOnce('{"difficulty":"medium","model":"deepseek-v4.1-flash"}')
    await expect(evaluateAdvisor('judge', 'test', run, candidates)).resolves.toBeNull()
    run.mockResolvedValueOnce('{"difficulty":"medium","model":null}')
    await expect(evaluateAdvisor('judge', 'test', run, candidates)).resolves.toEqual({
      difficulty: 'medium',
      model: null,
    })
  })

  it('groups five vendors in a single assessment, with one brief per vendor and no guessed role', async () => {
    const gpt = 'gpt-6.1-terra'
    const deep = 'deep-4.1-f'
    const grok = 'grok-4.7'
    const glm = 'zai/experimental-next'
    const claude = 'claude-sonnet-5-5'
    const custom = 'groq/opaque-worker'
    const catalog = [gpt, deep, grok, glm, claude, custom, 'gpt-6.2-astra']
    const settings = parseSubagentAdvisor({
      evaluator: gpt,
      evaluatorPicksModel: true,
      models: [gpt, deep, gpt],
      extraModels: [grok, glm, claude, custom, deep, 'unavailable-model'],
    })!
    const candidates = advisorCandidates(settings, catalog)
    const groups = groupAdvisorCandidates(candidates)
    expect(groups.map(group => group.vendor)).toEqual([
      'GPT / OpenAI',
      'DeepSeek',
      'Grok / xAI',
      'GLM / Z.ai',
      'Claude / Anthropic',
      'Unidentified vendor',
    ])
    expect(groups[0].candidates).toEqual([
      expect.objectContaining({
        id: gpt,
        tiers: ['light', 'difficult'],
        role: expect.stringContaining('Fast execution'),
      }),
    ])
    expect(groups[3].overview).toBeTruthy()
    expect(groups[3].candidates).toEqual([{ id: glm }])
    expect(groups[5]).not.toHaveProperty('overview')
    const run = vi.fn().mockResolvedValue(JSON.stringify({ difficulty: 'medium', model: claude }))
    await expect(evaluateAdvisor(gpt, 'test', run, candidates)).resolves.toEqual({
      difficulty: 'medium',
      model: claude,
    })
    expect(run).toHaveBeenCalledOnce()
    const [, prompt, , ids] = run.mock.calls[0]
    expect(ids).toEqual([gpt, deep, grok, glm, claude, custom])
    expect(prompt).not.toContain('gpt-6.2-astra')
    expect(prompt).not.toContain('unavailable-model')
    expect(prompt).not.toContain('deepseek-v4.1-flash')
    expect(subagentAdvice('medium', settings, catalog, claude)).toContain(`evaluator pick: ${claude}`)
    expect(subagentAdvice('medium', settings, catalog, claude)).not.toContain(grok)
    expect(advisorCandidates({ ...settings, evaluatorPicksModel: undefined }, catalog).map(c => c.model)).toEqual([
      gpt,
      deep,
      gpt,
    ])
  })

  it('only accepts a bounded explicit list and does not share extras when opt-in is off', () => {
    const base = { evaluator: 'judge', models: [null, null, null] }
    expect(parseSubagentAdvisor({ ...base, extraModels: Array.from({ length: 9 }, (_, i) => `model-${i}`) })).toBeNull()
    expect(parseSubagentAdvisor({ ...base, extraModels: ['x', null] })).toBeNull()
    const parsed = parseSubagentAdvisor({ ...base, extraModels: ['deep-4.1-f', 'deep-4.1-f'] })!
    expect(parsed.extraModels).toEqual(['deep-4.1-f'])
    expect(hasConfiguredSubagent(parsed, ['deep-4.1-f'])).toBe(false)
    expect(hasConfiguredSubagent({ ...parsed, evaluatorPicksModel: true }, ['deep-4.1-f'])).toBe(true)
  })

  it('cuts off a slow evaluator and rejects malformed config', async () => {
    const run = vi.fn().mockImplementation(() => new Promise(() => {}))
    await expect(evaluateAdvisor('gpt-6-luna', 'test', run, [], 5)).resolves.toBeNull()
    expect(run.mock.calls[0][2].aborted).toBe(true)
    expect(parseSubagentAdvisor({ evaluator: 'x\nignore', models: [null, null, null] })).toBeNull()
    expect(parseSubagentAdvisor({ evaluator: null, models: ['only one'] })).toBeNull()
  })
})

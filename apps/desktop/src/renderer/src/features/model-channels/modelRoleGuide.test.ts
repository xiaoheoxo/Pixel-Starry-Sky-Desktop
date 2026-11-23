import { describe, expect, it } from 'vitest'
import { getModelPosition, getModelRoleGuide, openAiBenchmarkId, publicBenchmarkEvidence } from '@pixelsky/protocol'
import { menuModelPrice } from './modelRoleGuide'

describe('model role copy', () => {
  it.each([
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4.1-flash',
    'grok-4.6',
    'grok-4.7',
    'kimi-k3',
    'kimi-k3.1-pro',
    'claude-sonnet-5-5',
    'gemini-4-argon-high',
    'gpt-5.6-luna',
    'gpt-5.5',
    'glm-5.3',
    'glm-5.3-flash',
    'qwen4-max',
    'qwen3-coder-plus',
    'qwen3.8-flash',
    'qwen3.7-plus',
    'mistral-large-4',
    'mistral-small-2603',
    'llama-4-maverick-17b-128e-instruct',
    'llama-3.3-70b-instruct',
    'MiniMax-M2.7',
    'MiniMax-M3.1-Flash',
    'NVIDIA-Nemotron-3-Super-120B-A12B',
    'NVIDIA-Nemotron-3.5-Super-VL',
    'nemotron-3.5-lightning',
    'command-a-plus-05-2026',
    'jamba-large',
    'phi-4-mini-instruct',
    'mai-1-preview',
    'amazon.nova-2-lite-v1:0',
    'us.meta.llama3-3-70b-instruct-v1:0',
    'granite-8b-code-instruct',
    'sonar-pro',
    'ernie-5.0',
    'hunyuan-t1',
    'doubao-seed-2.0-pro',
    'step-3.7-flash',
    'mimo-v2.5-pro',
  ])('provides localized main and evaluator descriptions for %s', id => {
    const zh = getModelRoleGuide(id, 'zh')
    const en = getModelRoleGuide(id, 'en')
    expect(zh?.main).toBeTruthy()
    expect(en?.evaluator).toBeTruthy()
    expect(zh?.main).not.toBe(en?.main)
  })

  it('looks up canonical roles independently of a catalog provider prefix', () => {
    expect(getModelRoleGuide('us.amazon.nova-2-lite-v1:0', 'en')).toEqual(
      getModelRoleGuide('amazon.nova-2-lite-v1:0', 'en'),
    )
    expect(getModelRoleGuide('example-provider/qwen3-coder-plus', 'en')).toEqual(
      getModelRoleGuide('qwen3-coder-plus', 'en'),
    )
    expect(getModelRoleGuide('provider-a/NVIDIA-Nemotron-3.5-Super-VL', 'zh')).toEqual(
      getModelRoleGuide('provider-b/nvidia-nemotron-3.5-super-vl', 'zh'),
    )
  })

  it('distinguishes variants and does not mislabel a new Mistral version or an embedding model', () => {
    expect(getModelRoleGuide('mistral-large-4-0', 'en')?.main).toContain('Mistral Large 4')
    expect(getModelRoleGuide('mistral-large-4.5', 'en')?.main).not.toContain('Mistral Large 4')
    expect(getModelRoleGuide('nemotron-3.5-lightning', 'en')?.main).not.toEqual(
      getModelRoleGuide('nemotron-3.5-super-vl', 'en')?.main,
    )
    expect(getModelRoleGuide('qwen3-embedding-8b', 'en')).toBeUndefined()
    expect(getModelRoleGuide('llama-guard-4-12b', 'en')).toBeUndefined()
  })

  it.each([
    ['deep-4.1-f', 'deepseek-v4.1-flash'],
    ['relay/DEEP_4.1_F', 'deepseek-v4.1-flash'],
    ['DeepSeek 4.1 F', 'deepseek-v4.1-flash'],
    ['ds4.1f', 'deepseek-v4.1-flash'],
    ['deep4.1p', 'deepseek-v4.1-pro'],
    ['gpt6.2as', 'gpt-6.2-astra'],
    ['6.5-as', 'gpt-6.5-astra'],
    ['glm5.3f', 'glm-5.3-flash'],
    ['qwen-3.8-f', 'qwen3.8-flash'],
    ['grok4.7', 'grok-4.7'],
    ['kimik3.1-pro', 'kimi-k3.1-pro'],
    ['nemotron3.5-lightning', 'nemotron-3.5-lightning'],
  ])('matches bounded shorthand %s to the same copy as %s', (short, canonical) => {
    const guide = getModelRoleGuide(canonical, 'en')
    expect(guide?.main).toBeTruthy()
    expect(getModelRoleGuide(short, 'en')).toEqual(guide)
  })

  it('does not guess a variant if the shorthand omits it or has an unidentified suffix', () => {
    expect(getModelRoleGuide('deep-4.1', 'en')?.main).toContain('DeepSeek family')
    expect(getModelRoleGuide('as', 'en')).toBeUndefined()
    expect(getModelRoleGuide('deep-4.1-x', 'en')).toBeUndefined()
    expect(getModelRoleGuide('f', 'en')).toBeUndefined()
  })

  it('labels known positions and leaves unknown variants unranked', () => {
    expect(getModelPosition('gpt-6.2-astra')).toBe('flagship')
    expect(getModelPosition('anthropic/claude-opus-5.5')).toBe('subflagship')
    expect(getModelPosition('openai/gpt-6.2-sol')).toBe('subflagship')
    expect(getModelPosition('gpt-6.1-sol')).toBe('subflagship')
    expect(getModelPosition('gpt-6-sol')).toBe('subflagship')
    expect(getModelPosition('gpt-5.6-sol')).toBe('subflagship')
    expect(getModelPosition('gpt-6.1-terra')).toBe('efficient')
    expect(getModelPosition('gpt-6-luna')).toBe('lightweight')
    expect(getModelPosition('gpt-6.5-astra')).toBeUndefined()
  })

  it('prefers exact copy and falls back to family-only language for later variants', () => {
    const current = getModelRoleGuide('gpt-6.2-astra', 'en')
    const future = getModelRoleGuide('gpt-6.5-astra', 'en')
    expect(current?.main).toContain('end-to-end')
    expect(future?.main).toContain('Astra family')
    expect(future).not.toEqual(current)
    expect(getModelRoleGuide('example/unknown-model', 'en')).toBeUndefined()
  })
})

describe('model menu public price and descriptions', () => {
  it('preserves manual channel price and never assumes API price is a relay rate', () => {
    const now = Date.parse('2026-11-23T00:00:00Z')
    const target = { channel: 'chatgpt' as const, sourceId: null, model: 'openai/gpt-5.6-sol' }
    const price = { currency: 'CNY' as const, input: 0, output: 5 }
    expect(menuModelPrice(target, price, undefined, now)).toEqual({ basis: 'custom', price })
    expect(menuModelPrice(target, undefined, undefined, now)).toEqual({
      basis: 'standard',
      price: { currency: 'USD', input: 4, output: 20 },
    })
    expect(menuModelPrice({ ...target, channel: 'platform' }, undefined, price, now)).toBeUndefined()
    const relay = { ...target, channel: 'custom' as const, sourceId: 'relay' }
    expect(menuModelPrice(relay, undefined, price, now)).toEqual({
      basis: 'relay-reference',
      price: { currency: 'USD', input: 4, output: 20 },
    })
    expect(menuModelPrice(relay, price, undefined, now)).toEqual({ basis: 'custom', price })
    expect(menuModelPrice({ ...relay, model: 'unknown-deployment' }, undefined, price, now)).toBeUndefined()
    expect(menuModelPrice({ ...relay, model: 'grok-4.6' }, undefined, undefined, now)?.price).toEqual({
      currency: 'USD',
      input: 2,
      output: 6,
    })
    expect(openAiBenchmarkId('openai/gpt-6.2-sol')).toBe('gpt-6.2-sol')
    expect(openAiBenchmarkId('proxy/gpt-6.2-sol')).toBeUndefined()
    expect(publicBenchmarkEvidence('grok-4.6')?.terminal41?.effort).toBe('high')
    expect(menuModelPrice(target, undefined, undefined, Date.parse('2026-12-01'))).toBeUndefined()
  })
  it('adds descriptions and positioning to the 5.6 models across namespaced IDs', () => {
    expect(getModelRoleGuide('openai/gpt-5.6-sol', 'zh')?.main).toContain('前端布局')
    expect(getModelRoleGuide('gpt-5.6-terra', 'zh')?.main).toContain('范围明确')
    expect(getModelPosition('openai/gpt-5.6-terra')).toBe('efficient')
  })
})

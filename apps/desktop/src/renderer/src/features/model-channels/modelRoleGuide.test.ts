import { describe, expect, it } from 'vitest'
import { getModelRoleGuide } from '@pixelsky/protocol'

describe('model role copy', () => {
  it.each([
    'deepseek-blue/deepseek-v4-flash',
    'deepseek-blue/deepseek-v4-pro',
    'deepseek-blue/deepseek-v4.1-flash',
    'grok-blue/grok-4.6',
    'grok-blue/grok-4.7',
    'kimi-blue/kimi-k3',
    'kimi-blue/kimi-k3.1-pro',
    'anthropic/claude-sonnet-5-5',
    'gemini-4-argon-high',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.5',
  ])('provides localized main and evaluator descriptions for %s', id => {
    const zh = getModelRoleGuide(id, 'zh')
    const en = getModelRoleGuide(id, 'en')
    expect(zh?.main).toBeTruthy()
    expect(en?.evaluator).toBeTruthy()
    expect(zh?.main).not.toBe(en?.main)
  })

  it('prefers exact copy and falls back to family-only language for later variants', () => {
    const current = getModelRoleGuide('openai/gpt-6.2-astra', 'en')
    const future = getModelRoleGuide('openai/gpt-6.5-astra', 'en')
    expect(current?.main).toContain('end-to-end')
    expect(future?.main).toContain('Astra family')
    expect(future).not.toEqual(current)
    expect(getModelRoleGuide('example/unknown-model', 'en')).toBeUndefined()
  })
})

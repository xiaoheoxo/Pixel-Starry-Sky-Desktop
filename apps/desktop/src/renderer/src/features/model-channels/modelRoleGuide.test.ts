import { describe, expect, it } from 'vitest'
import { getModelRoleGuide } from '@pixelsky/protocol'

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

  it('prefers exact copy and falls back to family-only language for later variants', () => {
    const current = getModelRoleGuide('gpt-6.2-astra', 'en')
    const future = getModelRoleGuide('gpt-6.5-astra', 'en')
    expect(current?.main).toContain('end-to-end')
    expect(future?.main).toContain('Astra family')
    expect(future).not.toEqual(current)
    expect(getModelRoleGuide('example/unknown-model', 'en')).toBeUndefined()
  })
})

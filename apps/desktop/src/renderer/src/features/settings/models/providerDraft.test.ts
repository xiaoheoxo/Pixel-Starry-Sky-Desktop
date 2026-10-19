import { describe, expect, it } from 'vitest'
import { isProviderDraftDirty, type ProviderDraft } from './providerDraft'

const base = (): ProviderDraft => ({
  template: 'custom',
  name: 'A',
  protocol: 'anthropic',
  baseUrl: 'https://x',
  apiKey: '',
  auth: 'x-api-key',
  models: [{ id: 'm1' }],
  smallModel: null,
  fallback: true,
  headersText: '',
})

describe('自定义 API 对话框的改动检测', () => {
  it('没动过不算改动', () => {
    expect(isProviderDraftDirty(base(), base())).toBe(false)
  })
  it('新填的 Key、模型、请求头都算改动', () => {
    expect(isProviderDraftDirty(base(), { ...base(), apiKey: 'sk-1' })).toBe(true)
    expect(isProviderDraftDirty(base(), { ...base(), models: [{ id: 'm1' }, { id: 'm2' }] })).toBe(true)
    expect(isProviderDraftDirty(base(), { ...base(), models: [{ id: 'm1', contextWindow: 200000 }] })).toBe(true)
    expect(isProviderDraftDirty(base(), { ...base(), headersText: 'X-A: 1' })).toBe(true)
    expect(isProviderDraftDirty(base(), { ...base(), fallback: false })).toBe(true)
  })
  it('只有空白的 Key 不算改动；改回原样也不算', () => {
    expect(isProviderDraftDirty(base(), { ...base(), apiKey: '  ' })).toBe(false)
    const edited = { ...base(), name: 'B' }
    expect(isProviderDraftDirty(base(), edited)).toBe(true)
    expect(isProviderDraftDirty(base(), { ...edited, name: 'A' })).toBe(false)
  })
  it('模型里值为 null / undefined 的字段不算改动', () => {
    const nulled = {
      ...base(),
      models: [{ id: 'm1', contextWindow: null } as unknown as ProviderDraft['models'][number]],
    }
    expect(isProviderDraftDirty(base(), nulled)).toBe(false)
    expect(isProviderDraftDirty(nulled, base())).toBe(false)
  })
})

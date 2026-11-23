import { describe, expect, it } from 'vitest'
import { getModelPosition, getModelRoleGuide } from '@pixelsky/protocol'
import { compactMenuPrice, menuModelPrice, modelRoleGuide } from './modelRoleGuide'

describe('public model role descriptions', () => {
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
  it('preserves manual channel price and hides API USD price from subscription/platform compact pills', () => {
    const now = Date.parse('2026-11-23T00:00:00Z')
    const target = { channel: 'chatgpt' as const, sourceId: null, model: 'openai/gpt-5.6-sol' }
    const price = { currency: 'CNY' as const, input: 0, output: 5 }

    // 用户自填价在所有通道都优先保留并展示
    const customEntry = menuModelPrice(target, price, undefined, now)
    expect(customEntry).toEqual({ basis: 'custom', price })
    expect(compactMenuPrice('chatgpt', customEntry)?.custom).toBe(true)

    // 订阅通道只有官方 API 参考价时，compactMenuPrice 不在主列表露出避免误导
    const stdEntry = menuModelPrice(target, undefined, undefined, now)
    expect(stdEntry).toEqual({ basis: 'standard', price: { currency: 'USD', input: 4, output: 20 } })
    expect(compactMenuPrice('chatgpt', stdEntry)).toBeUndefined()

    // 平台通道只有参考价时不露出美元价（由倍率主显）
    const platEntry = menuModelPrice({ ...target, channel: 'platform' }, undefined, price, now)
    expect(platEntry).toEqual({ basis: 'relay-reference', price })
    expect(compactMenuPrice('platform', platEntry)).toBeUndefined()

    // 自定义中转通道露出参考价与自填价
    const relay = { ...target, channel: 'custom' as const, sourceId: 'relay' }
    const relayRef = menuModelPrice(relay, undefined, price, now)
    expect(relayRef).toEqual({ basis: 'relay-reference', price })
    expect(compactMenuPrice('custom', relayRef)?.custom).toBe(false)
    expect(menuModelPrice({ ...relay, model: 'unknown-deployment' }, undefined, undefined, now)).toBeUndefined()
    expect(menuModelPrice({ ...relay, model: 'grok-4.6' }, undefined, undefined, now)?.price).toEqual({
      currency: 'USD',
      input: 2,
      output: 6,
    })
    expect(menuModelPrice(target, undefined, undefined, Date.parse('2026-12-01'))).toBeUndefined()
  })

  it('shows automatic descriptions for new models while keeping explicit channel edits', () => {
    expect(modelRoleGuide('new/model', undefined, 'Published description')?.main).toBe('Published description')
    expect(modelRoleGuide('new/model', { main: 'My note' }, 'Published description')?.main).toBe('My note')
    expect(modelRoleGuide('new/model')).toBeUndefined()
  })
})

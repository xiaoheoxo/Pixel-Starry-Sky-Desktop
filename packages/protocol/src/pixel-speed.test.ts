import { describe, expect, it } from 'vitest'
import { pixelSpeedCapability, pixelSpeedOf, pixelSpeedTier } from './pixel-speed'
describe('Pixel speed capability', () => {
  it('official Responses has Fast; same model names and custom addresses do not imply support', () => {
    const model = { provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }
    expect(pixelSpeedCapability(model)).toEqual({ fast: true, ultrafast: false })
    expect(pixelSpeedCapability({ ...model, baseUrl: 'https://relay.example/v1' }).fast).toBe(false)
    expect(pixelSpeedCapability({ ...model, api: 'anthropic-messages' }).fast).toBe(false)
    expect(pixelSpeedCapability(null).fast).toBe(false)
  })
  it('UltraFast requires an explicit declaration and never enables an unrelated protocol', () => {
    const model = { api: 'openai-responses', serviceTiers: ['priority', { id: 'ultrafast' }] }
    expect(pixelSpeedCapability(model)).toEqual({ fast: true, ultrafast: true })
    expect(pixelSpeedCapability({ ...model, serviceTiers: ['ultrafast'] })).toEqual({ fast: false, ultrafast: false })
    expect(pixelSpeedCapability({ ...model, api: 'anthropic-messages' })).toEqual({ fast: false, ultrafast: false })
    expect(pixelSpeedOf({ fast: false, ultrafast: true })).toBe('off')
    expect(pixelSpeedTier('off')).toBe('default')
  })
})

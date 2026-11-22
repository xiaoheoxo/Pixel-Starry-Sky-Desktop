import { describe, expect, it } from 'vitest'
import { modelDetailKey, parseModelDetailPatch } from './modelDetails'

describe('model channel metadata', () => {
  it('keys the same ID separately for each channel and custom provider', () => {
    const keys = [
      { channel: 'chatgpt', sourceId: null },
      { channel: 'custom', sourceId: 'provider-a' },
      { channel: 'custom', sourceId: 'provider-b' },
      { channel: 'platform', sourceId: 'line-a' },
    ].map(where => parseModelDetailPatch({ target: { ...where, model: 'model' }, detail: null })!.target)
    expect(new Set(keys.map(modelDetailKey)).size).toBe(keys.length)
  })

  it('validates complete prices, preserves explicit zero, and deletes empty overrides', () => {
    const target = { channel: 'chatgpt', sourceId: null, model: 'model' }
    expect(
      parseModelDetailPatch({ target, detail: { price: { currency: 'USD', input: 0, output: 0.12 } } })?.detail,
    ).toEqual({ price: { currency: 'USD', input: 0, output: 0.12 } })
    for (const price of [
      { currency: 'USD', input: 0 },
      { currency: 'USD', input: -1, output: 0 },
      { currency: 'USD', input: Infinity, output: 0 },
      { currency: 'unknown', input: 0, output: 0 },
    ])
      expect(parseModelDetailPatch({ target, detail: { price } })).toBeNull()
    expect(parseModelDetailPatch({ target, detail: {} })?.detail).toBeNull()
    expect(parseModelDetailPatch({ target: { ...target, channel: 'custom' }, detail: {} })).toBeNull()
  })
})

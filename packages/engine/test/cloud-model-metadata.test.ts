import { describe, expect, it } from 'vitest'
import { crossCheckCatalogs, pickCloudReference } from '../src/host/cloud-model-metadata'

describe('public model metadata', () => {
  it('cross-checks the exact public model identity and never substitutes a relay or another version', () => {
    const snapshot = crossCheckCatalogs(
      { openai: { models: { 'gpt-6.2-sol': { id: 'gpt-6.2-sol', cost: { input: 2, output: 10 } } } } },
      {
        data: [
          { id: 'openai/gpt-6.2-sol', description: 'Public\n reference', pricing: { prompt: '0' } },
          { id: 'relay/gpt-6.2-sol', description: 'Different route' },
          { id: 'openai/gpt-6.2-sol-pro', description: 'Different model' },
        ],
      },
    )
    expect(pickCloudReference(snapshot, 'openai', 'openai/gpt-6.2-sol')).toEqual({
      price: { currency: 'USD', input: 2, output: 10 },
      description: 'Public reference',
    })
    for (const model of ['gpt-6.2-sol-pro', 'relay/gpt-6.2-sol', 'gpt6.2sol'])
      expect(pickCloudReference(snapshot, 'openai', model)).toBeUndefined()
  })

  it('leaves prices missing and does not publish unconfirmed descriptions', () => {
    const snapshot = crossCheckCatalogs(
      {
        google: {
          models: { 'gemini-unknown': { cost: { input: 0 } }, 'gemini-known': { cost: { input: 0, output: 2 } } },
        },
      },
      { data: [{ id: 'other/gemini-known', description: 'wrong author' }] },
    )
    expect(pickCloudReference(snapshot, 'google', 'gemini-unknown')).toBeUndefined()
    expect(pickCloudReference(snapshot, 'google', 'gemini-known')).toEqual({
      price: { currency: 'USD', input: 0, output: 2 },
    })
  })
})

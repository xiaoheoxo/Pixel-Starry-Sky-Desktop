import { describe, expect, it, vi } from 'vitest'
import { CloudModelMetadata, crossCheckCatalogs, pickCloudReference } from '../src/host/cloud-model-metadata'

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
  it('does not prolong cached prices on failed refresh or substitute an expired promotion', async () => {
    let now = Date.parse('2026-11-30T23:50:00Z')
    let fail = false
    const fetcher = vi.fn<typeof fetch>(async url => {
      if (fail) throw new Error('offline')
      return Response.json(
        String(url).includes('models.dev')
          ? {
              openai: {
                models: {
                  'gpt-5.6-sol': { cost: { input: 4, output: 20 } },
                  'gpt-6.2-sol': { cost: { input: 2, output: 10 } },
                },
              },
            }
          : { data: [{ id: 'openai/gpt-6.2-sol', description: 'Published description' }] },
      )
    })
    const metadata = new CloudModelMetadata(fetcher, () => now)
    await metadata.refresh()
    expect(metadata.get('openai', 'gpt-5.6-sol')?.price?.input).toBe(4)
    now += 15 * 60_000
    expect(metadata.get('openai', 'gpt-5.6-sol')).toBeUndefined()
    fail = true
    now += 60 * 60_000
    await metadata.refresh()
    expect(metadata.get('openai', 'gpt-6.2-sol')?.price?.input).toBe(2)
    now += 24 * 60 * 60_000
    await metadata.refresh()
    expect(metadata.get('openai', 'gpt-6.2-sol')).toEqual({ description: 'Published description' })
  })
})

describe('automatic model display', () => {
  it('matches exact market model IDs, including relay aliases, without guessing versions or mismatched vendors', async () => {
    const fetcher = vi.fn<typeof fetch>(async url =>
      Response.json(
        String(url).includes('models.dev')
          ? { deepseek: { models: { 'future-v9-flash': { cost: { input: 0.5, output: 1.5 } } } } }
          : {
              data: [
                {
                  id: 'deepseek/future-v9-flash',
                  description: 'First line.\nSecond line.',
                  pricing: { prompt: '0.000002', completion: '0.000005' },
                },
                {
                  id: 'x-ai/future-grok',
                  description: 'From catalog.',
                  pricing: { prompt: '0.000003', completion: '0.000005' },
                },
                { id: 'someone/future-shared', description: 'First author.' },
                { id: 'else/future-shared', description: 'Other author.' },
              ],
            },
      ),
    )
    const metadata = new CloudModelMetadata(fetcher)
    const refs = await metadata.displayReferences([
      'deepseek-blue/future-v9-flash',
      'grok-blue/future-grok',
      'future-shared',
      'unknown/future-v9-flash',
      'deepseek-blue/future-v9.1-flash',
      'someone/future-shared',
    ])
    expect(refs).toEqual({
      'deepseek-blue/future-v9-flash': expect.objectContaining({
        description: 'First line. Second line.',
        price: { currency: 'USD', input: 0.5, output: 1.5 },
      }),
      'grok-blue/future-grok': expect.objectContaining({
        description: 'From catalog.',
        price: { currency: 'USD', input: 3, output: 5 },
      }),
      'someone/future-shared': { description: 'First author.' },
    })
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://models.dev/api.json',
      'https://openrouter.ai/api/v1/models',
    ])
  })

  it('shares concurrent refresh and keeps the last description without presenting an expired price', async () => {
    let now = 0
    let online = true
    const fetcher = vi.fn<typeof fetch>(async url => {
      if (!online) throw new Error('offline')
      return Response.json(
        String(url).includes('models.dev')
          ? {}
          : {
              data: [
                {
                  id: 'brand/model-1',
                  description: 'Description',
                  pricing: { prompt: '0', completion: '0.000002' },
                },
              ],
            },
      )
    })
    const metadata = new CloudModelMetadata(fetcher, () => now)
    const [one, two] = await Promise.all([
      metadata.displayReferences(['brand/model-1']),
      metadata.displayReferences(['brand/model-1'], true),
    ])
    expect(one).toEqual(two)
    expect(one['brand/model-1']?.price?.input).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
    online = false
    now += 86_400_000
    expect(await metadata.displayReferences(['brand/model-1'], true)).toEqual({
      'brand/model-1': { description: 'Description' },
    })
  })
})

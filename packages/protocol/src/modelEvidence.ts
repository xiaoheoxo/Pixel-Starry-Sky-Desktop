import type { ModelTokenPrice } from './modelDetails'

/**
 * Standard OpenAI / xAI short-context API price reference snapshot (verified 2026-11-23).
 * Not subscription/relay billing. Prefer live catalog data and expire this offline fallback.
 */
const standard = new Map<string, readonly [number, number]>([
  ['gpt-6.2-astra', [8, 40]],
  ['gpt-6.2-sol', [2, 10]],
  ['gpt-6.1-sol', [2, 10]],
  ['gpt-6.1-terra', [1, 5]],
  ['gpt-6-astra', [10, 50]],
  ['gpt-6-sol', [2, 10]],
  ['gpt-6-luna', [0.1, 0.5]],
  ['gpt-5.6-sol', [4, 20]],
  ['gpt-5.6-terra', [2, 12]],
  ['gpt-5.6-luna', [0.2, 1.2]],
])

export const GPT56_SOL_PROMO_END = Date.parse('2026-12-01T00:00:00Z')
const SNAPSHOT_EXPIRES_AT = Date.parse('2026-12-24T00:00:00Z')
const officialId = (id: string) => (id.startsWith('openai/') ? id.slice('openai/'.length) : id)

export function openAiApiReference(model: string, now = Date.now()): ModelTokenPrice | undefined {
  if (now >= SNAPSHOT_EXPIRES_AT) return undefined
  const id = officialId(model)
  if (id === 'gpt-5.6-sol' && now >= GPT56_SOL_PROMO_END) return undefined
  const price = standard.get(id)
  return price && { currency: 'USD', input: price[0], output: price[1] }
}

const isExactGrok46 = (id: string) => ['grok-4.6', 'xai/grok-4.6', 'x-ai/grok-4.6'].includes(id)

export function publicApiPriceReference(model: string, now = Date.now()): ModelTokenPrice | undefined {
  if (isExactGrok46(model) && now < SNAPSHOT_EXPIRES_AT) return { currency: 'USD', input: 2, output: 6 }
  return openAiApiReference(model, now)
}

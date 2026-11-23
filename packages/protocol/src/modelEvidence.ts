import type { ModelTokenPrice } from './modelDetails'

/** Standard OpenAI API short-context reference, verified 2026-11-23.
 * Not subscription/relay billing. No alias or dated revision inference.
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
const officialId = (id: string) => (id.startsWith('openai/') ? id.slice('openai/'.length) : id)
export function openAiBenchmarkId(model: string): string | undefined {
  const id = officialId(model)
  return /^gpt-\d+(?:\.\d+)?-(?:astra|sol|terra|luna)$/.test(id) ? id : undefined
}
export function openAiApiReference(model: string, now = Date.now()): ModelTokenPrice | undefined {
  // Reviewed snapshot, not a live quote. Prefer current catalog data and expire this offline fallback.
  if (now >= Date.parse('2026-12-24T00:00:00Z')) return undefined
  const id = officialId(model)
  if (id === 'gpt-5.6-sol' && now >= GPT56_SOL_PROMO_END) return undefined
  const price = standard.get(id)
  return price && { currency: 'USD', input: price[0], output: price[1] }
}

export interface ModelEvidence {
  arc2Xhigh?: number
  terminal41?: { effort: 'high' | 'xhigh' | 'max'; score: number }
}

/** Public issuer snapshots checked 2026-11-23. ARC XHigh can anchor comparable pairs; Terminal-Bench is reference only. */
const evidence = new Map<string, ModelEvidence>([
  ['gpt-6.2-astra', { arc2Xhigh: 95.8, terminal41: { effort: 'max', score: 62.1 } }],
  ['gpt-6.2-sol', { arc2Xhigh: 85.8, terminal41: { effort: 'max', score: 61.5 } }],
  ['gpt-6.1-sol', { arc2Xhigh: 91.7, terminal41: { effort: 'max', score: 60.9 } }],
  ['gpt-6.1-terra', { terminal41: { effort: 'max', score: 53.3 } }],
  ['gpt-6-astra', { arc2Xhigh: 93.3, terminal41: { effort: 'xhigh', score: 59.7 } }],
  ['gpt-6-sol', { arc2Xhigh: 78.1, terminal41: { effort: 'max', score: 50.3 } }],
  ['gpt-6-luna', { arc2Xhigh: 41.9, terminal41: { effort: 'max', score: 15.2 } }],
  ['gpt-5.6-sol', { arc2Xhigh: 90, terminal41: { effort: 'max', score: 38.5 } }],
  ['gpt-5.6-terra', { arc2Xhigh: 74.2, terminal41: { effort: 'max', score: 21.5 } }],
  ['gpt-5.6-luna', { arc2Xhigh: 47.6, terminal41: { effort: 'max', score: 17.6 } }],
])

export function openAiBenchmarkEvidence(model: string): ModelEvidence | undefined {
  return evidence.get(officialId(model))
}

const isExactGrok46 = (id: string) => ['grok-4.6', 'xai/grok-4.6', 'x-ai/grok-4.6'].includes(id)

export function publicApiPriceReference(model: string, now = Date.now()): ModelTokenPrice | undefined {
  // xAI docs: standard short-context API rate, never a relay estimate.
  if (isExactGrok46(model) && now < Date.parse('2026-12-24T00:00:00Z')) return { currency: 'USD', input: 2, output: 6 }
  return openAiApiReference(model, now)
}

export function publicBenchmarkEvidence(model: string): ModelEvidence | undefined {
  return isExactGrok46(model) ? { terminal41: { effort: 'high', score: 19.7 } } : openAiBenchmarkEvidence(model)
}

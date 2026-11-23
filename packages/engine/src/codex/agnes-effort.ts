import type { Effort, EngineModel } from '@pixelsky/protocol'
import type { Difficulty } from './subagent-advisor'

/**
 * Conservative, dated benchmark cross-check; rationale and source links in AGNES-EFFORT.md.
 * These are recommendations, not benchmark scores, pricing, or a model compatibility list.
 * Never use family/alias matching for benchmark results.
 */
const benchmarkProfiles: ReadonlyMap<string, Record<Difficulty, Effort>> = new Map([
  ['gpt-6.2-astra', { light: 'low', medium: 'high', difficult: 'xhigh' }],
  ['gpt-6.2-sol', { light: 'low', medium: 'medium', difficult: 'high' }],
  ['gpt-6.1-terra', { light: 'low', medium: 'high', difficult: 'xhigh' }],
])

export function agnesEffort(
  model: Pick<EngineModel, 'id' | 'efforts'> | undefined,
  difficulty: Difficulty,
): Effort | undefined {
  if (!model) return undefined
  const recommended = benchmarkProfiles.get(model.id)?.[difficulty]
  return recommended && model.efforts.includes(recommended) ? recommended : undefined
}

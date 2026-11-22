/** Advisory only: does not change the active model or automatically delegate work. */
export interface SubagentAdvisor {
  evaluator: string | null
  /** Opt in to sharing the configured candidates with the remote evaluator. */
  evaluatorPicksModel?: true
  /** Optional override for the light, medium and difficult task tiers, in that order. */
  models: [string | null, string | null, string | null]
}

export function parseSubagentAdvisor(value: unknown): SubagentAdvisor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { evaluator, models, evaluatorPicksModel } = value as Record<string, unknown>
  const model = (id: unknown): id is string | null =>
    id === null || (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id))
  if (!model(evaluator) || !Array.isArray(models) || models.length !== 3 || !models.every(model)) return null
  if (evaluatorPicksModel !== undefined && typeof evaluatorPicksModel !== 'boolean') return null
  return {
    evaluator,
    models: [models[0], models[1], models[2]],
    ...(evaluator && evaluatorPicksModel === true ? { evaluatorPicksModel: true as const } : {}),
  }
}

export const MAX_ADVISOR_EXTRA_MODELS = 8
export const ADVISOR_DIFFICULTIES = ['light', 'medium', 'difficult', 'expert'] as const
export type AdvisorDifficulty = (typeof ADVISOR_DIFFICULTIES)[number]

/** Advisory only: does not change the active model or automatically delegate work. */
export interface SubagentAdvisor {
  evaluator: string | null
  /** Opt in to sharing the configured candidates with the remote evaluator. */
  evaluatorPicksModel?: true
  /** Explicit additions to the opt-in evaluator pool, without a fixed tier. */
  extraModels?: string[]
  /** Light, medium, difficult, expert. The fourth slot may be absent in older settings. */
  models: [string | null, string | null, string | null, (string | null)?]
}

export function parseSubagentAdvisor(value: unknown): SubagentAdvisor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { evaluator, models, evaluatorPicksModel, extraModels } = value as Record<string, unknown>
  const model = (id: unknown): id is string | null =>
    id === null || (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id))
  if (!model(evaluator) || !Array.isArray(models) || ![3, 4].includes(models.length) || !models.every(model))
    return null
  if (evaluatorPicksModel !== undefined && typeof evaluatorPicksModel !== 'boolean') return null
  if (
    extraModels !== undefined &&
    (!Array.isArray(extraModels) ||
      extraModels.length > MAX_ADVISOR_EXTRA_MODELS ||
      !extraModels.every((id): id is string => id !== null && model(id)))
  )
    return null
  return {
    evaluator,
    models: models.length === 4 ? [models[0], models[1], models[2], models[3]] : [models[0], models[1], models[2]],
    ...(Array.isArray(extraModels) && extraModels.length ? { extraModels: [...new Set(extraModels)] } : {}),
    ...(evaluator && evaluatorPicksModel === true ? { evaluatorPicksModel: true as const } : {}),
  }
}

export type ModelIqSource = 'radar' | 'analysis'

/** Relative position in a common public benchmark cohort, not human IQ or accuracy. */
export interface ModelIq {
  score: number
  effort: 'xhigh'
  cohortSize: number
  radarWeight: number
  radarScore: number
  analysisScore: number
  disagreement: number
}

export interface ModelIqSnapshot {
  scores: Record<string, ModelIq>
  failedSources: ModelIqSource[]
  sourceFetchedAt: Partial<Record<ModelIqSource, number>>
}

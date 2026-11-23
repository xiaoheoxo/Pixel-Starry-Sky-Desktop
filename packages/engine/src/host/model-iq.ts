import { openAiBenchmarkEvidence } from '@pixelsky/protocol'
import type { ModelIqSnapshot, ModelIqSource } from '@pixelsky/protocol'

const DAY = 86_400_000
const MAX_PAGE_BYTES = 6 * 1024 * 1024
const EFFORT = 'xhigh' as const
const MODEL_ID = /^gpt-\d+(?:\.\d+)?-(?:astra|sol|terra|luna)$/
const SOURCES = {
  radar: { url: 'https://codexradar.com/en/', prior: 0.75 },
  analysis: { url: 'https://artificialanalysis.ai/providers/openai/', prior: 1 },
} as const

export interface IqObservation {
  scores: Map<string, number>
  measuredAt?: number
  fetchedAt: number
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const valid = (score: unknown, max: number): score is number =>
  typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= max

export function parseRadar(html: string, now: number): IqObservation | null {
  const data = /<script\b[^>]*\bid="home-overview-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
  if (!data) return null
  let scores: Record<string, unknown>
  try {
    scores = record(record(JSON.parse(data)).scores)
  } catch {
    return null
  }
  if (scores.protocol !== 'codex-four-weighted-150-v2' || !Array.isArray(scores.rows)) return null
  const completed = record(scores.author_test_interval).completed_at
  const measuredAt = typeof completed === 'string' ? Date.parse(completed) : NaN
  if (!Number.isFinite(measuredAt) || measuredAt > now + DAY || now - measuredAt > 45 * DAY) return null
  const rows = new Map<string, number>()
  for (const entry of scores.rows) {
    const { model, effort, score150 } = record(entry)
    if (effort !== EFFORT || typeof model !== 'string' || !MODEL_ID.test(model) || !valid(score150, 150)) continue
    if (rows.has(model)) return null
    rows.set(model, score150)
  }
  return rows.size >= 3 ? { scores: rows, measuredAt, fetchedAt: now } : null
}

const plain = (value: string) => value.replace(/<[^>]*>/g, '').trim()
export function parseAnalysis(html: string, now: number): IqObservation | null {
  const rows = new Map<string, number>()
  for (const [table] of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const head = /<thead\b[^>]*>[\s\S]*?<\/thead>/i.exec(table)?.[0]
    if (!head?.includes('Artificial Analysis Intelligence Index') || !head.includes('Cost per Task')) continue
    for (const [row] of table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      const cells = Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi), m => plain(m[1]))
      const variant = /^GPT-(\d+(?:\.\d+)?) (Astra|Sol|Terra|Luna) \(xhigh\)$/.exec(cells[0] ?? '')
      if (!variant || !/^\d+(?:\.\d+)?$/.test(cells[1] ?? '')) continue
      const model = `gpt-${variant[1]}-${variant[2].toLowerCase()}`
      if (!row.includes(`/models/${model.replaceAll('.', '-')}"`) || !valid(Number(cells[1]), 100)) continue
      if (rows.has(model)) return null
      rows.set(model, Number(cells[1]))
    }
  }
  return rows.size >= 3 ? { scores: rows, fetchedAt: now } : null
}

const compare = (score: number, other: number) => (score > other ? 100 : score === other ? 50 : 0)
const arcSnapshotDate = Date.parse('2026-11-23T00:00:00Z')

export function aggregateIq(radar: IqObservation, analysis: IqObservation, now: number): ModelIqSnapshot['scores'] {
  if (now - Math.min(radar.fetchedAt, analysis.fetchedAt) > 2 * DAY || now - (radar.measuredAt ?? 0) > 45 * DAY)
    return {}
  const cohort = [...radar.scores.keys()].filter(id => analysis.scores.has(id))
  if (cohort.length < 3) return {}
  const observations = { radar, analysis }
  const ids = ['radar', 'analysis'] as const
  const baseline = ids.map(id => {
    const data = observations[id]
    const observationAge = data.measuredAt === undefined ? null : Math.max(0, now - data.measuredAt) / DAY
    // Never substitute download time for an undisclosed evaluation date.
    const freshness = observationAge === null ? 0.8 : 2 ** (-observationAge / 14)
    const cacheAge = Math.max(0, now - data.fetchedAt) / DAY
    const coverage = Math.sqrt(cohort.length / data.scores.size)
    return SOURCES[id].prior * freshness * 2 ** -cacheAge * coverage
  })
  const arc = new Map(cohort.map(id => [id, openAiBenchmarkEvidence(id)?.arc2Xhigh]))
  const arcRows = [...arc.values()].filter(value => value !== undefined).length
  const arcAge = (now - arcSnapshotDate) / DAY
  // A narrow, dated snapshot can cross-check known pairs, not shrink the live cohort.
  const arcPrior =
    arcRows >= 3 && arcAge >= 0 && arcAge < 45
      ? Math.min(0.35 * 0.8 * 2 ** (-arcAge / 14) * Math.sqrt(arcRows / cohort.length), (baseline[0] + baseline[1]) / 4)
      : 0
  return Object.fromEntries(
    cohort.map(model => {
      const raw = [radar.scores.get(model)!, analysis.scores.get(model)!]
      const arcScore = arc.get(model)
      let sum = 0,
        radarWeight = 0,
        extraWeight = 0,
        radarRank = 0,
        analysisRank = 0
      for (const other of cohort) {
        const rr = compare(raw[0], radar.scores.get(other)!)
        const ar = compare(raw[1], analysis.scores.get(other)!)
        const arcOther = arc.get(other)
        const useArc = arcScore !== undefined && arcOther !== undefined
        const extra = useArc ? arcPrior : 0
        const total = baseline[0] + baseline[1] + extra
        sum += (rr * baseline[0] + ar * baseline[1] + (useArc ? compare(arcScore, arcOther) * extra : 0)) / total
        radarRank += rr
        analysisRank += ar
        radarWeight += baseline[0] / total
        extraWeight += extra / total
      }
      const rw = Math.round((100 * radarWeight) / cohort.length)
      const ew = Math.round((100 * extraWeight) / cohort.length)
      return [
        model,
        {
          score: Math.round(sum / cohort.length),
          effort: EFFORT,
          cohortSize: cohort.length,
          radarWeight: rw,
          analysisWeight: 100 - rw - ew,
          ...(ew ? { arcWeight: ew } : {}),
          radarScore: Math.round(raw[0] * 100) / 100,
          analysisScore: raw[1],
          disagreement: Math.round(Math.abs(radarRank - analysisRank) / cohort.length),
        },
      ]
    }),
  )
}

async function limitedText(response: Response): Promise<string | null> {
  if (!response.ok || !response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      size += chunk.value.byteLength
      if (size > MAX_PAGE_BYTES) return null
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export class CloudModelIq {
  private lastAttempt: number | null = null
  private cache: Partial<Record<ModelIqSource, IqObservation>> = {}
  private failures: ModelIqSource[] = []
  private pending?: Promise<ModelIqSnapshot>

  constructor(
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>,
    private readonly clock = Date.now,
  ) {}

  private snapshot(): ModelIqSnapshot {
    const { radar, analysis } = this.cache
    return {
      scores: radar && analysis ? aggregateIq(radar, analysis, this.clock()) : {},
      failedSources: this.failures,
      sourceFetchedAt: { radar: radar?.fetchedAt, analysis: analysis?.fetchedAt },
    }
  }

  refresh(force = false): Promise<ModelIqSnapshot> {
    if (this.pending) return this.pending
    const now = this.clock()
    if (
      !force &&
      this.lastAttempt !== null &&
      now - this.lastAttempt < (this.failures.length ? 5 * 60_000 : 60 * 60_000)
    )
      return Promise.resolve(this.snapshot())
    this.lastAttempt = now
    this.pending = Promise.all(
      (['radar', 'analysis'] as const).map(async id => {
        try {
          const response = await this.fetcher(SOURCES[id].url, {
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            signal: AbortSignal.timeout(5_000),
          })
          const text = await limitedText(response)
          const data = text && (id === 'radar' ? parseRadar(text, this.clock()) : parseAnalysis(text, this.clock()))
          if (!data) return id
          this.cache[id] = data
          return null
        } catch {
          return id
        }
      }),
    )
      .then(failures => {
        this.failures = failures.filter((source): source is ModelIqSource => source !== null)
        return this.snapshot()
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
}

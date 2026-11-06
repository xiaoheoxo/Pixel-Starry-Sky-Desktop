import type { ModelTurnUsage, PlatformCharge, TurnUsage } from '@pixelsky/protocol'
import { usageOfModel } from './genTimer'

/** Exact request matching, group checks, and idempotent aggregation across polls. */
export function settleUsage(original: TurnUsage, charges: PlatformCharge[], final: boolean): TurnUsage {
  const settlement = original.settlement!
  const byId = new Map(charges.map(c => [c.requestId, c]))
  const models: Record<string, ModelTurnUsage> = {}
  let missing = 0
  for (const request of settlement.requests) {
    const c = byId.get(request.chargeId ?? request.id)
    const valid =
      c &&
      c.groupId === request.groupId &&
      Number.isFinite(c.costUsd) &&
      c.costUsd >= 0 &&
      [c.input, c.output, c.cacheRead, c.cacheWrite].every(n => Number.isFinite(n) && n >= 0) &&
      (c.billing === 'balance' || c.billing === 'subscription')
    const name = request.model
    const m = (models[name] ??= {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      requests: 0,
      costUsd: 0,
      costSource: 'platform',
    })
    m.requests!++
    if (valid) {
      m.input += c.input
      m.output += c.output
      m.cacheRead += c.cacheRead
      m.cacheWrite += c.cacheWrite
      m.costUsd! += c.costUsd
      m.billing = c.billing
    } else {
      missing++
      m.costSource = final ? 'unavailable' : 'pending'
    }
  }
  for (const [name, m] of Object.entries(models))
    if (m.costSource !== 'platform') {
      const reported = usageOfModel(original.models, name)
      if (reported) {
        m.input = reported.input
        m.output = reported.output
        m.cacheRead = reported.cacheRead
        m.cacheWrite = reported.cacheWrite
      }
      m.costUsd = null
    }
  for (const [name, m] of Object.entries(models)) {
    const { genMs, genOutput, firstTokenMs } = usageOfModel(original.models, name) ?? {}
    Object.assign(m, genMs !== undefined && { genMs, genOutput }, firstTokenMs !== undefined && { firstTokenMs })
  }
  if (!settlement.requests.length) {
    for (const [name, m] of Object.entries(original.models))
      models[name] = { ...m, costUsd: null, costSource: 'unavailable' }
  }
  return {
    ...original,
    models,
    settlement: { ...settlement, complete: missing === 0 && settlement.requests.length > 0 },
  }
}

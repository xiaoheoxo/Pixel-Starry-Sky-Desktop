/** User-entered advisory metadata. It never changes model IDs or real billing. */
export const MODEL_DETAIL_CHANNELS = ['platform', 'claude', 'chatgpt', 'google', 'custom'] as const
export const MODEL_PRICE_CURRENCIES = ['USD', 'CNY', 'EUR'] as const
export const MODEL_DETAIL_MAX_TEXT = 600
export const MAX_MODEL_DETAILS = 500
export type ModelDetailChannel = (typeof MODEL_DETAIL_CHANNELS)[number]
export type ModelTokenPrice = { currency: (typeof MODEL_PRICE_CURRENCIES)[number]; input: number; output: number }
/** Exact public catalog reference; not a subscription, relay, or invoiced price. */
export interface CloudModelReference {
  price?: ModelTokenPrice
  priceExpiresAt?: number
  /** OpenRouter copy, present only when the provider/model ID also exists in Models.dev. */
  description?: string
}
export function currentCloudModelPrice(
  reference: CloudModelReference | undefined,
  now = Date.now(),
): ModelTokenPrice | undefined {
  if (!reference || (reference.priceExpiresAt !== undefined && now >= reference.priceExpiresAt)) return undefined
  return reference.price
}
export interface ModelDetailTarget {
  channel: ModelDetailChannel
  /** Custom endpoint or platform line ID. Null for the direct authorization channels. */
  sourceId: string | null
  model: string
}
export interface ModelDetail {
  main?: string
  evaluator?: string
  price?: ModelTokenPrice
}
export interface ModelDetailPatch {
  target: ModelDetailTarget
  detail: ModelDetail | null
}
export interface ModelMetadataSettings {
  details: Record<string, ModelDetail>
  cloudCatalog: boolean
}
export const modelDetailKey = (target: ModelDetailTarget): string =>
  JSON.stringify([target.channel, target.sourceId, target.model])

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value)
const priceAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000

export function parseModelDetailPatch(input: unknown): ModelDetailPatch | null {
  const value = record(input)
  const target = record(value?.target)
  if (!value || !target || !MODEL_DETAIL_CHANNELS.some(channel => channel === target.channel) || !id(target.model))
    return null
  const channel = target.channel as ModelDetailChannel
  const sourceId = target.sourceId
  if (channel === 'custom' || channel === 'platform' ? !id(sourceId) : sourceId !== null) return null
  const key = { channel, sourceId: sourceId as string | null, model: target.model }
  if (value.detail === null) return { target: key, detail: null }
  const fields = record(value.detail)
  if (!fields) return null
  const detail: ModelDetail = {}
  for (const name of ['main', 'evaluator'] as const) {
    const text = fields[name]
    if (text === undefined) continue
    if (typeof text !== 'string' || text.length > MODEL_DETAIL_MAX_TEXT) return null
    detail[name] = text
  }
  if (fields.price !== undefined) {
    const p = record(fields.price)
    const currency = MODEL_PRICE_CURRENCIES.find(item => item === p?.currency)
    if (!p || !currency || !priceAmount(p.input) || !priceAmount(p.output)) return null
    detail.price = { currency, input: p.input, output: p.output }
  }
  return { target: key, detail: Object.keys(detail).length ? detail : null }
}

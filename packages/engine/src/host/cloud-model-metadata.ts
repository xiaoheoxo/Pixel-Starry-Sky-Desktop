import type { CloudModelReference } from '@pixelsky/protocol'

const PROVIDERS = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  deepseek: 'deepseek',
  xai: 'x-ai',
  zai: 'z-ai',
  moonshotai: 'moonshotai',
  minimax: 'minimax',
  mistral: 'mistralai',
} as const
type Provider = keyof typeof PROVIDERS
const knownHost = (value: string): value is Provider => Object.hasOwn(PROVIDERS, value)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const validPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000

interface Prices {
  byProvider: Map<Provider, Map<string, CloudModelReference>>
}
const empty = (): Prices => ({ byProvider: new Map() })

export function crossCheckCatalogs(modelsDev: unknown, openRouter: unknown): Prices {
  const catalog = empty()
  const rows = obj(openRouter).data
  const descriptions = new Map<string, string>()
  if (Array.isArray(rows))
    for (const row of rows) {
      const { id, description } = obj(row)
      if (typeof id !== 'string' || typeof description !== 'string') continue
      const text = Array.from(
        description
          .replace(/[\u0000-\u001f\u007f]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
        .slice(0, 180)
        .join('')
      if (text) descriptions.set(id, text)
    }
  for (const [key, author] of Object.entries(PROVIDERS)) {
    const provider = key as Provider
    const models = new Map<string, CloudModelReference>()
    for (const [id, data] of Object.entries(obj(obj(obj(modelsDev)[key]).models))) {
      const raw = obj(data)
      if ((raw.id !== undefined && raw.id !== id) || !/^[a-z0-9][a-z0-9.-]{0,199}$/.test(id)) continue
      const { input, output } = obj(raw.cost)
      const description = descriptions.get(`${author}/${id}`)
      if (!description && (!validPrice(input) || !validPrice(output))) continue
      models.set(id, {
        ...(validPrice(input) && validPrice(output) ? { price: { currency: 'USD', input, output } } : {}),
        ...(description ? { description } : {}),
      })
    }
    if (models.size) catalog.byProvider.set(provider, models)
  }
  return catalog
}

export function pickCloudReference(catalog: Prices, provider: string, id: string): CloudModelReference | undefined {
  if (!knownHost(provider)) return undefined
  const [author, model, extra] = id.split('/')
  if (extra !== undefined) return undefined
  if (model !== undefined && author !== provider && author !== PROVIDERS[provider]) return undefined
  return catalog.byProvider.get(provider)?.get(model ?? author)
}

export class CloudModelMetadata {
  private state = empty()
  private fetchedAt = 0
  private pending?: Promise<void>

  constructor(private readonly fetcher?: typeof fetch) {}

  refresh(): Promise<void> {
    if (!this.fetcher || Date.now() - this.fetchedAt < 60 * 60_000) return Promise.resolve()
    if (this.pending) return this.pending
    const read = async (url: string): Promise<unknown> => {
      try {
        const response = await this.fetcher!(url, {
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(1_800),
        })
        return response.ok ? await response.json() : null
      } catch {
        return null
      }
    }
    this.pending = Promise.all([read('https://models.dev/api.json'), read('https://openrouter.ai/api/v1/models')])
      .then(([dev, router]) => {
        this.fetchedAt = Date.now()
        if (dev) this.state = crossCheckCatalogs(dev, router)
      })
      .finally(() => (this.pending = undefined))
    return this.pending
  }

  get(provider: string, id: string): CloudModelReference | undefined {
    return pickCloudReference(this.state, provider, id)
  }
}

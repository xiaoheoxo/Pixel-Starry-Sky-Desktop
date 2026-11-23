import { currentCloudModelPrice, GPT56_SOL_PROMO_END, type CloudModelReference } from '@pixelsky/protocol'

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

const IDENT = /^[a-z0-9][a-z0-9.-]{0,199}$/
const authorId = (name: string): string => (knownHost(name) ? PROVIDERS[name] : name === 'grok' ? 'x-ai' : name)
export type DisplayCatalog = Map<string, Map<string, CloudModelReference>>

/** Display prices are public references, not a relay's actual invoice. */
export function displayCatalog(router: unknown, verified: Prices, now: number): DisplayCatalog {
  const result: DisplayCatalog = new Map()
  const insert = (author: string, id: string, reference: CloudModelReference) => {
    const candidates = result.get(id) ?? new Map()
    candidates.set(author, reference)
    result.set(id, candidates)
  }
  const rows = obj(router).data
  if (Array.isArray(rows)) {
    for (const item of rows) {
      const row = obj(item)
      if (typeof row.id !== 'string') continue
      const [author, id, extra] = row.id.split('/')
      if (extra !== undefined || !IDENT.test(author) || !id || !IDENT.test(id)) continue
      const priceValue = (value: unknown) =>
        typeof value === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
          ? Number((Number(value) * 1_000_000).toPrecision(12))
          : NaN
      const input = priceValue(obj(row.pricing).prompt)
      const output = priceValue(obj(row.pricing).completion)
      const description =
        typeof row.description === 'string'
          ? row.description
              .replace(/[\u0000-\u001f\u007f]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 240)
          : ''
      insert(authorId(author), id, {
        ...(validPrice(input) && validPrice(output)
          ? { price: { currency: 'USD', input, output }, priceExpiresAt: now + 86_400_000 }
          : {}),
        ...(description ? { description } : {}),
      })
    }
  }
  // Models.dev official pricing wins when it has the same canonical ID.
  for (const [provider, models] of verified.byProvider) {
    for (const [id, entry] of models) {
      const author = authorId(provider)
      const publicEntry = result.get(id)?.get(author)
      const description = publicEntry?.description ?? entry.description
      insert(author, id, { ...publicEntry, ...entry, ...(description ? { description } : {}) })
    }
  }
  return result
}

export function matchDisplayModel(catalog: DisplayCatalog, raw: string): CloudModelReference | undefined {
  if (raw.length > 300) return undefined
  const parts = raw.trim().toLowerCase().split('/')
  if (parts.length > 2 || parts.some(part => !IDENT.test(part))) return undefined
  const [namespace, id] = parts.length === 2 ? parts : [undefined, parts[0]]
  if (!id) return undefined
  const candidates = catalog.get(id)
  if (!candidates) return undefined
  if (!namespace) return candidates.size === 1 ? candidates.values().next().value : undefined
  const direct = candidates.get(authorId(namespace))
  if (direct) return direct
  // A relay suffix may change the route name, never the version/model slug.
  const possible = new Set<string>()
  for (let i = namespace.indexOf('-'); i >= 0; i = namespace.indexOf('-', i + 1)) {
    const author = authorId(namespace.slice(0, i))
    if (candidates.has(author)) possible.add(author)
  }
  return possible.size === 1 ? candidates.get([...possible][0]) : undefined
}

export class CloudModelMetadata {
  private state = empty()
  private display: DisplayCatalog = new Map()
  private lastAttempt: number | null = null
  private pending?: Promise<void>

  constructor(
    private readonly fetcher?: typeof fetch,
    private readonly clock = Date.now,
  ) {}

  refresh(force = false): Promise<void> {
    if (this.pending) return this.pending
    if (
      !this.fetcher ||
      (this.lastAttempt !== null && this.clock() - this.lastAttempt < (force ? 15_000 : 60 * 60_000))
    )
      return Promise.resolve()
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
        const now = this.clock()
        this.lastAttempt = now
        if (!dev && !router) return
        const next = dev ? crossCheckCatalogs(dev, router) : this.state
        for (const [provider, models] of next.byProvider) {
          for (const [id, entry] of models) {
            if (!dev || !entry.price) continue
            const promo =
              provider === 'openai' && id === 'gpt-5.6-sol' && entry.price.input === 4 && entry.price.output === 20
            entry.priceExpiresAt = Math.min(now + 24 * 60 * 60_000, promo ? GPT56_SOL_PROMO_END : Infinity)
          }
        }
        this.state = next
        // Keep the last successful display source if OpenRouter is temporarily unavailable.
        const latest = displayCatalog(router, next, now)
        for (const [id, authors] of this.display) {
          for (const [author, old] of authors) {
            const fresh = latest.get(id)?.get(author)
            if (fresh || !router) {
              const byAuthor = latest.get(id) ?? new Map()
              byAuthor.set(author, { ...old, ...fresh })
              latest.set(id, byAuthor)
            }
          }
        }
        this.display = latest
      })
      .finally(() => (this.pending = undefined))
    return this.pending
  }

  async displayReferences(ids: readonly string[], force = false): Promise<Record<string, CloudModelReference>> {
    if (!ids.length) return {}
    await this.refresh(force)
    return Object.fromEntries(
      ids.flatMap(id => {
        const found = matchDisplayModel(this.display, id)
        if (!found) return []
        if (currentCloudModelPrice(found, this.clock())) return [[id, found]]
        return found.description ? [[id, { description: found.description }]] : []
      }),
    )
  }

  get(provider: string, id: string): CloudModelReference | undefined {
    const reference = pickCloudReference(this.state, provider, id)
    if (!reference || currentCloudModelPrice(reference, this.clock()) || !reference.price) return reference
    return reference.description ? { description: reference.description } : undefined
  }
}

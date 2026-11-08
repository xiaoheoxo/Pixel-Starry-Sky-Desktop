import { describe, expect, it } from 'vitest'
import { speedExtension, SPEED_COMMAND } from '../src/extensions/speed.ts'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'

type Json = Record<string, unknown>
interface Options {
  onPayload?: (payload: Json, model: unknown) => unknown
  onProviderStreamEvent?: (data: unknown, model: unknown) => void
}
interface Provider {
  id: string
  auth: { sentinel: boolean }
  getModels: () => Json[]
  stream: (model: unknown, context: unknown, options: Options) => void
  streamSimple: Provider['stream']
}

function setup() {
  const reports: Record<string, unknown>[] = []
  const hooks: Record<string, (event: unknown, ctx: ExtensionContext) => unknown> = {}
  let command!: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  const model = { id: 'reasoner', provider: 'test', api: 'openai-responses', serviceTiers: ['priority', 'ultrafast'] }
  let options: Options
  let provider: Provider = {
    id: 'test',
    auth: { sentinel: true },
    getModels: () => [model],
    stream: (_m, _c, o) => {
      options = o
    },
    streamSimple: (_m, _c, o) => {
      options = o
    },
  }
  let idle = true
  const ctx = {
    model,
    isIdle: () => idle,
    ui: { setStatus: (_k: string, v: string) => reports.push(JSON.parse(v)) },
    modelRegistry: {
      getAll: () => [model],
      getProvider: () => provider,
      registerProvider: (p: Provider) => {
        provider = p
      },
    },
  } as unknown as ExtensionContext
  speedExtension({
    on: (name: string, fn: (typeof hooks)[string]) => {
      hooks[name] = fn
    },
    registerCommand: (name: string, c: typeof command) => {
      expect(name).toBe(SPEED_COMMAND)
      command = c
    },
  } as never)
  hooks.session_start({}, ctx)
  return {
    reports,
    provider: () => provider,
    set: (value: string) => command.handler(value + ' req', ctx),
    busy: () => {
      idle = false
    },
    payload: async (stream: 'stream' | 'streamSimple' = 'streamSimple') => {
      provider[stream](model, {}, { onPayload: v => ({ ...v, kept: true }) })
      return options!.onPayload!({ service_tier: 'ultrafast' }, model)
    },
    response: () => options!.onProviderStreamEvent!({ response: { service_tier: 'default' } }, model),
  }
}
describe('Pixel speed extension', () => {
  it('maps all three tiers, preserves prior payload hooks and provider auth, and reports upstream downgrade', async () => {
    const r = setup()
    expect(r.provider().auth).toEqual({ sentinel: true })
    expect(await r.payload()).toEqual({ service_tier: 'default', kept: true })
    await r.set('fast')
    expect(await r.payload()).toMatchObject({ service_tier: 'priority' })
    await r.set('ultrafast')
    expect(await r.payload('stream')).toMatchObject({ service_tier: 'ultrafast' })
    r.response()
    expect(r.reports.at(-1)).toMatchObject({ requestedTier: 'ultrafast', actualTier: 'default' })
    await r.set('off')
    expect(await r.payload()).toMatchObject({ service_tier: 'default' })
  })
  it('rejects changes during a request and every independent process starts ordinary', async () => {
    const r = setup()
    await r.set('fast')
    r.busy()
    await r.set('ultrafast')
    expect(r.reports.at(-1)?.error).toBeTruthy()
    expect(await r.payload()).toMatchObject({ service_tier: 'priority' })
    expect(await setup().payload()).toMatchObject({ service_tier: 'default' })
  })
})

// Pixel 主会话速度。包一层 provider，普通请求、重试和压缩都经过同一处；认证和模型目录原样保留。
import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
// 纯协议函数，无运行时依赖；源码 CLI 与独立 bundle 共用同一判断。
import { pixelSpeedCapability, pixelSpeedTier, type PixelSpeed } from '../../../protocol/src/pixel-speed.ts'

export const SPEED_COMMAND = 'pixelsky-speed'
export const SPEED_STATUS = 'pixelsky-speed'
type Json = Record<string, unknown>
const object = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})

export const speedExtension: ExtensionFactory = pi => {
  let speed: PixelSpeed = 'off'
  let report: (extra?: Json) => void = () => {}
  const wrapped = new WeakSet<object>()
  const install = (ctx: ExtensionContext) => {
    report = (extra = {}) =>
      ctx.ui.setStatus(
        SPEED_STATUS,
        JSON.stringify({
          version: 1,
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
          ...pixelSpeedCapability(ctx.model),
          speed,
          ...extra,
        }),
      )
    // 旁聊、子任务是独立进程，初始始终 off，不读主会话的加速环境变量。
    for (const id of new Set(ctx.modelRegistry.getAll().map(m => m.provider))) {
      const provider = ctx.modelRegistry.getProvider(id)
      if (!provider || wrapped.has(provider.streamSimple)) continue
      const optionsFor = <T extends { onPayload?: unknown; onProviderStreamEvent?: unknown }>(
        model: { api: string; provider: string; id: string },
        options: T | undefined,
      ): T => {
        if (!['openai-responses', 'openai-codex-responses'].includes(model.api)) return options as T
        const caps = pixelSpeedCapability(model)
        const effective =
          speed === 'ultrafast' && caps.ultrafast ? speed : speed !== 'off' && caps.fast ? 'fast' : 'off'
        const tier = pixelSpeedTier(effective)
        const before = options?.onPayload as ((payload: unknown, model: unknown) => unknown) | undefined
        const streamed = options?.onProviderStreamEvent as ((data: unknown, model: unknown) => void) | undefined
        return {
          ...options,
          serviceTier: tier,
          onPayload: async (payload: unknown, requestModel: unknown) => {
            const next = await before?.(payload, requestModel)
            report({ model: `${model.provider}/${model.id}`, requestedTier: tier, actualTier: null })
            return { ...object(next === undefined ? payload : next), service_tier: tier }
          },
          onProviderStreamEvent: (data: unknown, requestModel: unknown) => {
            const event = object(data),
              response = object(event.response)
            if (typeof response.service_tier === 'string')
              report({ model: `${model.provider}/${model.id}`, requestedTier: tier, actualTier: response.service_tier })
            streamed?.(data, requestModel)
          },
        } as unknown as T
      }
      const next: typeof provider = {
        ...provider,
        stream: (model, context, options) => provider.stream(model, context, optionsFor(model, options)),
        streamSimple: (model, context, options) => provider.streamSimple(model, context, optionsFor(model, options)),
      }
      wrapped.add(next.streamSimple)
      ctx.modelRegistry.registerProvider(next)
    }
    report()
  }
  pi.on('session_start', (_event, ctx) => install(ctx))
  pi.on('model_select', (_event, ctx) => install(ctx))
  pi.registerCommand(SPEED_COMMAND, {
    description: 'Set the service tier for subsequent requests: off | fast | ultrafast',
    handler: async (args, ctx) => {
      install(ctx)
      const [next, req = ''] = args.trim().split(/\s+/)
      const caps = pixelSpeedCapability(ctx.model)
      let error = ''
      if (!['off', 'fast', 'ultrafast', 'status'].includes(next)) error = 'Invalid speed'
      else if (next !== 'status' && !ctx.isIdle()) error = 'Speed changes apply after the current turn'
      else if ((next === 'fast' && !caps.fast) || (next === 'ultrafast' && !caps.ultrafast))
        error = 'This model or route has no confirmed support for this service tier'
      else if (next !== 'status') speed = next as PixelSpeed
      report({ req, error })
    },
  })
}

// 自定义模型地址：桌面端（经本机网关）或用户环境里的 ANTHROPIC_BASE_URL / OPENAI_BASE_URL。
// 以前桌面端给每个会话写一个临时配置目录放 models.json，结果用户自己 ~/.pixelsky-cli/agent/ 下的
// mcp.json、技能、扩展、bin/ 全都看不到；现在改成扩展里 pi.registerProvider()，配置目录始终是用户自己的。
// 只用可擦除的 TS 语法。
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { enrichModel, findBuiltin, inferredOf } from './builtin-models.ts'
import {
  SUBAGENT_ENV,
  SUBAGENT_PROVIDER,
  SUBAGENT_TYPE_ENV,
  chosenRoute,
  subagentProviderConfig,
  subagentTypes,
} from '../tools/subagent.ts'

/** 桌面端适配器给的 provider 配置（JSON，结构同 models.json 的 providers，不含密钥：apiKey 写 $PIXELSKY_PIXEL_TOKEN） */
export const PROVIDERS_ENV = 'PIXELSKY_PIXEL_PROVIDERS'

type Json = Record<string, unknown>

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

/** 补齐 registerProvider 要的模型字段，默认值和 Pi 读 models.json 时一样（provider-composer.js modelFromJson） */
export function modelDefaults(model: Json): Json {
  const id = typeof model.id === 'string' ? model.id : ''
  return {
    name: id,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...model,
  }
}

/** 按 Pi 内置表补全一个 provider 的模型（builtin-models.ts）；all 是 Pi 的全部模型，没有时原样返回 */
function enriched(name: string, config: Json, models: Json[], env: NodeJS.ProcessEnv, all?: readonly Json[]): Json[] {
  if (!all) return models
  const api = typeof config.api === 'string' ? config.api : ''
  const inferred = inferredOf(env, name)
  return models.map(m => {
    const id = typeof m.id === 'string' ? m.id : ''
    return enrichModel(m, api, findBuiltin(id, api, all), inferred[id] ?? [])
  })
}

/**
 * 要注册的 provider：桌面端给的优先；没给时按用户环境里的 *_BASE_URL 覆盖内置 provider 的地址（Pi 本身不认这两个变量）。
 * 配置不合法时返回空并给出原因，不让整个命令行起不来。all：Pi 的全部模型，给了就按内置表补全模型字段
 */
export function gatewayProviders(
  env: NodeJS.ProcessEnv,
  all?: readonly Json[],
): { providers: Array<[string, Json]>; warning?: string } {
  const raw = env[PROVIDERS_ENV]?.trim()
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { providers: [], warning: `${PROVIDERS_ENV} is not valid JSON; ignored` }
    }
    const providers: Array<[string, Json]> = []
    for (const [name, value] of Object.entries(object(parsed))) {
      const config = { ...object(value) }
      if (Array.isArray(config.models))
        config.models = enriched(name, config, config.models.map(object), env, all).map(m => modelDefaults(m))
      providers.push([name, config])
    }
    return { providers }
  }
  const providers: Array<[string, Json]> = []
  if (env.ANTHROPIC_BASE_URL?.trim()) providers.push(['anthropic', { baseUrl: env.ANTHROPIC_BASE_URL.trim() }])
  if (env.OPENAI_BASE_URL?.trim()) providers.push(['openai', { baseUrl: env.OPENAI_BASE_URL.trim() }])
  return { providers }
}

/** 子智能体这个类型单独的站点（桌面端设置 › 子智能体）：只在子智能体的子进程里注册，主会话的模型列表里看不到 */
export function subagentProvider(env: NodeJS.ProcessEnv, all?: readonly Json[]): [string, Json] | null {
  if (env[SUBAGENT_ENV] !== '1') return null
  const type = subagentTypes(env).find(t => t.id === env[SUBAGENT_TYPE_ENV])
  // 主模型调度：主模型选的路线优先
  const route = chosenRoute(env) ?? type?.route
  const config = type && route ? subagentProviderConfig({ ...type, route }, env) : null
  if (!route || !config) return null
  const api = String(config.api ?? '')
  // 推理开关、图片是 subagentProviderConfig 猜的（站点没写明图片时），再加上桌面端标的
  const inferred = ['reasoning', ...('input' in route.model ? [] : ['input']), ...(route.inferred ?? [])]
  const models = (config.models as Json[]).map(m =>
    all ? enrichModel(m, api, findBuiltin(String(m.id ?? ''), api, all), inferred) : m,
  )
  return [SUBAGENT_PROVIDER, { ...config, models: models.map(m => modelDefaults(m)) }]
}

/** 注册桌面端的 provider；all 给了就按 Pi 内置表补全模型字段。返回有没有注册带模型的 provider */
function register(pi: ExtensionAPI, all?: readonly Json[]): boolean {
  const { providers, warning } = gatewayProviders(process.env, all)
  if (warning && !all) console.error(warning)
  for (const [name, config] of providers) pi.registerProvider(name, config as never)
  const sub = subagentProvider(process.env, all)
  if (sub) pi.registerProvider(sub[0], sub[1] as never)
  return !!sub || providers.some(([, config]) => Array.isArray(config.models))
}

export const gatewayExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  if (!register(pi)) return
  // 加载扩展时还拿不到模型表：会话开始时按 Pi 内置的同名模型补全后再注册一次（builtin-models.ts）
  pi.on('session_start', (_event, ctx) => {
    try {
      register(pi, ctx.modelRegistry.getAll() as unknown as Json[])
    } catch (error) {
      console.error(`gateway: could not match built-in models: ${(error as Error).message}`)
    }
  })
}

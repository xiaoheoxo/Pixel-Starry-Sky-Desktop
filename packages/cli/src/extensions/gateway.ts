// 自定义模型地址：桌面端（经本机网关）或用户环境里的 ANTHROPIC_BASE_URL / OPENAI_BASE_URL。
// 以前桌面端给每个会话写一个临时配置目录放 models.json，结果用户自己 ~/.pixelsky-cli/agent/ 下的
// mcp.json、技能、扩展、bin/ 全都看不到；现在改成扩展里 pi.registerProvider()，配置目录始终是用户自己的。
// 只用可擦除的 TS 语法。
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  SUBAGENT_ENV,
  SUBAGENT_PROVIDER,
  SUBAGENT_TYPE_ENV,
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

/**
 * 要注册的 provider：桌面端给的优先；没给时按用户环境里的 *_BASE_URL 覆盖内置 provider 的地址（Pi 本身不认这两个变量）。
 * 配置不合法时返回空并给出原因，不让整个命令行起不来。
 */
export function gatewayProviders(env: NodeJS.ProcessEnv): { providers: Array<[string, Json]>; warning?: string } {
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
      if (Array.isArray(config.models)) config.models = config.models.map(m => modelDefaults(object(m)))
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
export function subagentProvider(env: NodeJS.ProcessEnv): [string, Json] | null {
  if (env[SUBAGENT_ENV] !== '1') return null
  const type = subagentTypes(env).find(t => t.id === env[SUBAGENT_TYPE_ENV])
  const config = type ? subagentProviderConfig(type, env) : null
  if (!config) return null
  return [SUBAGENT_PROVIDER, { ...config, models: (config.models as Json[]).map(m => modelDefaults(m)) }]
}

export const gatewayExtension: ExtensionFactory = (pi: ExtensionAPI) => {
  const { providers, warning } = gatewayProviders(process.env)
  if (warning) console.error(warning)
  for (const [name, config] of providers) pi.registerProvider(name, config as never)
  const sub = subagentProvider(process.env)
  if (sub) pi.registerProvider(sub[0], sub[1] as never)
}

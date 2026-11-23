// 像素星空会话的网关环境变量（docs/own-cli.md §12）：按线路 / 接口的协议选 Pi 的 API 种类和本机地址。
// 不依赖 electron，单独测。
import { looksVisual } from '@pixelsky/protocol'
import type { ProviderModel, ProviderProtocol } from '../../shared/types/providers'
import type { PlatformGroupInfo } from '../../shared/types/platform-catalog'
import { platformModelApi } from '../../shared/platform-models'

export type PixelApi = 'anthropic-messages' | 'openai-responses' | 'openai-completions'

/** 上游原生是 Responses 的云端平台：分组两种协议都给时走 Responses（grok 的 Messages 是 Sub2api 转成 Responses 发的） */
const RESPONSES_PLATFORMS = new Set(['openai', 'grok'])

/**
 * 会话用哪种协议：自定义 API 看接口的协议；平台先看官方模型，再看分组声明的 supported_apis，都给或没声明时看分组的 platform。
 * 模型没有命名约定、分组也还没读到时按 Anthropic（和以前一样）。
 */
export function pixelApi(source: {
  protocol?: ProviderProtocol | null
  groupPlatform?: string | null
  /** 分组目录里的 supported_apis（messages / responses） */
  groupApis?: readonly string[] | null
  model?: string | null
}): PixelApi {
  if (source.protocol === 'chat') return 'openai-completions'
  if (source.protocol === 'responses') return 'openai-responses'
  if (source.protocol === 'anthropic') return 'anthropic-messages'
  const api = platformModelApi(source.model)
  if (api) return api === 'responses' ? 'openai-responses' : 'anthropic-messages'
  const apis = source.groupApis ?? []
  const messages = apis.includes('messages'),
    responses = apis.includes('responses')
  if (messages !== responses) return responses ? 'openai-responses' : 'anthropic-messages'
  return RESPONSES_PLATFORMS.has(source.groupPlatform ?? '') ? 'openai-responses' : 'anthropic-messages'
}

/**
 * Pi 的 Anthropic 客户端自己补 /v1/messages，地址不带 /v1；OpenAI 的 SDK 把 /responses、/chat/completions 接在地址后面，
 * 所以 OpenAI 两种要带 /v1，网关收到的才是 /v1/responses、/v1/chat/completions（不会变成 /v1/v1/…）。
 */
export function pixelBaseUrl(api: PixelApi, port: number): string {
  return `http://127.0.0.1:${port}${api === 'anthropic-messages' ? '' : '/v1'}`
}

const urlHas = (url: string, ...parts: string[]): boolean => parts.some(p => url.includes(p))

/** 只收 max_completion_tokens 的 OpenAI 推理模型（gpt-5 起、o 系列、codex），经转售接口时按名字认 */
const OPENAI_REASONING = /^(?:[\w.-]+\/)?(?:gpt-(?:[5-9]|\d{2,})|o\d+(?:-|$)|codex)/i

/**
 * Chat Completions 的兼容性：Pi 按 baseUrl 猜对方是谁（openai-completions.js 的 detectCompat），但我们给它的是本机网关地址，
 * 猜不出来，所以这里按真实接口地址用同一套判断写进模型的 compat。认不出的地址（多是转售接口）保守：不发 store、
 * 不用 developer 角色；OpenAI 推理模型用 max_completion_tokens，其余 max_tokens；Grok 不收 reasoning_effort。
 * 没写的字段 Pi 按默认值（标准 OpenAI）走，命令行还会按 Pi 内置表补上跟着模型走的（builtin-models.ts）
 */
export function chatCompat(upstreamBaseUrl: string | null, model = ''): Record<string, unknown> {
  const url = (upstreamBaseUrl ?? '').toLowerCase()
  const zai = urlHas(url, 'api.z.ai', 'open.bigmodel.cn')
  const together = urlHas(url, 'api.together.ai', 'api.together.xyz')
  const moonshot = urlHas(url, 'api.moonshot.', 'api.kimi.com')
  const openrouter = url.includes('openrouter.ai')
  const cfWorkers = url.includes('api.cloudflare.com')
  const cfGateway = url.includes('gateway.ai.cloudflare.com')
  const nvidia = url.includes('integrate.api.nvidia.com')
  const antLing = url.includes('api.ant-ling.com')
  const cerebras = url.includes('cerebras.ai')
  const deepseek = url.includes('deepseek.com')
  const grok = url.includes('api.x.ai')
  const chutes = url.includes('chutes.ai')
  const opencode = url.includes('opencode.ai')
  const openai = url.includes('api.openai.com')
  const azure = /\.(?:openai\.azure|cognitiveservices\.azure|services\.ai\.azure)\.com/.test(url)
  const nonStandard =
    nvidia ||
    cerebras ||
    grok ||
    together ||
    chutes ||
    deepseek ||
    zai ||
    moonshot ||
    opencode ||
    cfWorkers ||
    cfGateway ||
    antLing
  const base = { supportsUsageInStreaming: true }
  if (!nonStandard && !openrouter && !openai && !azure)
    return {
      ...base,
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: OPENAI_REASONING.test(model) ? 'max_completion_tokens' : 'max_tokens',
      ...(/grok/i.test(model) ? { supportsReasoningEffort: false } : {}),
    }
  const maxTokens = chutes || deepseek || moonshot || cfGateway || together || nvidia || antLing || zai
  const routedVendor = openrouter && /^(?:anthropic|openai)\//i.test(model)
  return {
    ...base,
    // Azure 旧版 API 不认 store、developer：都用默认值（不发 store、system 角色），推理模型照样能用
    supportsStore: !nonStandard && !azure,
    supportsDeveloperRole: routedVendor || (!nonStandard && !openrouter && !azure),
    supportsReasoningEffort: !grok && !zai && !moonshot && !together && !cfGateway && !nvidia && !antLing,
    maxTokensField: maxTokens ? 'max_tokens' : 'max_completion_tokens',
    ...(deepseek ? { requiresReasoningContentOnAssistantMessages: true } : {}),
    thinkingFormat: deepseek
      ? 'deepseek'
      : zai
        ? 'zai'
        : together
          ? 'together'
          : antLing
            ? 'ant-ling'
            : openrouter
              ? 'openrouter'
              : 'openai',
    ...(openrouter && /^anthropic\//i.test(model) ? { cacheControlFormat: 'anthropic' } : {}),
    ...(together || cfWorkers || cfGateway || nvidia || antLing ? { supportsLongCacheRetention: false } : {}),
  }
}

/**
 * 厂商自己的接口（DeepSeek、Kimi、智谱）：Pi 内置表里这家模型自己的 compat 比按地址认的更准（例如 Kimi k3 收 reasoning_effort、
 * K2 用 DeepSeek 式的思考参数），和 Pi 自己一样以模型的为准，所以把 compat 标成猜的
 */
function vendorOwnChat(upstreamBaseUrl: string | null): boolean {
  return urlHas(
    (upstreamBaseUrl ?? '').toLowerCase(),
    'deepseek.com',
    'api.z.ai',
    'open.bigmodel.cn',
    'api.moonshot.',
    'api.kimi.com',
  )
}

/**
 * Anthropic 协议的第三方接口（不是 api.anthropic.com 的自定义接口；云端线路里不是 Claude 的模型，如 DeepSeek、智谱、Kimi 分组）：
 * 和 Pi 给 Fireworks 这类兼容接口的设置一样，不发 Anthropic 才有的工具字段（eager_input_streaming、工具上的 cache_control）、
 * 不用 1 小时缓存，思考块没有签名也照样回传
 */
export const THIRD_PARTY_ANTHROPIC_COMPAT: Readonly<Record<string, unknown>> = {
  supportsEagerToolInputStreaming: false,
  supportsCacheControlOnTools: false,
  supportsLongCacheRetention: false,
  allowEmptySignature: true,
}

/**
 * 经网关的一个模型要写明的 compat，和命令行可以按 Pi 内置表改的字段（inferred，见 builtin-models.ts）。
 * upstreamBaseUrl：自定义接口的真实地址；云端线路为 null
 */
export function pixelModelCompat(
  api: PixelApi,
  upstreamBaseUrl: string | null,
  model: string,
): { compat?: Record<string, unknown>; inferred?: string[] } {
  if (api === 'openai-completions')
    return {
      compat: chatCompat(upstreamBaseUrl, model),
      ...(vendorOwnChat(upstreamBaseUrl) ? { inferred: ['compat'] } : {}),
    }
  if (api !== 'anthropic-messages') return {}
  const thirdParty =
    upstreamBaseUrl === null
      ? platformModelApi(model) !== 'messages'
      : !/^https?:\/\/api\.anthropic\.com(?:[/:]|$)/i.test(upstreamBaseUrl.trim())
  return thirdParty ? { compat: { ...THIRD_PARTY_ANTHROPIC_COMPAT } } : {}
}

/** 「看图」→ Pi 模型定义的 input */
const imageInput = (images: boolean): string[] => (images ? ['text', 'image'] : ['text'])

/** 去掉 Claude Code 的 1M 上下文后缀：像素星空把模型名原样发出去，上游不认 `[1m]` */
export function stripLongContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/i, '')
}

export function pixelGatewayEnv(options: {
  port: number
  secret: string
  api: PixelApi
  /** 自定义接口里的模型；平台线路没有，只用会话当前的 */
  models?: ProviderModel[]
  model: string | null
  /** 自定义接口的真实地址（给 Chat Completions、第三方 Anthropic 接口选兼容性）；云端线路不给 */
  upstreamBaseUrl?: string | null
}): Record<string, string> {
  const ids = (options.models ?? []).map(m => ({
    id: m.id,
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    // 用户指定了「看图」：写明 input，命令行不再按 Pi 内置表改
    ...(typeof m.images === 'boolean' ? { input: imageInput(m.images) } : {}),
  }))
  const list = ids.length ? ids : options.model ? [{ id: options.model }] : []
  // inferred 不是 Pi 的字段：引擎（pixelModelsConfig）取出来并进 PIXELSKY_PIXEL_INFERRED。
  // 用户没指定「看图」的不写图片：引擎按协议和名字定默认值并标成猜的，Pi 内置表里收图的模型（如 kimi-k3）照样能发图
  const models = list.map(m => ({ ...m, ...pixelModelCompat(options.api, options.upstreamBaseUrl ?? null, m.id) }))
  return {
    PIXELSKY_PIXEL_BASE_URL: pixelBaseUrl(options.api, options.port),
    PIXELSKY_PIXEL_TOKEN: options.secret,
    PIXELSKY_PIXEL_API: options.api,
    ...(models.length ? { PIXELSKY_PIXEL_MODELS: JSON.stringify(models) } : {}),
  }
}

/**
 * 子智能体一个类型单独的站点（设置 › 子智能体，docs/ui/subagent-routing.md）：写进 PIXELSKY_SUBAGENT_TYPES 的 route，
 * 结构对应命令行 packages/cli/src/tools/subagent.ts 的 SubagentRoute；密钥另放在 token 指的环境变量里
 */
export function pixelSubagentRoute(options: {
  api: PixelApi
  model: string
  /** 自定义接口里这个模型的上下文窗口 */
  contextWindow?: number | null
  /** 自定义接口里给这个模型指定的「看图」；不填按协议和模型名猜 */
  images?: boolean | null
  /** 接口里没写窗口时按模型系列猜的（engine pixelAutoWindow），命令行在 Pi 内置表里找到同名模型时以内置的为准 */
  autoContextWindow?: number | null
  upstreamBaseUrl?: string | null
  /** 站点名，显示在子智能体卡片上 */
  label: string
  token: string
}): { api: PixelApi; model: Record<string, unknown>; label: string; token: string; inferred?: string[] } {
  const { compat, inferred: compatInferred = [] } = pixelModelCompat(
    options.api,
    options.upstreamBaseUrl ?? null,
    options.model,
  )
  const window = options.contextWindow || options.autoContextWindow
  // 图片：用户指定了就写明；没指定时命令行按协议定默认值（Chat 只给文字），名字一看就能看图的这里先标上能，
  // 都算猜的，Pi 内置表里有这个模型时以内置的为准
  const images = typeof options.images === 'boolean'
  const visual = !images && options.api === 'openai-completions' && looksVisual(options.model)
  const inferred = [
    ...(!options.contextWindow && options.autoContextWindow ? ['contextWindow'] : []),
    ...(visual ? ['input'] : []),
    ...compatInferred,
  ]
  return {
    api: options.api,
    model: {
      id: options.model,
      ...(window ? { contextWindow: window } : {}),
      ...(images ? { input: imageInput(options.images!) } : visual ? { input: imageInput(true) } : {}),
      ...(compat ? { compat } : {}),
    },
    label: options.label,
    token: options.token,
    ...(inferred.length ? { inferred } : {}),
  }
}

/** 引擎能用哪些接口协议：一份在 shared，渲染层也用它 */
export { engineProviderProtocols } from '../../shared/provider-protocols'

/** 线路目录里这个分组能给哪个引擎用（没写 supported_engines 的按 platform 推：openai → Codex、像素星空；其余 → Claude Code、像素星空） */
export function groupEngines(group: Pick<PlatformGroupInfo, 'platform' | 'supported_engines'>): string[] {
  const engines = group.supported_engines ?? (group.platform === 'openai' ? ['codex', 'pixel'] : ['claude', 'pixel'])
  // 像素星空两种协议都会说：目录里写了 claude 或 codex 的线路它也能用
  const all =
    engines.includes('pixel') || !(engines.includes('claude') || engines.includes('codex'))
      ? engines
      : [...engines, 'pixel']
  // oh-my-pi 和像素星空同一套协议：像素星空能用的线路它也能用
  return all.includes('pixel') && !all.includes('omp') ? [...all, 'omp'] : all
}

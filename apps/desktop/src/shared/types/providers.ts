// 自定义 API（docs/ui/custom-api.md）：主进程和设置页之间传的接口配置。Key 和附加请求头的值只在主进程里
// chat：OpenAI Chat Completions（DeepSeek、OpenRouter 等兼容接口），只有像素星空能用；老版本读到会当成 anthropic，不会崩
export type ProviderProtocol = 'anthropic' | 'responses' | 'chat'
export type ProviderAuth = 'x-api-key' | 'bearer'
export type ProviderTemplate = 'anthropic' | 'openai' | 'custom'

export interface ProviderModel {
  id: string
  /** 上下文长度（token），选填 */
  contextWindow?: number | null
  /** 计价参照：按哪个官方模型估算费用；不填按模型名自动对 */
  priceRef?: string | null
  /** 像素星空能不能给它发图片：true 支持 / false 不支持；不填按协议和模型名自动判断（protocol 的 autoImageInput） */
  images?: boolean | null
}

/** 给设置页看的接口：Key 只剩末 4 位，请求头只给名字 */
export interface ProviderView {
  id: string
  name: string
  template: ProviderTemplate
  protocol: ProviderProtocol
  baseUrl: string
  auth: ProviderAuth
  models: ProviderModel[]
  /** 仅 Anthropic 协议：Claude Code 做标题、摘要等小任务用的模型；null 用列表第一个 */
  smallModel: string | null
  /** 请求的模型不在列表里时换成后台小模型或当前模型 */
  modelFallback: boolean
  /** 费用倍率：估算的官方价乘它（中转站打折，例如 0.3）；null 按 1 */
  costMultiplier?: number | null
  /** Key 末 4 位；null 表示没有 Key（或系统加密不可用、重启后丢了） */
  keyHint: string | null
  headerNames: string[]
  /** 明文 http（只允许本机和内网） */
  insecure: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderInput {
  /** 没有 id 是新建 */
  id?: string
  name: string
  template?: ProviderTemplate
  protocol: ProviderProtocol
  baseUrl: string
  auth?: ProviderAuth
  models?: ProviderModel[]
  smallModel?: string | null
  modelFallback?: boolean
  /** 不给表示不改，null 表示清掉（按 1） */
  costMultiplier?: number | null
  /** 留空或不给表示不改 */
  apiKey?: string
  /** 附加请求头：值为 MASKED_SECRET 表示不改；不在这里的旧请求头删掉 */
  headers?: Record<string, string>
}

export interface ProvidersState {
  providers: ProviderView[]
  /** 系统加密可用：Key 会加密写盘；不可用时只在内存里，重启要重填 */
  persistent: boolean
  warning: string | null
}

/**
 * 「从中转站读取」费用倍率（docs/ui/custom-api.md §4.3）：
 * - sub2api：用这个 Key 查到的实际倍率（分组 × 用户专属 × 高峰）；
 * - new-api：公开价格页的分组倍率、各模型相对官方价的倍数和充值折扣，Key 在哪个分组查不到，要用户选；
 * - unknown：认不出或没开放，message 是原因
 */
export type RelayBilling =
  | {
      kind: 'sub2api'
      /** 现在生效的倍率（含高峰） */
      multiplier: number
      /** 不算高峰的倍率（分组倍率或用户专属倍率） */
      base: number
      peak: { start: string; end: string; multiplier: number; active: boolean } | null
    }
  | {
      kind: 'new-api'
      site: string | null
      groups: { name: string; label: string; ratio: number }[]
      /** 接口模型列表里的模型：中转站的模型价相对官方价的倍数；对不上官方价或按次计费的为 null */
      models: { id: string; factor: number | null }[]
      /** 充值折扣：充值单价 ÷ 美元汇率（例如 ¥2.5 买 $1 额度、汇率 7.3 → 0.34）；读不到为 null */
      recharge: number | null
    }
  | { kind: 'unknown'; message: string }

export type ProviderProblem = 'auth' | 'quota' | 'model' | 'not_found' | 'timeout' | 'network' | 'redirect' | 'other'

export type ProviderTestResult =
  | { ok: true; status: number; model: string | null }
  | { ok: false; problem: ProviderProblem; status: number | null; message: string }

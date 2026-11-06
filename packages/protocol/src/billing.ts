/** Platform charges are authoritative; never substitute a CLI estimate. */
export type CostSource = 'estimate' | 'platform' | 'pending' | 'unavailable'
export type BillingSource = 'balance' | 'subscription'
export interface PlatformRequest {
  /** 本机网关生成的 ID（pixelsky-UUID），发请求前就记下，用来把请求固定到这一轮 */
  id: string
  /**
   * Sub2api 给这次请求生成的 ID（云端回传的响应头 X-Client-Request-ID），按它查实扣金额；
   * 没有时（旧云端、旧记录）按 id 查（docs/cloud-service.md §4.9）
   */
  chargeId?: string
  model: string
  groupId: string
}
export interface PlatformCharge {
  requestId: string
  model: string
  groupId: string
  costUsd: number
  billing: BillingSource
  rateMultiplier: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
export interface PlatformSettlement {
  account: string
  requests: PlatformRequest[]
  startedAt: number
  complete: boolean
}

export type CallClient = 'pixelsky-desktop' | 'jucode-cli' | 'api' | 'unknown'
export type CallStatus = 'success' | 'error' | 'rate_limited'
export interface RemoteCall {
  id: string
  createdAt: number
  model: string
  client: CallClient
  device: string | null
  keyName: string | null
  stream: boolean
  status: CallStatus
  httpStatus: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  costUsd: number | null
  firstTokenMs: number | null
  durationMs: number
  turnId: string | null
  billing?: BillingSource
}
export interface RemoteCallPage {
  calls: RemoteCall[]
  total: number
  offset: number
  nextCursor: string | null
}
export interface RemoteCallsQuery {
  range: 'today' | '7d' | '30d' | '90d'
  model: string | null
  offset: number
  limit: number
  now: number
}

/** 账号调用的合计（云端 /v1/oauth/usage/summary，docs/cloud-service.md §4.13）；金额是实扣 */
export interface RemoteUsageStat {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
}
export interface RemoteUsageSummary {
  /** 「今天」按小时、其余按天；start 是格子开始的毫秒，没有调用的格子不出现 */
  buckets: Array<RemoteUsageStat & { start: number }>
  models: Array<RemoteUsageStat & { model: string }>
  total: RemoteUsageStat
  /** 上一个同样长度的时间段的合计，用于 ▲ / ▼ 比较 */
  prevTotal: RemoteUsageStat
}
export interface RemoteUsageQuery {
  /** 'year'：热力图用，只要按天的格子（docs/ui/usage-learn.md §1.3） */
  range: 'today' | '7d' | '30d' | '90d' | 'year'
  model: string | null
  now: number
}

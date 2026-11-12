// 额度来源（docs/ui/custom-api.md §4.2）：有 platform 是平台，有 provider 是自定义 API，都没有是自有
import type { SessionSettings } from './types'

type Sourced = Pick<SessionSettings, 'platform' | 'provider'>

export type SourceKind = 'platform' | 'custom' | 'self'

export const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/

export const sourceKind = (r: Sourced): SourceKind => (r.platform ? 'platform' : r.provider ? 'custom' : 'self')

/** 换了这个值就要换引擎进程：平台按账号、自定义按接口 id；同一来源里换分组或模型不算 */
export const sourceKey = (r: Sourced): string | null =>
  r.platform ? `platform:${r.platform.account}` : r.provider ? `custom:${r.provider.id}` : null

/** 日志里写的来源：self / platform:<线路> / custom:<接口>（docs/ui/logging.md §4.5） */
export const sourceLabel = (r: Sourced): string =>
  r.platform ? `platform:${r.platform.groupId}` : r.provider ? `custom:${r.provider.id}` : 'self'

/** 请求经过本机网关（平台和自定义 API），引擎进程里没有真实凭证 */
export const viaGateway = (r: Sourced): boolean => !!(r.platform || r.provider)

/** 环境变量里不再接受的接口地址和 Key（docs/ui/custom-api.md §3.4）：改在自定义 API 里配置；已有的只能删除或迁移 */
export const PROVIDER_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
]

import type { EngineId } from './types/base'

/** 原生账号的限额窗口，独立于会话 token 和平台余额；时间统一为 Unix 毫秒。 */
export interface AccountUsageWindow {
  id: string
  kind: 'five_hour' | 'weekly' | 'other'
  label?: string
  usedPercent: number | null
  resetsAt: number | null
  windowMinutes?: number
}

export interface EngineAccountUsage {
  status: 'ready' | 'unavailable' | 'unsupported' | 'error'
  windows: AccountUsageWindow[]
  observedAt: number
  /** 单窗口事件，尚不能确认完整的套餐窗口列表。 */
  partial?: boolean
  account?: string
  plan?: string
  reason?: 'signed_out' | 'api_key' | 'missing' | 'no_data'
}

/** sessionId 使请求跟着会话所属机器路由；新会话跟着当前选中的机器。 */
export interface AccountUsageTarget {
  engine: EngineId
  sessionId?: string
}

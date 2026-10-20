// 订阅账号多开（docs/ui/engine-accounts.md、engine-accounts-claude.md）：同一个引擎登录多个账号，点一下切换
import type { QuotaWindow } from '../quota'

/** 支持多账号的引擎 */
export type AccountEngine = 'codex' | 'claude'

/** 原来的账号（用户本来的 CODEX_HOME / Claude Code 配置目录）的 id */
export const DEFAULT_ACCOUNT = 'default'

export interface EngineAccount {
  /** default 是原来的目录；别的是 a_ 开头的随机 id */
  id: string
  email: string | null
  /** 套餐（plus / pro / team…），读不到为 null */
  plan: string | null
  /** 用户写的备注 */
  label: string | null
  addedAt: number
  /** ok 已登录；expired 登录失效（读不到账号）；unknown 还没查过 */
  status: 'ok' | 'expired' | 'unknown'
}

/** 额度用完时自动换账号（默认关） */
export interface AccountAutoSwitch {
  enabled: boolean
  /** list 按列表顺序；most 剩余额度最多的 */
  order: 'list' | 'most'
  /** 原来的账号额度恢复后换回去 */
  switchBack: boolean
  /** 换的时候在对话里提示一句 */
  notice: boolean
}

export interface EngineAccounts {
  engine: AccountEngine
  current: string
  /** 列表顺序就是「按列表顺序」自动切换的顺序；原来的账号登录过才在里面 */
  accounts: EngineAccount[]
  auto: AccountAutoSwitch
}

/** 一个账号的额度（设置里的账号表、模型菜单的账号子菜单） */
export interface EngineAccountQuota {
  id: string
  /** 5 小时 / 本周等窗口；不是 ChatGPT 登录、读不到时为空 */
  windows: QuotaWindow[]
  /** 账号整体被拒（额度用完） */
  blocked: boolean
  observedAt: number
  /** 读的时候出错（网络等），登录失效不算出错 */
  error?: string
}

export interface AccountPatch {
  label?: string | null
  /** 在列表里上移一位 */
  move?: 'up'
}

// 账号额度（docs/ui/account-quota.md）：Claude 订阅、ChatGPT 订阅、像素星空平台的 5 小时 / 每周等用量。
// 引擎层把各家的原始形状（Claude get_usage / rate_limit_event、Codex account/rateLimits/*）统一成这里的快照；
// 窗口按时长认，不按「主 / 次」位置认。

/** 额度属于哪种账号 */
export type QuotaProvider = 'claude' | 'chatgpt' | 'platform'
/** 经引擎读取的两种（平台的额度在渲染层由 AccountInfo 换算，不走 quota:* 通道） */
export type EngineQuotaProvider = Exclude<QuotaProvider, 'platform'>

/**
 * - ok：有数据（windows / extras 至少有一项）
 * - empty：账号支持额度，但还没拿到数据（例如旧版 Claude Code 没有 get_usage，这一轮还没跑完）
 * - unsupported：这个登录方式没有订阅额度（API Key、Bedrock / Vertex、Codex 没用 ChatGPT 登录、没登录）→ 不显示按钮
 * - error：最近一次读取失败；windows / extras 保留上一次成功的数据（可能为空）
 */
export type QuotaStatus = 'ok' | 'empty' | 'unsupported' | 'error'

/** usage：主动读取；event：对话里顺带收到；demo：演示数据 */
export type QuotaSource = 'usage' | 'event' | 'demo'

export type QuotaErrorCode = 'timeout' | 'network' | 'engine-unavailable' | 'failed'

/** 一个时间窗口（5 小时、本周…） */
export interface QuotaWindow {
  /** 按时长定的 id（quotaWindowId）：'five_hour'、'seven_day'、其它 `mins:<分钟>`、时长不明 `unknown:<序号>` */
  id: string
  /** 窗口时长（分钟）；引擎没给为 null（界面写「额度」） */
  durationMins: number | null
  /** 已用百分比 0–100（引擎报的超过 100 截成 100，小于 0 记 0） */
  usedPercent: number
  /** 恢复时间，毫秒时间戳；不知道为 null */
  resetsAt: number | null
  /** 引擎明确报这个窗口已拒绝（用完）：不论百分比都按用完显示 */
  rejected?: boolean
  /** 只有平台有：这个窗口的金额 */
  money?: { used: number; limit: number; currency: string }
}

/** 分模型的额度（Claude 的 Opus / Sonnet / Fable 周额度；Codex 的其它额度桶） */
export interface QuotaModelLimit {
  /** 引擎原样给的显示名（「Opus」「Fable」、Codex 的 limitName） */
  name: string
  durationMins: number | null
  usedPercent: number
  resetsAt: number | null
  rejected?: boolean
}

/** Claude 的额外用量（超出套餐后按量付费，按月） */
export interface QuotaExtraUsage {
  enabled: boolean
  /** 已用 / 本月上限，按 currency 的主单位（美元）；单位拿不准时为 null，界面只显示百分比 */
  used: number | null
  limit: number | null
  currency: string | null
  usedPercent: number | null
  /** 本月上限已到 */
  reached?: boolean
  /** 最近一次请求正在花额外用量（rate_limit_event 的 isUsingOverage） */
  inUse?: boolean
}

/** ChatGPT 的 Codex 额度点数 */
export interface QuotaCredits {
  hasCredits: boolean
  unlimited: boolean
  /** 剩余点数；引擎给的是字符串，解析不了为 null */
  balance: number | null
}

/** Codex 的重置卡（docs/ui/codex-reset-card.md）：用一张把当前用量清零 */
export interface QuotaResetCredits {
  /** 可用张数 */
  available: number
  /** 每张的明细，按到期先后排；Codex 只给了张数时为 null */
  credits: { id: string; expiresAt: number | null; title: string | null }[] | null
  /** 最近一次自动使用的时间（毫秒）；界面看到它变了就提示一次 */
  lastAutoAt?: number
}

/** 用重置卡的结果：Codex 原值 */
export type ResetCreditOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'

/** 周限快到时自动用重置卡（设置 › 本机引擎 › Codex）；null 表示关 */
export interface ResetCreditAuto {
  /** 本周用量到这个百分比（80 / 90 / 95 / 100） */
  threshold: number
  /** 离周限恢复不到这么多小时就不用（0 不限） */
  minLeftHours: number
  /** 7 天内最多自动用几张 */
  perWeek: number
}

export interface AccountQuota {
  provider: QuotaProvider
  status: QuotaStatus
  /** 套餐原值（Claude 'pro' | 'max' | 'team' | 'enterprise'；ChatGPT 的 PlanType；平台套餐名），界面再转显示名 */
  plan: string | null
  /** 账号：邮箱（完整，界面打码显示）；平台是显示名。不知道为 null */
  account: string | null
  /** 时间窗口，顺序无意义（界面按时长排） */
  windows: QuotaWindow[]
  extras: {
    models?: QuotaModelLimit[]
    extraUsage?: QuotaExtraUsage
    credits?: QuotaCredits
    resetCredits?: QuotaResetCredits
    /** 平台：余额（null 表示暂时拿不到） */
    balance?: { amount: number; currency: string } | null
  }
  /**
   * 账号整体被拒绝、但说不清是哪个窗口（Codex ordinaryUsageAllowed=false / rateLimitReachedType；
   * Claude rejected 而 rateLimitType 不认识）。kind 是引擎原值；没有为 null
   */
  blocked: { kind: string; resetsAt: number | null } | null
  /** 最近一次拿到数据（主动读取或事件）的时间，毫秒；从没拿到为 null */
  observedAt: number | null
  /** 最近一次主动读取成功的时间；「打开弹窗超过 1 分钟才取」按它算 */
  fetchedAt: number | null
  source: QuotaSource
  /** 能不能主动刷新：旧版 Claude Code 没有 get_usage 时为 false，只靠每轮对话后的事件 */
  refreshable: boolean
  /** status 为 error 时的原因；message 是主进程文案（中文原文，界面 translateMessage） */
  error: { code: QuotaErrorCode; message: string } | null
  /**
   * 登录 / 换账号后清掉了旧记录、正在重读（docs/ui/claude-login-recovery.md §1 第 1 条）：界面显示「读取额度…」。
   * 读完的快照没有这一项
   */
  pending?: boolean
}

/** quota:refresh 的选项 */
export interface QuotaRefreshOptions {
  /** 手动刷新：不看 maxAgeMs（仍受 5 秒最短间隔和单飞约束） */
  force?: boolean
  /** 快照（fetchedAt）比这个新就不取；默认 60_000 */
  maxAgeMs?: number
}

/** 常见窗口的时长（分钟） */
export const QUOTA_WINDOW_MINS = { fiveHour: 300, day: 1_440, week: 10_080 } as const

/** 按时长给窗口 id；引擎层和渲染层（平台窗口）共用 */
export function quotaWindowId(durationMins: number | null, index = 0): string {
  if (durationMins === 300) return 'five_hour'
  if (durationMins === 10_080) return 'seven_day'
  return durationMins && durationMins > 0 ? `mins:${Math.round(durationMins)}` : `unknown:${index}`
}

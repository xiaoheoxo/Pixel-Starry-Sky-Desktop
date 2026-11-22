// 账号额度（docs/ui/account-quota.md §3.1）：引擎内部的类型和纯函数，不进协议。
// Claude 的 get_usage / rate_limit_event、Codex 的 account/rateLimits/* 各自解析成这里的形状，宿主（host/quota.ts）再合并。
import { quotaWindowObservedAt } from '@pixelsky/protocol'
import type { AccountQuota, QuotaCredits, QuotaExtraUsage, QuotaModelLimit, QuotaWindow } from '@pixelsky/protocol'

/** 一次主动读取的结果（会话进程或临时进程） */
export type QuotaReading =
  | {
      kind: 'ok'
      plan: string | null
      /** 引擎回包里带的账号（Claude initialize.account.email、Codex account/read 的 email）；没有为 null */
      account: string | null
      windows: QuotaWindow[]
      extras: AccountQuota['extras']
      blocked: AccountQuota['blocked']
      observedAt: number
    }
  /** 这个登录方式没有额度（rate_limits_available=false、Codex 不是 ChatGPT 登录） */
  | { kind: 'unsupported' }
  /** 引擎版本不支持主动读取（Claude Code 旧版不认识 get_usage） */
  | { kind: 'no-request' }

/** 对话里顺带收到的部分更新：有的字段才覆盖，没有的保留上一次（Codex 稀疏更新、Claude rate_limit_event） */
export interface AccountQuotaPatch {
  windows?: QuotaWindow[]
  models?: QuotaModelLimit[]
  credits?: QuotaCredits
  plan?: string
  /** undefined 不动，null 清掉 */
  blocked?: AccountQuota['blocked']
  /** 请求被放行：清掉所有窗口的 rejected（Claude status allowed / allowed_warning） */
  allowed?: boolean
  /** Claude isUsingOverage：只有 true 才会新建 extraUsage；已有 extraUsage 时 true / false 都更新 inUse */
  overage?: boolean
  observedAt: number
}

/** 引擎报的百分比 → 0–100 并截断；非数字为 null（字符串、null、NaN 都不认）。scale 1 表示引擎给的是 0–1 */
export function clampPercent(v: unknown, scale: 1 | 100 = 100): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const percent = scale === 1 ? v * 100 : v
  // 0.67 * 100 = 67.00000000000001：留两位小数
  return Math.min(100, Math.max(0, Math.round(percent * 100) / 100))
}

/** 秒 / 毫秒数字（< 1e12 当秒）或 ISO 字符串 → 毫秒；不合法为 null */
export function epochMs(v: unknown): number | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null
    return Math.round(v < 1e12 ? v * 1000 : v)
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function mergeById<T>(prev: readonly T[], next: readonly T[], key: (item: T) => string): T[] {
  const out = [...prev]
  for (const item of next) {
    const i = out.findIndex(old => key(old) === key(item))
    if (i >= 0) out[i] = item
    else out.push(item)
  }
  return out
}

const modelKey = (m: QuotaModelLimit): string => `${m.name}\u0000${m.durationMins ?? ''}`

/** 把对话里顺带收到的部分更新并进快照；规则见方案 §3.1 */
export function mergeQuota(prev: AccountQuota, patch: AccountQuotaPatch): AccountQuota {
  // 这个账号没有订阅额度（自己配了转发地址等）：对话里的事件不是它的额度，不能把状态翻成 ok
  if (prev.status === 'unsupported') return prev
  let windows = prev.windows
  const windowObservedAt: Record<string, number> = {}
  for (const old of prev.windows) {
    const seen = quotaWindowObservedAt(prev, old.id)
    if (seen !== null) windowObservedAt[old.id] = seen
  }
  let models = prev.extras.models
  // 请求被放行：之前标的「用完」作废（新带来的窗口自己说了算）
  if (patch.allowed) {
    windows = windows.map(w => (w.rejected ? withoutRejected(w) : w))
    models = models?.map(m => (m.rejected ? withoutRejected(m) : m))
  }
  const incoming = patch.windows?.filter(w => {
    if ((windowObservedAt[w.id] ?? -Infinity) > patch.observedAt) return false
    windowObservedAt[w.id] = patch.observedAt
    return true
  })
  if (incoming?.length) windows = mergeById(windows, incoming, w => w.id)
  if (patch.models?.length) models = mergeById(models ?? [], patch.models, modelKey)
  const extras: AccountQuota['extras'] = { ...prev.extras }
  if (models) extras.models = models
  if (patch.credits) extras.credits = patch.credits
  if (patch.overage !== undefined) {
    // 每条 rate_limit_event 都带 isUsingOverage：false 不代表开了额外用量，只有 true 才新建；已有这一项才更新 inUse
    const old: QuotaExtraUsage | undefined =
      extras.extraUsage ??
      (patch.overage ? { enabled: true, used: null, limit: null, currency: null, usedPercent: null } : undefined)
    if (old) extras.extraUsage = { ...old, inUse: patch.overage }
  }
  const status = windows.length || models?.length || extras.extraUsage || extras.credits ? 'ok' : prev.status
  return {
    ...prev,
    status,
    plan: patch.plan ?? prev.plan,
    windows,
    extras,
    blocked: patch.blocked !== undefined ? patch.blocked : prev.blocked,
    observedAt: Math.max(prev.observedAt ?? patch.observedAt, patch.observedAt),
    windowObservedAt,
    source: 'event',
    error: status === 'ok' ? null : prev.error,
  }
}

function withoutRejected<T extends { rejected?: boolean }>(item: T): T {
  const { rejected: _rejected, ...rest } = item
  return rest as T
}

const NO_DATA = '没有拿到额度数据'

/** 抛给宿主的「没有拿到额度数据」（rate_limits_available 为真但没有 rate_limits） */
export const quotaNoDataError = (): Error => new Error(NO_DATA)

export type QuotaHost = 'claude.ai' | 'chatgpt.com' | 'antigravity.google'

const ENGINE_NAME: Record<QuotaHost, string> = {
  'claude.ai': 'Claude Code',
  'chatgpt.com': 'Codex',
  'antigravity.google': 'Antigravity',
}

/**
 * 读取失败的原因归类。message 是主进程文案（中文原文，界面 translateMessage 反查，对应 systemMessages 的 system.quota*）。
 * host：出错的是哪一边的服务，用来写「连不上 {p0}」和「{p0} 现在不可用」
 */
export function classifyQuotaError(err: unknown, host: QuotaHost): NonNullable<AccountQuota['error']> {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  if (raw === NO_DATA) return { code: 'failed', message: NO_DATA }
  if (/没有回应|did not respond|timeout|timed out/i.test(raw)) return { code: 'timeout', message: '读取额度超时' }
  if (/ECONN|ENOTFOUND|ETIMEDOUT|network|fetch failed|socket/i.test(raw))
    return { code: 'network', message: `连不上 ${host}` }
  if (/进程已退出|process exited|引擎不可用|没装好|已重新检测|unavailable|ENOENT/i.test(raw))
    return { code: 'engine-unavailable', message: `${ENGINE_NAME[host]} 现在不可用` }
  return { code: 'failed', message: `读取额度失败：${raw.slice(0, 200)}` }
}

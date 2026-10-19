import type { AccountUsageWindow, EngineAccountUsage } from '@pixelsky/protocol'

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const percent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
const reset = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(n) ? n : null
}
const kind = (id: string): AccountUsageWindow['kind'] =>
  id === 'five_hour' ? 'five_hour' : id.startsWith('seven_day') ? 'weekly' : 'other'
const labels: Record<string, string> = {
  seven_day_opus: 'Opus',
  seven_day_sonnet: 'Sonnet',
  seven_day_oauth_apps: 'OAuth apps',
}

/** get_usage 是实验控制接口：只接受结构化额度字段，不拿会话费用估算套餐限额。 */
export function claudeAccountUsage(raw: unknown): EngineAccountUsage {
  const body = obj(raw),
    limits = obj(body.rate_limits)
  const base = {
    observedAt: Date.now(),
    ...(typeof body.subscription_type === 'string' ? { plan: body.subscription_type } : {}),
  }
  if (body.rate_limits_available === false)
    return { ...base, status: 'unavailable', windows: [], reason: body.subscription_type ? 'no_data' : 'api_key' }
  if (!body.rate_limits || typeof body.rate_limits !== 'object') return { ...base, status: 'error', windows: [] }
  const windows: AccountUsageWindow[] = []
  for (const [id, rawWindow] of Object.entries(limits)) {
    if (id !== 'five_hour' && !id.startsWith('seven_day')) continue
    if (!rawWindow || typeof rawWindow !== 'object' || Array.isArray(rawWindow)) continue
    const window = obj(rawWindow)
    windows.push({
      id,
      kind: kind(id),
      ...(labels[id] ? { label: labels[id] } : {}),
      usedPercent: percent(window.utilization),
      resetsAt: reset(window.resets_at),
    })
  }
  if (Array.isArray(limits.model_scoped))
    limits.model_scoped.forEach((rawWindow, i) => {
      const window = obj(rawWindow)
      if (windows.some(w => w.label && w.label === window.display_name)) return
      windows.push({
        id: `model:${i}`,
        kind: 'weekly',
        label: typeof window.display_name === 'string' ? window.display_name : undefined,
        usedPercent: percent(window.utilization),
        resetsAt: reset(window.resets_at),
      })
    })
  return { ...base, status: 'ready', windows }
}

/** 变化事件只包含一个窗口，合并已有窗口；不能据此断言其他窗口不存在。 */
export function claudeUsageEvent(raw: unknown, previous: EngineAccountUsage | null): EngineAccountUsage | null {
  const info = obj(raw),
    id = info.rateLimitType
  if (typeof id !== 'string' || (id !== 'five_hour' && !id.startsWith('seven_day'))) return null
  const utilization = percent(info.utilization)
  const seconds =
    typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0 && info.resetsAt < 8.64e12
      ? info.resetsAt
      : null
  const old = previous?.windows.find(w => w.id === id)
  const window: AccountUsageWindow = {
    id,
    kind: kind(id),
    ...(labels[id] ? { label: labels[id] } : {}),
    usedPercent: utilization === null ? (old?.usedPercent ?? null) : utilization * 100,
    resetsAt: seconds === null ? (old?.resetsAt ?? null) : seconds * 1000,
  }
  const windows = old
    ? previous!.windows.map(w => (w.id === id ? window : w))
    : id === 'five_hour'
      ? [window, ...(previous?.windows ?? [])]
      : [...(previous?.windows ?? []), window]
  return {
    ...previous,
    status: 'ready',
    partial: previous?.status === 'ready' ? previous.partial : true,
    observedAt: Date.now(),
    windows,
  }
}

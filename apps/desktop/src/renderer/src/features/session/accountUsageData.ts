import type { AccountUsageWindow } from '@pixelsky/protocol'
import { getLocale, tr } from '@/i18n/core'

export function usageWindowLabel(window: AccountUsageWindow): string {
  const name =
    window.kind === 'five_hour'
      ? tr('accountUsage.fiveHour')
      : window.kind === 'weekly'
        ? tr('accountUsage.weekly')
        : window.windowMinutes
          ? window.windowMinutes % 60 === 0
            ? tr('accountUsage.hours', { n: window.windowMinutes / 60 })
            : tr('accountUsage.minutes', { n: window.windowMinutes })
          : tr('accountUsage.other')
  return window.label ? `${name} · ${window.label}` : name
}

export function usageResetCountdown(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return tr('accountUsage.unknownReset')
  if (resetsAt <= now) return tr('accountUsage.resetSoon')
  const minutes = Math.ceil((resetsAt - now) / 60000)
  const d = Math.floor(minutes / 1440),
    h = Math.floor((minutes % 1440) / 60),
    m = minutes % 60
  const duration = d
    ? tr('accountUsage.days', { d, h })
    : h
      ? tr('accountUsage.durationHours', { h, m })
      : tr('accountUsage.durationMinutes', { m })
  return tr('accountUsage.resetIn', { duration })
}

export function usageResetTime(resetsAt: number | null): string {
  return resetsAt === null
    ? '—'
    : new Date(resetsAt).toLocaleString(getLocale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
}

export function usagePercent(percent: number): string {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(percent)
}

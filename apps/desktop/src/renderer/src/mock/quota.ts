// 演示模式下的账号额度（docs/ui/account-quota.md §6.12）：Claude、ChatGPT 各一份，数字照样稿。
// 账号和 mock/platform.ts 的 demoEngineStatus 一致；恢复时间按调用时的现在往后算。平台的额度由 mock/account.ts 换算（5h $0.50 / $2）。
import type { AccountQuota, EngineQuotaProvider } from '@pixelsky/protocol'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function demoQuota(now: number = Date.now()): Record<EngineQuotaProvider, AccountQuota> {
  const base = {
    status: 'ok',
    blocked: null,
    observedAt: now,
    fetchedAt: now,
    source: 'demo',
    refreshable: true,
    error: null,
  } as const
  return {
    claude: {
      ...base,
      provider: 'claude',
      plan: 'max_20x',
      account: 'linxia@example.com',
      windows: [
        { id: 'five_hour', durationMins: 300, usedPercent: 42, resetsAt: now + 2 * HOUR + 13 * MIN },
        { id: 'seven_day', durationMins: 10_080, usedPercent: 18, resetsAt: now + 3 * DAY + 4 * HOUR },
      ],
      extras: {
        models: [{ name: 'Opus', durationMins: 10_080, usedPercent: 61, resetsAt: now + 3 * DAY + 4 * HOUR }],
        extraUsage: { enabled: true, used: 12.4, limit: 50, currency: 'USD', usedPercent: 24.8 },
      },
    },
    chatgpt: {
      ...base,
      provider: 'chatgpt',
      plan: 'plus',
      account: 'linxia@example.com',
      windows: [
        { id: 'five_hour', durationMins: 300, usedPercent: 27, resetsAt: now + 3 * HOUR + 40 * MIN },
        { id: 'seven_day', durationMins: 10_080, usedPercent: 54, resetsAt: now + 2 * DAY + 20 * HOUR },
      ],
      extras: { credits: { hasCredits: true, unlimited: false, balance: 120 } },
    },
  }
}

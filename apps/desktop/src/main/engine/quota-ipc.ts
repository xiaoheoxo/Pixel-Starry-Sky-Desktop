// 账号额度的 IPC（docs/ui/account-quota.md §5）：quota:get / quota:refresh。
// 不用 engine: 前缀、也不放进 ENGINE_OPS：engine:* 会被转发到当前选中的远程机器，而额度只属于本机的账号；
// 推送 quota:changed 在 ipc.ts 里随 EngineHost 的 onQuota 广播，也不经过 engine:event。
import type { EngineHost } from '@pixelsky/engine'
import type { EngineQuotaProvider, QuotaRefreshOptions } from '@pixelsky/protocol'
import * as ipc from '../ipc/guard'

/** 快照比这个新就不取；渲染层没传或传了不合法的值时用它 */
export const DEFAULT_QUOTA_MAX_AGE_MS = 60_000
const MAX_AGE_LIMIT_MS = 3_600_000

/** provider 只认 claude / chatgpt */
export function quotaProvider(value: unknown): EngineQuotaProvider {
  if (value !== 'claude' && value !== 'chatgpt') throw new Error('参数不对')
  return value
}

/** force 只认 true；maxAgeMs 是有限数时截到 0–1 小时，否则用默认的 1 分钟 */
export function quotaRefreshOptions(value: unknown): Required<QuotaRefreshOptions> {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const maxAge =
    typeof raw.maxAgeMs === 'number' && Number.isFinite(raw.maxAgeMs)
      ? Math.min(MAX_AGE_LIMIT_MS, Math.max(0, raw.maxAgeMs))
      : DEFAULT_QUOTA_MAX_AGE_MS
  return { force: raw.force === true, maxAgeMs: maxAge }
}

export function registerQuotaIpc(host: EngineHost): void {
  ipc.handle('quota:get', (_event, provider: unknown) => host.accountQuota(quotaProvider(provider)))
  ipc.handle('quota:refresh', (_event, provider: unknown, opts: unknown) =>
    host.refreshAccountQuota(quotaProvider(provider), quotaRefreshOptions(opts)),
  )
  ipc.handle('quota:useResetCredit', () => host.useResetCredit())
}

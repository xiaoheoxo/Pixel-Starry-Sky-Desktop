import type { RequestRetryState } from '@pixelsky/protocol'
import { tr } from '../../../i18n/core'

/** 「 1/3」；一轮共用额度的（Claude）写「 · 本轮还能重试 n 次」，n/m 会显示成看不懂的 1/1（error-retry.md §9） */
export function retryProgress(retry: RequestRetryState): string {
  if (retry.attempt === null) return ''
  if (retry.scope === 'turn' && retry.maxRetries !== null) {
    const left = Math.max(0, retry.maxRetries - retry.attempt)
    return left > 0
      ? tr('session.live.RetryStatus.turnRetriesLeft', { p0: left })
      : tr('session.live.RetryStatus.turnLastRetry')
  }
  return ` ${retry.attempt}${retry.maxRetries === null ? '' : `/${retry.maxRetries}`}`
}

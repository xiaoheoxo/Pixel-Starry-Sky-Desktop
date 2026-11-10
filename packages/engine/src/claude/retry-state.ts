import type { RequestRetryState } from '@pixelsky/protocol'

const integer = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

export function requestRetryState(frame: Record<string, unknown>, turnId: string, now = Date.now()): RequestRetryState {
  const delay = integer(frame.retry_delay_ms)
  const status = integer(frame.error_status)
  const reason =
    status !== null
      ? `HTTP ${status}`
      : typeof frame.error === 'string' && frame.error.trim()
        ? frame.error.trim().slice(0, 500)
        : '模型请求暂时失败'
  return {
    turnId,
    attempt: integer(frame.attempt),
    maxRetries: integer(frame.max_retries),
    retryAt: delay === null ? null : now + delay,
    reason,
    scope: 'turn',
  }
}

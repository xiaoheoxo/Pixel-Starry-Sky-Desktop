// 会话事件记进日志（docs/ui/logging.md §4.5「session」）：请求重试、警告和错误提示、一轮结束
import { sourceLabel, type HostEvent, type SessionRecord } from '@pixelsky/protocol'
import { logger } from '@pixelsky/engine'

const log = logger('session')

/** record：取会话当前记录，「一轮结束」写上额度来源 */
export function logHostEvent(e: HostEvent, record?: (id: string) => SessionRecord | null): void {
  if (e.kind !== 'session') return
  const sessionId = e.sessionId
  const event = e.event
  switch (event.type) {
    case 'request_retry':
      if (event.retry)
        log.warn('请求重试', {
          sessionId,
          turnId: event.retry.turnId,
          attempt: event.retry.attempt,
          maxRetries: event.retry.maxRetries,
          retryInMs: event.retry.retryAt === null ? null : Math.max(0, event.retry.retryAt - Date.now()),
          reason: event.retry.reason,
        })
      return
    case 'turn_started':
      log.debug('一轮开始', { sessionId, turnId: event.turnId })
      return
    case 'turn_completed': {
      const current = record?.(sessionId)
      const fields = {
        sessionId,
        turnId: event.turnId,
        outcome: event.outcome,
        durationMs: event.usage?.durationMs ?? null,
        ...(current ? { source: sourceLabel(current) } : {}),
        ...(event.usage ? { models: Object.keys(event.usage.models) } : {}),
        ...(event.error ? { error: event.error } : {}),
      }
      if (event.outcome === 'completed') log.info('一轮结束', fields)
      else log.warn(event.outcome === 'failed' ? '一轮失败' : '一轮中断', fields)
      return
    }
    case 'item_completed': {
      const item = event.item
      if (item.kind !== 'notice' || item.level === 'info') return
      const fields = { sessionId, text: item.text, ...(item.detail ? { detail: item.detail } : {}) }
      if (item.level === 'error') log.error('错误提示', fields)
      else log.warn('警告提示', fields)
      return
    }
  }
}

// 会话事件记进日志（docs/ui/logging.md §4.5「session」）：请求重试、警告和错误提示、上下文压缩、一轮结束
import { sourceLabel, type HostEvent, type Item, type ItemStatus, type SessionRecord } from '@pixelsky/protocol'
import { logger } from '@pixelsky/engine'

const log = logger('session')

type Compaction = Extract<Item, { kind: 'compaction' }>
/**
 * 这一轮里的压缩，按会话、条目 id 留最新的一份：同一次压缩会先后来几个完成事件（结束帧、带大小的边界、
 * 之后的用量补上压缩后大小），一轮结束时一次写完，触发方式、前后大小都齐了（docs/ui/error-retry.md §10.1）
 */
const compactions = new Map<string, Map<string, Compaction>>()
/** 已经写过的压缩条目（每个会话留最近几个）：写完之后迟到的更新不再写一遍 */
const loggedCompactions = new Map<string, string[]>()
const LOGGED_KEEP = 20

function noteCompaction(sessionId: string, item: Compaction): void {
  if (loggedCompactions.get(sessionId)?.includes(item.id)) return
  let list = compactions.get(sessionId)
  if (!list) compactions.set(sessionId, (list = new Map()))
  list.set(item.id, item)
}

/**
 * settled：一轮结束时还在跑的压缩按这一轮的结果收尾（和 reduce 的 settle 一样，那时不再发完成事件）；
 * 没等到这一轮结束（下一轮开始时才写）的算中断
 */
function flushCompactions(sessionId: string, turnId: string | null, settled: ItemStatus): void {
  const list = compactions.get(sessionId)
  if (!list) return
  compactions.delete(sessionId)
  const logged = loggedCompactions.get(sessionId) ?? []
  for (const item of list.values()) {
    const fields = {
      sessionId,
      ...(turnId ? { turnId } : {}),
      status: item.status === 'running' ? settled : item.status,
      trigger: item.trigger,
      preTokens: item.preTokens,
      postTokens: item.postTokens,
      durationMs: item.durationMs,
      ...(item.model ? { model: item.model } : {}),
      ...(item.requests ? { requests: item.requests } : {}),
      ...(item.error ? { error: item.error } : {}),
    }
    if (fields.status === 'completed') log.info('上下文压缩', fields)
    else log.warn('上下文压缩没成功', fields)
    logged.push(item.id)
  }
  loggedCompactions.set(sessionId, logged.slice(-LOGGED_KEEP))
}

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
      // 上一轮没正常收尾（进程退出之类）留下的压缩：先写掉
      flushCompactions(sessionId, null, 'interrupted')
      log.debug('一轮开始', { sessionId, turnId: event.turnId })
      return
    case 'turn_completed': {
      flushCompactions(
        sessionId,
        event.turnId,
        event.outcome === 'interrupted' ? 'interrupted' : event.outcome === 'failed' ? 'failed' : 'completed',
      )
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
    case 'item_started':
      if (event.item.kind === 'compaction') noteCompaction(sessionId, event.item)
      return
    case 'item_completed': {
      const item = event.item
      if (item.kind === 'compaction') return noteCompaction(sessionId, item)
      if (item.kind !== 'notice' || item.level === 'info') return
      const fields = { sessionId, text: item.text, ...(item.detail ? { detail: item.detail } : {}) }
      if (item.level === 'error') log.error('错误提示', fields)
      else log.warn('警告提示', fields)
      return
    }
  }
}

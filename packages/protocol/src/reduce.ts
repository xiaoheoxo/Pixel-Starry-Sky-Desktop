// 把事件折叠成会话快照。主进程（保存、给新打开的窗口）和界面（实时显示）用同一个函数，结果一定一致。
// 纯函数：不修改传入的快照，返回新对象（React 靠引用变化判断要不要重画）。
import type { EngineEvent, Item, ItemStatus, SessionFlags, SessionRecord, SessionSnapshot } from './types'

export const EMPTY_FLAGS: SessionFlags = {
  ultracodeAvailable: null,
  fastAvailable: null,
  fastState: null,
  fastBlocked: null,
}

export function emptySnapshot(record: SessionRecord, items: Item[] = []): SessionSnapshot {
  return {
    record,
    context: null,
    state: 'idle',
    items,
    pending: [],
    usage: null,
    flags: EMPTY_FLAGS,
    tasks: [],
    subagents: [],
    runs: { workflows: [], agents: [] },
    suggestion: null,
    queue: [],
    queuePaused: false,
    execution: null,
    turnId: null,
    retry: null,
    compaction: null,
  }
}

/** 一轮异常结束时，还在进行中的条目统一改成这个状态 */
/** 一轮结束时把还在跑的条目收尾；后台子智能体的工具不跟着这一轮结束 */
export function settle(item: Item, status: ItemStatus): Item {
  if (item.kind === 'user' || item.kind === 'notice' || item.kind === 'turn_stats') return item
  if ((item.kind === 'command' || item.kind === 'tool' || item.kind === 'file_change') && item.background) return item
  return item.status === 'running' ? { ...item, status } : item
}

/** 增量几乎都落在最后一项：先看末尾，再从后往前找（id 唯一，结果和 findIndex 一致） */
function indexOfId(items: readonly Item[], id: string): number {
  const last = items.length - 1
  if (last >= 0 && items[last].id === id) return last
  return items.findLastIndex(x => x.id === id)
}

function upsert(items: Item[], item: Item): Item[] {
  const i = indexOfId(items, item.id)
  if (i < 0) return [...items, item]
  const next = items.slice()
  next[i] = item
  return next
}

export function reduce(s: SessionSnapshot, e: EngineEvent): SessionSnapshot {
  switch (e.type) {
    case 'context':
      return { ...s, context: e.context }
    case 'request_retry':
      return !e.retry || e.retry.turnId === s.turnId ? { ...s, retry: e.retry } : s
    case 'compaction_progress':
      return { ...s, compaction: e.progress }
    case 'request_usage':
    case 'request_cache_reset':
      return s
    case 'status':
      return s.state === e.state ? s : { ...s, state: e.state }
    case 'record':
      return {
        ...s,
        record: e.record,
        ...(s.context &&
        (e.record.model !== s.record.model ||
          e.record.engine !== s.record.engine ||
          JSON.stringify(e.record.platform) !== JSON.stringify(s.record.platform) ||
          (e.record.provider?.id ?? null) !== (s.record.provider?.id ?? null))
          ? { context: { ...s.context, stale: true, diagnosticStale: true } }
          : {}),
      }
    case 'turn_started':
      return { ...s, turnId: e.turnId, execution: e.execution ?? null, retry: null, compaction: null }
    case 'execution':
      return { ...s, execution: e.settings }
    case 'queue':
      return { ...s, queue: e.items, queuePaused: e.paused }
    case 'input_ack':
      return s
    case 'items_truncated': {
      const i = indexOfId(s.items, e.fromItemId)
      return i < 0 ? s : { ...s, items: s.items.slice(0, i) }
    }
    case 'items_reset':
      return { ...s, items: e.items }
    case 'item_started':
    case 'item_completed':
      return { ...s, items: upsert(s.items, e.item) }
    case 'item_delta': {
      const i = indexOfId(s.items, e.itemId)
      if (i < 0) return s
      const item = s.items[i]
      let next: Item
      if (e.field === 'text' && (item.kind === 'assistant' || item.kind === 'reasoning')) {
        next = { ...item, text: item.text + e.delta }
      } else if (e.field === 'output' && (item.kind === 'command' || item.kind === 'tool')) {
        next = { ...item, output: item.output + e.delta }
      } else {
        return s
      }
      const items = s.items.slice()
      items[i] = next
      return { ...s, items }
    }
    case 'approval_request':
      return { ...s, pending: [...s.pending.filter(p => p.requestId !== e.request.requestId), e.request] }
    case 'approval_resolved':
      return { ...s, pending: s.pending.filter(p => p.requestId !== e.requestId) }
    case 'usage':
      return { ...s, usage: e.usage }
    case 'flags':
      return { ...s, flags: e.flags }
    case 'tasks':
      return { ...s, tasks: e.tasks }
    case 'subagents':
      return { ...s, subagents: e.subagents }
    case 'background':
      return (s.background ?? 0) === e.count ? s : { ...s, background: e.count }
    case 'runs':
      return { ...s, runs: e.runs }
    case 'suggestion':
      return s.suggestion === e.text ? s : { ...s, suggestion: e.text }
    case 'commands':
      return { ...s, commands: e.commands }
    case 'mcp':
      return { ...s, mcp: e.report }
    case 'turn_completed': {
      const status: ItemStatus =
        e.outcome === 'interrupted' ? 'interrupted' : e.outcome === 'failed' ? 'failed' : 'completed'
      return {
        ...s,
        turnId: null,
        retry: null,
        compaction: null,
        execution: null,
        pending: [],
        items: s.items.some(x => settle(x, status) !== x) ? s.items.map(x => settle(x, status)) : s.items,
      }
    }
  }
}

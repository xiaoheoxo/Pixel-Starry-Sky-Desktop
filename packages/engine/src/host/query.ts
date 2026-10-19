// 只读查询：全局搜索、产物面板。不启动引擎，不持有状态。
import { join } from 'node:path'
import type { Item, SessionRecord } from '@pixelsky/protocol'
import { artifactQuery, collectArtifacts, historyItems, recordedIn } from '../artifacts'
import { LastTodoCache, type TodoItem } from '../last-todo'
import { searchQuery, searchSessions } from '../search'
import type { HostContext } from './context'

export class HostQuery {
  /** 没有运行时的会话的最后一个 todo，按 items.jsonl 的大小 / 修改时间缓存 */
  private readonly todos = new LastTodoCache()

  constructor(private readonly ctx: HostContext) {}

  search(value: unknown, signal?: AbortSignal) {
    const { ctx } = this
    return searchSessions(
      {
        dataDir: ctx.store.dir,
        records: [...ctx.records.values()],
        projects: ctx.m.projects.projects(),
        liveItems: id => ctx.runtimes.get(id)?.snapshot.items,
        exists: id => ctx.records.has(id),
      },
      searchQuery(value),
      signal,
    )
  }

  artifacts(value: unknown, workspace: string, signal?: AbortSignal) {
    const { ctx } = this
    return collectArtifacts(
      {
        dataDir: ctx.store.dir,
        records: [...ctx.records.values()],
        liveItems: id => ctx.runtimes.get(id)?.snapshot.items,
      },
      artifactQuery(value, workspace),
      signal,
    )
  }

  /**
   * 会话的全部条目（只读）。已有运行时就直接给内存里的数组（不复制），没有就异步流式读 items.jsonl；
   * 都不创建运行时，不触发 loadRuns / 续跑结算。给对话历史工具用
   */
  async historyItems(sessionId: string): Promise<readonly Item[]> {
    const { items } = await this.artifactItems(sessionId)
    return items
  }

  /** 会话里最后一个 todo；已有运行时读它的快照，否则从 items.jsonl 末尾往前找。不创建运行时。给任务面板用 */
  async lastTodo(sessionId: string): Promise<TodoItem | null> {
    const live = this.ctx.runtimes.get(sessionId)?.snapshot.items
    if (live) {
      for (let i = live.length - 1; i >= 0; i--) {
        const item = live[i]
        if (item.kind === 'todo') return item
      }
      return null
    }
    return this.todos.get(join(this.ctx.store.dir, 'sessions', sessionId, 'items.jsonl'))
  }

  private async artifactItems(sessionId: string): Promise<{ record: SessionRecord; items: readonly Item[] }> {
    const record = this.ctx.records.get(sessionId)
    if (!record) throw new Error('会话不存在')
    const live = this.ctx.runtimes.get(sessionId)?.snapshot.items
    return {
      record,
      items: live ?? (await historyItems(join(this.ctx.store.dir, 'sessions', sessionId, 'items.jsonl'))).items,
    }
  }

  async artifactItem(sessionId: string, itemId: string): Promise<Extract<Item, { kind: 'file_change' }> | null> {
    const { items } = await this.artifactItems(sessionId)
    const item = items.find(i => i.id === itemId)
    return item?.kind === 'file_change' ? item : null
  }

  async recordedPath(sessionId: string, absolute: string): Promise<boolean> {
    const { record, items } = await this.artifactItems(sessionId)
    return recordedIn(record, items, absolute)
  }
}

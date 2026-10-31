// 设置 › 存储的批量删除会话。不碰 electron，方便测试。
import type { StorageDeleteResult } from '../../shared/types/storage'

/** 删除要用到的引擎宿主部分 */
export interface SessionRemover {
  sessions(): ReadonlyArray<{ record: { id: string }; state: string; background?: unknown }>
  deleteSession(id: string): Promise<unknown>
}

/**
 * 逐个删除会话。每个删之前都重新取一次这个会话的最新状态：列表是打开对话框时取的，
 * 前面几个删的期间后面的可能刚开始跑，正在运行的进 failed 不删。
 */
export async function removeSessions(host: SessionRemover, list: readonly string[]): Promise<StorageDeleteResult> {
  const result: StorageDeleteResult = { done: [], failed: [] }
  for (const id of list) {
    const s = host.sessions().find(item => item.record.id === id)
    if (!s) {
      result.failed.push({ id, message: '会话不存在' })
      continue
    }
    if (s.state !== 'idle' || s.background) {
      result.failed.push({ id, message: '会话正在运行' })
      continue
    }
    try {
      await host.deleteSession(id)
      result.done.push(id)
    } catch (error) {
      result.failed.push({ id, message: String((error as Error)?.message ?? error) })
    }
  }
  return result
}

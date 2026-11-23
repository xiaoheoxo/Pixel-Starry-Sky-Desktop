// 侧栏批量删除已归档对话的数据（docs/ui/archived-bulk-delete.md）：打开确认框的入口、逐个删除、对话文件夹汇总。
import { useSyncExternalStore } from 'react'
import { demo, demoSessionChanges } from '@/data/demo'
import { tr, translateMessage } from '@/i18n/core'
import { bridge, getEngineState, isLive } from '@/features/engine'
import { paneActions } from '@/features/panes/store'
import { retainSessionFiles } from '@/features/files/store'
import { chatFilesSummary, type ArchivedItem, type ArchivedScope, type ChatFolder } from './archivedDelete'

export interface ArchivedDeleteRequest {
  scope: ArchivedScope
  sessions: ArchivedItem[]
}

let request: ArchivedDeleteRequest | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(l => l())
export const openArchivedDelete = (next: ArchivedDeleteRequest): void => {
  request = next
  emit()
}
export const closeArchivedDelete = (): void => {
  request = null
  emit()
}
export function useArchivedDeleteRequest(): ArchivedDeleteRequest | null {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => request,
  )
}

/** 现在还是不是归档的：true / false；会话已经没了 null */
export function archivedNow(id: string): boolean | null {
  if (!isLive) {
    const change = demoSessionChanges()[id]
    if (change?.deleted) return null
    // 演示数据：打开确认框时是归档的，没改过就还是
    return change ? !!change.archivedAt : true
  }
  const record = getEngineState().sessions.find(s => s.record.id === id)?.record
  return record ? !!record.archivedAt : null
}

/** 删一个（和侧栏单个删除同一条路，远端会话按 id 走对应机器）；失败抛出界面能直接显示的原因 */
export async function deleteArchived(id: string): Promise<void> {
  try {
    if (isLive && bridge) {
      retainSessionFiles(id)
      await bridge.deleteSession(id)
    } else demo().sessions.change(id, { deleted: true, stopped: true })
    paneActions.closeSessions(new Set([id]))
  } catch (error) {
    throw new Error(translateMessage((error as Error).message) || tr('session.retry'), { cause: error })
  }
}

/** 要删的这批对话的文件夹里一共有几项（读第一层；读不出来、演示模式返回 null） */
export async function chatFolders(ids: readonly string[]): Promise<{ folders: number; items: string } | null> {
  const files = window.pixelsky?.files
  if (!isLive || !files) return null
  const records = getEngineState().sessions.map(s => s.record),
    batch = new Set(ids),
    mine = records.filter(r => batch.has(r.id))
  const usedOutside = new Set(records.filter(r => !batch.has(r.id)).map(r => r.cwd))
  const folders: ChatFolder[] = await Promise.all(
    mine.map(r =>
      files.listExisting({ sessionId: r.id }, '').then(
        listing => ({ cwd: r.cwd, entries: listing?.entries.length ?? 0, truncated: !!listing?.truncated }),
        () => ({ cwd: r.cwd, entries: null, truncated: false }),
      ),
    ),
  )
  return chatFilesSummary(folders, usedOutside)
}

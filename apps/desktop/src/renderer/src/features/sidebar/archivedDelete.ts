// 侧栏「已归档 N 个」› 删除全部已归档对话的纯逻辑（docs/ui/archived-bulk-delete.md）

/** 这批要删的哪一组：项目下面的，或「对话」分组 */
export type ArchivedScope = { kind: 'project'; id: string; name: string } | { kind: 'chat' }

export interface ArchivedItem {
  id: string
  title: string
  time?: string
}

/**
 * 这次还要删的：打开确认框时记下的这批里，没删成功过、现在仍是归档的（期间被恢复或已经没了的跳过）。
 * archivedNow 返回 null = 会话已经不在了
 */
export function pendingIds(
  batch: readonly ArchivedItem[],
  done: ReadonlySet<string>,
  archivedNow: (id: string) => boolean | null,
): string[] {
  return batch.filter(s => !done.has(s.id) && archivedNow(s.id) === true).map(s => s.id)
}

/** 一个要删的对话的文件夹：entries 是第一层有几项（读不出来 null） */
export interface ChatFolder {
  cwd: string
  entries: number | null
  truncated: boolean
}

/**
 * 删一批对话时确认框补的那句：几个文件夹里共有几项会移到回收站。
 * 文件夹还被这批以外的对话（分叉）用着的不算（引擎留着它）；同一个文件夹只算一次。
 * 有读不出来的：不说（宁可不说也不说错）；全都没东西：null
 */
export function chatFilesSummary(
  batch: readonly ChatFolder[],
  usedOutside: ReadonlySet<string>,
): { folders: number; items: string } | null {
  const byCwd = new Map<string, ChatFolder>()
  for (const f of batch) {
    if (f.entries === null) return null
    if (!usedOutside.has(f.cwd) && !byCwd.has(f.cwd)) byCwd.set(f.cwd, f)
  }
  const full = [...byCwd.values()].filter(f => (f.entries ?? 0) > 0)
  if (!full.length) return null
  const total = full.reduce((sum, f) => sum + (f.entries ?? 0), 0)
  return { folders: full.length, items: `${total}${full.some(f => f.truncated) ? '+' : ''}` }
}

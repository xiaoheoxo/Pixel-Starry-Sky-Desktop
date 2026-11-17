// 新建页「最近的项目」（docs/ui/desktop-parity.md §3.2）：这台机器上最近有对话的项目，按最近一次对话的时间排
import { isChatProject } from '@pixelsky/protocol'

export interface RecentProject {
  id: string
  name: string
  /** 最近一次对话的时间 */
  at: number
}

interface SessionLike {
  record: { projectId: string; updatedAt: number; archivedAt?: number | null; scheduleTaskId?: string | null }
}

/**
 * 不算已归档的、定时任务建的对话；「对话」和已经移除的项目（不在 projects 里）不算。
 * onMachine 判断项目在不在当前机器上（项目 id 带机器前缀）
 */
export function recentProjects(
  projects: readonly { id: string; name: string }[],
  sessions: readonly SessionLike[],
  onMachine: (projectId: string) => boolean,
  limit = 4,
): RecentProject[] {
  const names = new Map(projects.filter(p => !isChatProject(p.id) && onMachine(p.id)).map(p => [p.id, p.name]))
  const latest = new Map<string, number>()
  for (const { record } of sessions) {
    if (record.archivedAt || record.scheduleTaskId || !names.has(record.projectId)) continue
    if ((latest.get(record.projectId) ?? -Infinity) < record.updatedAt) latest.set(record.projectId, record.updatedAt)
  }
  return [...latest]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, at]) => ({ id, name: names.get(id)!, at }))
}

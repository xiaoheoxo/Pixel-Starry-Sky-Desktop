// 当前项目（docs/mobile-remote.md §18.3）：新建会话和「更多」里的工具作用于它；每台电脑记住上次选的。
import type { ProjectRecord, SessionSummary } from '@pixelsky/protocol'

/**
 * 当前项目（「新建会话」右边写的、工具按钮作用的）：正在看的会话的项目，其次上次选的，再其次最近有会话的，
 * 都没有时第一个项目。
 */
export function currentProject(
  projects: readonly ProjectRecord[],
  sessions: readonly SessionSummary[],
  openSession: string | null,
  remembered: string | null,
): ProjectRecord | null {
  const has = (id: string | null | undefined) => (id ? (projects.find(p => p.id === id) ?? null) : null)
  const fromSession = has(sessions.find(s => s.record.id === openSession)?.record.projectId)
  if (fromSession) return fromSession
  const chosen = has(remembered)
  if (chosen) return chosen
  const latest = [...sessions]
    .filter(s => !s.record.archivedAt)
    .sort((a, b) => b.record.updatedAt - a.record.updatedAt)[0]
  return has(latest?.record.projectId) ?? projects[0] ?? null
}

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 上次选的项目（每台电脑一个） */
export function rememberedProject(deviceId: string): string | null {
  return storage()?.getItem('pixelsky.m.project:' + deviceId) ?? null
}

export function rememberProject(deviceId: string, projectId: string): void {
  storage()?.setItem('pixelsky.m.project:' + deviceId, projectId)
}

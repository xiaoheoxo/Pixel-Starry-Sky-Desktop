// 设置 › 存储的纯计算：字节数显示、色条分段、哪些会话算「旧会话」
import {
  STORAGE_PARTS,
  type StoragePartKey,
  type StorageSession,
  type StorageUsage,
} from '../../../../shared/types/storage'

const DAY_MS = 86_400_000

/** 1023 B、12.3 KB、4.5 MB、1.23 GB：十进制位数随大小变，避免一长串小数 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes,
    i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  if (i === 0) return `${Math.round(value)} B`
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[i]}`
}

export function totalBytes(usage: StorageUsage): number {
  return STORAGE_PARTS.reduce((sum, key) => sum + usage.parts[key], 0)
}

export interface Segment {
  key: StoragePartKey
  bytes: number
  /** 占总量的百分比（0–100） */
  percent: number
}

/** 色条的分段：去掉为 0 的分类；总量为 0 时没有分段 */
export function segments(usage: StorageUsage): Segment[] {
  const total = totalBytes(usage)
  if (total <= 0) return []
  return STORAGE_PARTS.filter(key => usage.parts[key] > 0).map(key => ({
    key,
    bytes: usage.parts[key],
    percent: (usage.parts[key] / total) * 100,
  }))
}

/** 百分比的显示：不到 1% 写「<1」，其余取整 */
export function percentLabel(percent: number): string {
  return percent > 0 && percent < 1 ? '<1' : `${Math.round(percent)}`
}

export interface OldSessionQuery {
  days: number
  includeArchived: boolean
  sort: 'size' | 'time'
  now: number
}

/** 可以清理的旧会话：超过 days 天没动、没置顶、没在运行；默认不含已归档的（另有入口） */
export function oldSessions(sessions: readonly StorageSession[], q: OldSessionQuery): StorageSession[] {
  const before = q.now - q.days * DAY_MS
  return sessions
    .filter(s => !s.pinned && !s.busy && s.updatedAt < before && (q.includeArchived || !s.archivedAt))
    .sort((a, b) => (q.sort === 'size' ? b.bytes - a.bytes : a.updatedAt - b.updatedAt) || a.id.localeCompare(b.id))
}

/** 已归档的会话，最近归档的在前 */
export function archivedSessions(sessions: readonly StorageSession[]): StorageSession[] {
  return sessions.filter(s => s.archivedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
}

/** 删掉一批会话后在本地更新统计结果，不用重新扫一遍 */
export function withoutSessions(usage: StorageUsage, ids: readonly string[]): StorageUsage {
  const gone = new Set(ids)
  const parts = { ...usage.parts }
  for (const s of usage.sessions) {
    if (!gone.has(s.id)) continue
    const key = s.archivedAt ? 'archived' : 'sessions'
    parts[key] = Math.max(0, parts[key] - s.bytes)
  }
  return { ...usage, parts, sessions: usage.sessions.filter(s => !gone.has(s.id)) }
}

/** 恢复一个归档的会话后在本地更新：它的大小从「已归档」挪到「会话」 */
export function withRestored(usage: StorageUsage, id: string): StorageUsage {
  const target = usage.sessions.find(s => s.id === id && s.archivedAt)
  if (!target) return usage
  return {
    ...usage,
    parts: {
      ...usage.parts,
      archived: Math.max(0, usage.parts.archived - target.bytes),
      sessions: usage.parts.sessions + target.bytes,
    },
    sessions: usage.sessions.map(s => (s.id === id ? { ...s, archivedAt: null } : s)),
  }
}

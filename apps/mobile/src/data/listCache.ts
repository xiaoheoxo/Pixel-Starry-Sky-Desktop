// 会话列表和项目列表的本机缓存（docs/mobile-remote.md §21）：每台电脑最近一次的列表存在 localStorage，
// 下次打开页面先显示它，连上电脑取到新的再替换。只存列表要用的字段（不存对话内容），各最多 200 条，写入节流。
import type { ProjectRecord, SessionRecord, SessionSummary } from '@pixelsky/protocol'

export const MAX_CACHED = 200
/** 写入最小间隔（毫秒）：电脑推事件很频繁，不用每次都写 */
export const WRITE_INTERVAL = 1000
const PREFIX = 'pixelsky.mobile.lists.'
const VERSION = 1

export interface CachedLists {
  sessions: SessionSummary[]
  projects: ProjectRecord[]
}

/** 缓存用到的存储（localStorage 的一部分，测试里换成假的） */
export interface CacheStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 会话记录里列表和输入框要用的字段；引擎会话、导入、分叉这类大块的内容不存 */
const RECORD_KEYS = [
  'id',
  'projectId',
  'cwd',
  'engine',
  'engineSessionId',
  'title',
  'titleEdited',
  'createdAt',
  'updatedAt',
  'lastOutcome',
  'lastError',
  'lastReply',
  'archivedAt',
  'pinnedAt',
  'bottomedAt',
  'platform',
  'provider',
  'model',
  'effort',
  'permissionMode',
  'ultracode',
  'fast',
  'thinkingSummaries',
] as const

export function slimSession(s: SessionSummary): SessionSummary {
  const record: Record<string, unknown> = {}
  for (const k of RECORD_KEYS) if (s.record[k] !== undefined) record[k] = s.record[k]
  const slim: SessionSummary = { record: record as unknown as SessionRecord, state: s.state }
  if (s.background) slim.background = s.background
  if (s.queue) slim.queue = s.queue
  return slim
}

/** 最近有动静的会话留 200 条 */
export function trimSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions]
    .sort((a, b) => b.record.updatedAt - a.record.updatedAt)
    .slice(0, MAX_CACHED)
    .map(slimSession)
}

/** 项目留 200 个（最近添加的优先） */
export function trimProjects(projects: readonly ProjectRecord[]): ProjectRecord[] {
  return [...projects].sort((a, b) => b.addedAt - a.addedAt).slice(0, MAX_CACHED)
}

const valid = (s: unknown): s is SessionSummary => {
  const x = s as SessionSummary | null
  return (
    !!x && typeof x.state === 'string' && typeof x.record?.id === 'string' && typeof x.record.projectId === 'string'
  )
}
const validProject = (p: unknown): p is ProjectRecord => {
  const x = p as ProjectRecord | null
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.path === 'string'
}

/** 每台电脑一份缓存；写入按电脑节流（间隔内的多次改动合并成最后一次） */
export class ListCache {
  private readonly last = new Map<string, number>()
  private readonly pending = new Map<string, { lists: CachedLists; timer: ReturnType<typeof setTimeout> | null }>()

  constructor(
    private readonly storage: CacheStorage | null,
    private readonly now: () => number = Date.now,
    private readonly interval = WRITE_INTERVAL,
  ) {}

  /** 读缓存；没有、坏了、版本不对都返回 null */
  load(deviceId: string): CachedLists | null {
    try {
      const raw = this.storage?.getItem(PREFIX + deviceId)
      if (!raw) return null
      const data = JSON.parse(raw) as { v?: number; sessions?: unknown; projects?: unknown }
      if (data.v !== VERSION || !Array.isArray(data.sessions) || !Array.isArray(data.projects)) return null
      return { sessions: data.sessions.filter(valid), projects: data.projects.filter(validProject) }
    } catch {
      return null
    }
  }

  /** 存一份（节流）：距上次写入不到 1 秒就先放着，到点写最后那一份 */
  save(deviceId: string, lists: CachedLists): void {
    const wait = (this.last.get(deviceId) ?? -Infinity) + this.interval - this.now()
    const pending = this.pending.get(deviceId)
    if (wait <= 0 && !pending?.timer) {
      this.pending.delete(deviceId)
      this.write(deviceId, lists)
    } else if (pending?.timer) pending.lists = lists
    else
      this.pending.set(deviceId, {
        lists,
        timer: setTimeout(() => this.flush(deviceId), Math.max(wait, 0)),
      })
  }

  /** 马上写掉等着的（页面切到后台前调用）；不传电脑就全部 */
  flush(deviceId?: string): void {
    for (const id of deviceId ? [deviceId] : [...this.pending.keys()]) {
      const p = this.pending.get(id)
      if (!p) continue
      if (p.timer) clearTimeout(p.timer)
      this.pending.delete(id)
      this.write(id, p.lists)
    }
  }

  /** 删掉一台电脑的缓存（连等着写的也取消） */
  drop(deviceId: string): void {
    const p = this.pending.get(deviceId)
    if (p?.timer) clearTimeout(p.timer)
    this.pending.delete(deviceId)
    this.last.delete(deviceId)
    try {
      this.storage?.removeItem(PREFIX + deviceId)
    } catch {
      // 存储不可用就算了
    }
  }

  /** 删掉不在 keep 里的电脑的缓存（忘掉电脑、别的标签页删了、旧版本留下的） */
  pruneExcept(keep: ReadonlySet<string>): void {
    const storage = this.storage
    if (!storage) return
    try {
      const stale: string[] = []
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key?.startsWith(PREFIX) && !keep.has(key.slice(PREFIX.length))) stale.push(key.slice(PREFIX.length))
      }
      for (const id of stale) this.drop(id)
    } catch {
      // 同上
    }
    for (const id of [...this.pending.keys()]) if (!keep.has(id)) this.drop(id)
  }

  private write(deviceId: string, lists: CachedLists): void {
    this.last.set(deviceId, this.now())
    try {
      const payload = {
        v: VERSION,
        savedAt: this.now(),
        sessions: trimSessions(lists.sessions),
        projects: trimProjects(lists.projects),
      }
      this.storage?.setItem(PREFIX + deviceId, JSON.stringify(payload))
    } catch {
      // 存储满了或被禁用：下次打开就没有缓存，不影响使用
    }
  }
}

/** 浏览器的 localStorage；取不到（隐私模式、被禁用）就是 null */
export function browserStorage(): CacheStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

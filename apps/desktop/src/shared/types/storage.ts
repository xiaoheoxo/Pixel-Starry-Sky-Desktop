// 设置 › 存储：本机数据目录的占用和清理。主进程统计，界面只显示和发起清理；只看本机，不含 SSH / WSL 机器上的数据。

/** 占用分类：会话按是否归档分两类；项目副本在各项目旁的 .pixelsky/worktrees，不在数据目录里 */
export type StoragePartKey = 'sessions' | 'archived' | 'copies' | 'cache' | 'logs' | 'other'

export const STORAGE_PARTS: readonly StoragePartKey[] = ['sessions', 'archived', 'copies', 'cache', 'logs', 'other']

/** 本机的一个会话和它的会话目录（对话记录、检查点）占多大 */
export interface StorageSession {
  id: string
  title: string
  /** 所属项目的名字；项目已经移除时为 null */
  projectName: string | null
  /** 最后活动时间（毫秒） */
  updatedAt: number
  archivedAt: number | null
  pinned: boolean
  /** 正在运行、等审批或后台还有子智能体：不能删 */
  busy: boolean
  bytes: number
}

/** 一个项目副本（工作树） */
export interface StorageCopy {
  id: string
  name: string
  path: string
  projectName: string | null
  branch: string
  /** 上次查到有没提交的改动 */
  dirty: boolean
  /** 目录已经不在了 */
  missing: boolean
  bytes: number
}

export interface StorageUsage {
  /** 数据目录 */
  root: string
  /** 统计完成的时间（毫秒） */
  scannedAt: number
  parts: Record<StoragePartKey, number>
  sessions: StorageSession[]
  copies: StorageCopy[]
}

export interface StorageDeleteResult {
  done: string[]
  failed: Array<{ id: string; message: string }>
}

export interface StorageBridge {
  /** 统计占用；force 为 false 时，一分钟内统计过就直接用上次的结果 */
  usage(force?: boolean): Promise<StorageUsage>
  /** 在资源管理器里打开数据目录 */
  open(): Promise<void>
  /** 清除界面缓存（网页缓存、代码缓存、着色器缓存）；返回释放的字节数 */
  clearCache(): Promise<number>
  /** 永久删除本机会话（含归档的）；正在运行的会跳过 */
  deleteSessions(ids: string[]): Promise<StorageDeleteResult>
  /** 恢复一个已归档的会话 */
  restoreSession(id: string): Promise<void>
}

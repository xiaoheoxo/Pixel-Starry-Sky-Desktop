// 设置 › 存储的统计：按分类算数据目录和项目副本的占用。只用 node:fs，不碰 electron，方便测试。
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { StorageCopy, StoragePartKey, StorageSession, StorageUsage } from '../../shared/types/storage'

/** Chromium 自己的缓存目录（在数据目录下）：清掉不丢数据，下次打开慢一点 */
export const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Shared Dictionary',
] as const

/** 一次最多同时 stat 多少个条目：项目副本里可能有几十万个文件，一下全开会把文件句柄用光 */
const BATCH = 64

const norm = (path: string): string => {
  const p = resolve(path)
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * 目录（或文件）一共占多少字节。不跟符号链接 / 目录联接（pnpm 的 node_modules 里很多），读不了的条目当 0；
 * skip 返回 true 的路径整个不算。
 */
export async function dirSize(path: string, skip?: (path: string) => boolean): Promise<number> {
  let total = 0
  const pending = [path]
  while (pending.length) {
    const batch = pending.splice(0, BATCH)
    await Promise.all(
      batch.map(async p => {
        if (skip?.(p)) return
        let st
        try {
          st = await lstat(p)
        } catch {
          return
        }
        if (st.isSymbolicLink()) return
        if (!st.isDirectory()) {
          total += st.size
          return
        }
        try {
          for (const name of await readdir(p)) pending.push(join(p, name))
        } catch {
          // 没权限、正在被删：跳过
        }
      }),
    )
  }
  return total
}

/** 依次跑，最多同时 limit 个 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export interface ScanInput {
  /** 数据目录 */
  root: string
  /** 引擎的会话目录（每个会话一个子目录，名字是会话 ID） */
  sessionsDir: string
  /** 不用项目的对话的工作目录（同样每个会话一个子目录，名字是会话 ID）；删会话时引擎会一起移走 */
  chatsDir?: string
  /** 日志目录；在数据目录外也算进来 */
  logsDir: string | null
  sessions: Array<Omit<StorageSession, 'bytes'>>
  copies: Array<Omit<StorageCopy, 'bytes' | 'missing'>>
  now?: () => number
}

/** 统计占用：会话目录按会话分别算，副本按目录算，缓存和日志单独算，数据目录里剩下的都算「其他」 */
export async function scanUsage(input: ScanInput): Promise<StorageUsage> {
  const parts: Record<StoragePartKey, number> = { sessions: 0, archived: 0, copies: 0, cache: 0, logs: 0, other: 0 }
  const cacheDirs = CACHE_DIRS.map(name => join(input.root, name))
  const perSession = [input.sessionsDir, ...(input.chatsDir ? [input.chatsDir] : [])]
  const separate = new Set([...cacheDirs, ...perSession, ...(input.logsDir ? [input.logsDir] : [])].map(norm))

  // 会话目录和对话目录都按会话 ID 分子目录，同一个 ID 的加在一起
  const sessionBytes = new Map<string, number>()
  for (const dir of perSession) {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      // 还没有这个目录
    }
    const sizes = await mapLimit(names, 8, name => dirSize(join(dir, name)))
    names.forEach((name, i) => sessionBytes.set(name, (sessionBytes.get(name) ?? 0) + sizes[i]))
  }

  const sessions: StorageSession[] = input.sessions.map(s => {
    const bytes = sessionBytes.get(s.id) ?? 0
    sessionBytes.delete(s.id)
    if (s.archivedAt) parts.archived += bytes
    else parts.sessions += bytes
    return { ...s, bytes }
  })
  // 没有对应会话的目录（删了一半、旧版本留下的）算「其他」
  for (const bytes of sessionBytes.values()) parts.other += bytes

  const [cache, logs, rest, copySizes] = await Promise.all([
    Promise.all(cacheDirs.map(dir => dirSize(dir))).then(list => list.reduce((a, b) => a + b, 0)),
    input.logsDir ? dirSize(input.logsDir) : Promise.resolve(0),
    dirSize(input.root, p => separate.has(norm(p))),
    mapLimit(input.copies, 2, async c => {
      try {
        await lstat(c.path)
      } catch {
        return null
      }
      return dirSize(c.path)
    }),
  ])
  parts.cache = cache
  parts.logs = logs
  parts.other += rest
  const copies: StorageCopy[] = input.copies.map((c, i) => {
    const bytes = copySizes[i]
    parts.copies += bytes ?? 0
    return { ...c, bytes: bytes ?? 0, missing: bytes === null }
  })

  return { root: input.root, scannedAt: (input.now ?? Date.now)(), parts, sessions, copies }
}

/** 缓存目录一共多大（清除前后各量一次，算释放了多少） */
export async function cacheSize(root: string): Promise<number> {
  const list = await Promise.all(CACHE_DIRS.map(name => dirSize(join(root, name))))
  return list.reduce((a, b) => a + b, 0)
}

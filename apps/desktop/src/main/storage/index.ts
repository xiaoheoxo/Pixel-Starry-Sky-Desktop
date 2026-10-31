// 设置 › 存储（本机数据目录的占用和清理）：把 scan.ts 接到 Electron 和本机引擎宿主上。
// 只管本机：会话来自 ctx.engine，副本来自 ctx.projectTools；SSH / WSL 机器上的数据不在这里统计。
import { join } from 'node:path'
import { app, session, shell } from 'electron'
import { logger } from '@pixelsky/engine'
import type { AppContext } from '../app/context'
import { logService } from '../app/logging'
import * as ipc from '../ipc/guard'
import type { StorageDeleteResult, StorageUsage } from '../../shared/types/storage'
import { removeSessions } from './remove'
import { cacheSize, scanUsage } from './scan'

/** 一分钟内重复打开设置页直接用上次的结果（项目副本可能很大，统计要几秒） */
const FRESH_MS = 60_000
const MAX_DELETE = 1000

const log = logger('storage')

const ids = (raw: unknown): string[] => {
  if (!Array.isArray(raw) || raw.length > MAX_DELETE || raw.some(id => typeof id !== 'string' || !id))
    throw new Error('会话 ID 不正确')
  return [...new Set(raw as string[])]
}

export function initStorage(ctx: AppContext): void {
  const root = app.getPath('userData')
  let last: StorageUsage | null = null
  let running: Promise<StorageUsage> | null = null

  const scan = (): Promise<StorageUsage> => {
    running ??= (async () => {
      const host = ctx.engine
      const projects = new Map((host?.projects() ?? []).map(p => [p.id, p.name]))
      const sessions = (host?.sessions() ?? []).map(s => ({
        id: s.record.id,
        title: s.record.title,
        projectName: projects.get(s.record.projectId) ?? null,
        updatedAt: s.record.updatedAt,
        archivedAt: s.record.archivedAt ?? null,
        pinned: !!s.record.pinnedAt,
        busy: s.state !== 'idle' || !!s.background,
      }))
      const copies = (ctx.projectTools?.copies.store.data.copies ?? []).map(c => ({
        id: c.id,
        name: c.name,
        path: c.path,
        projectName: projects.get(c.projectId) ?? null,
        branch: c.branch,
        dirty: c.dirty,
      }))
      const started = Date.now()
      const usage = await scanUsage({
        root,
        sessionsDir: join(root, 'engine', 'sessions'),
        chatsDir: join(root, 'engine', 'chats'),
        logsDir: logService()?.files.dir ?? null,
        sessions,
        copies,
      })
      log.info('统计存储占用', { ms: Date.now() - started, sessions: sessions.length, copies: copies.length })
      last = usage
      return usage
    })().finally(() => {
      running = null
    })
    return running
  }

  ipc.handle('storage:usage', (_event, force: unknown) => {
    if (force !== true && last && Date.now() - last.scannedAt < FRESH_MS) return last
    return scan()
  })

  ipc.handle('storage:open', async () => {
    const err = await shell.openPath(root)
    if (err) throw new Error(`打不开数据文件夹：${err}`)
  })

  ipc.handle('storage:clearCache', async () => {
    const before = await cacheSize(root)
    const ses = session.defaultSession
    await ses.clearCache()
    await ses.clearCodeCaches({})
    await ses.clearStorageData({ storages: ['shadercache'] })
    const freed = Math.max(0, before - (await cacheSize(root)))
    log.info('清除缓存', { freed })
    last = null
    return freed
  })

  ipc.handle('storage:deleteSessions', async (_event, raw: unknown): Promise<StorageDeleteResult> => {
    const host = ctx.engine
    if (!host) throw new Error('引擎还没准备好')
    const list = ids(raw)
    const result = await removeSessions(host, list)
    log.info('删除会话', { done: result.done.length, failed: result.failed.length })
    last = null
    return result
  })

  ipc.handle('storage:restoreSession', async (_event, id: unknown) => {
    const host = ctx.engine
    if (!host) throw new Error('引擎还没准备好')
    if (typeof id !== 'string' || !id) throw new Error('会话 ID 不正确')
    await host.archiveSession(id, false, false)
    last = null
  })
}

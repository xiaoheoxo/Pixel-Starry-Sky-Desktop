// 设置 › 存储（本机数据目录的占用和清理）：把 scan.ts 接到 Electron 和本机引擎宿主上。
// 只管本机：会话来自 ctx.engine，副本来自 ctx.projectTools；SSH / WSL 机器上的数据不在这里统计。
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, Notification, session, shell } from 'electron'
import { dataRoot } from '../app/data-dir'
import { DATA_ENTRIES, inside, samePath } from '../app/data-location'
import { logger } from '@pixelsky/engine'
import type { AppContext } from '../app/context'
import { logService } from '../app/logging'
import { isPayWindow } from '../app/payWindowRegistry'
import { sendWhenReady } from '../app/rendererHealth'
import { isSettingsWindow } from '../app/settingsWindowRegistry'
import { trayText } from '../app/tray'
import { windowLocale } from '../app/ui-language'
import * as ipc from '../ipc/guard'
import type { StorageDeleteResult, StorageUsage } from '../../shared/types/storage'
import { removeSessions } from './remove'
import { cacheSize, dirSize, scanUsage } from './scan'

/** 一分钟内重复打开设置页直接用上次的结果（项目副本可能很大，统计要几秒） */
const FRESH_MS = 60_000
const MAX_DELETE = 1000
/** 数据目录所在磁盘剩余少于这么多：弹一次系统通知（每次运行一次，docs/ui/checkpoint-disk.md） */
const LOW_DISK = 2 * 1024 ** 3
const LOW_DISK_FIRST_MS = 30_000
const LOW_DISK_EVERY_MS = 5 * 60_000

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
        sessionsDir: join(dataRoot(), 'engine', 'sessions'),
        chatsDir: join(dataRoot(), 'engine', 'chats'),
        logsDir: logService()?.files.dir ?? null,
        sessions,
        copies,
      })
      // 数据位置不在 userData：会话目录上面已经算了，其余数据条目（频道、附件、扩展包……）补进「其他」
      // 数据位置在 userData 里面（子文件夹）：上面统计 userData 时已经算进「其他」了，不再加
      if (!samePath(dataRoot(), root) && !inside(root, dataRoot())) {
        const counted = new Set(['engine'])
        const sizes = await Promise.all(
          DATA_ENTRIES.filter(name => !counted.has(name)).map(name => dirSize(join(dataRoot(), name))),
        )
        const engineRest = await dirSize(join(dataRoot(), 'engine'), p =>
          [join(dataRoot(), 'engine', 'sessions'), join(dataRoot(), 'engine', 'chats')].some(dir => samePath(dir, p)),
        )
        usage.parts.other += sizes.reduce((a, b) => a + b, 0) + engineRest
      }
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

  ipc.handle('storage:clearCheckpoints', async () => {
    const host = ctx.engine
    if (!host) throw new Error('引擎还没准备好')
    const freed = await host.cleanCheckpoints(true)
    log.info('清理检查点', { freed })
    last = null
    return freed
  })

  // 磁盘快满：对话、频道都会保存不了（ENOSPC），提前说一声。通知对象要留着引用，否则被回收后点击没反应
  let lowDiskNotice: Notification | null = null
  const checkDisk = async (): Promise<void> => {
    if (lowDiskNotice || !Notification.isSupported()) return
    // 对话、频道写在数据位置：看那个盘
    const fs = await statfs(dataRoot()).catch(() => null)
    const free = fs ? fs.bavail * fs.bsize : null
    if (free === null || free >= LOW_DISK) return
    log.warn('磁盘空间不足', { free })
    const text = trayText(windowLocale())
    lowDiskNotice = new Notification({
      title: text('storage.lowDiskTitle'),
      body: text('storage.lowDiskBody', { size: `${(free / 1024 ** 3).toFixed(1)} GB` }),
    })
    lowDiskNotice.on('click', () => {
      const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && !isPayWindow(w) && !isSettingsWindow(w))
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      sendWhenReady(win.webContents, 'settings:openDialog', { section: 'storage' })
    })
    lowDiskNotice.show()
  }
  setTimeout(() => void checkDisk(), LOW_DISK_FIRST_MS).unref()
  setInterval(() => void checkDisk(), LOW_DISK_EVERY_MS).unref()

  ipc.handle('storage:restoreSession', async (_event, id: unknown) => {
    const host = ctx.engine
    if (!host) throw new Error('引擎还没准备好')
    if (typeof id !== 'string' || !id) throw new Error('会话 ID 不正确')
    await host.archiveSession(id, false, false)
    last = null
  })
}

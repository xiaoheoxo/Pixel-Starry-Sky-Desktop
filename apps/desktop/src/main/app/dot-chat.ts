import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AppContext } from './context'
import * as ipc from '../ipc/guard'
import { dataRoot } from './data-dir'
import { DotChatSessions } from './dot-chat-sessions'

/** 后台多久查一次新消息 */
const DOT_POLL_MS = 60_000
import { sendWhenReady } from './rendererHealth'

/** Dot 复用主窗口的对话标签；每次调用显式携带账号 + Dot 引用，切标签不改变目标。 */
export function initDotChat(ctx: AppContext, showMain: () => BrowserWindow): void {
  const sessions = new DotChatSessions(ctx.engine!, dataRoot())
  // 新消息提醒（docs/ui/dot-optimize.md §7 #3）：未读变了广播给所有窗口；每分钟查一次打开过的 Dot
  sessions.onChange = change => ctx.events.broadcast('dotChat:changed', change)
  setInterval(() => void sessions.poll(), DOT_POLL_MS).unref?.()
  const owners = new Map<Electron.WebContents, { abort: AbortController; keys: Set<string> }>()
  const bind = (sender: Electron.WebContents, value: unknown) => {
    if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error('Invalid Dot entry')
    sessions.entry(value)
    let owner = owners.get(sender)
    if (!owner) {
      owner = { abort: new AbortController(), keys: new Set() }
      owners.set(sender, owner)
      sender.once('destroyed', () => {
        owner!.abort.abort()
        owners.delete(sender)
        for (const key of owner!.keys)
          if (![...owners.values()].some(other => other.keys.has(key))) sessions.release(key)
      })
    }
    owner.keys.add(value)
    return { key: value, signal: owner.abort.signal }
  }
  const deny = { deny: '不允许的调用方' }
  ipc.handle(
    'dotChat:open',
    async (_event, value?: unknown) => {
      if (value !== undefined && (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)))
        throw new Error('Invalid Dot entry')
      const catalog = await sessions.catalog(value === undefined)
      const key = typeof value === 'string' ? value : catalog.entries[0]?.key
      if (!key) throw new Error(catalog.errors[0] || 'No Dot available; refresh the Dot list')
      const snapshot = sessions.snapshot(key)
      const main = showMain()
      sendWhenReady(main.webContents, 'mainWindow:action', { kind: 'openSession', sessionId: snapshot.record.id })
    },
    deny,
  )
  ipc.handle(
    'dotChat:catalog',
    (_event, refresh?: unknown) => {
      if (refresh !== undefined && typeof refresh !== 'boolean') throw new Error('Invalid refresh flag')
      return sessions.catalog(refresh === true)
    },
    deny,
  )
  ipc.handle('dotChat:snapshot', (event, key: unknown) => sessions.snapshot(bind(event.sender, key).key), deny)
  ipc.handle(
    'dotChat:send',
    (event, key: unknown, id: unknown, text: unknown, files?: unknown) =>
      sessions.send(bind(event.sender, key).key, id, text, files),
    deny,
  )
  ipc.handle(
    'dotChat:pickFiles',
    async (event, value: unknown) => {
      const { key } = bind(event.sender, value)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('Dot chat window required')
      const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      if (result.canceled || win.isDestroyed()) return []
      return sessions.pickFiles(key, result.filePaths)
    },
    deny,
  )
  ipc.handle(
    'dotChat:addFiles',
    (event, value: unknown, files: unknown) => sessions.addFiles(bind(event.sender, value).key, files),
    deny,
  )
  ipc.handle(
    'dotChat:file',
    async (event, value: unknown, fileId: unknown) => {
      const { key, signal } = bind(event.sender, value)
      const file = await sessions.download(key, fileId, signal)
      return { name: file.name, mime: file.mime, dataBase64: Buffer.from(file.data).toString('base64') }
    },
    deny,
  )
  ipc.handle(
    'dotChat:saveFile',
    async (event, value: unknown, fileId: unknown) => {
      const { key, signal } = bind(event.sender, value)
      const file = await sessions.download(key, fileId, signal)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed()) return false
      const result = await dialog.showSaveDialog(win, { defaultPath: basename(file.name.replaceAll('\\', '/')) })
      if (result.canceled || !result.filePath || win.isDestroyed()) return false
      await writeFile(result.filePath, file.data)
      return true
    },
    deny,
  )
  ipc.handle(
    'dotChat:computerOffer',
    (event, value: unknown, offer: unknown) => {
      const { key, signal } = bind(event.sender, value)
      return sessions.computerOffer(key, offer, signal)
    },
    deny,
  )
  ipc.handle(
    'dotChat:read',
    (event, value: unknown, raw: unknown) => {
      const options = raw === undefined ? {} : raw
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid Dot read options')
      const input = options as { before?: unknown; overview?: unknown; seen?: unknown }
      if (
        (input.before !== undefined && (typeof input.before !== 'string' || input.before.length > 500)) ||
        (input.overview !== undefined && typeof input.overview !== 'boolean') ||
        (input.seen !== undefined && typeof input.seen !== 'boolean')
      )
        throw new Error('Invalid Dot read options')
      const { key, signal } = bind(event.sender, value)
      return sessions.read(
        key,
        {
          before: input.before as string | undefined,
          overview: input.overview as boolean | undefined,
          seen: input.seen as boolean | undefined,
        },
        signal,
      )
    },
    deny,
  )
}

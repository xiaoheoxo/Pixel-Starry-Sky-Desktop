// 脚本扩展的命令：主进程入口（docs/ui/extension-commands-plan.md §4）
import { app, type WebContents } from 'electron'
import { join } from 'node:path'
import { dataRoot } from '../../app/data-dir'
import { text } from '@pixelsky/engine'
import { codedError } from '@pixelsky/protocol'
import type { ExtCommandApiReply, ExtCommandOutcome } from '../../../shared/types/ext-commands'
import * as ipc from '../../ipc/guard'
import type { ExtensionPacks } from '../service'
import { ScriptStorage } from './consent'
import { ScriptHost } from './host'
import { runScriptCommand } from './runner'

interface Active {
  revision: number
  granted: readonly string[]
  cancel(reason: 'stopped'): void
}

export function initExtCommands(service: ExtensionPacks): void {
  const host = new ScriptHost()
  const storage = new ScriptStorage(join(dataRoot(), 'extension-packs', 'script-storage'))
  service.onForgetScript(id => storage.forget(id))
  const active = new Map<string, Active>()
  const pendingCalls = new Map<number, { sender: WebContents; resolve: (r: ExtCommandApiReply) => void }>()
  let callSeq = 0

  // 停用、卸载、停用名单、更新、撤销权限：立刻停掉
  service.onChange(() => {
    for (const [key, run] of active) {
      const now = service.scriptTarget(key)
      if (!now || now.revision !== run.revision || run.granted.some(p => !now.granted.includes(p)))
        run.cancel('stopped')
    }
  })

  ipc.handle(
    'extCommands:run',
    async (event, rawKey: unknown, rawId: unknown, rawToken: unknown): Promise<ExtCommandOutcome> => {
      const key = text(rawKey, 'key'),
        commandId = text(rawId, 'commandId'),
        token = text(rawToken, 'token')
      const target = service.scriptTarget(key)
      if (!target || !target.commandIds.includes(commandId)) return { status: 'failed', code: 'unavailable' }
      if (active.has(key)) return { status: 'failed', code: 'busy' }
      const missing = target.permissions.filter(p => !target.granted.includes(p))
      if (missing.length) return { status: 'needsConsent', permissions: missing }
      const code = await service.readScript(key)
      // 读文件期间可能又点了一次，也可能被停用、更新、撤销了权限（这时候还没进 active，onChange 管不到）
      if (active.has(key)) return { status: 'failed', code: 'busy' }
      const now = service.scriptTarget(key)
      if (!now || now.revision !== target.revision || target.granted.some(p => !now.granted.includes(p)))
        return { status: 'failed', code: 'stopped' }
      const sender = event.sender
      const mine = new Set<number>()
      const { done, cancel } = runScriptCommand(
        { key, id: target.id, commandId, granted: target.granted, code },
        {
          open: (t, onMemoryLimit) => host.open(t, onMemoryLimit),
          storage,
          viaWindow: (method, args) =>
            new Promise((resolve, reject) => {
              if (sender.isDestroyed()) return reject(new Error('window closed'))
              const callId = ++callSeq
              mine.add(callId)
              pendingCalls.set(callId, {
                sender,
                resolve: r => {
                  mine.delete(callId)
                  if (r.ok) resolve(r.value)
                  else reject(new Error(r.message))
                },
              })
              sender.send('extCommands:api', { callId, token, method, args })
            }),
          finished: () => {
            for (const id of mine) pendingCalls.delete(id)
            mine.clear()
            if (!sender.isDestroyed()) sender.send('extCommands:finished', token)
          },
        },
      )
      active.set(key, { revision: target.revision, granted: target.granted, cancel })
      // 窗口关了就没有人能回答了
      const onGone = (): void => cancel('stopped')
      sender.once('destroyed', onGone)
      try {
        return await done
      } finally {
        active.delete(key)
        sender.removeListener('destroyed', onGone)
      }
    },
  )

  ipc.handle('extCommands:apiReply', (event, rawId: unknown, reply: unknown) => {
    const pending = typeof rawId === 'number' ? pendingCalls.get(rawId) : undefined
    // 只认发出这次调用的那个窗口
    if (!pending || pending.sender !== event.sender) return
    pendingCalls.delete(rawId as number)
    const r = (reply ?? {}) as { ok?: unknown; value?: unknown; message?: unknown }
    pending.resolve(
      r.ok === true
        ? { ok: true, value: r.value }
        : { ok: false, message: String(r.message ?? 'failed').slice(0, 500) },
    )
  })

  ipc.handle('extCommands:grant', (_e, rawKey: unknown, raw: unknown) => {
    if (!Array.isArray(raw) || raw.length > 20 || raw.some(p => typeof p !== 'string'))
      throw codedError('extpacks.badRequest')
    service.grantScript(text(rawKey, 'key'), raw as string[])
  })
  ipc.handle('extCommands:revoke', (_e, rawKey: unknown, permission: unknown) =>
    service.revokeScript(text(rawKey, 'key'), text(permission, 'permission')),
  )
}

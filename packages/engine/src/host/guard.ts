// 工作目录维护锁：副本删除、切分支等操作前停掉这个目录下的所有会话
import { resolve } from 'node:path'
import type { HostContext } from './context'

export class HostGuard {
  constructor(private readonly ctx: HostContext) {}

  workspaceKey(path: string): string {
    const key = resolve(path)
    return process.platform === 'win32' ? key.toLowerCase() : key
  }

  /** 这个目录正在维护 */
  isLocked(path: string): boolean {
    return this.ctx.lockedWorkspaces.has(this.workspaceKey(path))
  }

  async withWorkspaceStopped<T>(path: string, action: () => Promise<T>): Promise<T> {
    const { ctx } = this
    const key = this.workspaceKey(path)
    if (ctx.lockedWorkspaces.has(key)) throw new Error('工作目录正在维护，请稍后重试')
    ctx.lockedWorkspaces.add(key)
    try {
      for (const record of ctx.records.values()) {
        if (record.subagentParentId) continue
        if (this.workspaceKey(record.cwd) !== key) continue
        const rt = ctx.m.sessions.runtime(record.id)
        await ctx.m.turn.interrupt(record.id)
        await rt.pumpFinished
        rt.generation++
        if (rt.idleTimer) clearTimeout(rt.idleTimer)
        await rt.session?.close()
        rt.session = null
        if (rt.snapshot.turnId)
          ctx.m.events.onEngineEvent(record.id, {
            type: 'turn_completed',
            turnId: rt.snapshot.turnId,
            outcome: 'interrupted',
            error: null,
          })
        if (rt.snapshot.state !== 'idle') ctx.m.events.apply(record.id, { type: 'status', state: 'idle' })
      }
      return await action()
    } finally {
      ctx.lockedWorkspaces.delete(key)
    }
  }
}

// 工作目录维护锁：副本删除、切分支等操作前停掉这个目录下的所有会话
import { resolve, sep } from 'node:path'
import type { HostContext } from './context'

/** path 和 root 相同或在它下面（都已经过 workspaceKey） */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

export class HostGuard {
  constructor(private readonly ctx: HostContext) {}

  workspaceKey(path: string): string {
    const key = resolve(path)
    return process.platform === 'win32' ? key.toLowerCase() : key
  }

  /** 这个目录（或它所在的上级目录）正在维护 */
  isLocked(path: string): boolean {
    const key = this.workspaceKey(path)
    for (const lock of this.ctx.lockedWorkspaces) if (within(key, lock)) return true
    return false
  }

  async withWorkspaceStopped<T>(path: string, action: () => Promise<T>): Promise<T> {
    const { ctx } = this
    const key = this.workspaceKey(path)
    // 和正在维护的目录相同、在它下面或包含它，都要等那边做完
    for (const lock of ctx.lockedWorkspaces)
      if (within(key, lock) || within(lock, key)) throw new Error('工作目录正在维护，请稍后重试')
    ctx.lockedWorkspaces.add(key)
    try {
      for (const record of ctx.records.values()) {
        // 会话可以开在副本的子文件夹里（导入的原生会话），在这个目录下面的也一起停
        if (!within(this.workspaceKey(record.cwd), key)) continue
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

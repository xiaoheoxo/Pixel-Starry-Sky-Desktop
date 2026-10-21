import { describe, expect, it, vi } from 'vitest'
import { resolve, join } from 'node:path'
import { TerminalManager } from './manager'

describe('TerminalManager.stopUnder', () => {
  it('stops only running terminals whose cwd is the path or inside it', async () => {
    const manager = new TerminalManager(
      resolve('scratch-none'),
      () => ({ projectId: 'p', projectName: 'p', cwd: '.' }),
      () => {},
    )
    const base = resolve('copy-root')
    const make = (cwd: string) => ({ record: { cwd }, closing: false, timer: undefined, paused: false })
    const kills: string[] = []
    const stop = vi.fn(async (run: { record: { cwd: string } }) => {
      kills.push(run.record.cwd)
    })
    const internals = manager as unknown as { running: Map<string, unknown>; stop: typeof stop }
    internals.stop = stop
    internals.running.set('a', make(base))
    internals.running.set('b', make(join(base, 'sub')))
    internals.running.set('c', make(base + '-other'))
    internals.running.set('d', make(resolve('elsewhere')))
    await manager.stopUnder(process.platform === 'win32' ? base.toUpperCase() : base)
    expect(kills.sort()).toEqual([base, join(base, 'sub')].sort())
  })
})

describe('TerminalManager.create', () => {
  it('保存记录期间窗口关了（shutdown(owner) 已执行）：不再启动进程', async () => {
    const manager = new TerminalManager(
      resolve('scratch-none'),
      () => ({ projectId: 'p', projectName: 'p', cwd: process.cwd() }),
      () => {},
    )
    let release!: () => void
    const saving = new Promise<void>(r => {
      release = r
    })
    const internals = manager as unknown as {
      settle: () => Promise<void>
      save: () => Promise<void>
      start: (owner: number, record: unknown) => unknown
      profiles: Array<{ id: string; label: string; available: boolean }>
    }
    internals.settle = async () => {}
    internals.profiles = [{ id: 'sh', label: 'Shell', available: true }]
    internals.save = vi.fn().mockReturnValueOnce(saving).mockResolvedValue(undefined)
    const start = vi.fn()
    internals.start = start
    const created = manager.create(1, { projectId: 'p' }, 'sh', 'req-1')
    await new Promise(r => setTimeout(r, 0))
    await manager.shutdown(1)
    release()
    await expect(created).resolves.toMatchObject({ status: 'stopped' })
    expect(start).not.toHaveBeenCalled()
  })
})

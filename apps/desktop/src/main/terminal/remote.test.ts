// 远端终端关窗口 / 退出时的收尾：网络静默断开、close 回不来也不能卡住
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Machines } from '../machines/service'
import { RemoteTerminals } from './remote'

let dir: string | undefined
afterEach(async () => {
  vi.useRealTimers()
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

/** 一个 kill 之后永远不回 close 的通道（断网时的 SSH channel） */
const deadChannel = () => ({ kill: vi.fn(), onClose: vi.fn(), onData: vi.fn(), onError: vi.fn() })

describe('RemoteTerminals.shutdown', () => {
  it('close 回不来：等满 5 秒当它断了，不报错，后面的终端照样停，记录标成已停止', async () => {
    const scratch = resolve('../../scratch')
    await mkdir(scratch, { recursive: true })
    dir = await mkdtemp(join(scratch, 'remote-terminals-'))
    const events: unknown[] = []
    const terminals = new RemoteTerminals({} as Machines, dir, (_owner, event) => events.push(event))
    const inner = terminals as unknown as {
      records: Array<{ id: string; status: string }>
      runs: Map<string, { channel: ReturnType<typeof deadChannel>; owner: number }>
    }
    for (const id of ['ssh-a~t1', 'ssh-a~t2']) {
      inner.records.push({ id, status: 'running' })
      inner.runs.set(id, { channel: deadChannel(), owner: 1 })
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const done = terminals.shutdown(1)
    await vi.advanceTimersByTimeAsync(5000)
    await expect(done).resolves.toBeUndefined()
    expect(terminals.hasRunning(1)).toBe(false)
    expect(inner.records.map(r => r.status)).toEqual(['stopped', 'stopped'])
    expect(events).toHaveLength(2)
  })
})

describe('RemoteTerminals 启动 shell', () => {
  /** openShell 由测试手动放行的机器：记下每次打开的通道 */
  const slowMachines = () => {
    const opens: Array<{ resolve: (channel: ReturnType<typeof deadChannel>) => void }> = []
    const machines = {
      connection: () => ({
        hello: { shell: '/bin/sh' },
        openShell: () => new Promise(resolve => opens.push({ resolve })),
      }),
      state: () => ({ machines: [] }),
    } as unknown as Machines
    return { machines, opens }
  }
  const setup = async (machines: Machines) => {
    const scratch = resolve('../../scratch')
    await mkdir(scratch, { recursive: true })
    dir = await mkdtemp(join(scratch, 'remote-terminals-'))
    const terminals = new RemoteTerminals(machines, dir, () => {})
    const inner = terminals as unknown as {
      records: Array<{ id: string; cwd: string; status: string; generation: number }>
      start(owner: number, record: unknown): Promise<unknown>
    }
    inner.records.push({ id: 'ssh-a~t1', cwd: '/home', status: 'stopped', generation: 0 })
    return { terminals, inner }
  }

  it('重启要等 shell 开好才放开：连点两次只开一个', async () => {
    const { machines, opens } = slowMachines()
    const { terminals } = await setup(machines)
    const first = terminals.change(1, 'ssh-a~t1', true, true)
    await expect(terminals.change(1, 'ssh-a~t1', true, true)).rejects.toThrow('终端正在关闭')
    expect(opens).toHaveLength(1)
    opens[0].resolve(deadChannel())
    await first
    expect(terminals.hasRunning(1)).toBe(true)
  })

  it('打开期间终端被关掉或又重启了：先开好的 shell 关掉，不记着', async () => {
    const { machines, opens } = slowMachines()
    const { terminals, inner } = await setup(machines)
    const record = inner.records[0]
    const removed = inner.start(1, record)
    inner.records.length = 0
    const gone = deadChannel()
    opens[0].resolve(gone)
    await removed
    expect(gone.kill).toHaveBeenCalled()
    expect(terminals.hasRunning(1)).toBe(false)

    inner.records.push(record)
    const older = inner.start(1, record),
      newer = inner.start(1, record)
    const stale = deadChannel(),
      fresh = deadChannel()
    opens[1].resolve(stale)
    opens[2].resolve(fresh)
    await Promise.all([older, newer])
    expect(stale.kill).toHaveBeenCalled()
    expect(fresh.kill).not.toHaveBeenCalled()
    expect(terminals.hasRunning(1)).toBe(true)
  })
})

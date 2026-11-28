import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINES, type EngineInfo } from '@pixelsky/protocol'
import { EngineHost, type EngineAdapter, type SessionContext } from '../src'
import { makeTmp, removeTmp } from './helpers/tmp'

// 闲置引擎进程释放（docs/engine-idle-release.md）：闲置时长按设置、改了马上重算、「不释放」、闲置上限、内存紧张时释放

const MIN = 60_000

/** 内存紧张时闲置不到 2 分钟的不放（MEMORY_KEEP_MS）：按 3 分钟后的时间放 */
function releaseLater(host: EngineHost, after = 3 * MIN): number {
  const now = Date.now()
  const spy = vi.spyOn(Date, 'now').mockReturnValue(now + after)
  try {
    return host.releaseIdleProcesses('memory')
  } finally {
    spy.mockRestore()
  }
}
const roots: string[] = []
const hosts: EngineHost[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(hosts.splice(0).map(h => h.shutdown()))
  roots.splice(0).forEach(removeTmp)
})

function setup(opts: { root?: string } = {}) {
  const root = opts.root ?? makeTmp('idle-release')
  if (!opts.root) roots.push(root)
  const contexts = new Map<string, SessionContext>()
  const closes = new Map<string, number>()
  const adapter: EngineAdapter = {
    info: async () =>
      ({ ...ENGINES.codex, status: 'ready', version: '1.0.0', path: 'codex', message: null }) as EngineInfo,
    createSession: ctx => {
      const id = ctx.record().id
      contexts.set(id, ctx)
      return {
        send: () => {},
        interrupt: async () => {},
        answer: () => {},
        update: async () => {},
        stopTask: async () => {},
        taskOutput: async () => ({ output: '', truncated: false }),
        close: async () => {
          closes.set(id, (closes.get(id) ?? 0) + 1)
        },
      }
    },
  }
  const host = new EngineHost({ dataDir: join(root, 'data'), adapters: { codex: adapter }, emit: () => {} })
  hosts.push(host)
  const project = host.addProject(root)
  const create = () => host.createSession({ projectId: project.id, engine: 'codex' }).id
  /** 发一条消息，等引擎进程起来（还在跑） */
  const start = async (id: string) => {
    await host.send(id, '你好')
    await vi.waitFor(() => expect(host.open(id).state).toBe('running'))
  }
  /** 让这一轮结束，会话转为闲置 */
  const finish = async (id: string) => {
    const turnId = host.open(id).turnId!
    contexts.get(id)!.emit({ type: 'turn_completed', turnId, outcome: 'completed', error: null })
    await vi.waitFor(() => expect(host.open(id).state).toBe('idle'))
  }
  const closed = (id: string) => closes.get(id) ?? 0
  const processes = () => host.memoryStats().processes
  return { root, host, contexts, create, start, finish, closed, processes }
}

/** 记下宿主挂的定时器（延迟和回调），照常交给真的 setTimeout */
function spyTimers() {
  const real = globalThis.setTimeout
  const calls: { ms: number; fn: () => void }[] = []
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    calls.push({ ms: ms ?? 0, fn })
    return real(fn, ms)
  }) as typeof setTimeout)
  return calls
}

describe('闲置时长设置', () => {
  it('默认 10 分钟；改了存进设置文件，重开宿主还在；不合法的值报错', async () => {
    const { root, host } = setup()
    expect(host.idleRelease()).toEqual({ minutes: 10 })
    expect(host.setIdleRelease(5)).toEqual({ minutes: 5 })
    const file = JSON.parse(readFileSync(join(root, 'data', 'engine-settings.json'), 'utf8'))
    expect(file.idleReleaseMinutes).toBe(5)
    expect(() => host.setIdleRelease(7)).toThrow('闲置释放时长')
    expect(() => host.setIdleRelease('10')).toThrow('闲置释放时长')
    expect(host.setIdleRelease(null)).toEqual({ minutes: null })
    await host.shutdown()
    const again = setup({ root })
    expect(again.host.idleRelease()).toEqual({ minutes: null })
  })

  it('设置文件里的值坏了按 10 分钟', () => {
    const root = makeTmp('idle-release')
    roots.push(root)
    const first = setup({ root })
    first.host.setIdleRelease(30)
    const path = join(root, 'data', 'engine-settings.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), idleReleaseMinutes: 999 }))
    const again = setup({ root })
    expect(again.host.idleRelease()).toEqual({ minutes: 10 })
  })
})

describe('到点释放', () => {
  it('一轮结束按设置的时长挂定时器，到点关掉进程；下一条消息重新起进程', async () => {
    const { host, create, start, finish, closed, processes } = setup()
    const id = create()
    await start(id)
    const timers = spyTimers()
    await finish(id)
    const idle = timers.filter(t => t.ms === 10 * MIN)
    expect(idle).toHaveLength(1)
    idle[0].fn()
    await vi.waitFor(() => expect(closed(id)).toBe(1))
    expect(processes()).toBe(0)
    await start(id)
    expect(processes()).toBe(1)
    expect(host.open(id).state).toBe('running')
  })

  it('改了时长：已经闲置着的按原起点重挂（不从头算）', async () => {
    const { host, create, start, finish } = setup()
    const id = create()
    await start(id)
    await finish(id)
    const timers = spyTimers()
    host.setIdleRelease(30)
    const rearmed = timers.filter(t => t.ms > 29 * MIN && t.ms <= 30 * MIN)
    expect(rearmed).toHaveLength(1)
  })

  it('内存紧张时刚用完不到 2 分钟的不放，过了再放', async () => {
    const { host, create, start, finish, closed } = setup()
    const id = create()
    await start(id)
    await finish(id)
    expect(host.releaseIdleProcesses('memory')).toBe(0)
    expect(releaseLater(host, MIN)).toBe(0)
    expect(closed(id)).toBe(0)
    expect(releaseLater(host)).toBe(1)
    await vi.waitFor(() => expect(closed(id)).toBe(1))
  })

  it('改成「不释放」：清掉定时器，不再挂；内存紧张时照样能放', async () => {
    const { host, create, start, finish, closed } = setup()
    const id = create()
    await start(id)
    const timers = spyTimers()
    const clears = vi.spyOn(globalThis, 'clearTimeout')
    await finish(id)
    expect(timers.filter(t => t.ms === 10 * MIN)).toHaveLength(1)
    host.setIdleRelease(null)
    expect(clears).toHaveBeenCalled()
    expect(timers.filter(t => t.ms >= MIN)).toHaveLength(1)
    expect(closed(id)).toBe(0)
    expect(releaseLater(host)).toBe(1)
    await vi.waitFor(() => expect(closed(id)).toBe(1))
  })
})

describe('闲置上限', () => {
  it('闲置着还开着进程的最多留 2 个，第 3 个闲置时放最久没用的', async () => {
    const { create, start, finish, closed, processes } = setup()
    const [a, b, c] = [create(), create(), create()]
    for (const id of [a, b, c]) await start(id)
    await finish(a)
    await new Promise(r => setTimeout(r, 5))
    await finish(b)
    await new Promise(r => setTimeout(r, 5))
    expect(closed(a)).toBe(0)
    await finish(c)
    await vi.waitFor(() => expect(closed(a)).toBe(1))
    expect(closed(b)).toBe(0)
    expect(closed(c)).toBe(0)
    expect(processes()).toBe(2)
  })

  it('还在跑的不算进上限，也不会被放', async () => {
    const { create, start, finish, closed } = setup()
    const [a, b, c] = [create(), create(), create()]
    for (const id of [a, b, c]) await start(id)
    await finish(a)
    await finish(b)
    // c 还在跑：闲置的只有 a、b 两个，不超
    expect(closed(a) + closed(b) + closed(c)).toBe(0)
  })

  it('设置成「不释放」时不限数量', async () => {
    const { host, create, start, finish, closed } = setup()
    host.setIdleRelease(null)
    const ids = [create(), create(), create()]
    for (const id of ids) await start(id)
    for (const id of ids) await finish(id)
    expect(ids.map(closed)).toEqual([0, 0, 0])
  })
})

describe('内存紧张时释放', () => {
  it('只放闲置的：在跑的、有后台子智能体的、有后台命令的都不动', async () => {
    const { host, contexts, create, start, finish, closed } = setup()
    host.setIdleRelease(null)
    const [idle, running, agents, tasks] = [create(), create(), create(), create()]
    for (const id of [idle, running, agents, tasks]) await start(id)
    await finish(idle)
    contexts.get(agents)!.emit({ type: 'background', count: 1 })
    await finish(agents)
    contexts
      .get(tasks)!
      .emit({ type: 'tasks', tasks: [{ id: 't1', kind: 'local_bash', description: 'pnpm dev', message: null }] })
    await finish(tasks)
    expect(releaseLater(host)).toBe(1)
    await vi.waitFor(() => expect(closed(idle)).toBe(1))
    expect([running, agents, tasks].map(closed)).toEqual([0, 0, 0])
  })

  it('没有进程的会话（已经放过的）不重复放', async () => {
    const { host, create, start, finish, closed } = setup()
    const id = create()
    await start(id)
    await finish(id)
    expect(releaseLater(host)).toBe(1)
    expect(releaseLater(host)).toBe(0)
    await vi.waitFor(() => expect(closed(id)).toBe(1))
  })
})

describe('审查补的回归', () => {
  it('停止后直接发新消息：队列里只剩单独暂停的项，这一轮结束后也算闲置，能放', async () => {
    const { host, contexts, create, start, finish, closed } = setup()
    const id = create()
    await start(id)
    await host.send(id, '第二条')
    const first = host.open(id).turnId!
    void host.interrupt(id)
    contexts.get(id)!.emit({ type: 'turn_completed', turnId: first, outcome: 'interrupted', error: null })
    await vi.waitFor(() => expect(host.open(id).state).toBe('idle'))
    await host.send(id, '第三条')
    await vi.waitFor(() => expect(host.open(id).state).toBe('running'))
    await finish(id)
    const queue = host.open(id).queue
    expect(queue.length).toBeGreaterThan(0)
    expect(queue.every(q => q.held)).toBe(true)
    expect(releaseLater(host)).toBe(1)
    await vi.waitFor(() => expect(closed(id)).toBe(1))
  })

  it('到点时会话被别的流程占着：没放成，过 60 秒再看一次', async () => {
    const { host, create, start, finish, closed } = setup()
    const id = create()
    await start(id)
    const timers = spyTimers()
    await finish(id)
    const idle = timers.find(t => t.ms === 10 * MIN)!
    // 模拟补终端轮次、撤回改动这类流程正占着会话
    const changing = (host as unknown as { ctx: { changingSessions: Set<string> } }).ctx.changingSessions
    changing.add(id)
    idle.fn()
    expect(closed(id)).toBe(0)
    const retry = timers.filter(t => t.ms === MIN)
    expect(retry).toHaveLength(1)
    changing.delete(id)
    retry[0].fn()
    await vi.waitFor(() => expect(closed(id)).toBe(1))
  })
})

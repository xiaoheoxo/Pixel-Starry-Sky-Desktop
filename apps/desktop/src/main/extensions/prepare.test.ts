// 队友派来的活（docs/multica-learn.md §11.4）：会话启动前的扩展准备不带我的任何 MCP、扩展
import { describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@pixelsky/protocol'

vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {}, shell: {} }))
vi.mock('../app/system-cipher', () => ({ systemCipher: {} }))

const { Extensions } = await import('./ipc')

const record = { id: 's1', engine: 'claude', cwd: 'D:/web', projectId: 'p1' } as unknown as SessionRecord
const entry = (name: string) => ({ url: `http://127.0.0.1/${name}`, token: 't' })

function make(isolated: boolean) {
  const launches: unknown[][] = []
  const ctx = {
    channelTools: {
      forSession: async () => ({ tools: { mode: 'only', ids: [] }, entry: isolated ? null : entry('ch'), isolated }),
    },
    extPacks: {
      readyWithin: async () => {},
      mcpLaunch: () => ({ key: 'k', servers: { mine: { type: 'stdio', command: 'x' } } }),
      skillLaunch: () => ({ key: 'p', pluginDirs: ['D:/packs'], skillRoots: [] }),
    },
  }
  const history = { entry: async () => entry('history') }
  const threads = { entry: async () => entry('threads') }
  const ext = new Extensions(ctx as never, history as never, threads as never)
  ;(ext as unknown as { service: unknown }).service = {
    launch: (...args: unknown[]) => {
      launches.push(args)
      return { key: 'base', pluginDirs: [], pathDirs: [] }
    },
  }
  return { ext, launches }
}

describe('扩展准备', () => {
  it('队友派来的活：应用自己的 MCP、扩展包的连接器和技能都不带，引擎只读项目的 MCP', async () => {
    const { ext, launches } = make(true)
    const launch = await ext.prepare(record)
    const [, , , servers, only, packServers] = launches[0]
    expect(servers).toEqual({})
    expect(only).toEqual(new Set())
    expect(packServers).toEqual({})
    expect(launch.strictMcp).toBe(true)
    expect(launch.pluginDirs).toEqual([])
    expect(launch.allowTools).toBeUndefined()
  })

  it('oh-my-pi：应用自己的工具另给（走它的扩展）、带扩展包；队友派来的活隔离，key 不同会换进程', async () => {
    const omp = { ...record, engine: 'omp' } as SessionRecord
    const { ext, launches } = make(false)
    const plain = await ext.prepare(omp)
    expect(plain.ownTools?.map(t => t.name)).toEqual(['pixelsky_history', 'pixelsky_threads', 'pixelsky_channel'])
    expect(plain.ownTools?.[2]).toEqual({ name: 'pixelsky_channel', url: 'http://127.0.0.1/ch', token: 't' })
    expect(launches[0][1]).toBe('omp')
    expect(launches[0][5]).toHaveProperty('mine')
    const isolated = make(true)
    const launch = await isolated.ext.prepare(omp)
    expect(launch.strictMcp).toBe(true)
    expect(launch.ownTools).toEqual([])
    expect(isolated.launches[0][5]).toEqual({})
    expect(launch.key).toBe('base|isolated')
  })

  it('平常：照旧带应用自己的 MCP 和扩展包', async () => {
    const { ext, launches } = make(false)
    const launch = await ext.prepare(record)
    const [, , , servers, , packServers] = launches[0]
    expect(Object.keys(servers as object).sort()).toEqual(
      ['pixelsky_channel', 'pixelsky_history', 'pixelsky_threads'].sort(),
    )
    expect(packServers).toHaveProperty('mine')
    expect(launch.strictMcp).toBeUndefined()
  })
})

import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENGINES, type EngineId, type EngineInfo, type Item } from '@pixelsky/protocol'
import { EngineHost, type EngineAdapter, type SessionContext } from '../src'
import { BACKGROUND_STOPPED } from '../src/host/sessions'
import { makeTmp, removeTmp } from './helpers/tmp'

// 换额度来源 / 换引擎要换进程时，后台命令会被引擎连同进程一起结束：对话里留一条提示说清楚（docs/ui/source-switch.md §9）

const roots: string[] = []
const hosts: EngineHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(h => h.shutdown()))
  roots.splice(0).forEach(removeTmp)
})

function setup() {
  const root = makeTmp('switch-background')
  roots.push(root)
  const contexts = new Map<string, SessionContext>()
  const closes: { engine: EngineId; id: string }[] = []
  const adapter = (engine: EngineId): EngineAdapter => ({
    info: async () =>
      ({ ...ENGINES[engine], status: 'ready', version: '1.0.0', path: engine, message: null }) as EngineInfo,
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
          closes.push({ engine, id })
          // 真的引擎关进程时会把后台任务清空（claude/translate.ts processGone）
          ctx.emit({ type: 'tasks', tasks: [] })
        },
      }
    },
  })
  const host = new EngineHost({
    dataDir: join(root, 'data'),
    adapters: { claude: adapter('claude'), codex: adapter('codex') },
    emit: () => {},
  })
  hosts.push(host)
  const project = host.addProject(root)
  const id = host.createSession({ projectId: project.id, engine: 'claude' }).id
  const start = async () => {
    await host.send(id, '起一个开发服务')
    await vi.waitFor(() => expect(host.open(id).state).toBe('running'))
  }
  const background = (descriptions: string[]) =>
    contexts.get(id)!.emit({
      type: 'tasks',
      tasks: descriptions.map((description, i) => ({ id: `t${i}`, kind: 'local_bash', description, message: null })),
    })
  const finish = async () => {
    const turnId = host.open(id).turnId!
    contexts.get(id)!.emit({ type: 'turn_completed', turnId, outcome: 'completed', error: null })
    await vi.waitFor(() => expect(host.open(id).state).toBe('idle'))
  }
  const notices = () =>
    host
      .open(id)
      .items.filter((i): i is Extract<Item, { kind: 'notice' }> => i.kind === 'notice')
      .map(i => i.text)
  return { host, id, start, background, finish, notices, closes }
}

const platform = { groupId: '7', account: 'someone@example.com' }

describe('换进程时还有后台任务', () => {
  it('空闲时换额度来源：关进程，留一条列出后台命令的提示', async () => {
    const t = setup()
    await t.start()
    t.background(['npm run dev', 'pytest -x'])
    await t.finish()
    await t.host.update(t.id, { platform })
    expect(t.closes).toHaveLength(1)
    expect(t.notices()).toEqual([
      BACKGROUND_STOPPED.source.replace('{n}', '2').replace('{names}', 'npm run dev、pytest -x'),
    ])
    expect(t.host.open(t.id).tasks).toEqual([])
  })

  it('没有后台任务时换来源：照旧关进程，不留提示', async () => {
    const t = setup()
    await t.start()
    await t.finish()
    await t.host.update(t.id, { platform })
    expect(t.closes).toHaveLength(1)
    expect(t.notices()).toEqual([])
  })

  it('运行中换来源：这一轮不动，下一条消息换进程时才结束并提示', async () => {
    const t = setup()
    await t.start()
    t.background(['npm run dev'])
    await t.host.update(t.id, { platform })
    expect(t.closes).toHaveLength(0)
    await t.finish()
    await t.host.send(t.id, '接着来')
    await vi.waitFor(() => expect(t.closes).toHaveLength(1))
    await vi.waitFor(() =>
      expect(t.notices()).toEqual([BACKGROUND_STOPPED.source.replace('{n}', '1').replace('{names}', 'npm run dev')]),
    )
  })

  it('换引擎：关旧引擎的进程，提示说是换了引擎', async () => {
    const t = setup()
    await t.start()
    t.background(['npm run dev'])
    await t.finish()
    await t.host.update(t.id, { engine: 'codex' })
    expect(t.closes).toEqual([{ engine: 'claude', id: t.id }])
    expect(t.notices()).toEqual([BACKGROUND_STOPPED.engine.replace('{n}', '1').replace('{names}', 'npm run dev')])
    expect(t.host.open(t.id).record.engine).toBe('codex')
  })
})

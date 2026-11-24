import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@pixelsky/protocol'
import { ompAgentUsed } from '../src/omp/agents'
import { ompLaunch } from '../src/omp/launch'
import { ompOverlayText } from '../src/omp/overlay'
import { OMP_SUBAGENTS_ENV, OMP_SUBAGENT_SOURCE } from '../src/omp/subagent-ext'
import { makeTmp, removeTmp } from './helpers/tmp'

// oh-my-pi 子智能体的模型和思考深度（docs/omp-engine.md §18）

let root: string
beforeEach(() => {
  root = makeTmp('omp-subagents')
})
afterEach(() => {
  removeTmp(root)
  vi.unstubAllGlobals()
})

const record = { engine: 'omp', model: 'gpt-6.2-sol', permissionMode: 'ask' } as SessionRecord
const snapshot = (efforts: Record<string, string>, maxEffort = 'max') => JSON.stringify({ efforts, maxEffort })

describe('启动参数', () => {
  const launch = (env: NodeJS.ProcessEnv, loaded = true) => {
    const picks: boolean[] = []
    const r = ompLaunch(env, record, 'ask', undefined, {
      ...(loaded ? { subagentFile: () => '/x/sub.mjs' } : {}),
      configFile: (_s, _i, pick) => (picks.push(pick), '/x/o.yml'),
    })
    return { ...r, pick: picks[0] }
  }
  it('有设置才加载扩展；有类型按任务选才开 enableEffort', () => {
    const on = launch({ [OMP_SUBAGENTS_ENV]: snapshot({ task: 'pick' }) })
    expect(on.args).toContain('/x/sub.mjs')
    expect(on.pick).toBe(true)
    const off = launch({ [OMP_SUBAGENTS_ENV]: snapshot({ task: 'follow' }) })
    expect(off.args).toContain('/x/sub.mjs')
    expect(off.pick).toBe(false)
    expect(launch({}).args).not.toContain('/x/sub.mjs')
    expect(launch({ [OMP_SUBAGENTS_ENV]: 'oops' }).args).not.toContain('/x/sub.mjs')
  })
  it('不加载扩展时不把查设置的密钥留在环境里', () => {
    const r = launch({ [OMP_SUBAGENTS_ENV]: snapshot({ task: 'pick' }), PIXELSKY_SUBAGENT_OPTIONS_TOKEN: 't' }, false)
    expect(r.env.PIXELSKY_SUBAGENT_OPTIONS_TOKEN).toBeUndefined()
    expect(r.pick).toBe(false)
  })
  it('叠加设置和 Ultracode 合在一个 task 下', () => {
    const text = ompOverlayText({ thinkingSummaries: true, ultracode: true }, false, true)
    expect(text.match(/^task:/gm)).toHaveLength(1)
    expect(text).toContain('  eager: always')
    expect(text).toContain('  enableEffort: true')
    expect(ompOverlayText({ thinkingSummaries: true, ultracode: false })).not.toContain('task:')
  })
})

describe('扩展', () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>
  /** 装一份扩展：主智能体和每个子智能体各一份，同一个进程 */
  async function load() {
    const url =
      'data:text/javascript;base64,' + Buffer.from(OMP_SUBAGENT_SOURCE + `\n// ${Math.random()}`).toString('base64')
    const ext = (await import(/* @vite-ignore */ url)) as { default: (pi: unknown) => void }
    const make = (level: string, models: Record<string, boolean> = {}) => {
      const on: Record<string, Handler> = {}
      const pi = {
        level,
        providers: [] as Array<{ name: string; config: Record<string, unknown> }>,
        model: null as unknown,
        on: (name: string, fn: Handler) => (on[name] = fn),
        getThinkingLevel: () => pi.level,
        setThinkingLevel: (l: string) => (pi.level = l),
        registerProvider: (name: string, config: Record<string, unknown>) => pi.providers.push({ name, config }),
        setModel: async (m: { id: string }) => (models[m.id] === false ? false : ((pi.model = m), true)),
      }
      ext.default(pi)
      return { pi, on }
    }
    const ui = {
      notes: [] as string[],
      status: [] as unknown[],
      notify: (t: string) => ui.notes.push(t),
      setStatus: (_k: string, t: string) => ui.status.push(JSON.parse(t)),
    }
    const main = make('max')
    await main.on.before_agent_start!({}, { agent: { kind: 'main' }, mode: 'rpc', ui })
    let n = 0
    const spawn = async (type: string, level: string, task = '', models = {}, more: unknown[] = []) => {
      const s = make(level, models)
      const id = `A${++n}`
      const ctx = {
        agent: { kind: 'sub', name: type, id },
        model: { id: 'main-model' },
        modelRegistry: { find: (_p: string, m: string) => ({ id: m }) },
        sessionManager: {
          getSessionFile: () => id,
          getEntries: () => [{ type: 'session_init', task: 'Complete:\n\n' + task }, ...more],
        },
      }
      const start = () => s.on.before_agent_start!({}, ctx)
      await start()
      return { ...s, start }
    }
    const dispatch = (tasks: unknown[]) => {
      const event = { toolName: 'task', input: { tasks } }
      return main.on.tool_call!(event, {}).then(() => event.input.tasks as Array<Record<string, unknown>>)
    }
    return { main, spawn, dispatch, ui }
  }
  const setup = (
    efforts: Record<string, string>,
    reply?: (body: Record<string, unknown>) => unknown,
    maxEffort = 'max',
  ) => {
    delete (globalThis as Record<string, unknown>).__pixelskyOmpSub
    process.env[OMP_SUBAGENTS_ENV] = snapshot(efforts, maxEffort)
    process.env.PIXELSKY_PIXEL_SUB_BASE_URL = 'http://127.0.0.1:9'
    process.env.PIXELSKY_SUBAGENT_OPTIONS_TOKEN = 'opt'
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      if (!reply) throw new Error('offline')
      return { ok: true, json: async () => ({ omp: reply(JSON.parse(init.body) as Record<string, unknown>) }) }
    })
    return load()
  }
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__pixelskyOmpSub
    for (const k of [OMP_SUBAGENTS_ENV, 'PIXELSKY_PIXEL_SUB_BASE_URL', 'PIXELSKY_SUBAGENT_OPTIONS_TOKEN'])
      delete process.env[k]
  })

  it('跟随主会话现在的档、固定档、照 omp 自己的；没列出来的用 *', async () => {
    const e = await setup({ scout: 'low', sonic: 'omp', '*': 'follow' })
    expect(process.env.PIXELSKY_SUBAGENT_OPTIONS_TOKEN).toBeUndefined()
    expect((await e.spawn('mine', 'medium')).pi.level).toBe('max')
    e.main.pi.level = 'high'
    const follow = await e.spawn('mine', 'medium')
    expect(follow.pi.level).toBe('high')
    expect((await e.spawn('scout', 'medium')).pi.level).toBe('low')
    expect((await e.spawn('sonic', 'medium')).pi.level).toBe('medium')
    // 已经开始的不再改
    e.main.pi.level = 'low'
    await follow.start()
    expect(follow.pi.level).toBe('high')
    expect(e.ui.status.at(0)).toEqual({ id: 'A1', model: 'main-model', effort: 'max' })
    expect(e.ui.status).toHaveLength(3)
  })

  it('按任务选：选了的保留（不超过上限），没选的跟随；不让选的类型填了的拿掉', async () => {
    const rules = { efforts: { task: 'pick', '*': 'low' }, maxEffort: 'high' }
    const e = await setup({ task: 'pick', '*': 'low' }, () => rules)
    const tasks = await e.dispatch([
      { agent: 'task', task: 'one', effort: 'hi' },
      { task: 'two' },
      { agent: 'scout', task: 'three', effort: 'hi' },
    ])
    expect(tasks.map(t => t.effort)).toEqual(['hi', undefined, undefined])
    expect((await e.spawn('task', 'max', 'one')).pi.level).toBe('high')
    expect((await e.spawn('task', 'auto', 'two')).pi.level).toBe('max')
  })

  it('任务文字首尾有空白、一个包着另一个，也对得上', async () => {
    const rules = { efforts: { task: 'pick' }, maxEffort: 'max' }
    const e = await setup({ task: 'pick' }, () => rules)
    await e.dispatch([
      { task: 'fix tests', effort: 'lo' },
      { task: 'fix tests in x' },
      { task: '  a\n\n   b \n', effort: 'lo' },
    ])
    expect((await e.spawn('task', 'auto', 'fix tests in x')).pi.level).toBe('max')
    expect((await e.spawn('task', 'low', 'fix tests')).pi.level).toBe('low')
    expect((await e.spawn('task', 'low', 'a\n\n   b')).pi.level).toBe('low')
  })

  it('换了进程再叫醒的（已经答过话）不改', async () => {
    const e = await setup({ '*': 'follow' })
    const s = await e.spawn('task', 'low', 'x', {}, [{ type: 'message', message: { role: 'assistant' } }])
    expect(s.pi.level).toBe('low')
  })

  it('没开 enableEffort 时不动派活的参数', async () => {
    const e = await setup({ '*': 'follow' })
    expect((await e.dispatch([{ task: 'x', effort: 'hi' }]))[0]!.effort).toBe('hi')
  })

  it('单独的线路：注册提供方、密钥只在内存里；换不过去或不能用时说明原因、跟随对话', async () => {
    const route = { api: 'openai-responses', model: { id: 'other', contextWindow: 9 } }
    const e = await setup({ '*': 'low' }, b => ({
      efforts: { '*': 'low' },
      maxEffort: 'max',
      ...(b.type === 'scout' ? { route, secret: 's1' } : b.type === 'sonic' ? { problem: '线路不在了' } : {}),
    }))
    const ok = await e.spawn('scout', 'medium')
    expect(ok.pi.model).toEqual({ id: 'other' })
    expect(ok.pi.providers[0]).toMatchObject({
      name: 'pixelsky-sub-1',
      config: {
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 's1',
        models: [{ id: 'other', contextWindow: 9, reasoning: true }],
      },
    })
    expect(JSON.stringify(process.env)).not.toContain('"s1"')
    const bad = await e.spawn('scout', 'medium', '', { other: false })
    expect(bad.pi.model).toBeNull()
    expect(bad.pi.level).toBe('low')
    await e.spawn('sonic', 'medium')
    expect(e.ui.notes).toHaveLength(2)
    expect(e.ui.notes[1]).toContain('线路不在了')
  })
})

describe('读回', () => {
  it('子智能体会话文件里最后的强度；换过线路的给出换过的模型', () => {
    mkdirSync(root, { recursive: true })
    const file = join(root, 'a.jsonl')
    const lines = [
      { type: 'model_change', model: 'pixelsky/main' },
      { type: 'thinking_level_change', thinkingLevel: 'medium' },
      { type: 'message', message: { role: 'user', content: 'thinking_level_change model_change' } },
    ]
    const write = (extra: unknown[]) =>
      writeFileSync(file, [...lines, ...extra].map(l => JSON.stringify(l)).join('\n') + '\n')
    write([])
    expect(ompAgentUsed(file)).toEqual({ effort: 'medium' })
    write([
      { type: 'model_change', model: 'pixelsky-sub-2/org/other' },
      { type: 'thinking_level_change', thinkingLevel: 'xhigh' },
    ])
    expect(ompAgentUsed(file)).toEqual({ effort: 'xhigh', model: 'org/other' })
  })
})

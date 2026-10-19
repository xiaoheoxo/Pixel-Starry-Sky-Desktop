// 设置 › 子智能体：task 工具按类型起子进程（站点、只读、额外说明、最长运行），出错且还没动手时改走主会话的模型，
// 同时运行有上限（docs/ui/subagent-routing.md）
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { subagentProvider } from '../src/extensions/gateway.ts'
import {
  READ_ONLY_TOOLS,
  SUBAGENT_ENV,
  SUBAGENT_FALLBACK_ENV,
  SUBAGENT_MAX_CONCURRENT_ENV,
  SUBAGENT_PROVIDER,
  SUBAGENT_TYPES_ENV,
  SUBAGENT_TYPE_ENV,
  SUB_BASE_URL_ENV,
  childArgs,
  createSubagentExtension,
  subagentMaxConcurrent,
  subagentTypes,
  taskDescription,
} from '../src/tools/subagent.ts'

type Json = Record<string, unknown>
type Behave = (child: FakeChild) => void | Promise<void>

/** 假的子进程：回所有请求；prompt 之后按 behave 发消息再 agent_settled */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly received: Json[] = []
  readonly stdin: Writable
  constructor(behave: Behave) {
    super()
    let buf = ''
    this.stdin = new Writable({
      write: (chunk, _enc, done) => {
        buf += String(chunk)
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const m = JSON.parse(buf.slice(0, i)) as Json
          buf = buf.slice(i + 1)
          this.received.push(m)
          if (m.type === 'abort') continue
          this.send({ type: 'response', id: m.id, command: m.type, success: true, data: {} })
          if (m.type === 'prompt') void Promise.resolve(behave(this)).then(() => this.send({ type: 'agent_settled' }))
        }
        done()
      },
      final: done => {
        setImmediate(() => this.emit('exit', 0))
        done()
      },
    })
  }
  send(m: Json): void {
    this.stdout.write(JSON.stringify(m) + '\n')
  }
  kill(): void {
    this.emit('exit', null)
  }
}

const reply = (text: string): Json => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 1, output: 1 } },
})
const failed = (error: string): Json => ({
  type: 'message_end',
  message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: error },
})

const EXPLORE = {
  id: 'explore',
  name: '探索',
  description: 'Read-only research',
  tools: 'read',
  maxMs: 600_000,
  instructions: 'Be brief.',
  route: {
    api: 'openai-completions',
    model: { id: 'deepseek-chat', input: ['text'] },
    label: 'DeepSeek 兼容',
    token: 'PIXELSKY_PIXEL_SUB_TOKEN_2',
  },
}
const TYPES = [
  {
    id: 'general',
    name: '通用',
    description: 'Anything',
    tools: 'all',
    maxMs: 1_800_000,
    instructions: '',
    route: null,
  },
  EXPLORE,
]
const ENV = { [SUBAGENT_TYPES_ENV]: JSON.stringify(TYPES), [SUB_BASE_URL_ENV]: 'http://127.0.0.1:9' }

interface Tool {
  description: string
  parameters: { properties: Record<string, unknown> }
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Json }>
}

function setup(env: NodeJS.ProcessEnv, behaviours: Behave[]) {
  const children: FakeChild[] = []
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  const entries: Json[] = []
  let tool: Tool | null = null
  let seq = 0
  createSubagentExtension({
    mode: () => 'default',
    env,
    spawnChild: (args, childEnv) => {
      expect(childEnv[SUBAGENT_ENV]).toBe('1')
      spawned.push({ args, env: childEnv })
      const child = new FakeChild(behaviours[children.length] ?? (() => {}))
      children.push(child)
      return child as never
    },
  })({
    registerTool: (t: Tool) => (tool = t),
    getThinkingLevel: () => 'off',
    appendEntry: (_type: string, data: Json) => entries.push(data),
  } as never)
  const ctx = {
    cwd: process.cwd(),
    mode: 'rpc',
    model: { provider: 'pixelsky', id: 'claude-sonnet-5-5' },
    sessionManager: { getSessionFile: () => undefined },
    ui: { setStatus: () => {}, select: async () => undefined, notify: () => {} },
  }
  const call = (params: Json, signal?: AbortSignal) =>
    tool!.execute(`t${++seq}`, { description: '查接口', prompt: 'find it', ...params }, signal, undefined, ctx)
  const models = () => children.map(c => c.received.find(m => m.type === 'set_model'))
  return { tool: () => tool!, call, children, spawned, entries, models }
}

describe('子智能体类型', () => {
  it('读桌面端给的类型；没给时只有跟随主会话的 general；route 不完整时当成跟随主会话', () => {
    expect(subagentTypes({}).map(t => t.id)).toEqual(['general'])
    expect(subagentTypes({ [SUBAGENT_TYPES_ENV]: '{bad' }).map(t => t.id)).toEqual(['general'])
    expect(subagentTypes(ENV).map(t => [t.id, t.tools, t.maxMs, !!t.route])).toEqual([
      ['general', 'all', 1_800_000, false],
      ['explore', 'read', 600_000, true],
    ])
    const broken = [{ ...EXPLORE, route: { ...EXPLORE.route, token: 'HOME' } }]
    expect(subagentTypes({ [SUBAGENT_TYPES_ENV]: JSON.stringify(broken) }).map(t => [t.id, t.route])).toEqual([
      ['general', null],
      ['explore', null],
    ])
  })

  it('有多个类型时 task 工具多一个 type 参数，说明里列出每个类型', () => {
    const r = setup(ENV, [])
    expect(r.tool().parameters.properties).toHaveProperty('type')
    expect(r.tool().description).toContain('- explore (探索) [read-only]: Read-only research')
    expect(taskDescription(subagentTypes({}))).not.toContain('Subagent types')
    expect(setup({}, []).tool().parameters.properties).not.toHaveProperty('type')
  })

  it('子进程参数：只读只给读的工具、挡掉 MCP；额外说明追加到系统提示', () => {
    const args = childArgs({
      entry: 'cli',
      mode: 'default',
      sessionDir: null,
      readOnly: true,
      instructions: 'Be brief.',
    })
    expect(args).toContain(READ_ONLY_TOOLS.join(','))
    const i = args.indexOf('--exclude-tools')
    expect(args.slice(i, i + 2)).toEqual(['--exclude-tools', 'mcp__*'])
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(
      'Additional instructions for this subagent:\nBe brief.',
    )
    const plain = childArgs({ entry: 'cli', mode: 'default', sessionDir: null })
    expect(plain).toContain('+grep,+find,+ls')
    expect(plain).not.toContain('--append-system-prompt')
  })

  it('子智能体的 provider 只在这个类型的子进程里注册，地址按协议补 /v1', () => {
    expect(subagentProvider({ ...ENV, [SUBAGENT_TYPE_ENV]: 'explore' })).toBeNull()
    expect(subagentProvider({ ...ENV, [SUBAGENT_ENV]: '1', [SUBAGENT_TYPE_ENV]: 'general' })).toBeNull()
    const sub = subagentProvider({ ...ENV, [SUBAGENT_ENV]: '1', [SUBAGENT_TYPE_ENV]: 'explore' })
    expect(sub?.[0]).toBe(SUBAGENT_PROVIDER)
    expect(sub?.[1]).toMatchObject({
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      apiKey: '$PIXELSKY_PIXEL_SUB_TOKEN_2',
    })
    expect((sub?.[1].models as Json[])[0]).toMatchObject({
      id: 'deepseek-chat',
      reasoning: false,
      contextWindow: 128000,
    })
  })

  it('按类型起子进程：站点、只读参数、类型名记进进度', async () => {
    const r = setup(ENV, [c => c.send(reply('found'))])
    const out = await r.call({ type: 'explore' })
    expect(r.models()).toEqual([expect.objectContaining({ provider: SUBAGENT_PROVIDER, modelId: 'deepseek-chat' })])
    expect(r.spawned[0]!.env[SUBAGENT_TYPE_ENV]).toBe('explore')
    expect(r.spawned[0]!.args).toContain('--exclude-tools')
    expect(out.details).toMatchObject({ model: 'DeepSeek 兼容 · deepseek-chat', type: 'explore', typeName: '探索' })
  })

  it('不填类型用 general（跟随主会话）；不认识的类型报错并列出可用的', async () => {
    const r = setup(ENV, [c => c.send(reply('ok'))])
    await r.call({})
    expect(r.models()).toEqual([expect.objectContaining({ provider: 'pixelsky', modelId: 'claude-sonnet-5-5' })])
    await expect(r.call({ type: 'nope' })).rejects.toThrow('Available types: general, explore')
  })

  it('站点出错、还没调用工具：改走主会话的模型重来一次，结果里写明', async () => {
    const r = setup(ENV, [c => c.send(failed('401 invalid key')), c => c.send(reply('found on main'))])
    const out = await r.call({ type: 'explore' })
    expect(r.children).toHaveLength(2)
    expect(r.models()[1]).toMatchObject({ provider: 'pixelsky', modelId: 'claude-sonnet-5-5' })
    expect(out.content[0]!.text).toContain('"DeepSeek 兼容" failed (401 invalid key)')
    expect(out.content[0]!.text).toContain('found on main')
    expect(r.entries).toHaveLength(1)
  })

  it('已经动手后出错不重来；关了「出错时改用主会话」也不重来', async () => {
    const a = setup(ENV, [
      c => {
        c.send({ type: 'tool_execution_start', toolCallId: 'k1', toolName: 'read', args: {} })
        c.send(failed('429 quota'))
      },
    ])
    await expect(a.call({ type: 'explore' })).rejects.toThrow('Subagent failed: 429 quota')
    expect(a.children).toHaveLength(1)
    const b = setup({ ...ENV, [SUBAGENT_FALLBACK_ENV]: '0' }, [c => c.send(failed('401 invalid key'))])
    await expect(b.call({ type: 'explore' })).rejects.toThrow('401 invalid key')
    expect(b.children).toHaveLength(1)
  })

  it('同时运行上限：多出来的排队，前一个结束才起；排队时停下就不起子进程', async () => {
    expect(subagentMaxConcurrent({})).toBe(Infinity)
    expect(subagentMaxConcurrent({ [SUBAGENT_MAX_CONCURRENT_ENV]: '2' })).toBe(2)
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    const r = setup({ ...ENV, [SUBAGENT_MAX_CONCURRENT_ENV]: '1' }, [
      async c => {
        await gate
        c.send(reply('first'))
      },
      c => c.send(reply('second')),
    ])
    const first = r.call({})
    const second = r.call({})
    const stop = new AbortController()
    const third = r.call({}, stop.signal)
    await new Promise(res => setTimeout(res, 30))
    expect(r.children).toHaveLength(1)
    stop.abort()
    expect((await third).content[0]!.text).toBe('Subagent was stopped before it started.')
    release()
    expect((await first).content[0]!.text).toBe('first')
    expect((await second).content[0]!.text).toBe('second')
    expect(r.children).toHaveLength(2)
  })
})

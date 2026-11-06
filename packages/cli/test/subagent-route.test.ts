// 设置 › 子智能体：task 工具按类型起子进程（站点、只读、额外说明、最长运行），出错且还没动手时改走主会话的模型，
// 同时运行有上限（docs/ui/subagent-routing.md）
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { subagentProvider } from '../src/extensions/gateway.ts'
import { MCP_FILE_ENV, mcpExtension } from '../src/extensions/mcp.ts'
import {
  READ_ONLY_TOOLS,
  SUBAGENT_ENV,
  SUBAGENT_FALLBACK_ENV,
  SUBAGENT_MAX_CONCURRENT_ENV,
  SUBAGENT_MODELS_CONTEXT,
  SUBAGENT_OPTIONS_TOKEN_ENV,
  SUBAGENT_PROVIDER,
  SUBAGENT_ROUTE_ENV,
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

/** 下一个假子进程先不回哪个请求 */
let holdNext: string | null = null

/** 假的子进程：回所有请求；prompt 之后按 behave 发消息再 agent_settled */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly received: Json[] = []
  readonly stdin: Writable
  /** 这个请求先不回，测试里调 held() 再回 */
  readonly hold = holdNext
  held: (() => void) | null = null
  constructor(behave: Behave) {
    super()
    holdNext = null
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
          if (m.type === this.hold) {
            this.held = () => this.send({ type: 'response', id: m.id, command: m.type, success: true, data: {} })
            continue
          }
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

function setup(env: NodeJS.ProcessEnv, behaviours: Behave[], fetcher?: typeof fetch) {
  const children: FakeChild[] = []
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  const entries: Json[] = []
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {}
  let tool: Tool | null = null
  let seq = 0
  createSubagentExtension({
    mode: () => 'default',
    env,
    ...(fetcher ? { fetch: fetcher } : {}),
    spawnChild: (args, childEnv) => {
      expect(childEnv[SUBAGENT_ENV]).toBe('1')
      spawned.push({ args, env: childEnv })
      const child = new FakeChild(behaviours[children.length] ?? (() => {}))
      children.push(child)
      return child as never
    },
  })({
    registerTool: (t: Tool) => (tool = t),
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => (handlers[name] = fn),
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
  return { tool: () => tool!, call, children, spawned, entries, models, handlers, ctx }
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

  it('子进程参数：只读只给读的工具、关掉 MCP；额外说明追加到系统提示', () => {
    const args = childArgs({
      entry: 'cli',
      mode: 'default',
      sessionDir: null,
      readOnly: true,
      instructions: 'Be brief.',
    })
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 3)).toEqual([
      '--tools',
      READ_ONLY_TOOLS.join(','),
      '--no-mcp',
    ])
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(
      'Additional instructions for this subagent:\nBe brief.',
    )
    const plain = childArgs({ entry: 'cli', mode: 'default', sessionDir: null })
    expect(plain).toContain('+grep,+find,+ls')
    // 频道流程按会话认人：子代理不能替主代理交付、提问
    expect(plain[plain.indexOf('--exclude-tools') + 1]).toBe(
      'mcp__pixelsky_channel__task_done,mcp__pixelsky_channel__member_ask,mcp__pixelsky_channel__user_ask',
    )
    expect(plain).not.toContain('--no-mcp')
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

  it('站点没写图片时 Chat 默认只给文字，标成猜的：Pi 内置表里收图的模型（kimi-k3）改成能发图，compat 按 route 标的继承', () => {
    const types = [
      {
        ...TYPES[1],
        route: {
          api: 'openai-completions',
          model: { id: 'kimi-k3', compat: { supportsReasoningEffort: false } },
          label: 'Kimi',
          token: 'PIXELSKY_PIXEL_SUB_TOKEN_2',
          inferred: ['compat'],
        },
      },
    ]
    const env = {
      [SUBAGENT_TYPES_ENV]: JSON.stringify(types),
      [SUB_BASE_URL_ENV]: 'http://127.0.0.1:9',
      [SUBAGENT_ENV]: '1',
      [SUBAGENT_TYPE_ENV]: 'explore',
    }
    expect((subagentProvider(env)?.[1].models as Json[])[0]).toMatchObject({ input: ['text'], reasoning: false })
    const all = [
      {
        provider: 'moonshotai',
        id: 'kimi-k3',
        api: 'openai-completions',
        contextWindow: 1_048_576,
        maxTokens: 1_048_576,
        reasoning: true,
        input: ['text', 'image'],
        compat: { supportsReasoningEffort: true },
      },
    ]
    expect((subagentProvider(env, all)?.[1].models as Json[])[0]).toMatchObject({
      input: ['text', 'image'],
      reasoning: true,
      maxTokens: 524_288,
      compat: { supportsReasoningEffort: true },
    })
  })

  it('按类型起子进程：站点、只读参数、类型名记进进度；只读的不带桌面端的 MCP 服务器文件', async () => {
    // 让 mcp.ts 记下服务器文件（主会话加载扩展时就是这样），子智能体靠 mcpChildEnv 带上
    const dir = mkdtempSync(join(tmpdir(), 'pixel-subagent-mcp-'))
    const file = join(dir, 'mcp.json')
    try {
      writeFileSync(file, JSON.stringify({ mcpServers: {} }))
      process.env[MCP_FILE_ENV] = file
      mcpExtension({
        registerMcpServer: () => {},
        on: () => {},
        events: { on: () => () => {}, emit: () => {} },
        registerCommand: () => {},
      } as never)
      const r = setup(ENV, [c => c.send(reply('found')), c => c.send(reply('ok'))])
      const out = await r.call({ type: 'explore' })
      expect(r.models()).toEqual([expect.objectContaining({ provider: SUBAGENT_PROVIDER, modelId: 'deepseek-chat' })])
      expect(r.spawned[0]!.env[SUBAGENT_TYPE_ENV]).toBe('explore')
      expect(r.spawned[0]!.args).toContain('--no-mcp')
      expect(r.spawned[0]!.env[MCP_FILE_ENV]).toBeUndefined()
      expect(out.details).toMatchObject({ model: 'DeepSeek 兼容 · deepseek-chat', type: 'explore', typeName: '探索' })
      await r.call({})
      expect(r.spawned[1]!.args).not.toContain('--no-mcp')
      expect(r.spawned[1]!.env[MCP_FILE_ENV]).toBe(file)
    } finally {
      delete process.env[MCP_FILE_ENV]
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('启动时（等子进程回 get_state）停下：不再发 set_model / prompt，不会调模型', async () => {
    const r = setup(ENV, [c => c.send(reply('不该跑'))])
    const stop = new AbortController()
    holdNext = 'get_state'
    const task = r.call({}, stop.signal)
    while (!r.children[0]?.held) await new Promise(res => setTimeout(res, 5))
    stop.abort()
    r.children[0].held!()
    await task
    const sent = r.children[0].received.map(m => m.type)
    expect(sent).toContain('abort')
    expect(sent).not.toContain('set_model')
    expect(sent).not.toContain('prompt')
    expect(r.entries.pop()).toMatchObject({ state: 'stopped' })
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

describe('主模型调度（docs/ui/subagent-model-dispatch.md）', () => {
  const DISPATCH_TYPES = [
    { id: 'general', name: '通用', description: 'x', tools: 'all', maxMs: 1_800_000, instructions: '', route: null },
    {
      id: 'explore',
      name: '探索',
      description: 'x',
      tools: 'read',
      maxMs: 600_000,
      instructions: '',
      route: null,
      dispatch: true,
    },
    { ...EXPLORE, id: 'fixed' },
  ]
  const DENV = {
    [SUBAGENT_TYPES_ENV]: JSON.stringify(DISPATCH_TYPES),
    [SUB_BASE_URL_ENV]: 'http://127.0.0.1:9',
    [SUBAGENT_OPTIONS_TOKEN_ENV]: 'options-secret',
  }
  const LUNA_ROUTE = {
    api: 'openai-responses',
    model: { id: 'gpt-6-luna' },
    label: 'GPT Pro',
    token: 'PIXELSKY_PIXEL_SUB_TOKEN_0',
  }
  const LIST = {
    currentModel: 'gpt-6.1-sol',
    options: [
      { model: 'gpt-6-luna', note: '最便宜', outside: false },
      { model: 'deepseek-chat', note: '', outside: true },
    ],
    defaultModel: 'gpt-6-luna',
  }
  /** 假网关：记下请求，按 answer 回 */
  const gateway = (answer: (body: Json) => Json) => {
    const calls: Array<{ url: string; auth: string; body: Json }> = []
    const fetcher = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Json
      calls.push({ url, auth: new Headers(init.headers).get('authorization') ?? '', body })
      return new Response(JSON.stringify(answer(body)))
    }) as unknown as typeof fetch
    return { calls, fetcher }
  }
  const picked = (pick: Json) => gateway(() => ({ ...LIST, pick }))
  const ROUTE_PICK = { outcome: 'route', route: LUNA_ROUTE, secret: 'route-secret', source: 'chosen', outside: false }

  it('有这种类型时 task 才多 model 参数', () => {
    expect(setup(ENV, []).tool().parameters.properties).not.toHaveProperty('model')
    expect(setup(DENV, []).tool().parameters.properties).toHaveProperty('model')
    expect(subagentTypes(DENV).map(t => !!t.dispatch)).toEqual([false, true, false])
  })

  it('选了模型：带密钥问网关，子进程走回来的路线，密钥只进这个子进程', async () => {
    const g = picked(ROUTE_PICK)
    const r = setup(DENV, [c => c.send(reply('done'))], g.fetcher)
    const out = await r.call({ type: 'explore', model: 'gpt-6-luna' })
    expect(g.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:9/pixelsky/subagent-options',
      auth: 'Bearer options-secret',
      body: { type: 'explore', model: 'gpt-6-luna', pick: true, mainModel: 'claude-sonnet-5-5' },
    })
    const env = r.spawned[0]!.env
    expect(env.PIXELSKY_PIXEL_SUB_TOKEN_0).toBe('route-secret')
    expect(JSON.parse(env[SUBAGENT_ROUTE_ENV]!)).toEqual(LUNA_ROUTE)
    expect(r.models()[0]).toMatchObject({ provider: SUBAGENT_PROVIDER, modelId: 'gpt-6-luna' })
    expect(out.details).toMatchObject({ model: 'GPT Pro · gpt-6-luna', modelSource: 'chosen' })
    expect(out.details.outsideGroup).toBeUndefined()
  })

  it('子进程按选中的路线注册 provider，优先于类型自己的', () => {
    const child = { ...DENV, [SUBAGENT_ENV]: '1', [SUBAGENT_TYPE_ENV]: 'explore' }
    const sub = subagentProvider({ ...child, [SUBAGENT_ROUTE_ENV]: JSON.stringify(LUNA_ROUTE) })
    expect(sub?.[1]).toMatchObject({ api: 'openai-responses', apiKey: '$PIXELSKY_PIXEL_SUB_TOKEN_0' })
    expect((sub?.[1].models as Json[])[0]).toMatchObject({ id: 'gpt-6-luna' })
    // 令牌名不能指向别的环境变量：路线不对就不注册（子进程 set_model 失败，走出错改用主会话）
    const bad = JSON.stringify({ ...LUNA_ROUTE, token: 'HOME' })
    expect(subagentProvider({ ...child, [SUBAGENT_ROUTE_ENV]: bad })).toBeNull()
  })

  it('不填 model 用默认，分组外的标上；用主模型自己时不带路线', async () => {
    const g = picked({ ...ROUTE_PICK, source: 'default', outside: true })
    const r = setup(DENV, [c => c.send(reply('done'))], g.fetcher)
    const out = await r.call({ type: 'explore' })
    expect(g.calls[0]!.body).not.toHaveProperty('model')
    expect(out.details).toMatchObject({ modelSource: 'default', outsideGroup: true })

    const self = setup(DENV, [c => c.send(reply('done'))], picked({ outcome: 'self' }).fetcher)
    const own = await self.call({ type: 'explore' })
    expect(self.spawned[0]!.env).not.toHaveProperty(SUBAGENT_ROUTE_ENV)
    expect(self.models()[0]).toMatchObject({ provider: 'pixelsky', modelId: 'claude-sonnet-5-5' })
    expect(own.details.modelSource).toBeUndefined()
  })

  it('选了不允许的：报错并列出能选的，不起子进程，不悄悄换', async () => {
    const r = setup(DENV, [], picked({ outcome: 'rejected' }).fetcher)
    await expect(r.call({ type: 'explore', model: 'gpt-6-astra' })).rejects.toThrow(
      /"gpt-6-astra" is not allowed.*Allowed: gpt-6-luna, deepseek-chat\..*gpt-6-luna/,
    )
    expect(r.spawned).toHaveLength(0)
  })

  it('固定模型的类型传 model：报错', async () => {
    const r = setup(DENV, [], picked(ROUTE_PICK).fetcher)
    await expect(r.call({ type: 'fixed', model: 'gpt-6-luna' })).rejects.toThrow('has a fixed model')
    expect(r.spawned).toHaveLength(0)
  })

  it('网关查不到：指定了模型报错；没指定用主模型自己', async () => {
    const down = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch
    const named = setup(DENV, [], down)
    await expect(named.call({ type: 'explore', model: 'gpt-6-luna' })).rejects.toThrow('connection refused')
    expect(named.spawned).toHaveLength(0)
    const r = setup(DENV, [c => c.send(reply('done'))], down)
    expect((await r.call({ type: 'explore' })).content[0]!.text).toBe('done')
    expect(r.models()[0]).toMatchObject({ provider: 'pixelsky' })
  })

  it('查候选时主会话停了：按停止收尾，不报查不到', async () => {
    const stop = new AbortController()
    const fetcher = (async () => {
      stop.abort()
      throw new Error('aborted')
    }) as unknown as typeof fetch
    const r = setup(DENV, [], fetcher)
    const out = await r.call({ type: 'explore', model: 'gpt-6-luna' }, stop.signal)
    expect(out.content[0]!.text).toBe('Subagent was stopped before it started.')
    expect(r.spawned).toHaveLength(0)
  })

  it('选的模型出错、还没动手：改走主会话的模型，标记清掉', async () => {
    const r = setup(DENV, [c => c.send(failed('401')), c => c.send(reply('saved'))], picked(ROUTE_PICK).fetcher)
    const out = await r.call({ type: 'explore', model: 'gpt-6-luna' })
    expect(r.models()[1]).toMatchObject({ provider: 'pixelsky', modelId: 'claude-sonnet-5-5' })
    expect(out.content[0]!.text).toContain('The subagent site "GPT Pro" failed')
    expect(out.details.modelSource).toBeUndefined()
    expect(out.details.model).toBe('pixelsky/claude-sonnet-5-5')
  })

  describe('隐藏消息', () => {
    const turn = (r: ReturnType<typeof setup>, messageType = 'user') =>
      r.handlers.before_agent_start!({ messageType }, r.ctx) as Promise<{ message: Json } | undefined>

    it('有候选时告诉主模型；没变不重发；变了发新的；压缩、新会话后重发', async () => {
      let answer: Json = LIST
      const r = setup(DENV, [], gateway(() => answer).fetcher)
      const first = await turn(r)
      expect(first?.message).toMatchObject({ customType: SUBAGENT_MODELS_CONTEXT, display: false })
      expect(first?.message.content).toContain('while your model is gpt-6.1-sol')
      expect(first?.message.content).toContain(
        '- explore: default gpt-6-luna\n  - gpt-6-luna: 最便宜\n  - deepseek-chat',
      )
      expect(await turn(r)).toBeUndefined()
      expect(await turn(r, 'custom')).toBeUndefined()
      await r.handlers.session_compact!({}, r.ctx)
      expect((await turn(r))?.message.content).toBe(first?.message.content)
      await r.handlers.session_start!({}, r.ctx)
      expect((await turn(r))?.message.content).toBe(first?.message.content)
      await r.handlers.session_tree!({}, r.ctx)
      expect((await turn(r))?.message.content).toBe(first?.message.content)
      answer = { ...LIST, currentModel: 'gpt-6-sol', defaultModel: null }
      expect((await turn(r))?.message.content).toContain('default gpt-6-sol (your current model)')
    })

    it('一开始就没候选：不发；发过之后没了：说一声', async () => {
      const empty = { currentModel: 'm', options: [], defaultModel: null }
      let answer: Json = empty
      const r = setup(DENV, [], gateway(() => answer).fetcher)
      expect(await turn(r)).toBeUndefined()
      answer = LIST
      expect(await turn(r)).toBeDefined()
      answer = empty
      expect((await turn(r))?.message.content).toContain('no models to pick')
      expect(await turn(r)).toBeUndefined()
    })

    it('查不到：这轮不发，不影响下一轮', async () => {
      let up = false
      const fetcher = (async () => {
        if (!up) throw new Error('down')
        return new Response(JSON.stringify(LIST))
      }) as unknown as typeof fetch
      const r = setup(DENV, [], fetcher)
      expect(await turn(r)).toBeUndefined()
      up = true
      expect(await turn(r)).toBeDefined()
    })
  })
})

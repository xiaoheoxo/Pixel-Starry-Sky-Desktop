import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  EngineConfig,
  EngineId,
  Item,
  PeekScope,
  ProjectRecord,
  SessionRecord,
  SessionState,
  SessionSummary,
} from '@pixelsky/protocol'
import { ago, threadsScope, threadsServer, type ThreadsContext, type ThreadsServer } from './threads-mcp'

const NOW = 1_800_000_000_000
const MIN = 60_000
const id = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`
const ME = id(1)
const SIBLING = id(2)
const OTHER_PROJECT = id(3)
const ARCHIVED = id(4)
const SSH = `ssh-abc~${id(5)}`
const EMPTY = id(6)

const config = (claude: PeekScope, codex: PeekScope = 'off'): EngineConfig =>
  ({ claude: { peekSessions: claude }, codex: { peekSessions: codex }, pixel: { peekSessions: 'all' } }) as EngineConfig

const record = (rid: string, extra: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    id: rid,
    projectId: 'p1',
    engine: 'claude',
    title: rid,
    updatedAt: NOW,
    lastOutcome: null,
    ...extra,
  }) as SessionRecord
const summary = (r: SessionRecord, state: SessionState = 'idle'): SessionSummary => ({ record: r, state })

let n = 0
const user = (text: string, engine: EngineId = 'claude'): Item => ({
  kind: 'user',
  id: `u${++n}`,
  text,
  createdAt: 0,
  engine,
})
const assistant = (text: string): Item => ({ kind: 'assistant', id: `a${++n}`, text, status: 'completed' })

const projects: ProjectRecord[] = [
  { id: 'p1', name: '前端', path: 'D:/web', addedAt: 0 },
  { id: 'p2', name: '后端', path: 'D:/api', addedAt: 0 },
]
const itemsOf: Record<string, Item[]> = {
  [SIBLING]: [
    user('改登录页样式'),
    assistant('改好了按钮颜色'),
    user('再把表单对齐'),
    assistant('表单已对齐'),
    user('跑一下测试'),
    assistant('测试全部通过'),
  ],
  [OTHER_PROJECT]: [user('加登录接口', 'codex'), assistant('接口写好了')],
  [ARCHIVED]: [user('归档会话的秘密'), assistant('不该被看到')],
  [EMPTY]: [],
}

let sessions: SessionSummary[] = []
let engineConfig = config('project')
const ctx: ThreadsContext = {
  engine: {
    sessions: () => sessions,
    projects: () => projects,
    historyItems: async rid => itemsOf[rid] ?? [],
    engineConfig: () => engineConfig,
  },
}

let server: ThreadsServer | null = null
let clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.map(c => c.close().catch(() => undefined)))
  clients = []
  server?.close()
  server = null
  engineConfig = config('project')
})

function seed(): void {
  sessions = [
    summary(record(ME)),
    summary(record(SIBLING, { title: '修登录页样式', updatedAt: NOW - 5 * MIN, lastReply: '测试全部通过' }), 'running'),
    summary(
      record(OTHER_PROJECT, {
        projectId: 'p2',
        engine: 'codex',
        title: '登录接口',
        updatedAt: NOW - 3 * 60 * MIN,
        lastOutcome: 'failed',
        lastError: '网络断了',
      }),
    ),
    summary(record(ARCHIVED, { title: '归档的会话', archivedAt: NOW })),
    summary(record(SSH, { title: '远程会话' })),
    summary(record(EMPTY, { title: '刚建的', updatedAt: NOW - 2 * 24 * 60 * MIN })),
  ]
}

async function connect(rid = ME): Promise<Client> {
  server ??= threadsServer(ctx, () => NOW)
  const entry = (await server.entry(sessions.find(s => s.record.id === rid)!.record))!
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(entry.url), {
      requestInit: { headers: { Authorization: `Bearer ${entry.token}` } },
    }),
  )
  clients.push(client)
  return client
}
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return {
    text: (result as { content: Array<{ text: string }> }).content.map(c => c.text).join('\n'),
    isError: result.isError === true,
  }
}

describe('threadsScope', () => {
  it('按调用方引擎的设置；SSH、Pixel 引擎、没有设置时关闭', () => {
    expect(threadsScope(record(ME), config('project'))).toBe('project')
    expect(threadsScope(record(ME), config('all'))).toBe('all')
    expect(threadsScope(record(ME), config('off', 'all'))).toBe('off')
    expect(threadsScope(record(ME, { engine: 'codex' }), config('off', 'all'))).toBe('all')
    expect(threadsScope(record(ME, { engine: 'pixel' }), config('all', 'all'))).toBe('off')
    expect(threadsScope(record(SSH), config('all'))).toBe('off')
    expect(threadsScope(record(ME), null)).toBe('off')
  })

  it('相对时间', () => {
    expect(ago(NOW - 20_000, NOW)).toBe('刚刚')
    expect(ago(NOW - 5 * MIN, NOW)).toBe('5 分钟前')
    expect(ago(NOW - 3 * 60 * MIN, NOW)).toBe('3 小时前')
    expect(ago(NOW - 2 * 24 * 60 * MIN, NOW)).toBe('2 天前')
  })
})

describe('查看别的会话 MCP 服务', () => {
  it('设置关闭时没有入口；开了时有，同一会话令牌稳定', async () => {
    seed()
    server = threadsServer(ctx, () => NOW)
    engineConfig = config('off')
    expect(await server.entry(record(ME))).toBeNull()
    engineConfig = config('project')
    const a = (await server.entry(record(ME)))!
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(await server.entry(record(ME))).toEqual(a)
    expect(await server.entry(record(SSH))).toBeNull()
  })

  it('只有两个只读工具，没有发消息的', async () => {
    seed()
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual(['list_threads', 'read_thread'])
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true)
    expect(client.getInstructions()).toContain('加入频道')
  })

  it('同一个项目：不含自己、归档的、SSH 的和别的项目，最近活动的在前', async () => {
    seed()
    const { text } = await call(await connect(), 'list_threads')
    expect(text).toContain('同一个项目「前端」里其他会话共 2 个')
    expect(text).toContain(`- 「修登录页样式」 id=${SIBLING}`)
    expect(text).toContain('Claude Code · 正在运行 · 最近活动 5 分钟前 · 项目 前端')
    expect(text).toContain('最后回复：测试全部通过')
    expect(text).toContain('「刚建的」')
    expect(text.indexOf('修登录页样式')).toBeLessThan(text.indexOf('刚建的'))
    for (const hidden of ['登录接口', '归档的会话', '远程会话', `id=${ME}`]) expect(text).not.toContain(hidden)
  })

  it('不用项目的对话：「同一个项目」时每个对话只算它自己，看不到别的对话', async () => {
    seed()
    const chatA = id(7)
    sessions[0] = summary(record(ME, { projectId: 'chat' }))
    sessions.push(summary(record(chatA, { projectId: 'chat', title: '另一个对话' })))
    const client = await connect()
    expect((await call(client, 'list_threads')).text).toContain('这个对话里没有其他会话')
    const result = await call(client, 'read_thread', { id: chatA })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('（这个对话）')
    engineConfig = config('all')
    expect((await call(client, 'list_threads')).text).toContain('「另一个对话」')
  })

  it('本机所有：别的项目也列出，失败的写错误摘要；按标题筛选和数量上限', async () => {
    seed()
    engineConfig = config('all')
    const client = await connect()
    const all = await call(client, 'list_threads')
    expect(all.text).toContain('本机所有项目里其他会话共 3 个')
    expect(all.text).toContain('Codex · 空闲 · 最近活动 3 小时前 · 项目 后端')
    expect(all.text).toContain('上一轮失败：网络断了')
    const filtered = await call(client, 'list_threads', { query: '登录' })
    expect(filtered.text).toContain('标题包含「登录」的其他会话共 2 个')
    expect(filtered.text).not.toContain('刚建的')
    const limited = await call(client, 'list_threads', { limit: 1 })
    expect(limited.text).toContain('共 3 个，按最近活动排序，列出前 1 个')
    expect((await call(client, 'list_threads', { query: '没有这个' })).text).toContain('没有标题包含「没有这个」')
  })

  it('read_thread 默认读最后两轮，给 turn 时从那一轮读；提示换成 read_thread 的调用方式', async () => {
    seed()
    const client = await connect()
    const last = await call(client, 'read_thread', { id: SIBLING })
    expect(last.isError).toBe(false)
    expect(last.text).toContain('会话「修登录页样式」（Claude Code · 正在运行 · 最近活动 5 分钟前）共 3 轮（#1–#3）')
    expect(last.text).toContain('更早的第 1 轮用 read_thread 加 turn 读')
    expect(last.text).toContain('===== 第 2 轮')
    expect(last.text).toContain('助手：测试全部通过')
    expect(last.text).not.toContain('改好了按钮颜色')
    const first = await call(client, 'read_thread', { id: SIBLING, turn: 1, count: 1 })
    expect(first.text).toContain('改好了按钮颜色')
    expect(first.text).toContain(`read_thread(id="${SIBLING}", turn=2)`)
    expect(first.text).not.toContain('read(turn=')
    expect((await call(client, 'read_thread', { id: EMPTY })).text).toContain('还没有内容')
  })

  it('看不到范围外、归档的、不存在的会话；自己不用读；参数不对返回错误', async () => {
    seed()
    const client = await connect()
    for (const target of [OTHER_PROJECT, ARCHIVED, SSH, 'nope']) {
      const result = await call(client, 'read_thread', { id: target })
      expect(result.isError).toBe(true)
      expect(result.text).toContain('看不到会话')
      expect(result.text).not.toContain('秘密')
    }
    expect((await call(client, 'read_thread', { id: ME })).text).toContain('你自己所在的会话')
    const missing = await call(client, 'read_thread', {})
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('缺少参数 id')
    expect((await call(client, 'list_threads', { limit: 'x' })).isError).toBe(true)
  })

  it('每次调用按当时的设置：关掉后工具返回错误，改成本机所有后能读别的项目', async () => {
    seed()
    const client = await connect()
    engineConfig = config('off')
    const off = await call(client, 'list_threads')
    expect(off.isError).toBe(true)
    expect(off.text).toContain('关掉了')
    engineConfig = config('all')
    expect((await call(client, 'read_thread', { id: OTHER_PROJECT })).text).toContain('接口写好了')
  })

  it('Codex 会话按 Codex 的设置', async () => {
    seed()
    sessions[0] = summary(record(ME, { engine: 'codex' }))
    engineConfig = config('off', 'project')
    const { text } = await call(await connect(), 'list_threads')
    expect(text).toContain('其他会话共 2 个')
  })

  it('引擎还没有就绪时没有入口，已连上的工具返回错误', async () => {
    seed()
    const client = await connect()
    const saved = ctx.engine
    ;(ctx as { engine: ThreadsContext['engine'] }).engine = null
    try {
      expect((await call(client, 'list_threads')).isError).toBe(true)
      expect(await server!.entry(record(ME))).toBeNull()
    } finally {
      ;(ctx as { engine: ThreadsContext['engine'] }).engine = saved
    }
  })
})

import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { EngineSessionState, Item, SessionRecord } from '@pixelsky/protocol'
import { historyEnabled, historyServer, type HistoryServer } from './history-mcp'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const state = (id: string): EngineSessionState => ({ id, seen: null })
const record = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    id,
    engine: 'codex',
    engineSessions: { claude: state('c'), codex: state('x') },
    ...extra,
  }) as SessionRecord

let n = 0
const user = (text: string, engine: 'claude' | 'codex'): Item => ({
  kind: 'user',
  id: `u${++n}`,
  text,
  createdAt: 0,
  engine,
})
const assistant = (text: string): Item => ({ kind: 'assistant', id: `a${++n}`, text, status: 'completed' })

const itemsOf: Record<string, Item[]> = {
  [ID_A]: [user('部署 staging 环境', 'claude'), assistant('已部署'), user('看下日志', 'codex'), assistant('日志正常')],
  [ID_B]: [user('另一个对话的秘密', 'claude'), assistant('不能被 A 看到')],
}
let server: HistoryServer | null = null
let clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.map(c => c.close().catch(() => undefined)))
  clients = []
  server?.close()
  server = null
})
const start = () => {
  server = historyServer({
    engine: {
      historyItems: async id => {
        const items = itemsOf[id]
        if (!items) throw new Error('会话不存在')
        return items
      },
    },
  })
  return server
}
async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  )
  clients.push(client)
  return client
}
const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content.map(c => c.text).join('\n')

/** 手写 HTTP 请求：可以带任意头，包括 SDK 客户端不会发的 Origin / 伪造的 Host */
function post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}
const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

describe('historyEnabled', () => {
  it('本机、用过至少两个引擎、不是像素星空引擎才开', () => {
    expect(historyEnabled(record(ID_A))).toBe(true)
    expect(historyEnabled(record(ID_A, { engine: 'claude' }))).toBe(true)
    expect(historyEnabled(record(ID_A, { engine: 'pixel' }))).toBe(false)
    expect(historyEnabled(record(ID_A, { engineSessions: { claude: state('c') } }))).toBe(false)
    expect(historyEnabled(record(ID_A, { engineSessions: undefined }))).toBe(false)
    expect(historyEnabled(record(`ssh-abc~${ID_A}`))).toBe(false)
  })
})

describe('对话历史 MCP 服务', () => {
  it('不满足条件的对话没有入口；有入口时地址在回环上，同一对话令牌稳定，不同对话令牌不同', async () => {
    const s = start()
    expect(await s.entry(record(ID_A, { engineSessions: undefined }))).toBeNull()
    expect(await s.entry(record(`ssh-abc~${ID_A}`))).toBeNull()
    const a = (await s.entry(record(ID_A)))!
    const again = (await s.entry(record(ID_A)))!
    const b = (await s.entry(record(ID_B)))!
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(a.token).toMatch(/^[0-9a-f]{64}$/)
    expect(again).toEqual(a)
    expect(b.url).toBe(a.url)
    expect(b.token).not.toBe(a.token)
  })

  it('列出三个只读工具；outline / read / search 只查令牌对应的对话', async () => {
    const s = start()
    const a = (await s.entry(record(ID_A)))!
    const client = await connect(a.url, a.token)
    expect(client.getServerCapabilities()?.tools).toBeDefined()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual(['outline', 'read', 'search'])
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true)

    const outline = textOf(await client.callTool({ name: 'outline', arguments: {} }))
    expect(outline).toContain('共 2 轮')
    expect(outline).toContain('#1 [Claude Code] 用户：部署 staging 环境 → 助手：已部署')
    expect(outline).toContain('#2 [Codex] 用户：看下日志 → 助手：日志正常')
    expect(outline).not.toContain('秘密')

    const read = textOf(await client.callTool({ name: 'read', arguments: { turn: 2 } }))
    expect(read).toContain('===== 第 2 轮 [Codex] =====')
    expect(read).toContain('助手：日志正常')

    const search = textOf(await client.callTool({ name: 'search', arguments: { query: 'STAGING' } }))
    expect(search).toContain('#1 [用户] 部署 staging 环境')
    expect(textOf(await client.callTool({ name: 'search', arguments: { query: '秘密' } }))).toContain('没有找到')

    // 多余的 id 参数被忽略：不能借此查别的对话
    const sneaky = textOf(await client.callTool({ name: 'outline', arguments: { sessionId: ID_B, id: ID_B } }))
    expect(sneaky).not.toContain('秘密')
  })

  it('另一个对话用自己的令牌查到自己的内容；每次调用取最新条目', async () => {
    const s = start()
    const b = (await s.entry(record(ID_B)))!
    const client = await connect(b.url, b.token)
    expect(textOf(await client.callTool({ name: 'outline', arguments: {} }))).toContain('另一个对话的秘密')
    itemsOf[ID_B].push(user('新来的一问', 'codex'), assistant('新答'))
    expect(textOf(await client.callTool({ name: 'outline', arguments: {} }))).toContain('#2 [Codex] 用户：新来的一问')
    itemsOf[ID_B].length = 2
  })

  it('参数不对时返回工具错误而不是抛出', async () => {
    const s = start()
    const a = (await s.entry(record(ID_A)))!
    const client = await connect(a.url, a.token)
    const missing = await client.callTool({ name: 'read', arguments: {} })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('缺少参数 turn')
    const range = await client.callTool({ name: 'read', arguments: { turn: 99 } })
    expect(textOf(range)).toContain('没有第 99 轮')
  })

  it('令牌错误或缺失返回 401', async () => {
    const s = start()
    const a = (await s.entry(record(ID_A)))!
    expect((await post(a.url, {}, ping)).status).toBe(401)
    expect((await post(a.url, { authorization: 'Bearer nope' }, ping)).status).toBe(401)
    expect((await post(a.url, { authorization: a.token }, ping)).status).toBe(401)
    expect((await post(a.url, { authorization: `Bearer ${a.token}` }, ping)).status).toBe(200)
  })

  it('带 Origin 或 Host 不是回环地址返回 403，即使令牌正确', async () => {
    const s = start()
    const a = (await s.entry(record(ID_A)))!
    const auth = { authorization: `Bearer ${a.token}` }
    expect((await post(a.url, { ...auth, origin: 'http://evil.example' }, ping)).status).toBe(403)
    expect((await post(a.url, { ...auth, host: 'evil.example' }, ping)).status).toBe(403)
    expect((await post(a.url, { ...auth, host: `evil.example:${new URL(a.url).port}` }, ping)).status).toBe(403)
    expect((await post(a.url, { ...auth, host: `localhost:${new URL(a.url).port}` }, ping)).status).toBe(200)
  })

  it('请求体超过 1 MB 被拒绝；不是 JSON 返回 400；路径不对返回 404', async () => {
    const s = start()
    const a = (await s.entry(record(ID_A)))!
    const auth = { authorization: `Bearer ${a.token}` }
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { pad: 'x'.repeat(1024 * 1024 + 10) },
    })
    const result = await post(a.url, auth, big).catch(() => ({ status: 413, body: '' }))
    expect(result.status).toBe(413)
    expect((await post(a.url, auth, '{bad')).status).toBe(400)
    expect((await post(a.url.replace('/mcp', '/other'), auth, ping)).status).toBe(404)
  })

  it('GET 不支持（无状态服务）；关闭后入口为空、旧令牌失效', async () => {
    const s = start()
    const a = (await s.entry(record(ID_A)))!
    const got = await new Promise<number>((resolve, reject) => {
      const u = new URL(a.url)
      request(
        { host: u.hostname, port: u.port, path: u.pathname, headers: { authorization: `Bearer ${a.token}` } },
        res => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
        .on('error', reject)
        .end()
    })
    expect(got).toBe(405)
    s.close()
    expect(await s.entry(record(ID_A))).toBeNull()
    await expect(post(a.url, { authorization: `Bearer ${a.token}` }, ping)).rejects.toThrow()
  })

  it('引擎还没有就绪时工具返回错误', async () => {
    server = historyServer({ engine: null })
    const a = (await server.entry(record(ID_A)))!
    const client = await connect(a.url, a.token)
    const result = await client.callTool({ name: 'outline', arguments: {} })
    expect(result.isError).toBe(true)
  })
})

// 对话历史 MCP 服务（只读）：让换过引擎的对话里，后来接手的引擎按需查这段对话更早的部分。
// 主进程里一个只绑 127.0.0.1 的 HTTP 服务（无状态，每个 POST 一个 MCP 服务器），每个对话一个令牌，工具只能查令牌对应的那一个对话。
// 注入给引擎的方式：extensions/ipc.ts 把 entry() 的地址和令牌作为额外的 MCP 服务器交给扩展服务（claude 写 --mcp-config 文件，codex 走 -c + 环境变量）。
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { historyOutline, historyRead, historySearch } from '@pixelsky/engine'
import type { Item, SessionRecord } from '@pixelsky/protocol'
import { machineOf } from '../machines/identity'

export const HISTORY_SERVER_NAME = 'pixelsky_history'
const PATH = '/mcp'
const BODY_LIMIT = 1024 * 1024

/** 引擎宿主里这个服务用到的部分（EngineHost 满足） */
export interface HistoryContext {
  engine: { historyItems(id: string): Promise<readonly Item[]> } | null
}

export interface HistoryEntry {
  url: string
  token: string
}

export interface HistoryServer {
  /** 这个对话要不要给引擎挂历史工具；要的话（必要时先启动服务）给出地址和令牌 */
  entry(record: SessionRecord): Promise<HistoryEntry | null>
  close(): void
}

/** 本机对话、用过至少两个引擎（只有一个引擎时它自己的会话里就有全部历史）。像素星空引擎不读 MCP 配置，不挂 */
export function historyEnabled(record: SessionRecord): boolean {
  return (
    machineOf(record.id) === 'local' &&
    Object.keys(record.engineSessions ?? {}).length >= 2 &&
    record.engine !== 'pixel'
  )
}

const TOOLS = [
  {
    name: 'outline',
    description:
      '查看当前像素星空对话的目录：共多少轮，每轮一行（编号、处理该轮的 AI 引擎、用户说了什么、助手最后答了什么）。这段对话更早的部分可能是别的 AI 引擎处理的，你的上下文里没有；想知道之前发生过什么，先看目录。每页 50 轮，用 page 翻页。',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'integer', minimum: 1, description: '页码，从 1 开始，默认 1' } },
    },
  },
  {
    name: 'read',
    description:
      '读取当前像素星空对话中某几轮的原文（用户消息、助手回复、命令及输出、工具调用、文件改动、待办）。轮次编号来自 outline 或 search 的结果。从 turn 起最多读 count 轮（默认 1，最多 5），总长有上限。',
    inputSchema: {
      type: 'object',
      properties: {
        turn: { type: 'integer', minimum: 0, description: '起始轮次编号' },
        count: { type: 'integer', minimum: 1, maximum: 5, description: '读几轮，默认 1，最多 5' },
      },
      required: ['turn'],
    },
  },
  {
    name: 'search',
    description:
      '在当前像素星空对话里按关键词搜索（不分大小写的子串匹配，范围含用户消息、助手回复、命令及输出、工具调用、改动的文件），返回命中的轮次和片段。找到后可用 read 读那一轮原文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回几处，默认 20，最多 50' },
      },
      required: ['query'],
    },
  },
].map(tool => ({
  ...tool,
  annotations: {
    title: tool.name,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}))

const INSTRUCTIONS =
  '只读地查询当前像素星空对话的历史。这段对话可能先后由不同的 AI 引擎处理过；需要更早几轮的细节时先 outline，再 read 或 search，不要凭印象猜。'

type Args = Record<string, unknown>
const text = (value: string, isError = false) => ({
  content: [{ type: 'text' as const, text: value }],
  ...(isError ? { isError } : {}),
})

/** 可选的整数参数：没给为 undefined；给了但不是整数则抛错 */
function integer(args: Args, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`参数 ${key} 必须是整数`)
  return value
}

function run(name: string, args: Args, items: readonly Item[]): string {
  if (name === 'outline') return historyOutline(items, { page: integer(args, 'page') })
  if (name === 'read') {
    const turn = integer(args, 'turn')
    if (turn === undefined) throw new Error('缺少参数 turn')
    return historyRead(items, { turn, count: integer(args, 'count') })
  }
  if (name === 'search') {
    if (typeof args.query !== 'string') throw new Error('缺少参数 query（字符串）')
    return historySearch(items, { query: args.query, limit: integer(args, 'limit') })
  }
  throw new Error(`没有这个工具：${name}`)
}

/** 给一个对话建 MCP 服务器；工具只能查 sessionId 这一个对话，每次调用都取最新的条目 */
function mcpServer(ctx: HistoryContext, sessionId: string): Server {
  const server = new Server(
    { name: HISTORY_SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (!ctx.engine) return text('引擎还没有就绪，稍后再试。', true)
      const items = await ctx.engine.historyItems(sessionId)
      return text(run(request.params.name, (request.params.arguments ?? {}) as Args, items))
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true)
    }
  })
  return server
}

function reply(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        resolve(null)
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function historyServer(ctx: HistoryContext): HistoryServer {
  const byToken = new Map<string, string>()
  const byId = new Map<string, string>()
  let http: HttpServer | null = null
  let starting: Promise<number> | null = null
  let closed = false

  const handle = async (req: IncomingMessage, res: ServerResponse, port: number): Promise<void> => {
    // 浏览器页面（带 Origin）和 DNS 重绑定（Host 不是回环地址）都拒绝
    const host = (req.headers.host ?? '').toLowerCase()
    if (req.headers.origin !== undefined || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`))
      return reply(res, 403, '不允许这个来源')
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== PATH) return reply(res, 404, '没有这个地址')
    const header = req.headers.authorization ?? ''
    const sessionId = header.startsWith('Bearer ') ? byToken.get(header.slice(7).trim()) : undefined
    if (!sessionId) return reply(res, 401, '缺少或无效的令牌', { 'www-authenticate': 'Bearer' })
    if (req.method !== 'POST') return reply(res, 405, '只支持 POST', { allow: 'POST' })
    const raw = await readBody(req)
    if (raw === null) return reply(res, 413, '请求太大')
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return reply(res, 400, '请求不是有效的 JSON')
    }
    const server = mcpServer(ctx, sessionId)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const start = (): Promise<number> => {
    starting ??= (async () => {
      const server = createServer((req, res) => {
        const address = server.address() as AddressInfo
        handle(req, res, address.port).catch(() => reply(res, 500, '内部错误'))
      })
      http = server
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      server.unref()
      return (server.address() as AddressInfo).port
    })()
    // 启动失败不缓存，下次再试
    starting.catch(() => {
      starting = null
      http = null
    })
    return starting
  }

  return {
    async entry(record) {
      if (closed || !historyEnabled(record)) return null
      const port = await start()
      if (closed) return null
      let token = byId.get(record.id)
      if (!token) {
        token = randomBytes(32).toString('hex')
        byId.set(record.id, token)
        byToken.set(token, record.id)
      }
      return { url: `http://127.0.0.1:${port}${PATH}`, token }
    },
    close() {
      closed = true
      byToken.clear()
      byId.clear()
      http?.closeAllConnections()
      http?.close()
    },
  }
}

import { once } from 'node:events'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { EngineHost, PixelAdapter, type EngineAdapter, type SessionContext } from '@pixelsky/engine'
import { ENGINES, type SessionRecord } from '@pixelsky/protocol'
import { platformGateway } from '../platform/gateway'
import { pixelGatewayEnv } from '../platform/pixel-env'
import type { ResolvedProvider } from '../core/providers/store'
import { subagentServer } from './subagent-mcp'
import type { HistoryServer } from './history-mcp'

let host: EngineHost | null = null,
  mcp: HistoryServer | null = null,
  client: Client | null = null,
  http: Server | null = null
let root: string | null = null
afterEach(async () => {
  await host?.shutdown()
  await client?.close()
  mcp?.close()
  http?.closeAllConnections()
  if (http?.listening) await new Promise<void>(resolve => http!.close(() => resolve()))
  if (root) rmSync(root, { recursive: true, force: true })
  host = null
  mcp = null
  client = null
  http = null
  root = null
})

describe('A → MCP task → 独立 B → 本机网关 → 工具结果', () => {
  it('真实 Pixel CLI 请求只使用 B 站点和 B 模型，独立执行工具并将报告交回 A', async () => {
    root = mkdtempSync(join(tmpdir(), 'pixelsky-delegation-wire-'))
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
    const sessions = new Map<string, { secret: string; recordId: string }>()
    const provider = {
      id: 'site-b',
      name: '测试站点 B',
      protocol: 'chat',
      auth: 'bearer',
      baseUrl: 'https://b.example.invalid/v1',
      apiKey: 'test-only-site-b-key',
      models: [{ id: 'model-b' }],
      headers: {},
      modelFallback: false,
    } as ResolvedProvider
    http = platformGateway({
      sessions,
      record: id => host?.executionRecord(id) ?? null,
      account: () => null,
      fetch: async () => {
        throw new Error('不应请求平台')
      },
      provider: id => (id === provider.id ? provider : null),
      upstream: async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        requests.push({ url, init, body })
        const tool = requests.length === 1
        const delta = tool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'read-components',
                  type: 'function',
                  function: { name: 'ls', arguments: '{"path":"."}' },
                },
              ],
            }
          : { content: 'B 已检查目录并返回独立报告。' }
        const chunks = [
          {
            id: 'b-response',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'model-b',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          },
          {
            id: 'b-response',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'model-b',
            choices: [{ index: 0, delta, finish_reason: null }],
          },
          {
            id: 'b-response',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'model-b',
            choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          },
        ]
        return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    http.listen(0, '127.0.0.1')
    await once(http, 'listening')
    const port = (http.address() as { port: number }).port
    let parentContext: SessionContext | undefined
    const parentAdapter: EngineAdapter = {
      info: async () => ({
        ...ENGINES.claude,
        id: 'claude',
        status: 'ready',
        version: 'test',
        path: 'test',
        message: null,
      }),
      createSession: ctx => {
        parentContext = ctx
        return { send() {}, interrupt: async () => {}, answer() {}, update: async () => {}, close: async () => {} }
      },
    }
    const pixel = new PixelAdapter({
      launcher: { command: process.execPath, args: [resolve('../../packages/cli/src/cli.ts')] },
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        USERPROFILE: root,
        PIXELSKY_CODING_AGENT_DIR: agentDir,
        PI_TELEMETRY: '0',
        PI_SKIP_VERSION_CHECK: '1',
        NO_PROXY: '127.0.0.1,localhost',
      },
      sessionEnv: record => {
        const entry = { secret: `local-only-${record.id}`, recordId: record.id }
        sessions.set(record.id, entry)
        return pixelGatewayEnv({
          port,
          secret: entry.secret,
          api: 'openai-completions',
          model: record.model,
          models: provider.models,
        })
      },
    })
    host = new EngineHost({
      dataDir: join(root, 'host'),
      emit() {},
      adapters: { claude: parentAdapter, pixel },
      subagentSite: () => provider.name,
    })
    const project = host.addProject(root)
    const parent = host.createSession({
      projectId: project.id,
      engine: 'claude',
      model: 'model-a',
      subagent: { source: 'custom', providerId: 'site-b', model: 'model-b' },
    })
    await host.send(parent.id, '请把目录检查交给子代理')
    await expect.poll(() => !!parentContext).toBe(true)
    mcp = subagentServer({ engine: host })
    const entry = (await mcp.entry(parent))!
    client = new Client({ name: 'model-a-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: { headers: { Authorization: `Bearer ${entry.token}` } },
      }),
    )
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toEqual(['task'])
    const result = await client.callTool(
      { name: 'task', arguments: { description: '检查目录', prompt: '列出当前目录，然后返回报告。' } },
      undefined,
      { timeout: 25000 },
    )
    expect(result.isError).not.toBe(true)
    expect(result.content).toContainEqual({ type: 'text', text: 'B 已检查目录并返回独立报告。' })
    expect(requests).toHaveLength(2)
    expect(
      requests.every(r => r.url === 'https://b.example.invalid/v1/chat/completions' && r.body.model === 'model-b'),
    ).toBe(true)
    expect(
      requests.every(r => (r.init.headers as Record<string, string>).authorization === 'Bearer test-only-site-b-key'),
    ).toBe(true)
    expect(JSON.stringify(requests.map(r => r.body))).not.toContain('test-only-site-b-key')
    expect((requests[1].body.messages as Array<{ role: string }>).some(m => m.role === 'tool')).toBe(true)
    expect(host.open(parent.id).runs.agents).toContainEqual(
      expect.objectContaining({ model: 'model-b', site: provider.name, state: 'completed', toolCalls: 1 }),
    )
    expect(host.sessions()).toHaveLength(1)
    await expect(client.callTool({ name: 'task', arguments: { description: '错误参数' } })).resolves.toMatchObject({
      isError: true,
    })
    expect(await mcp.entry({ ...parent, subagentParentId: parent.id } as SessionRecord)).toBeNull()
  }, 35000)
})

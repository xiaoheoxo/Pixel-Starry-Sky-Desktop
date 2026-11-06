import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { SessionRecord } from '@pixelsky/protocol'
import type { Channels } from '../core/channels/service'
import { channelToolsServer, type ChannelToolsServer } from './channel-mcp'

let server: ChannelToolsServer | null = null
const clients: Client[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  server?.close()
  server = null
})

/** 只实现工具要用的几个方法：记下调用 */
function fakeChannels(calls: unknown[][]): Channels {
  return {
    sessionMember: (id: string) => (id === 's1' ? { memberId: 'm1', tools: { mode: 'only', ids: ['x'] } } : null),
    toolRead: (...args: unknown[]) => (calls.push(['read', ...args]), '读到了'),
    toolThread: (...args: unknown[]) => (calls.push(['thread', ...args]), '串'),
    toolReply: async (...args: unknown[]) => (calls.push(['reply', ...args]), '已发'),
    toolPropose: async (...args: unknown[]) => (calls.push(['propose', ...args]), '已提议'),
    toolAttachments: async () => ({ text: '1 张图片', images: [{ dataBase64: 'QUJD', mediaType: 'image/png' }] }),
    toolHandover: async () => {
      throw new Error('没有打开互相派活')
    },
  } as unknown as Channels
}

const record = (id: string) => ({ id }) as SessionRecord

describe('频道工具 MCP（docs/ui/channels-collab-v2.md §1）', () => {
  it('只给本机的频道会话；令牌认出调用方会话，参数传给频道服务，出错变成工具错误', async () => {
    const calls: unknown[][] = []
    server = channelToolsServer(() => fakeChannels(calls))
    expect(await server.forSession(record('other'))).toBeNull()
    expect(await server.forSession(record('ssh-ab~s1'))).toBeNull()
    const own = await server.forSession(record('s1'))
    expect(own?.tools).toEqual({ mode: 'only', ids: ['x'] })
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(own!.entry!.url), {
        requestInit: { headers: { Authorization: `Bearer ${own!.entry!.token}` } },
      }),
    )
    clients.push(client)
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual([
      'channel_read',
      'thread_read',
      'channel_reply',
      'task_propose',
      'task_handover',
      'task_done',
      'member_ask',
      'user_ask',
      'attachment_read',
    ])
    // Claude 靠这个把工具直接声明给模型，不藏进 ToolSearch
    expect(tools.every(t => t._meta?.['anthropic/alwaysLoad'] === true)).toBe(true)
    expect(tools.find(t => t.name === 'channel_read')?.annotations?.readOnlyHint).toBe(true)
    expect(await client.callTool({ name: 'attachment_read', arguments: { id: 'm1' } })).toMatchObject({
      content: [
        { type: 'text', text: '1 张图片' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ],
    })
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text
    expect(text(await client.callTool({ name: 'channel_read', arguments: { before: 'm9', limit: 5 } }))).toBe('读到了')
    expect(text(await client.callTool({ name: 'channel_reply', arguments: { text: '进展' } }))).toBe('已发')
    expect(text(await client.callTool({ name: 'task_propose', arguments: { member: '文档', request: '写' } }))).toBe(
      '已提议',
    )
    const missing = await client.callTool({ name: 'channel_reply', arguments: {} })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toContain('缺少参数 text')
    const failed = await client.callTool({ name: 'task_handover', arguments: { member: 'a', request: 'b' } })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toBe('没有打开互相派活')
    expect(calls).toEqual([
      ['read', 's1', { before: 'm9', limit: 5 }],
      ['reply', 's1', '进展'],
      ['propose', 's1', '文档', '写'],
    ])
  })
})

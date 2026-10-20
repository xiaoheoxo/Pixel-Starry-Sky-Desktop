import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MCP_FILE_ENV,
  literalValue,
  mcpChildEnv,
  mcpExtension,
  piMcpServers,
  piServerName,
} from '../src/extensions/mcp.ts'

const root = mkdtempSync(join(tmpdir(), 'pixel-mcp-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Pi 自己展开配置值的函数（包的 exports 里没有，按文件路径加载）
const resolver = (): Promise<{ resolveConfigValueOrThrow(value: string, label: string): string }> =>
  import(
    /* @vite-ignore */ new URL(
      '../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js',
      import.meta.url,
    ).href
  )

describe('桌面端的 MCP 配置 → Pi', () => {
  it('值原样保住：经 Pi 展开后还是原文（$ 不当变量、! 开头不当命令）', async () => {
    const { resolveConfigValueOrThrow } = await resolver()
    process.env.PIXELSKY_MCP_TEST_VAR = 'expanded'
    try {
      for (const value of [
        'plain',
        'Bearer abc$def',
        '$PIXELSKY_MCP_TEST_VAR',
        '${PIXELSKY_MCP_TEST_VAR}',
        '!echo hacked',
        '!',
        '$!x',
        '$$',
        'a$',
      ])
        expect(resolveConfigValueOrThrow(literalValue(value), 'test')).toBe(value)
    } finally {
      delete process.env.PIXELSKY_MCP_TEST_VAR
    }
  })

  it('stdio / HTTP 转成 Pi 的写法；SSE 和不完整的跳过并说明；名字里的点换成 _', () => {
    const { servers, skipped } = piMcpServers({
      mcpServers: {
        'fs.local': { type: 'stdio', command: 'C:/node.exe', args: ['server.js', 1], env: { KEY: 'a$b' } },
        docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: '!secret' } },
        old: { type: 'sse', url: 'https://example.com/sse' },
        broken: { type: 'stdio' },
      },
    })
    expect(servers).toEqual({
      fs_local: { command: 'C:/node.exe', args: ['server.js'], env: { KEY: 'a$$b' } },
      docs: { url: 'https://example.com/mcp', headers: { Authorization: '$!secret' } },
    })
    expect(skipped).toHaveLength(2)
    expect(skipped[0]).toContain('SSE')
    expect(piServerName('a.b-c_d')).toBe('a_b-c_d')
    expect(piMcpServers(null)).toEqual({ servers: {}, skipped: [] })
  })

  it('换名后重名（alpha.beta 和 alpha_beta）：两个都跳过并说明，不让后一个悄悄盖掉前一个', () => {
    const { servers, skipped } = piMcpServers({
      mcpServers: {
        'alpha.beta': { command: 'a' },
        alpha_beta: { command: 'b' },
        other: { command: 'c' },
      },
    })
    expect(Object.keys(servers)).toEqual(['other'])
    expect(skipped).toHaveLength(2)
    expect(skipped[0]).toContain('alpha.beta')
    expect(skipped[0]).toContain('alpha_beta')
  })

  it('扩展：注册文件里的服务器，路径从进程环境里拿掉（子智能体另外带上）；注册失败的会话开始时提示', async () => {
    const file = join(root, 'mcp.json')
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          pixelsky_history: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } },
          bad: { type: 'stdio', command: 'x' },
        },
      }),
    )
    process.env[MCP_FILE_ENV] = file
    const registered: Record<string, unknown> = {}
    const handlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = []
    const pi = {
      registerMcpServer: (name: string, config: unknown) => {
        if (name === 'bad') throw new Error('invalid')
        registered[name] = config
      },
      on: (_name: string, h: (event: unknown, ctx: unknown) => Promise<void>) => handlers.push(h),
      // 连接状态的转发（statusBridge）：这里不测
      events: { on: () => () => {}, emit: () => {} },
      registerCommand: () => {},
    }
    mcpExtension(pi as never)
    expect(registered).toEqual({
      pixelsky_history: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } },
    })
    expect(process.env[MCP_FILE_ENV]).toBeUndefined()
    expect(mcpChildEnv()).toEqual({ [MCP_FILE_ENV]: file })
    // 重新加载（/reload）时照样注册
    mcpExtension(pi as never)
    expect(Object.keys(registered)).toEqual(['pixelsky_history'])
    const notes: string[] = []
    // 每次加载扩展先登记状态转发（statusBridge），再登记提示：第一次加载的提示是 handlers[1]
    await handlers[1]!({}, { ui: { notify: (m: string) => notes.push(m), setStatus: () => {} } })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('bad')
  })
})

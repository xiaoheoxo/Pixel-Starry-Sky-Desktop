// 连接器状态（docs/ui/connectors.md）：三家引擎的格式按 2026-10-19 实测的回应写
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent } from '@pixelsky/protocol'
import { claudeMcpServers, codexMcpServers, McpReporter, pixelMcpServers } from '../src/mcp'

afterEach(() => vi.useRealTimers())

describe('MCP status parsing', () => {
  it('reads Claude Code mcp_status', () => {
    expect(
      claudeMcpServers({
        mcpServers: [
          {
            name: 'demo-srv',
            status: 'connected',
            scope: 'dynamic',
            serverInfo: { name: 'fake', version: '1.0.0' },
            config: { type: 'stdio', command: 'node', args: ['s.mjs'] },
            tools: [{ name: 'say' }, { name: 'peek', annotations: { readOnly: true } }],
          },
          { name: 'bad', status: 'failed', error: 'Connection closed', tools: [] },
          { name: 'gh', status: 'needs-auth' },
          { status: 'connected' },
        ],
      }),
    ).toEqual([
      {
        name: 'demo-srv',
        status: 'connected',
        source: 'dynamic',
        version: 'fake 1.0.0',
        transport: 'node s.mjs',
        tools: [{ name: 'say' }, { name: 'peek', readOnly: true }],
      },
      { name: 'bad', status: 'failed', error: 'Connection closed', tools: [] },
      { name: 'gh', status: 'auth', tools: [] },
    ])
    expect(claudeMcpServers(null)).toEqual([])
  })

  it('reads Codex mcpServerStatus/list with its tool map and startup pushes', () => {
    const list = codexMcpServers(
      [
        { name: 'bad', runtimeStatus: 'failed', tools: {}, toolsError: 'handshake failed', authStatus: 'unsupported' },
        {
          name: 'demo-srv',
          runtimeStatus: 'connected',
          tools: { say: { description: 'Say' }, peek: { name: 'peek', annotations: { readOnlyHint: true } } },
          authStatus: 'unsupported',
        },
        { name: 'gh', runtimeStatus: null, tools: {}, authStatus: 'notLoggedIn' },
        { name: 'slow', runtimeStatus: null, tools: {}, authStatus: 'unsupported' },
      ],
      new Map([['slow', { status: 'failed', error: 'timed out' }]]),
    )
    expect(list).toEqual([
      { name: 'bad', status: 'failed', error: 'handshake failed', tools: [] },
      {
        name: 'demo-srv',
        status: 'connected',
        tools: [
          { name: 'say', description: 'Say' },
          { name: 'peek', readOnly: true },
        ],
      },
      { name: 'gh', status: 'auth', tools: [] },
      { name: 'slow', status: 'failed', error: 'timed out', tools: [] },
    ])
  })

  it('reads the PixelSky CLI status JSON', () => {
    expect(
      pixelMcpServers(
        JSON.stringify([
          { name: 'demo-srv', enabled: true, state: 'connected', transport: 'node s.mjs', tools: [{ name: 'say' }] },
          { name: 'bad', enabled: true, state: 'failed', error: 'MCP connection closed', tools: [] },
          { name: 'off', enabled: false, state: 'disabled', tools: [] },
          { name: 'new', enabled: true, state: 'starting', tools: [] },
        ]),
      ),
    ).toEqual([
      { name: 'demo-srv', status: 'connected', transport: 'node s.mjs', tools: [{ name: 'say' }] },
      { name: 'bad', status: 'failed', error: 'MCP connection closed', tools: [] },
      { name: 'off', status: 'disabled', tools: [] },
      { name: 'new', status: 'pending', tools: [] },
    ])
    expect(pixelMcpServers('not json')).toBeNull()
  })
})

describe('McpReporter', () => {
  it('emits only changes, polls while servers connect, and marks the last state stale', async () => {
    vi.useFakeTimers()
    const events: EngineEvent[] = []
    let state: 'pending' | 'connected' = 'pending'
    const reporter = new McpReporter(
      e => events.push(e),
      ['reconnect'],
      async () => [{ name: 'a', status: state, tools: [] }],
    )
    await reporter.refresh()
    await reporter.refresh()
    expect(events).toHaveLength(1)
    state = 'connected'
    await vi.advanceTimersByTimeAsync(3_100)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ type: 'mcp', report: { live: true, servers: [{ status: 'connected' }] } })
    reporter.stale()
    reporter.stale()
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ type: 'mcp', report: { live: false } })
    reporter.dispose()
    reporter.set([])
    expect(events).toHaveLength(3)
  })
})

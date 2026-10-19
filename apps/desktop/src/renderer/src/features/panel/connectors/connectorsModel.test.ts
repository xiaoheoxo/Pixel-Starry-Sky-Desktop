import { describe, expect, it } from 'vitest'
import type { ExtensionEntry, Item, McpReport } from '@pixelsky/protocol'
import { buildConnectors, configured, countCalls, displayName, initials, mcpCallOf, summarize } from './connectorsModel'

const tool = (name: string, extra: Partial<Item> = {}): Item =>
  ({
    kind: 'tool',
    id: name + Math.random(),
    tool: 'mcp',
    name,
    title: '',
    output: '',
    status: 'completed',
    ...extra,
  }) as Item

const entry = (over: Partial<ExtensionEntry>): ExtensionEntry =>
  ({
    id: 'x',
    kind: 'mcp',
    name: 'x',
    description: '',
    scope: { kind: 'global' },
    enabled: true,
    origin: 'managed',
    source: { kind: 'created', location: '' },
    components: [],
    ...over,
  }) as ExtensionEntry

const ENTRIES: ExtensionEntry[] = [
  entry({
    id: 'native-mcp:user:gpt-sovits',
    name: 'gpt-sovits',
    origin: 'native',
    path: 'C:/Users/me/.claude.json',
    source: { kind: 'native', location: 'C:/Users/me/.claude.json' },
    mcp: { type: 'stdio', command: 'python', args: ['server.py'], env: { HOME_DIR: '••••' } },
  }),
  entry({
    id: 'native-mcp:project:unity',
    name: 'unityMCP',
    origin: 'native',
    scope: { kind: 'project', path: 'D:/Game' },
    path: 'D:\\Game\\.mcp.json',
    source: { kind: 'native', location: 'D:\\Game\\.mcp.json' },
    mcp: { type: 'http', url: 'http://127.0.0.1:6400/mcp' },
  }),
  entry({
    id: 'm1',
    name: 'github',
    engines: ['claude', 'codex', 'pixel'],
    mcp: { type: 'http', url: 'https://x/mcp', headers: { Authorization: '••' } },
  }),
  entry({ id: 'm2', name: 'off', enabled: false, mcp: { type: 'stdio', command: 'x' } }),
  entry({
    id: 'p1',
    kind: 'plugin',
    name: 'figma-tools',
    origin: 'native',
    components: [
      { kind: 'mcp', name: 'figma', description: '', mcp: { type: 'stdio', command: 'npx', args: ['figma'] } },
    ],
  }),
]

describe('connectors model', () => {
  it('reads the server and tool out of each engine’s MCP call names', () => {
    expect(mcpCallOf('claude', tool('mcp__plugin_figma-tools_figma__get_file'))).toEqual({
      server: 'plugin_figma-tools_figma',
      tool: 'get_file',
    })
    expect(mcpCallOf('pixel', tool('mcp__gpt_sovits__synthesize'))).toEqual({
      server: 'gpt_sovits',
      tool: 'synthesize',
    })
    expect(mcpCallOf('codex', tool('github / search_issues'))).toEqual({ server: 'github', tool: 'search_issues' })
    expect(mcpCallOf('claude', tool('Read', { tool: 'read' } as Partial<Item>))).toBeNull()
    expect(countCalls('claude', [tool('mcp__gpt-sovits__synthesize'), tool('mcp__gpt-sovits__synthesize')])).toEqual({
      gpt_sovits: { synthesize: 2 },
    })
  })

  it('lists what each engine loads from the extension settings', () => {
    expect(configured('claude', ENTRIES).map(c => [c.name, c.source])).toEqual([
      ['gpt-sovits', 'user'],
      ['unityMCP', 'project'],
      ['github', 'managed'],
      ['figma', 'plugin'],
    ])
    // Codex 和像素星空不读 Claude Code 的配置
    expect(configured('codex', ENTRIES).map(c => c.name)).toEqual(['github'])
    expect(configured('pixel', ENTRIES)[0]!.config.secrets).toEqual(['Authorization'])
  })

  it('puts live status on top of the config and sorts problems first', () => {
    const report: McpReport = {
      ops: ['reconnect'],
      at: 1,
      live: true,
      servers: [
        {
          name: 'gpt-sovits',
          status: 'connected',
          tools: [{ name: 'synthesize' }, { name: 'list_voices', readOnly: true }],
        },
        { name: 'plugin:figma-tools:figma', status: 'failed', error: 'bad key', tools: [] },
        { name: 'pixelsky_history', status: 'connected', tools: [{ name: 'search' }] },
        { name: 'mystery', status: 'auth', source: 'user', tools: [] },
      ],
    }
    const list = buildConnectors('claude', report, ENTRIES, countCalls('claude', [tool('mcp__gpt-sovits__synthesize')]))
    expect(list.map(c => [c.name, c.status, c.source])).toEqual([
      ['mystery', 'auth', 'user'],
      ['plugin:figma-tools:figma', 'failed', 'plugin'],
      ['gpt-sovits', 'connected', 'user'],
      ['pixelsky_history', 'connected', 'builtin'],
    ])
    expect(list[1]!.sourceDetail).toBe('figma-tools')
    expect(displayName(list[1]!)).toBe('figma')
    expect(list[2]!.calls).toBe(1)
    expect(summarize(list)).toEqual({ connected: 2, attention: 2, tools: 3, calls: 1 })
  })

  it('shows the configured servers as not started when the engine has not reported yet', () => {
    const list = buildConnectors('codex', null, ENTRIES, {})
    expect(list.map(c => [c.name, c.status])).toEqual([['github', 'idle']])
  })

  it('makes short avatar letters', () => {
    expect(initials('gpt-sovits')).toBe('GS')
    expect(initials('unityMCP')).toBe('U')
    expect(initials('plugin:figma')).toBe('F')
    expect(initials('像素历史')).toBe('像')
  })
})

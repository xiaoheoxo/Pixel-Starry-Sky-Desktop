// 右侧「连接器」的演示数据（docs/ui/connectors.md，照样式稿 docs/ui/connectors-mockup.html）
import type { ExtensionEntry } from '@pixelsky/protocol'
import type { DemoConnectors } from '@/data/demo'

const native = (
  name: string,
  path: string,
  mcp: ExtensionEntry['mcp'],
  scope: ExtensionEntry['scope'] = { kind: 'global' },
): ExtensionEntry => ({
  id: `native-mcp:${path}:${name}`,
  kind: 'mcp',
  name,
  description: '',
  scope,
  enabled: true,
  origin: 'native',
  source: { kind: 'native', location: path },
  path,
  components: [],
  mcp,
})

export const demoConnectors: DemoConnectors = {
  engine: 'claude',
  cwd: 'D:\\Game',
  calls: { gpt_sovits: { synthesize: 3 }, unitymcp: { import_asset: 1 } },
  entries: [
    native('gpt-sovits', '~/.claude.json', {
      type: 'stdio',
      command: 'python',
      args: ['D:\\tools\\gpt-sovits\\mcp_server.py', '--port', '9880'],
      env: { GPT_SOVITS_HOME: '••••' },
    }),
    native(
      'unityMCP',
      'D:\\Game\\.mcp.json',
      { type: 'http', url: 'http://127.0.0.1:6400/mcp' },
      {
        kind: 'project',
        path: 'D:\\Game',
      },
    ),
    native('postgres', '~/.claude.json', {
      type: 'stdio',
      command: 'npx',
      args: ['@modelcontextprotocol/server-postgres'],
      env: { DATABASE_URL: '••••' },
    }),
    {
      id: 'demo-github',
      kind: 'mcp',
      name: 'github',
      description: '',
      scope: { kind: 'global' },
      enabled: true,
      origin: 'managed',
      engines: ['claude', 'codex', 'pixel'],
      source: { kind: 'created', location: '' },
      components: [],
      mcp: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: '••••' } },
    },
    {
      id: 'demo-figma-plugin',
      kind: 'plugin',
      name: 'figma-tools',
      description: '',
      scope: { kind: 'global' },
      enabled: true,
      origin: 'native',
      source: { kind: 'native', location: '~/.claude/plugins/figma-tools' },
      path: '~/.claude/plugins/figma-tools',
      components: [
        {
          kind: 'mcp',
          name: 'figma',
          description: '',
          mcp: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', 'figma-developer-mcp', '--stdio'],
            env: { FIGMA_API_KEY: '••••' },
          },
        },
      ],
    },
  ],
  report: {
    ops: ['reconnect', 'toggle', 'login'],
    at: 0,
    live: true,
    servers: [
      {
        name: 'gpt-sovits',
        status: 'connected',
        version: 'gpt-sovits-mcp 0.4.1',
        tools: [
          { name: 'synthesize', description: 'Synthesize speech from text and return the wav file path' },
          { name: 'list_voices', description: 'List available voices', readOnly: true },
          { name: 'set_reference_audio', description: 'Set the reference audio' },
          { name: 'get_task_status', description: 'Check synthesis progress', readOnly: true },
          { name: 'cancel_task', description: 'Cancel a running synthesis' },
        ],
      },
      {
        name: 'unityMCP',
        status: 'connected',
        tools: [
          { name: 'import_asset', description: 'Import a file into a folder under Assets' },
          { name: 'get_scene_hierarchy', description: 'Read the object hierarchy of the open scene', readOnly: true },
          { name: 'find_gameobjects', description: 'Find objects by name or component', readOnly: true },
          { name: 'create_gameobject', description: 'Create an object in the scene' },
          { name: 'set_component_property', description: 'Change a component property' },
          { name: 'run_tests', description: 'Run Unity editor tests', readOnly: true },
        ],
      },
      {
        name: 'pixelsky_history',
        status: 'connected',
        tools: [
          { name: 'search_history', description: 'Search earlier turns of this conversation', readOnly: true },
          { name: 'read_turn', description: 'Read one earlier turn', readOnly: true },
        ],
      },
      { name: 'github', status: 'auth', tools: [] },
      {
        name: 'plugin:figma-tools:figma',
        status: 'failed',
        error: 'Error: FIGMA_API_KEY is invalid (401)\n    at FigmaClient.verify (index.js:42:11)',
        tools: [],
      },
      { name: 'postgres', status: 'disabled', tools: [] },
    ],
  },
}

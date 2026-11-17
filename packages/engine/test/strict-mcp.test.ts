// 队友派来的活：只用项目自己的 MCP 配置（docs/multica-learn.md §8、§11.4）
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { HostEvent, SessionRecord } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost } from '../src'
import { codexLaunchConfig } from '../src/codex/session'
import { makeTmp, removeTmp } from './helpers/tmp'

let root: string, host: EngineHost | undefined, events: HostEvent[]
beforeEach(() => {
  root = makeTmp('strict-mcp')
  events = []
})
afterEach(async () => {
  await host?.shutdown()
  removeTmp(root)
})

async function claudeArgs(strictMcp: boolean): Promise<string[]> {
  const fake = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url)),
    argsLog = join(root, `args-${strictMcp}`),
    projectsDir = join(root, 'claude-projects')
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
  const adapter = new ClaudeAdapter({
    launcher: { command: process.execPath, args: [fake] },
    projectsDir,
    env: { ...process.env, FAKE_CLAUDE_LOG: argsLog, FAKE_CLAUDE_PROJECTS: projectsDir },
  })
  host = new EngineHost({
    dataDir: join(root, `engine-${strictMcp}`),
    adapters: { claude: adapter },
    emit: e => events.push(e),
    extensions: () => ({ key: '1', pluginDirs: [], pathDirs: [], mcpFile: join(root, 'own.json'), strictMcp }),
  })
  const s = host.createSession({ projectId: host.addProject(root).id })
  await host.send(s.id, 'hi')
  for (let n = 0; n < 200; n++) {
    if (events.some(e => e.kind === 'session' && e.sessionId === s.id && e.event.type === 'turn_completed')) break
    await new Promise(r => setTimeout(r, 20))
  }
  await host.shutdown()
  host = undefined
  const line = readFileSync(argsLog, 'utf8')
    .trim()
    .split('\n')
    .find(l => l.startsWith('['))!
  return JSON.parse(line) as string[]
}

it('Claude：strictMcp 时加 --strict-mcp-config，只带给的和项目的 .mcp.json', async () => {
  const strict = await claudeArgs(true)
  expect(strict).toContain('--strict-mcp-config')
  const i = strict.indexOf('--mcp-config')
  expect(strict.slice(i + 1, i + 3)).toEqual([join(root, 'own.json'), join(root, '.mcp.json')])
  const normal = await claudeArgs(false)
  expect(normal).not.toContain('--strict-mcp-config')
  expect(normal.slice(normal.indexOf('--mcp-config') + 1, normal.indexOf('--mcp-config') + 3)).not.toContain(
    join(root, '.mcp.json'),
  )
})

it('Codex：strictMcp 时先清空 mcp_servers，再加给的', async () => {
  const record = { id: 's1', engine: 'codex', cwd: root, projectId: 'p1' } as unknown as SessionRecord
  const ext = {
    key: '1',
    pluginDirs: [],
    pathDirs: [],
    codexConfig: { 'mcp_servers.pixelsky_history': { url: 'http://127.0.0.1:1/mcp' } },
  }
  const strict = (
    await codexLaunchConfig(record, {}, { maxRetries: null, extensions: { ...ext, strictMcp: true } }, {}, false)
  ).args
  const clear = strict.findIndex(a => /^mcp_servers=\{\s*\}$/.test(a))
  expect(clear).toBeGreaterThan(0)
  expect(strict[clear - 1]).toBe('-c')
  expect(strict.findIndex(a => a.startsWith('mcp_servers.pixelsky_history='))).toBeGreaterThan(clear)
  const normal = (await codexLaunchConfig(record, {}, { maxRetries: null, extensions: ext }, {}, false)).args
  expect(normal.some(a => /^mcp_servers=/.test(a))).toBe(false)
})

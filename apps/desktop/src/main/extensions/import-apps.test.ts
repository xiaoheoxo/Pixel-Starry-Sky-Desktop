import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publicScan, scanApp } from './import-apps'

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

function setup(files: Record<string, string>, platform: NodeJS.Platform = 'win32') {
  root = mkdtempSync(join(tmpdir(), 'pixelsky-import-apps-'))
  const home = join(root, 'home')
  const project = join(root, 'proj')
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
  return { home, env: { APPDATA: join(home, 'AppData', 'Roaming') }, platform, project }
}
const json = (v: unknown): string => JSON.stringify(v)

describe('scanApp', () => {
  it('Claude Desktop：mcpServers，密钥只报名字，${…} 引用不算密钥', () => {
    const w = setup({
      'home/AppData/Roaming/Claude/claude_desktop_config.json': json({
        mcpServers: {
          'brave search': {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-brave-search'],
            env: { BRAVE_API_KEY: 'sk-real', OTHER_TOKEN: '${FROM_ENV}', MODE: 'x' },
          },
        },
      }),
    })
    const r = scanApp('claude-desktop', w)
    expect(r.errors).toEqual([])
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ kind: 'mcp', name: 'brave search', secrets: ['BRAVE_API_KEY'], project: false })
    expect(r.items[0].detail).toBe('npx -y @modelcontextprotocol/server-brave-search')
    const pub = publicScan('claude-desktop', r, () => false)
    expect(JSON.stringify(pub)).not.toContain('sk-real')
  })

  it('Cursor：全局 + 项目，${env:X} 换成 ${X}', () => {
    const w = setup({
      'home/.cursor/mcp.json': json({
        mcpServers: { context7: { url: 'https://mcp.context7.com/mcp', type: 'http' } },
      }),
      'proj/.cursor/mcp.json': json({
        mcpServers: { gh: { command: 'npx', args: ['x'], env: { GITHUB_TOKEN: '${env:GITHUB_TOKEN}' } } },
      }),
    })
    const r = scanApp('cursor', w)
    expect(r.items.map(i => [i.name, i.project])).toEqual([
      ['context7', false],
      ['gh', true],
    ])
    expect(r.items[1].config?.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' })
    expect(r.items[1].secrets).toEqual([])
  })

  it('VS Code：servers 字段；${input:…} 标「要自己填」', () => {
    const w = setup({
      'home/AppData/Roaming/Code/User/mcp.json': json({
        servers: { fs: { type: 'stdio', command: 'npx', args: ['-y', 'fs', '${input:folder}'] } },
        inputs: [{ id: 'folder', type: 'promptString' }],
      }),
    })
    expect(scanApp('vscode', w).items[0]).toMatchObject({ name: 'fs', needsInput: true })
  })

  it('Codex：config.toml 的 mcp_servers，url + bearer_token_env_var；关着的照样列出但导入后是关的', () => {
    const w = setup({
      'home/.codex/config.toml': [
        '[mcp_servers.playwright]',
        'command = "npx"',
        'args = ["@playwright/mcp@0.0.40"]',
        'enabled = false',
        '',
        '[mcp_servers.docs]',
        'url = "https://docs.example.com/mcp"',
        'bearer_token_env_var = "DOCS_TOKEN"',
        '',
        '[mcp_servers.docs.http_headers]',
        'X-Team = "acme"',
      ].join('\n'),
      'home/.codex/skills/pptx/SKILL.md': '---\nname: pptx\ndescription: x\n---\n',
      'home/.codex/skills/not-a-skill/readme.md': 'x',
    })
    const r = scanApp('codex', w)
    expect(r.errors).toEqual([])
    const [pw, docs, skill] = r.items
    expect(pw).toMatchObject({ name: 'playwright', enabled: false, detail: 'npx @playwright/mcp@0.0.40' })
    expect(docs.config).toEqual({
      type: 'http',
      url: 'https://docs.example.com/mcp',
      headers: { 'X-Team': 'acme', Authorization: 'Bearer ${DOCS_TOKEN}' },
    })
    expect(skill).toMatchObject({ kind: 'skill', name: 'pptx' })
    expect(r.items).toHaveLength(3)
  })

  it('Claude Code：~/.claude.json 全局 + 这个项目的、.mcp.json、技能目录', () => {
    const w = setup({})
    const project = w.project
    writeFileSync(
      join(w.home, '.claude.json'),
      json({
        mcpServers: { a: { command: 'npx', args: ['a'] } },
        projects: { [project]: { mcpServers: { b: { type: 'http', url: 'https://b.dev/mcp' } } } },
      }),
    )
    writeFileSync(join(project, '.mcp.json'), json({ mcpServers: { c: { command: 'uvx', args: ['c'] } } }))
    mkdirSync(join(w.home, '.claude', 'skills', 'review'), { recursive: true })
    writeFileSync(join(w.home, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n')
    const r = scanApp('claude-code', w)
    expect(r.items.map(i => `${i.kind}:${i.name}:${i.project}`)).toEqual([
      'mcp:a:false',
      'mcp:b:true',
      'mcp:c:true',
      'skill:review:false',
    ])
  })

  it('坏文件只报这个文件；坏的一项只报这一项；没装的软件什么都没有', () => {
    const w = setup({
      'home/.codeium/windsurf/mcp_config.json': '{ not json',
      'home/.cursor/mcp.json': json({ mcpServers: { bad: { type: 'ws' }, ok: { command: 'npx', args: [] } } }),
    })
    const wind = scanApp('windsurf', w)
    expect(wind.items).toEqual([])
    expect(wind.errors).toHaveLength(1)
    const cursor = scanApp('cursor', w)
    expect(cursor.items.map(i => i.name)).toEqual(['ok'])
    expect(cursor.errors).toHaveLength(1)
    expect(scanApp('claude-desktop', w)).toMatchObject({ items: [], errors: [] })
  })
})

describe('审查后补的', () => {
  it('坏文件的报错不带原文（解析器会引用出错那几行，可能有密钥）', () => {
    const w = setup({
      'home/.codex/config.toml': ['[mcp_servers.a.env]', 'K = "sk-SECRET123"', 'broken = '].join('\n'),
      'home/.cursor/mcp.json': '{"mcpServers": {"a": {"env": {"B": sk-RAW}}}}',
    })
    for (const app of ['codex', 'cursor'] as const) {
      const r = scanApp(app, w)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).not.toMatch(/SECRET|sk-RAW/)
    }
  })

  it('Cursor 远程只写 url、Windsurf 用 serverUrl：当 http；VS Code 的注释和结尾逗号能读', () => {
    const w = setup({
      'home/.cursor/mcp.json': json({ mcpServers: { remote: { url: 'https://r.dev/mcp', headers: { A: 'b' } } } }),
      'home/.codeium/windsurf/mcp_config.json': json({ mcpServers: { w: { serverUrl: 'https://w.dev/mcp' } } }),
      'home/AppData/Roaming/Code/User/mcp.json': [
        '{',
        '  // 注释',
        '  "servers": { "fs": { "command": "npx", "args": ["x"], }, },',
        '}',
      ].join('\n'),
    })
    expect(scanApp('cursor', w).items[0].config).toMatchObject({ type: 'http', url: 'https://r.dev/mcp' })
    expect(scanApp('windsurf', w).items[0].config).toMatchObject({ type: 'http', url: 'https://w.dev/mcp' })
    expect(scanApp('vscode', w)).toMatchObject({ errors: [], items: [{ name: 'fs' }] })
  })

  it('Codex env_http_headers 换成 ${变量}；~/.agents/skills 也读', () => {
    const w = setup({
      'home/.codex/config.toml': [
        '[mcp_servers.d]',
        'url = "https://d.dev/mcp"',
        '[mcp_servers.d.env_http_headers]',
        'X-Key = "D_KEY"',
      ].join('\n'),
      'home/.agents/skills/notes/SKILL.md': ['---', 'name: notes', '---'].join('\n'),
    })
    const r = scanApp('codex', w)
    expect(r.items[0].config?.headers).toEqual({ 'X-Key': '${D_KEY}' })
    expect(r.items.map(i => i.name)).toEqual(['d', 'notes'])
  })

  it('项目就是主目录：同一个文件不列两遍', () => {
    const w = setup({ 'home/.cursor/mcp.json': json({ mcpServers: { a: { command: 'npx', args: [] } } }) })
    expect(scanApp('cursor', { ...w, project: w.home }).items).toHaveLength(1)
  })
})

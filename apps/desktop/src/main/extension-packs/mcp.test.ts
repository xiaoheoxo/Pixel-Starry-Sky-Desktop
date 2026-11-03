import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtMcpServer, ExtPackInfo } from '@pixelsky/protocol'
import type { Cipher } from '../core/secure-store'
import type { LoadedPack } from './loader'
import { mcpConfigOf, PackMcp } from './mcp'

const cipher: Cipher = { available: () => true, encrypt: s => s, decrypt: s => s }
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function store(): { mcp: PackMcp; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pixelsky-packmcp-'))
  dirs.push(dir)
  const file = join(dir, 'mcp.json')
  return { mcp: new PackMcp(file, cipher), file }
}

const github: ExtMcpServer = {
  name: 'github',
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'],
  inputs: [{ name: 'GITHUB_TOKEN', description: 'token', secret: true, required: true }],
  source: 'https://github.com/modelcontextprotocol/servers',
}
const docs: ExtMcpServer = {
  name: 'docs',
  type: 'http',
  url: 'https://x.dev/${TEAM}/mcp',
  headers: { Authorization: 'Bearer ${KEY}' },
  inputs: [
    { name: 'TEAM', description: 'team' },
    { name: 'KEY', description: 'key' },
  ],
  source: 'https://github.com/x/y',
}

function pack(servers: ExtMcpServer[], extra: Partial<ExtPackInfo> = {}): LoadedPack {
  const info = {
    key: 's-lin.tools',
    id: 'lin.tools',
    live: true,
    inactive: {},
    manifest: { contributes: { mcpServers: servers } },
    ...extra,
  } as unknown as ExtPackInfo
  return { info, root: '', files: new Map() } as unknown as LoadedPack
}

describe('PackMcp', () => {
  it('没同意不给；同意 + 填了必填才给，值换进参数 / 环境变量', () => {
    const { mcp } = store()
    const p = pack([github])
    expect(mcp.launch([p]).servers).toEqual({})
    mcp.set('lin.tools', github, true, {})
    expect(mcp.status(p.info)).toEqual([{ name: 'github', approved: true, missing: ['GITHUB_TOKEN'], filled: [] }])
    expect(mcp.launch([p]).servers).toEqual({})
    mcp.set('lin.tools', github, true, { GITHUB_TOKEN: 'ghp_x', NOT_DECLARED: 'y' })
    const r = mcp.launch([p])
    expect(r.servers.github).toEqual({
      type: 'stdio',
      command: 'npx',
      args: github.args,
      env: { GITHUB_TOKEN: 'ghp_x' },
    })
    expect(r.key).not.toContain('ghp_x')
  })

  it('更新改了参数要重新同意；值留着', () => {
    const { mcp } = store()
    mcp.set('lin.tools', github, true, { GITHUB_TOKEN: 'ghp_x' })
    const updated = pack([{ ...github, args: ['-y', '@modelcontextprotocol/server-github@2025.5.1'] }])
    expect(mcp.status(updated.info)?.[0]).toMatchObject({ approved: false, filled: ['GITHUB_TOKEN'] })
    expect(mcp.launch([updated]).servers).toEqual({})
    // 只改说明不用重新同意
    const described = pack([{ ...github, description: '新说明' }])
    expect(mcp.launch([described]).servers.github).toBeDefined()
  })

  it('撤销、清值、被校验停用的那条、同名先到先得', () => {
    const { mcp } = store()
    mcp.set('lin.tools', github, true, { GITHUB_TOKEN: 'a' })
    expect(mcp.launch([pack([github], { inactive: { mcpServers: [0] } })]).servers).toEqual({})
    const other = pack([{ ...github, source: 'https://github.com/other/x' }], { key: 'f-x', id: 'other.tools' })
    mcp.set('other.tools', other.info.manifest!.contributes.mcpServers![0], true, { GITHUB_TOKEN: 'b' })
    expect(mcp.launch([pack([github]), other]).servers.github.env).toEqual({ GITHUB_TOKEN: 'a' })
    mcp.set('lin.tools', github, true, { GITHUB_TOKEN: '' })
    expect(mcp.status(pack([github]).info)?.[0].missing).toEqual(['GITHUB_TOKEN'])
    mcp.set('lin.tools', github, false, {})
    expect(mcp.status(pack([github]).info)?.[0].approved).toBe(false)
  })

  it('存盘、重开还在；forget 删掉', () => {
    const { mcp, file } = store()
    mcp.set('lin.tools', github, true, { GITHUB_TOKEN: 'a' })
    expect(new PackMcp(file, cipher).launch([pack([github])]).servers.github).toBeDefined()
    mcp.forget('lin.tools')
    expect(new PackMcp(file, cipher).launch([pack([github])]).servers).toEqual({})
  })

  it('没有连接器的扩展没有 mcp 状态', () => {
    expect(store().mcp.status(pack([]).info)).toBeUndefined()
  })
})

describe('mcpConfigOf', () => {
  it('http：占位换成值，没填的换成空', () => {
    expect(mcpConfigOf(docs, { TEAM: 'acme' })).toEqual({
      type: 'http',
      url: 'https://x.dev/acme/mcp',
      headers: { Authorization: 'Bearer ' },
    })
  })
})

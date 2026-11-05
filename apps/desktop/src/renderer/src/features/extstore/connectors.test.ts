import { describe, expect, it, vi } from 'vitest'
import type { ExtMcpServer, ExtPackInfo, ExtStoreDetail, ExtStoreItem, McpReport } from '@pixelsky/protocol'
import {
  connectExtension,
  connectorNoProgram,
  connectorOn,
  disconnectExtension,
  isConnector,
  pendingLogins,
  sameServers,
  type ConnectDeps,
} from './connectors'

const remote: ExtMcpServer = {
  name: 'linear',
  type: 'http',
  url: 'https://mcp.linear.app/mcp',
  source: 'https://linear.app/docs/mcp',
}
const withInputs: ExtMcpServer = {
  name: 'feishu',
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'x@1.0.0'],
  inputs: [
    { name: 'APP_ID', description: 'id', required: true },
    { name: 'APP_SECRET', description: 'secret', secret: true, required: true },
  ],
  source: 'https://example.com/src',
}
const detail = (servers: ExtMcpServer[], local: ExtStoreDetail['local'] = null): ExtStoreDetail =>
  ({
    extension: { id: 'pixelsky.x', name: 'X' },
    latest: { version: '1.0.0' },
    manifest: { contributes: { mcpServers: servers } },
    local,
  }) as unknown as ExtStoreDetail
const pack = (servers: ExtMcpServer[], over: Partial<ExtPackInfo> = {}): ExtPackInfo =>
  ({
    key: 'k',
    id: 'pixelsky.x',
    enabled: true,
    manifest: { contributes: { mcpServers: servers } },
    ...over,
  }) as unknown as ExtPackInfo
const text = { changed: '内容变了', failed: '安装失败', noProgram: (c: string) => `找不到 ${c}` }

function deps(installed: ExtPackInfo[], over: Partial<ConnectDeps> = {}) {
  return {
    install: vi.fn(async () => true),
    installError: vi.fn(() => undefined),
    refresh: vi.fn(async () => {}),
    packs: () => installed,
    setEnabled: vi.fn(async () => {}),
    setMcp: vi.fn(async () => {}),
    ...over,
  }
}

describe('一步连接', () => {
  it('没装：装商店这一版，再同意', async () => {
    const d = deps([pack([remote])])
    await connectExtension(detail([remote]), {}, d, text)
    expect(d.install).toHaveBeenCalledWith('pixelsky.x', '1.0.0', 'install', 'X')
    expect(d.setMcp).toHaveBeenCalledWith('k', 'linear', true, {})
  })

  it('已经是这一版：不重新装；装着旧版：更新', async () => {
    const same = deps([pack([remote])])
    await connectExtension(
      detail([remote], { key: 'k', version: '1.0.0', source: 'store', enabled: true }),
      {},
      same,
      text,
    )
    expect(same.install).not.toHaveBeenCalled()
    const old = deps([pack([remote])])
    await connectExtension(
      detail([remote], { key: 'k', version: '0.9.0', source: 'store', enabled: true }),
      {},
      old,
      text,
    )
    expect(old.install).toHaveBeenCalledWith('pixelsky.x', '1.0.0', 'update', 'X')
  })

  it('装上的和确认框里看到的不一样：不同意', async () => {
    const swapped = { ...remote, url: 'https://evil.example/mcp' }
    const d = deps([pack([swapped])])
    await expect(connectExtension(detail([remote]), {}, d, text)).rejects.toThrow('内容变了')
    expect(d.setMcp).not.toHaveBeenCalled()
  })

  it('安装失败：说原因，不同意', async () => {
    const d = deps([], { install: vi.fn(async () => false), installError: () => '校验不过' })
    await expect(connectExtension(detail([remote]), {}, d, text)).rejects.toThrow('校验不过')
    expect(d.setMcp).not.toHaveBeenCalled()
  })

  it('填的值去掉空白传过去；没填的传 null，已存的密钥不会被清掉', async () => {
    const d = deps([pack([withInputs])])
    await connectExtension(detail([withInputs]), { feishu: { APP_ID: ' cli_a ' } }, d, text)
    expect(d.setMcp).toHaveBeenCalledWith('k', 'feishu', true, { APP_ID: 'cli_a', APP_SECRET: null })
  })

  it('扩展被关掉了：先打开再同意；被文件夹版替代的不算装上', async () => {
    const off = deps([pack([remote], { enabled: false })])
    await connectExtension(detail([remote]), {}, off, text)
    expect(off.setEnabled).toHaveBeenCalledWith('k', true)
    const shadowed = deps([pack([remote], { shadowedBy: 'folder' })])
    await expect(connectExtension(detail([remote]), {}, shadowed, text)).rejects.toThrow('内容变了')
  })

  it('这台电脑启动不了：说原因，不同意，也不打开扩展', async () => {
    const noNode = [{ name: 'feishu', approved: false, missing: [], filled: [], noProgram: 'npx' }]
    const d = deps([pack([withInputs], { enabled: false, mcp: noNode })])
    await expect(connectExtension(detail([withInputs]), {}, d, text)).rejects.toThrow('找不到 npx')
    expect(d.setMcp).not.toHaveBeenCalled()
    expect(d.setEnabled).not.toHaveBeenCalled()
    expect(connectorNoProgram(pack([withInputs], { mcp: noNode }))).toBe('npx')
    expect(connectorNoProgram(pack([remote]))).toBeUndefined()
  })

  it('停用：只撤销同意，不传值', async () => {
    const d = deps([])
    await disconnectExtension(pack([remote]), d)
    expect(d.setMcp).toHaveBeenCalledWith('k', 'linear', false, {})
  })
})

describe('连接器状态', () => {
  const status = (approved: boolean, missing: string[] = []) => [{ name: 'linear', approved, missing, filled: [] }]

  it('只有官方发布的 MCP 连接器走一步连接', () => {
    const item = (official: boolean, kinds: string[]) => ({ publisher: { official }, kinds }) as unknown as ExtStoreItem
    expect(isConnector(item(true, ['mcpServers']))).toBe(true)
    expect(isConnector(item(false, ['mcpServers']))).toBe(false)
    expect(isConnector(item(true, ['skills']))).toBe(false)
  })

  it('开着、同意过、必填都填了才算生效', () => {
    expect(connectorOn(undefined)).toBe(false)
    expect(connectorOn(pack([remote], { mcp: status(true) }))).toBe(true)
    expect(connectorOn(pack([remote], { mcp: status(false) }))).toBe(false)
    expect(connectorOn(pack([remote], { mcp: status(true, ['APP_ID']) }))).toBe(false)
    expect(connectorOn(pack([remote], { mcp: status(true), enabled: false }))).toBe(false)
  })

  it('比较连接器：地址、参数、要填的值变了都算不一样', () => {
    expect(sameServers([remote], [{ ...remote, description: '只改说明' }])).toBe(true)
    expect(sameServers([remote], [{ ...remote, url: 'https://other.example/mcp' }])).toBe(false)
    expect(sameServers([withInputs], [{ ...withInputs, args: ['-y', 'x@2.0.0'] }])).toBe(false)
    expect(sameServers([withInputs], [{ ...withInputs, inputs: [] }])).toBe(false)
    expect(sameServers([remote], [])).toBe(false)
  })

  it('提示还没登录：只算扩展里启用的、引擎还在跑、支持登录的', () => {
    const report = (over: Partial<McpReport> = {}): McpReport => ({
      servers: [
        { name: 'linear', status: 'auth', tools: [] },
        { name: 'mine', status: 'auth', tools: [] },
        { name: 'notion', status: 'connected', tools: [] },
      ],
      ops: ['login'],
      at: 0,
      live: true,
      ...over,
    })
    const packs = [pack([remote], { mcp: status(true) })]
    expect(pendingLogins(report(), packs).map(x => x.name)).toEqual(['linear'])
    expect(pendingLogins(report({ live: false }), packs)).toEqual([])
    expect(pendingLogins(report({ ops: [] }), packs)).toEqual([])
    expect(pendingLogins(null, packs)).toEqual([])
    expect(pendingLogins(report(), [pack([remote], { mcp: status(false) })])).toEqual([])
    expect(pendingLogins(report(), [pack([remote], { mcp: status(true), enabled: false })])).toEqual([])
  })
})

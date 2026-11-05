import type { ExtMcpServer, ExtPackInfo, ExtStoreDetail, ExtStoreItem, McpReport } from '@pixelsky/protocol'

// 发现页的「连接常用服务」（docs/ui/one-click-connectors.md）：商店里官方发布的 MCP 连接器，一步完成安装和同意。
// 只放纯函数和流程，依赖都传进来，node 测试可直接用

/** 官方发布的 MCP 连接器才走一步连接；别人发布的还是到详情页看清楚再同意 */
export const isConnector = (item: ExtStoreItem): boolean => item.publisher.official && item.kinds.includes('mcpServers')

/** 决定跑什么的字段（和主进程 mcpFingerprint 算的是同一批） */
const runSpec = (s: ExtMcpServer): string =>
  JSON.stringify([
    s.name,
    s.type,
    s.command ?? null,
    s.args ?? [],
    s.url ?? null,
    s.headers ?? {},
    (s.inputs ?? []).map(i => [i.name, i.secret === true, i.required === true]),
    s.source,
  ])

export const sameServers = (a: readonly ExtMcpServer[], b: readonly ExtMcpServer[]): boolean =>
  a.length === b.length && a.every((s, i) => runSpec(s) === runSpec(b[i]))

/** 这个连接器现在生效：扩展开着，每一条都同意过当前这一份、必填都填了 */
export function connectorOn(pack: ExtPackInfo | undefined): boolean {
  const list = pack?.mcp
  return !!pack?.enabled && !!list?.length && list.every(s => s.approved && !s.missing.length)
}

/** 这台电脑上启动不了时，找不到的命令 */
export const connectorNoProgram = (pack: ExtPackInfo | undefined): string | undefined =>
  pack?.mcp?.find(s => s.noProgram)?.noProgram

export interface ConnectDeps {
  /** 装好返回 true；失败时原因用 installError 取 */
  install(id: string, version: string, kind: 'install' | 'update', name: string): Promise<boolean>
  installError(id: string): string | undefined
  refresh(): Promise<void>
  packs(): readonly ExtPackInfo[]
  setEnabled(key: string, enabled: boolean): Promise<void>
  setMcp(key: string, name: string, approved: boolean, values: Record<string, string | null>): Promise<void>
}

/**
 * 一步连接：确认框里看到的是商店这一版，所以装的也是这一版，装好再核对一次，对不上不同意。
 * 已经是这一版就不重新装（停用后再连接、上次半路失败）。values 是这次填的值，按连接器名字分；没填的不动，已存的密钥不会被清掉
 */
export async function connectExtension(
  detail: ExtStoreDetail,
  values: Readonly<Record<string, Readonly<Record<string, string>>>>,
  deps: ConnectDeps,
  text: { changed: string; failed: string; noProgram(command: string): string },
): Promise<void> {
  const { id, name } = detail.extension
  const shown = detail.manifest?.contributes.mcpServers ?? []
  if (!shown.length) throw new Error(text.changed)
  const version = detail.latest.version
  if (detail.local?.version !== version) {
    const ok = await deps.install(id, version, detail.local ? 'update' : 'install', name)
    if (!ok) throw new Error(deps.installError(id) ?? text.failed)
  }
  await deps.refresh()
  const pack = deps.packs().find(p => p.id === id && !p.shadowedBy)
  if (!pack || !sameServers(pack.manifest?.contributes.mcpServers ?? [], shown)) throw new Error(text.changed)
  // 启动不了就别写「已启用」：同意了也不会加载，用户只会看到连接器凭空不见。确认框留着，填的值不丢
  const noProgram = connectorNoProgram(pack)
  if (noProgram) throw new Error(text.noProgram(noProgram))
  if (!pack.enabled) await deps.setEnabled(pack.key, true)
  for (const server of shown) {
    const patch: Record<string, string | null> = {}
    for (const input of server.inputs ?? []) patch[input.name] = values[server.name]?.[input.name]?.trim() || null
    await deps.setMcp(pack.key, server.name, true, patch)
  }
  await deps.refresh()
}

/** 停用：撤销同意，扩展留着，填的值也留着，再连接时不用重填 */
export async function disconnectExtension(
  pack: ExtPackInfo,
  deps: Pick<ConnectDeps, 'refresh' | 'setMcp'>,
): Promise<void> {
  for (const server of pack.manifest?.contributes.mcpServers ?? []) await deps.setMcp(pack.key, server.name, false, {})
  await deps.refresh()
}

/** 这个会话里还没登录、又是用户在扩展里启用的连接器：只提示这些，用户自己配的不打扰 */
export function pendingLogins(
  report: McpReport | null | undefined,
  packs: readonly ExtPackInfo[],
): Array<{ name: string; pack: ExtPackInfo }> {
  if (!report?.live || !report.ops.includes('login')) return []
  return report.servers.flatMap(server => {
    if (server.status !== 'auth') return []
    const pack = packs.find(p => p.enabled && p.mcp?.some(s => s.name === server.name && s.approved))
    return pack ? [{ name: server.name, pack }] : []
  })
}

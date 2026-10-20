// 右侧工作区 › 连接器的数据整理（docs/ui/connectors.md）：引擎报告的实时状态 + 设置 › 扩展里的配置 + 本会话调用次数
import type {
  EngineId,
  ExtensionEntry,
  Item,
  McpConfig,
  McpReport,
  McpServerState,
  McpServerStatus,
  McpServerTool,
} from '@pixelsky/protocol'

/** idle：会话进程没在跑、也没有上次的状态，只知道配置 */
export type ConnectorStatus = McpServerStatus | 'idle'

/** 配置从哪来（界面文字 connectors.source.<kind>） */
export type SourceKind = 'user' | 'local' | 'project' | 'plugin' | 'managed' | 'builtin' | 'engine'

export interface ConnectorConfig {
  /** 设置 › 扩展里的条目 id（插件里的连接器是插件的 id） */
  entryId: string
  path: string | null
  transport: McpConfig['type']
  /** 命令和参数，或网址 */
  target: string
  /** 环境变量 / 请求头的名字（值不显示） */
  secrets: string[]
  /** 只在这个项目里生效 */
  project: string | null
}

export interface Connector {
  name: string
  status: ConnectorStatus
  error: string | null
  tools: McpServerTool[]
  /** 本会话调用次数（总数和按工具） */
  calls: number
  toolCalls: Record<string, number>
  source: SourceKind
  /** 插件名（source 为 plugin 时）或引擎报告的原始来源 */
  sourceDetail: string | null
  version: string | null
  config: ConnectorConfig | null
}

/** 应用自己的历史对话服务器（main/extensions/ipc.ts 的 HISTORY_SERVER_NAME） */
export const HISTORY_SERVER = 'pixelsky_history'

/** 名字比较时忽略大小写和符号：引擎会把服务器名里的 - . : 等换成 _ */
export const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_')

/** 一条工具调用是哪个服务器的哪个工具；不是 MCP 调用时返回 null */
export function mcpCallOf(engine: EngineId, item: Item): { server: string; tool: string } | null {
  if (item.kind !== 'tool' || item.tool !== 'mcp') return null
  if (engine === 'codex') {
    const at = item.name.indexOf(' / ')
    return at > 0 ? { server: item.name.slice(0, at), tool: item.name.slice(at + 3) } : null
  }
  const m = /^mcp__(.+?)__(.+)$/i.exec(item.name)
  return m ? { server: m[1]!, tool: m[2]! } : null
}

/** 本会话的 MCP 调用：按服务器（normalize 过的名字）再按工具 */
export function countCalls(engine: EngineId, items: readonly Item[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const item of items) {
    const call = mcpCallOf(engine, item)
    if (!call) continue
    const server = (out[normalize(call.server)] ??= {})
    server[call.tool] = (server[call.tool] ?? 0) + 1
  }
  return out
}

interface Configured {
  name: string
  source: SourceKind
  sourceDetail: string | null
  config: ConnectorConfig
}

function target(mcp: McpConfig): string {
  return mcp.url ?? [mcp.command ?? '', ...(mcp.args ?? [])].join(' ').trim()
}

function configOf(entryId: string, path: string | null, mcp: McpConfig, project: string | null): ConnectorConfig {
  return {
    entryId,
    path,
    transport: mcp.type,
    target: target(mcp),
    secrets: [...Object.keys(mcp.env ?? {}), ...Object.keys(mcp.headers ?? {})],
    project,
  }
}

const sameFile = (path: string, name: string) =>
  path
    .replace(/\\/g, '/')
    .toLowerCase()
    .endsWith('/' + name)

/** 这个引擎的会话会加载哪些连接器（设置 › 扩展的数据） */
export function configured(engine: EngineId, entries: readonly ExtensionEntry[]): Configured[] {
  const out: Configured[] = []
  for (const e of entries) {
    if (!e.enabled || e.error) continue
    const project = e.scope.kind === 'project' ? e.scope.path : null
    if (e.origin === 'native') {
      // ~/.claude.json、.mcp.json、Claude Code 的插件：只有 Claude Code 自己读
      if (engine !== 'claude') continue
      const path = e.path ?? e.source.location
      if (e.kind === 'mcp' && e.mcp) {
        const source: SourceKind = sameFile(path, '.mcp.json') ? 'project' : project ? 'local' : 'user'
        out.push({ name: e.name, source, sourceDetail: null, config: configOf(e.id, path, e.mcp, project) })
      }
    } else if (!(e.engines ?? ['claude']).includes(engine)) continue
    else if (e.kind === 'mcp' && e.mcp)
      out.push({
        name: e.name,
        source: 'managed',
        sourceDetail: null,
        config: configOf(e.id, e.path ?? null, e.mcp, project),
      })
    if (e.kind === 'plugin')
      for (const c of e.components)
        if (c.kind === 'mcp' && c.mcp)
          out.push({
            name: c.name,
            source: 'plugin',
            sourceDetail: e.name,
            config: configOf(e.id, c.path ?? e.path ?? null, c.mcp, project),
          })
  }
  return out
}

/** 引擎报告的名字对上配置：完全一样，或 Claude 插件服务器 plugin:<插件>:<名字> */
function matches(reported: string, c: Configured): boolean {
  const r = normalize(reported),
    n = normalize(c.name)
  if (r === n) return true
  return c.source === 'plugin' && r.startsWith('plugin_') && r.endsWith('_' + n)
}

const ENGINE_SOURCE: Record<string, SourceKind> = {
  user: 'user',
  local: 'local',
  project: 'project',
  plugin: 'plugin',
  // 应用用 --mcp-config 传进去的（设置 › 扩展里管理的）
  dynamic: 'managed',
}

/** 列表顺序：要处理的在前，然后已连接（调用多的在前），连接中，最后停用的 */
const RANK: Record<ConnectorStatus, number> = { auth: 0, failed: 1, connected: 2, pending: 3, idle: 4, disabled: 5 }

export function buildConnectors(
  engine: EngineId,
  report: McpReport | null | undefined,
  entries: readonly ExtensionEntry[],
  calls: Record<string, Record<string, number>>,
): Connector[] {
  const known = configured(engine, entries)
  const callsOf = (name: string) => {
    const toolCalls = calls[normalize(name)] ?? {}
    return { toolCalls, calls: Object.values(toolCalls).reduce((a, b) => a + b, 0) }
  }
  const fromConfig = (c: Configured, state: McpServerState | null): Connector => ({
    name: state?.name ?? c.name,
    status: state?.status ?? 'idle',
    error: state?.error ?? null,
    tools: state?.tools ?? [],
    ...callsOf(state?.name ?? c.name),
    source: c.source,
    sourceDetail: c.sourceDetail,
    version: state?.version ?? null,
    config: c.config,
  })
  const list: Connector[] = report
    ? report.servers.map(s => {
        // 名字一样的优先；只能按换算后的名字认时，要只对上一条才算（alpha.beta 和 alpha_beta 都换成 alpha_beta，
        // 认不清就不挂配置，免得详情里显示另一个服务的命令）
        const loose = known.filter(k => matches(s.name, k))
        const c = known.find(k => k.name === s.name) ?? (loose.length === 1 ? loose[0] : undefined)
        if (c) return fromConfig(c, s)
        const builtin = normalize(s.name) === HISTORY_SERVER
        return {
          name: s.name,
          status: s.status,
          error: s.error ?? null,
          tools: s.tools,
          ...callsOf(s.name),
          source: builtin ? 'builtin' : (ENGINE_SOURCE[s.source ?? ''] ?? 'engine'),
          sourceDetail: builtin ? null : (s.source ?? null),
          version: s.version ?? null,
          config: null,
        }
      })
    : known.map(c => fromConfig(c, null))
  return list.sort((a, b) => RANK[a.status] - RANK[b.status] || b.calls - a.calls || a.name.localeCompare(b.name))
}

/** 界面上的名字：Claude 插件里的服务器报成 plugin:<插件>:<名字>，插件名已经写在来源里，只显示最后一段 */
export const displayName = (c: Connector): string =>
  c.source === 'plugin' && c.name.includes(':') ? c.name.slice(c.name.lastIndexOf(':') + 1) : c.name

export interface ConnectorSummary {
  connected: number
  attention: number
  tools: number
  calls: number
}

export function summarize(list: readonly Connector[]): ConnectorSummary {
  return {
    connected: list.filter(c => c.status === 'connected').length,
    attention: list.filter(c => c.status === 'auth' || c.status === 'failed').length,
    tools: list.reduce((n, c) => n + (c.status === 'connected' ? c.tools.length : 0), 0),
    calls: list.reduce((n, c) => n + c.calls, 0),
  }
}

/** 头像上的字：名字里第一个字母或汉字，两个词时取两个首字母 */
export function initials(name: string): string {
  const words = name
    .replace(/^plugin[:_]/i, '')
    .split(/[^A-Za-z0-9一-鿿]+/)
    .filter(Boolean)
  if (!words.length) return '?'
  const first = words[0]!
  if (/[一-鿿]/.test(first[0]!)) return first[0]!
  return (words.length > 1 ? first[0]! + words[1]![0]! : first[0]!).toUpperCase()
}

/** 头像颜色：按名字固定挑一种（0–4） */
export function tint(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 5
}

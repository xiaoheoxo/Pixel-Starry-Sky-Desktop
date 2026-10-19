// 会话里的 MCP 服务器状态（docs/ui/connectors.md）：三家引擎各自的格式换成 McpServerState，
// McpReporter 负责发 mcp 事件、连接中时隔一会儿再取、进程关了标成「上次的状态」。
import type {
  EngineEvent,
  McpOpKind,
  McpReport,
  McpServerState,
  McpServerStatus,
  McpServerTool,
} from '@pixelsky/protocol'

type Msg = Record<string, unknown>
const obj = (v: unknown): Msg => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Msg) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function tool(raw: unknown): McpServerTool | null {
  const t = obj(raw)
  const name = str(t.name)
  if (!name) return null
  const notes = obj(t.annotations)
  const readOnly = notes.readOnlyHint ?? notes.readOnly
  return {
    name,
    ...(str(t.description) ? { description: str(t.description)!.trim() } : {}),
    ...(typeof readOnly === 'boolean' ? { readOnly } : {}),
  }
}

/** 数组，或 Codex 的 { 工具名: Tool } */
const tools = (list: unknown): McpServerTool[] =>
  (Array.isArray(list) ? list : Object.entries(obj(list)).map(([name, v]) => ({ name, ...obj(v) }))).flatMap(
    v => tool(v) ?? [],
  )

function version(info: unknown): string | undefined {
  const i = obj(info)
  return str(i.version) ? (str(i.name) ? `${str(i.name)} ${str(i.version)}` : str(i.version)) : undefined
}

const CLAUDE_STATUS: Record<string, McpServerStatus> = {
  connected: 'connected',
  pending: 'pending',
  'needs-auth': 'auth',
  failed: 'failed',
  disabled: 'disabled',
}

/** Claude Code 控制请求 mcp_status 的回应 { mcpServers: [...] } */
export function claudeMcpServers(response: unknown): McpServerState[] {
  const list = obj(response).mcpServers
  if (!Array.isArray(list)) return []
  return list.flatMap(raw => {
    const s = obj(raw)
    const name = str(s.name)
    if (!name) return []
    const status = CLAUDE_STATUS[str(s.status) ?? ''] ?? 'pending'
    const config = obj(s.config)
    const transport =
      str(config.url) ?? (str(config.command) ? [config.command, ...arr(config.args)].join(' ') : undefined)
    return [
      {
        name,
        status,
        ...(str(s.error) ? { error: str(s.error) } : {}),
        ...(str(s.scope) || str(s.source) ? { source: str(s.scope) ?? str(s.source) } : {}),
        ...(version(s.serverInfo) ? { version: version(s.serverInfo) } : {}),
        ...(transport ? { transport } : {}),
        tools: status === 'connected' ? tools(s.tools) : [],
      },
    ]
  })
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

const CODEX_RUNTIME: Record<string, McpServerStatus> = {
  notStarted: 'pending',
  starting: 'pending',
  connected: 'connected',
  authenticationRequired: 'auth',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'disabled',
}

const CODEX_STARTUP: Record<string, McpServerStatus> = {
  starting: 'pending',
  ready: 'connected',
  failed: 'failed',
  cancelled: 'failed',
}

/**
 * Codex app-server mcpServerStatus/list 的 data；startup 是启动状态推送（mcpServer/startupStatus/updated）记下的
 * 状态和报错：列表还没有运行状态时以推送为准
 */
export function codexMcpServers(
  data: unknown[],
  startup: ReadonlyMap<string, { status: string; error?: string }> = new Map(),
): McpServerState[] {
  return data.flatMap(raw => {
    const s = obj(raw)
    const name = str(s.name)
    if (!name) return []
    const pushed = startup.get(name)
    let status: McpServerStatus =
      CODEX_RUNTIME[str(s.runtimeStatus) ?? ''] ?? (pushed && CODEX_STARTUP[pushed.status]) ?? 'pending'
    if (status !== 'connected' && s.authStatus === 'notLoggedIn' && pushed?.status !== 'ready') status = 'auth'
    const list = tools(s.tools)
    if (status === 'pending' && !pushed && list.length) status = 'connected'
    const error = str(s.toolsError) ?? (status === 'connected' ? undefined : pushed?.error)
    return [
      {
        name,
        status,
        ...(error ? { error } : {}),
        ...(str(s.pluginId) ? { source: `plugin ${str(s.pluginId)}` } : {}),
        ...(version(s.serverInfo) ? { version: version(s.serverInfo) } : {}),
        ...(str(s.httpOrigin) ? { transport: str(s.httpOrigin) } : {}),
        tools: status === 'connected' ? list : [],
      },
    ]
  })
}

const PIXEL_STATUS: Record<string, McpServerStatus> = {
  connected: 'connected',
  connecting: 'pending',
  starting: 'pending',
  disconnected: 'failed',
  'needs-auth': 'auth',
  failed: 'failed',
  closed: 'disabled',
  disabled: 'disabled',
}

/** 像素星空命令行 setStatus('pixelsky-mcp') 带的 JSON（packages/cli/src/extensions/mcp.ts） */
export function pixelMcpServers(json: string): McpServerState[] | null {
  let list: unknown
  try {
    list = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  return list.flatMap(raw => {
    const s = obj(raw)
    const name = str(s.name)
    if (!name) return []
    const status = s.enabled === false ? 'disabled' : (PIXEL_STATUS[str(s.state) ?? ''] ?? 'pending')
    return [
      {
        name,
        status,
        ...(str(s.error) && status !== 'connected' ? { error: str(s.error) } : {}),
        ...(str(s.source) ? { source: str(s.source) } : {}),
        ...(str(s.transport) ? { transport: str(s.transport) } : {}),
        tools: status === 'connected' ? tools(s.tools) : [],
      },
    ]
  })
}

/** 连接中时再取的间隔：Claude / 像素星空的服务器在后台连，启动时多半还没好 */
const PENDING_RETRY_MS = [1_500, 3_000, 6_000, 12_000]

export class McpReporter {
  private last: McpReport | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  private disposed = false

  constructor(
    private readonly emit: (event: EngineEvent) => void,
    readonly ops: McpOpKind[],
    /** 取一次状态；进程没在跑时返回 null */
    private readonly fetch?: () => Promise<McpServerState[] | null>,
  ) {}

  get report(): McpReport | null {
    return this.last
  }

  /** 取一次并发事件；出错时保持上次的状态 */
  async refresh(): Promise<McpReport | null> {
    if (!this.fetch) return this.last
    const servers = await this.fetch()
    if (!servers) return this.last
    return this.set(servers, true)
  }

  /** 引擎主动推来的完整列表（像素星空） */
  set(servers: McpServerState[], fromFetch = false): McpReport {
    const report: McpReport = { servers, ops: this.ops, at: Date.now(), live: true }
    const same =
      this.last?.live && JSON.stringify(this.last.servers) === JSON.stringify(servers) && this.last.ops === this.ops
    this.last = report
    if (!same && !this.disposed) this.emit({ type: 'mcp', report })
    if (fromFetch) this.schedule(servers)
    return report
  }

  /** 还有连接中的就过一会儿再取，最多几次；全部有结果后重置 */
  private schedule(servers: McpServerState[]): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!servers.some(s => s.status === 'pending')) {
      this.retries = 0
      return
    }
    const delay = PENDING_RETRY_MS[this.retries++]
    if (delay === undefined || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh().catch(() => undefined)
    }, delay)
    this.timer.unref?.()
  }

  /** 引擎进程退了：保留最后的状态，标成不是实时的 */
  stale(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.retries = 0
    if (!this.last?.live || this.disposed) return
    this.last = { ...this.last, live: false }
    this.emit({ type: 'mcp', report: this.last })
  }

  dispose(): void {
    this.stale()
    this.disposed = true
  }
}

// 会话里的 MCP 服务器（右侧工作区 › 连接器，docs/ui/connectors.md）：引擎报告的实时连接状态和能做的操作

/** connected 已连接；pending 连接中；auth 要登录；failed 连不上；disabled 这个会话停用了 */
export type McpServerStatus = 'connected' | 'pending' | 'auth' | 'failed' | 'disabled'

export interface McpServerTool {
  name: string
  description?: string
  /** 服务器声明只读（annotations.readOnlyHint）；没声明时省略 */
  readOnly?: boolean
}

export interface McpServerState {
  name: string
  status: McpServerStatus
  /** 连不上 / 要登录时引擎给的原因 */
  error?: string
  /** 引擎说的来源（Claude 的 scope：user / project / local / plugin…；像素星空：mcp.json 路径） */
  source?: string
  /** 服务器自报的名字和版本 */
  version?: string
  /** 连接方式（命令或网址），引擎报告了才有 */
  transport?: string
  /** 已连接时的工具；没连上时为空 */
  tools: McpServerTool[]
}

export type McpOpKind = 'reconnect' | 'toggle' | 'login'

export type McpOp =
  | { kind: 'refresh' }
  | { kind: 'reconnect'; name: string }
  | { kind: 'toggle'; name: string; enabled: boolean }
  | { kind: 'login'; name: string }

export interface McpReport {
  servers: McpServerState[]
  /** 这个引擎支持的操作 */
  ops: McpOpKind[]
  /** 取到的时间 */
  at: number
  /** false：引擎进程已经关了，这是上次连接时的状态 */
  live: boolean
}

/** 操作结果：最新报告；登录另带要在浏览器里打开的授权链接 */
export interface McpOpResult {
  report: McpReport | null
  url?: string
}

export type ExtensionKind = 'plugin' | 'mcp' | 'cli' | 'skill'
export type ExtensionScope = { kind: 'global' } | { kind: 'project'; path: string }
export interface McpConfig {
  type: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}
export interface ExtensionComponent {
  kind: ExtensionKind
  name: string
  description: string
  path?: string
  mcp?: McpConfig
  invocable?: boolean
}
/** 插件自带的钩子：只展示，由 Claude Code 自己在对应事件执行 */
export interface ExtensionHook {
  event: string
  /** 匹配条件（工具名、会话来源等）；没写表示该事件每次都触发 */
  matcher: string
  type: string
  /** command 类型是命令行，http 是地址，prompt / agent 是提示词 */
  command: string
  timeout?: number
}
export interface ExtensionCheck {
  status: 'connected' | 'ready' | 'error' | 'auth'
  message: string
  tools?: Array<{ name: string; description: string }>
  at: number
}
export interface ExtensionEntry {
  engines?: Array<'claude' | 'codex' | 'pixel'>
  id: string
  kind: ExtensionKind
  name: string
  description: string
  scope: ExtensionScope
  enabled: boolean
  origin: 'managed' | 'native'
  source: { kind: 'local' | 'git' | 'created' | 'native'; location: string; subdir?: string; revision?: string }
  path?: string
  version?: string
  components: ExtensionComponent[]
  /** 插件自带钩子，每次读取状态时现读（不落盘）；不是插件或没有时为空 */
  hooks?: ExtensionHook[]
  mcp?: McpConfig
  command?: string
  args?: string[]
  digest?: string
  sourceDigest?: string
  edited?: boolean
  revision?: number
  check?: ExtensionCheck
  error?: string
}
export interface ExtensionState {
  entries: ExtensionEntry[]
  warnings: string[]
  revision: number
  secretsPersistent: boolean
}
export interface ExtensionInput {
  engines?: Array<'claude' | 'codex' | 'pixel'>
  id?: string
  kind: ExtensionKind
  name: string
  description?: string
  scope: ExtensionScope
  enabled?: boolean
  mcp?: McpConfig
  command?: string
  args?: string[]
  text?: string
  expectedVersion?: string
}
export interface ExtensionImport {
  engines?: Array<'claude' | 'codex' | 'pixel'>
  kind: 'plugin' | 'skill'
  source: 'local' | 'git'
  location: string
  subdir?: string
  scope: ExtensionScope
  name?: string
}
export interface ExtensionLaunch {
  codexConfig?: Record<string, unknown>
  /** 只加进引擎进程环境的变量（MCP 凭据），配置里按名字引用，不进命令行 */
  env?: Record<string, string>
  skillRoots?: string[]
  key: string
  pluginDirs: string[]
  mcpFile?: string
  /** 不用逐次审批的工具（Claude 的 permissions.allow 规则），例如只读的对话历史 MCP */
  allowTools?: string[]
  pathDirs: string[]
  dispose?: () => void
}
export interface SkillCommand {
  invocation?: 'slash' | 'skill'
  path?: string
  name: string
  description: string
  source: 'engine' | 'configured'
  /** Claude initialize 的原生标记；不能仅凭命令名称判定，用户技能可能同名。 */
  builtin?: boolean
}

// 从本机其他软件导入（apps/desktop/src/main/extensions/import-apps.ts，docs/ui/extension-remaining-plan.md §H）
export const IMPORT_APPS = ['claude-code', 'claude-desktop', 'cursor', 'codex', 'vscode', 'windsurf'] as const
export type ImportApp = (typeof IMPORT_APPS)[number]

export const IMPORT_APP_NAMES: Record<ImportApp, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  codex: 'Codex',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
}

/** 界面上的一项：密钥只给名字 */
export interface ImportItem {
  key: string
  kind: 'mcp' | 'skill'
  name: string
  /** 命令行 / 地址 / 技能目录 */
  detail: string
  secrets: string[]
  /** 来自项目里的配置（.mcp.json、.cursor/mcp.json…） */
  project: boolean
  /** 有导入后要自己填的值（VS Code 的 ${input:…}） */
  needsInput: boolean
  /** 插件配置里已有同名的（界面默认不勾，导入时自动改名） */
  exists?: boolean
}
export interface ImportAppScan {
  app: ImportApp
  name: string
  /** 读的位置（给人看的） */
  places: string[]
  items: ImportItem[]
  errors: string[]
}

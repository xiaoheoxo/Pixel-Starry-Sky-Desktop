// 工具调用批准扩展：每次 tool_call 前按权限模式决定 放行 / 拒绝 / 询问。
// 询问走 ctx.ui.select（允许 / 本会话不再询问 / 拒绝；RPC 模式下变成 extension_ui_request，由桌面界面回答）；
// 没有界面（print / json 模式）时无法询问，直接拒绝并说明原因。
// 「本会话不再询问」的规则用 pi.appendEntry 记进会话文件，进程重启、续接会话后照样生效。
// 只用可擦除的 TS 语法。
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import {
  EXIT_PLAN_DESCRIPTION,
  EXIT_PLAN_TOOL,
  PLAN_CONTEXT,
  PLAN_OPTIONS,
  PLAN_PROMPT,
  exitPlanParameters,
  isPlanContext,
  planResult,
  planTitle,
} from './plan.ts'

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** 只读工具：任何模式都放行（后三个是 Pi 读 MCP 资源的工具，Pi 自己也标成只读） */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'ls',
  'find',
  'grep',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
])
/**
 * 无副作用的内部工具（待办、按需加载工具、交计划）：任何模式都放行。
 * 子智能体（task）和 codemode 脚本本身也放行：子进程里、脚本里的每个工具调用照样走这里逐个问
 * （codemode 跑在没有文件、网络的沙箱里，只能调工具，Pi 文档 docs/codemode.md）
 */
export const SAFE_INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'todo_write',
  'tool_search',
  EXIT_PLAN_TOOL,
  'task',
  'codemode',
])
/**
 * 桌面端声明不用问的工具（逗号分隔；`mcp__<服务器>` 表示这个 MCP 服务器的全部工具），
 * 例如换引擎后挂上的只读对话历史服务器
 */
export const ALLOW_TOOLS_ENV = 'PIXELSKY_ALLOW_TOOLS'

/** 工具名是否在 PIXELSKY_ALLOW_TOOLS 里（MCP 工具名里 - 等字符 Pi 换成了 _，这里同样换掉再比） */
export function isAllowedTool(toolName: string, allow: string | undefined): boolean {
  const ident = (s: string) => s.trim().replace(/[^A-Za-z0-9_]/g, '_')
  return (allow ?? '')
    .split(',')
    .map(ident)
    .some(p => p !== '' && (toolName === p || toolName.startsWith(p + '__')))
}
/** acceptEdits 下自动放行的编辑类工具 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write'])

export const PERMISSION_FLAG = 'permission-mode'
export const PERMISSION_ENV = 'PIXELSKY_PERMISSION_MODE'
/** 运行中切换权限模式的扩展命令（`/pixelsky-mode <mode>`），桌面端适配器用 */
export const MODE_COMMAND = 'pixelsky-mode'
/**
 * 当前权限模式用 ctx.ui.setStatus 报出去（终端里显示在状态栏；RPC 里桌面端适配器据此同步模式，
 * 例如计划确认后自己退出了计划模式）
 */
export const MODE_STATUS = 'pixelsky-mode'

/** 询问时的三个选项。桌面端适配器按这三个原文认出「这是审批」（packages/engine/src/pixel/translate.ts 的 APPROVAL_OPTIONS） */
export const ALLOW_OPTION = '允许 / Allow'
export const ALWAYS_OPTION = '本会话不再询问 / Always allow in this session'
export const DENY_OPTION = '拒绝 / Deny'
export const APPROVAL_OPTIONS = [ALLOW_OPTION, ALWAYS_OPTION, DENY_OPTION] as const
/** 会话文件里「不再询问」规则的条目类型 */
export const RULE_ENTRY = 'pixelsky-approval-rule'
/** 命令类工具：规则按完整命令记，别的工具按工具名记 */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell'])

/**
 * 「本会话不再询问」规则的键：命令按工具 + 完整命令（同一条命令不再问，别的命令照问），抓网页按网站，
 * 其余（改文件、搜索网页、MCP 工具等）按工具名。
 */
export function ruleKey(toolName: string, input: unknown): string {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  // 抓网页按网站记：同一个网站不再问，别的网站照问
  if (toolName === 'web_fetch' && typeof record.url === 'string') {
    try {
      return `web_fetch:${new URL(record.url).host.toLowerCase()}`
    } catch {
      return toolName
    }
  }
  if (COMMAND_TOOLS.has(toolName) && typeof record.command === 'string') return `${toolName}:${record.command.trim()}`
  return toolName
}

/** 询问对话框的标题：第一行给适配器认工具名（toolNameFromTitle），第二行是摘要 */
export function approvalTitle(toolName: string, input: unknown): string {
  const summary = describeToolCall(toolName, input)
  return `允许工具 ${toolName}？ / Allow tool ${toolName}?${summary ? '\n' + summary : ''}`
}

/** 从询问标题里取工具名（approvalTitle 的反过程；不是审批时返回空串） */
export function approvalTool(title: string): string {
  return /^允许工具 ([^\s？?]+)？ \/ Allow tool /.exec(title)?.[1] ?? ''
}

export type PermissionDecision = { action: 'allow' } | { action: 'block'; reason: string } | { action: 'ask' }

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * 解析权限模式：命令行参数优先，其次环境变量，默认 default。
 * 值不合法时回落 default（最严格的可交互模式）并返回警告文字。
 */
export function resolvePermissionMode(
  flagValue: string | boolean | undefined,
  envValue: string | undefined,
): { mode: PermissionMode; warning?: string } {
  const raw = typeof flagValue === 'string' && flagValue !== '' ? flagValue : envValue?.trim() || undefined
  if (raw === undefined) return { mode: 'default' }
  if (isPermissionMode(raw)) return { mode: raw }
  return {
    mode: 'default',
    warning: `未知的权限模式 "${raw}"，已改用 default（可选：${PERMISSION_MODES.join(' / ')}）/ Unknown permission mode "${raw}", using default.`,
  }
}

/** 纯函数：不带副作用，便于测试。 */
export function decidePermission(input: {
  mode: PermissionMode
  toolName: string
  hasUI: boolean
}): PermissionDecision {
  const { mode, toolName, hasUI } = input
  if (mode === 'bypassPermissions') return { action: 'allow' }
  if (READ_ONLY_TOOLS.has(toolName) || SAFE_INTERNAL_TOOLS.has(toolName)) return { action: 'allow' }
  if (mode === 'plan') {
    return {
      action: 'block',
      reason: `Tool "${toolName}" is blocked: the session is in plan mode (read-only). Use read/ls/find/grep to investigate, then present your plan to the user instead of making changes.`,
    }
  }
  if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return { action: 'allow' }
  // edit / write（default 模式）、bash / powershell 和未知工具（含 MCP 工具）：要问用户
  if (!hasUI) {
    return {
      action: 'block',
      reason: `Tool "${toolName}" requires user approval, but no interactive UI is available (mode "${mode}"). Run with --permission-mode bypassPermissions to allow it without asking.`,
    }
  }
  return { action: 'ask' }
}

/** 截断；边界落在 emoji（代理对）中间时少截一位，不留半个字符（适配器的 clipText 要一致） */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const high = text.charCodeAt(max - 1)
  const low = text.charCodeAt(max)
  const end = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? max - 1 : max
  return `${text.slice(0, end)}…`
}

/**
 * 抓网页的摘要：先写真正会去抓的网址（WHATWG 归一化之后的：`127。0。0。1`、全角字母、`2130706433` 这类写法
 * 在这里就现出原形），再写 prompt。不再整个参数 JSON 截断——prompt 写在前面、写得长时网址会被截没，
 * 用户看不到批准的是哪里。适配器（packages/engine/src/pixel/translate.ts 的 approvalSummary）要算出一样的文字
 */
function describeWebFetch(raw: string, prompt: unknown): string {
  let target = raw
  try {
    target = new URL(raw.trim()).href
  } catch {
    // 不是合法网址：照原文显示，工具执行时会报错
  }
  const ask = typeof prompt === 'string' ? prompt.trim() : ''
  return ask ? `${clip(target, 400)} — ${clip(ask, 300)}` : clip(target, 400)
}

/** 给询问对话框用的一行摘要 */
export function describeToolCall(toolName: string, input: unknown): string {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (toolName === 'web_fetch' && typeof record.url === 'string') return describeWebFetch(record.url, record.prompt)
  if (typeof record.command === 'string') return clip(record.command, 800)
  if (typeof record.path === 'string') return clip(record.path, 400)
  if (typeof record.file_path === 'string') return clip(record.file_path, 400)
  try {
    return clip(JSON.stringify(record), 800)
  } catch {
    return ''
  }
}

export type ApprovalExtension = ExtensionFactory & {
  /** 当前权限模式（子智能体按这个模式起子进程） */
  currentMode(): PermissionMode
  /** 本会话「不再询问」的规则里有没有这个键（子智能体转来的询问也按主会话的规则答） */
  allowed(key: string): boolean
  /** 记一条「不再询问」规则（子智能体那边选了「本会话不再询问」时，主会话也记上） */
  remember(key: string): void
  /** 运行中权限模式变了（/pixelsky-mode、计划确认后退出计划模式）时通知；返回取消订阅。子智能体靠它把新模式同步给正在跑的子进程 */
  onModeChange(listener: (mode: PermissionMode) => void): () => void
}

/**
 * 创建批准扩展；mode 不传时在首次工具调用时从 --permission-mode / 环境变量读取。
 * subagent：自己是子智能体（子智能体工具起的子进程）时不注入计划模式说明、不注册 exit_plan_mode——计划由主智能体交。
 */
export function createApprovalExtension(
  options: { mode?: PermissionMode; subagent?: boolean } = {},
): ApprovalExtension {
  let mode: PermissionMode | undefined = options.mode
  let flag: () => string | boolean | undefined = () => undefined
  const currentMode = (): PermissionMode => {
    if (mode) return mode
    const resolved = resolvePermissionMode(flag(), process.env[PERMISSION_ENV])
    if (resolved.warning) console.error(resolved.warning)
    mode = resolved.mode
    return mode
  }
  // 本会话里「不再询问」的规则：会话开始 / 续接 / 分叉时从会话文件里读回来，新记的用 pi.appendEntry 写进去
  const rules = new Set<string>()
  let persist: (key: string) => void = () => {}
  const remember = (key: string): void => {
    if (rules.has(key)) return
    rules.add(key)
    persist(key)
  }
  const modeListeners = new Set<(mode: PermissionMode) => void>()
  const onModeChange = (listener: (mode: PermissionMode) => void): (() => void) => {
    modeListeners.add(listener)
    return () => {
      modeListeners.delete(listener)
    }
  }
  const factory = (pi: ExtensionAPI) => {
    persist = key => pi.appendEntry(RULE_ENTRY, { key })
    pi.registerFlag(PERMISSION_FLAG, {
      type: 'string',
      description: `Permission mode: ${PERMISSION_MODES.join(' | ')} (default: default; env ${PERMISSION_ENV})`,
    })
    flag = () => pi.getFlag(PERMISSION_FLAG)

    /** 进入计划模式之前的模式：计划确认后回到它（一开始就是计划模式时回到 default） */
    let beforePlan: PermissionMode = 'default'
    const setMode = (next: PermissionMode, ctx: Pick<ExtensionContext, 'ui'>): void => {
      const prev = currentMode()
      if (next === 'plan' && prev !== 'plan') beforePlan = prev
      mode = next
      ctx.ui.setStatus(MODE_STATUS, next)
      if (next !== prev) for (const l of [...modeListeners]) l(next)
    }

    // 运行中切换权限模式：桌面端（RPC）发 prompt "/pixelsky-mode <mode>"，扩展命令立即执行、不进模型（disposition: handled）。
    pi.registerCommand(MODE_COMMAND, {
      description: `Switch the permission mode at runtime: ${PERMISSION_MODES.join(' | ')}`,
      handler: async (args, ctx) => {
        const next = args.trim()
        if (!isPermissionMode(next)) {
          ctx.ui.notify(
            `未知的权限模式 "${next}"（可选：${PERMISSION_MODES.join(' / ')}）/ Unknown permission mode "${next}".`,
            'error',
          )
          return
        }
        setMode(next, ctx)
      },
    })

    // 计划模式：每轮开始前告诉模型；退出后从上下文里去掉之前注入的说明。子智能体只做调查、把结果交回去
    if (!options.subagent) registerPlanMode()
    function registerPlanMode(): void {
      pi.on('before_agent_start', async event => {
        if (event.messageType !== 'user' || currentMode() !== 'plan') return undefined
        return { message: { customType: PLAN_CONTEXT, content: PLAN_PROMPT, display: false } }
      })
      pi.on('context', async event => {
        if (currentMode() === 'plan') return undefined
        return { messages: event.messages.filter(m => !isPlanContext(m)) }
      })

      pi.registerTool({
        name: EXIT_PLAN_TOOL,
        label: 'Plan',
        description: EXIT_PLAN_DESCRIPTION,
        promptSnippet: `Present the plan for approval and leave plan mode (${EXIT_PLAN_TOOL})`,
        parameters: exitPlanParameters,
        executionMode: 'sequential' as const,
        async execute(
          _toolCallId: string,
          params: { plan: string },
          _signal: unknown,
          _onUpdate: unknown,
          ctx: ExtensionContext,
        ) {
          const text = (s: string) => ({
            content: [{ type: 'text' as const, text: s }],
            details: { plan: params.plan },
          })
          if (currentMode() !== 'plan') return text('Not in plan mode; nothing to approve. Continue with the task.')
          if (!ctx.hasUI)
            return text(
              'No interactive user is available to approve the plan. Present the plan as your final answer instead.',
            )
          const result = planResult(await ctx.ui.select(planTitle(params.plan), [...PLAN_OPTIONS]))
          if (result.approved) setMode(beforePlan === 'plan' ? 'default' : beforePlan, ctx)
          return text(result.text)
        },
      } as never)
    }

    pi.on('session_start', async (_event, ctx) => {
      ctx.ui.setStatus(MODE_STATUS, currentMode())
      rules.clear()
      for (const entry of ctx.sessionManager.getEntries() as Array<{
        type: string
        customType?: string
        data?: unknown
      }>) {
        const key = (entry.data as { key?: unknown } | undefined)?.key
        if (entry.type === 'custom' && entry.customType === RULE_ENTRY && typeof key === 'string') rules.add(key)
      }
    })

    pi.on('tool_call', async (event, ctx) => {
      if (isAllowedTool(event.toolName, process.env[ALLOW_TOOLS_ENV])) return undefined
      const decision = decidePermission({ mode: currentMode(), toolName: event.toolName, hasUI: ctx.hasUI })
      if (decision.action === 'allow') return undefined
      if (decision.action === 'block') return { block: true, reason: decision.reason }
      const key = ruleKey(event.toolName, event.input)
      if (rules.has(key)) return undefined
      const choice = await ctx.ui.select(approvalTitle(event.toolName, event.input), [...APPROVAL_OPTIONS])
      if (choice === ALWAYS_OPTION) {
        remember(key)
        return undefined
      }
      if (choice === ALLOW_OPTION) return undefined
      return { block: true, reason: `The user denied the "${event.toolName}" tool call.` }
    })
  }
  return Object.assign(factory, { currentMode, allowed: (key: string) => rules.has(key), remember, onModeChange })
}

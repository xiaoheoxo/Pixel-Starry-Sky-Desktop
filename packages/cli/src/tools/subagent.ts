// 子智能体：task 工具另起一个我们自己的命令行（--mode rpc），把任务交给它独立完成，结果交回主智能体。
// 做法参照 Pi 随包的官方示例 examples/extensions/subagent（MIT，它用 --mode json -p）。这里用 RPC 模式，
// 子进程要批准的操作（extension_ui_request）原样转给主进程的 ctx.ui：桌面端照常弹审批卡片，权限模式、「不再询问」规则都照旧生效。
// 子进程起来时带着当时的权限模式；之后主会话换模式（例如切到计划模式），用同一条 /pixelsky-mode 命令同步给正在跑的子进程，
// 转过来的审批也先按主会话当前的模式判一次，同步慢一步时计划模式也挡得住写操作。
// 子进程带 PIXELSKY_SUBAGENT=1：不再派子智能体、不注入计划模式说明。会话文件放在主会话目录的 subagents/ 下，不进 --resume 列表。
// 进度通过 onUpdate 的 details 报给桌面端（智能体追踪），结束时用 pi.appendEntry 记进主会话文件。
// 只用可擦除的 TS 语法。
import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  ALLOW_OPTION,
  ALWAYS_OPTION,
  APPROVAL_OPTIONS,
  DENY_OPTION,
  MODE_COMMAND,
  approvalTool,
  decidePermission,
  describeToolCall,
  isPermissionMode,
  ruleKey,
} from '../extensions/approval.ts'
import { mcpChildEnv } from '../extensions/mcp.ts'

export const SUBAGENT_TOOL = 'task'
export const SUBAGENT_ENV = 'PIXELSKY_SUBAGENT'
/** 主会话文件里子智能体结果的条目类型 */
export const SUBAGENT_ENTRY = 'pixelsky-subagent'
/**
 * 转子智能体的审批之前，先用 ctx.ui.setStatus 报一下这是子智能体里哪次工具调用（RPC 模式才报）：
 * 桌面端适配器据此在审批卡片上显示真实的命令 / 改动（主会话里没有这个工具条目）。值是 JSON：SubagentApproval
 */
export const APPROVAL_CONTEXT_STATUS = 'pixelsky-approval-context'

/** APPROVAL_CONTEXT_STATUS 的内容 */
export interface SubagentApproval {
  /** 主会话里 task 工具调用的 id */
  toolCallId: string
  agentId: string
  label: string
  /** 子进程里要批准的工具和参数 */
  tool: string
  args: unknown
}
/** 子智能体一轮默认最多跑多久（桌面端按类型给） */
const MAX_MS = 30 * 60 * 1000
/**
 * 桌面端设置 › 子智能体（docs/ui/subagent-routing.md）：启用的类型，JSON 数组（SubagentTypeDef）。
 * 没有时只有一个「general」，跟随主会话，和以前一样
 */
export const SUBAGENT_TYPES_ENV = 'PIXELSKY_SUBAGENT_TYPES'
/** 本机网关的根地址（不带 /v1）：类型单独的站点都经它，各用自己的会话密钥（route.token 是放密钥的环境变量名） */
export const SUB_BASE_URL_ENV = 'PIXELSKY_PIXEL_SUB_BASE_URL'
/** 子进程是哪个类型：网关扩展据此注册这个类型的站点 */
export const SUBAGENT_TYPE_ENV = 'PIXELSKY_SUBAGENT_TYPE'
export const SUBAGENT_PROVIDER = 'pixelsky-sub'
/** 0：单独的站点出错时不改走主会话的模型 */
export const SUBAGENT_FALLBACK_ENV = 'PIXELSKY_SUBAGENT_FALLBACK'
/** 一个会话同时运行的子智能体上限（1–16）；没给时不限 */
export const SUBAGENT_MAX_CONCURRENT_ENV = 'PIXELSKY_SUBAGENT_MAX_CONCURRENT'
export const GENERAL_TYPE = 'general'
/** 只读类型能用的工具；MCP 工具一律不给（可能会写东西） */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'web_fetch', 'web_search', 'todo_write']

export interface SubagentRoute {
  /** Pi 的 API 种类：anthropic-messages / openai-responses / openai-completions */
  api: string
  /** models.json 的模型定义（至少有 id） */
  model: Record<string, unknown>
  /** 站点名，显示在子智能体卡片上 */
  label: string
  /** 放这个站点会话密钥的环境变量名 */
  token: string
}

export interface SubagentTypeDef {
  id: string
  name: string
  description: string
  tools: 'all' | 'read'
  maxMs: number
  instructions: string
  route: SubagentRoute | null
}

const TYPE_ID = /^[a-z][a-z0-9-]{0,31}$/
const TOKEN_ENV = /^PIXELSKY_PIXEL_SUB_TOKEN_\d{1,3}$/

/** 桌面端给的类型；没给或不对时只有跟随主会话的 general */
export function subagentTypes(env: NodeJS.ProcessEnv): SubagentTypeDef[] {
  const general: SubagentTypeDef = {
    id: GENERAL_TYPE,
    name: 'General',
    description: '',
    tools: 'all',
    maxMs: MAX_MS,
    instructions: '',
    route: null,
  }
  let raw: unknown
  try {
    raw = JSON.parse(env[SUBAGENT_TYPES_ENV] ?? '[]')
  } catch {
    raw = []
  }
  const types: SubagentTypeDef[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const o = object(item)
    const id = text(o.id)
    if (!TYPE_ID.test(id) || types.some(t => t.id === id)) continue
    const ms = Number(o.maxMs)
    const r = object(o.route)
    const model = object(r.model)
    const route =
      text(r.api) && text(model.id) && TOKEN_ENV.test(text(r.token))
        ? { api: text(r.api), model, label: text(r.label) || text(model.id), token: text(r.token) }
        : null
    types.push({
      id,
      name: text(o.name) || id,
      description: text(o.description),
      tools: o.tools === 'read' ? 'read' : 'all',
      maxMs: Number.isFinite(ms) && ms >= 60_000 && ms <= 24 * 3600_000 ? ms : MAX_MS,
      instructions: text(o.instructions),
      route,
    })
  }
  if (!types.some(t => t.id === GENERAL_TYPE)) types.unshift(general)
  return types
}

/** 子进程里注册的 provider：这个类型单独的站点（地址按协议补 /v1，和桌面端 pixelBaseUrl 一样） */
export function subagentProviderConfig(type: SubagentTypeDef, env: NodeJS.ProcessEnv): Json | null {
  const root = env[SUB_BASE_URL_ENV]?.trim().replace(/\/+$/, '')
  if (!type.route || !root) return null
  return {
    baseUrl: type.route.api === 'anthropic-messages' ? root : `${root}/v1`,
    api: type.route.api,
    apiKey: `$${type.route.token}`,
    models: [{ reasoning: type.route.api !== 'openai-completions', input: ['text', 'image'], ...type.route.model }],
  }
}

/** 智能体追踪里的模型：站点名 · 模型（不带 /，界面的短名就是整串） */
export function routedModelLabel(route: SubagentRoute): string {
  return `${route.label} · ${text(route.model.id)}`
}

/** 同时运行上限；没给或不对时不限 */
export function subagentMaxConcurrent(env: NodeJS.ProcessEnv): number {
  const n = Number(env[SUBAGENT_MAX_CONCURRENT_ENV])
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : Infinity
}

/** task 工具的说明：有多个类型时列出每个类型的标识和什么时候用 */
export function taskDescription(types: readonly SubagentTypeDef[]): string {
  if (types.length <= 1) return DESCRIPTION
  const lines = types.map(
    t =>
      `- ${t.id} (${t.name})${t.tools === 'read' ? ' [read-only]' : ''}: ${t.description || 'General-purpose subagent.'}`,
  )
  return `${DESCRIPTION}

Subagent types — pass the best match as \`type\` (default: ${GENERAL_TYPE}):
${lines.join('\n')}`
}

export type SubagentState = 'running' | 'completed' | 'failed' | 'stopped'

/** 进度和结果（tool_execution_update / end 的 details，适配器据此生成智能体追踪） */
export interface SubagentProgress {
  /** 子智能体 id：子进程的会话 id（没有会话文件时用工具调用 id） */
  agentId: string
  label: string
  prompt: string
  state: SubagentState
  model: string
  startedAt: number
  durationMs: number
  tokens: number
  toolCalls: number
  lastTool: string | null
  /** 子进程的会话文件（读子智能体的对话用） */
  sessionFile: string | null
  /** 最后一条回复（结束时是结果） */
  result: string
  /** 类型的标识和名字（设置 › 子智能体） */
  type?: string
  typeName?: string
  /** 在排队等空位（同时运行上限） */
  queued?: boolean
}

type Json = Record<string, unknown>
const object = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 助手消息里的文字 */
export function messageText(message: unknown): string {
  const content = object(message).content
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? content : [])
    .map(b => (object(b).type === 'text' ? text(object(b).text) : ''))
    .join('')
}

/** 用量里的 token 总数（输入 + 输出 + 缓存） */
export function usageTokens(usage: unknown): number {
  const u = object(usage)
  return ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((n, k) => n + (Number(u[k]) || 0), 0)
}

/** 子进程的启动参数 */
export function childArgs(options: {
  entry: string
  mode: string
  sessionDir: string | null
  /** 只读：只给 READ_ONLY_TOOLS，不给 MCP 工具 */
  readOnly?: boolean
  /** 类型的额外说明，追加在系统提示后面 */
  instructions?: string
}): string[] {
  return [
    options.entry,
    '--mode',
    'rpc',
    '--permission-mode',
    options.mode,
    ...(options.readOnly
      ? ['--tools', READ_ONLY_TOOLS.join(','), '--exclude-tools', 'mcp__*']
      : ['--tools', '+grep,+find,+ls']),
    // 前面加一行标题：Pi 把能找到的路径当文件读，带换行的文字不会被当成路径
    ...(options.instructions?.trim()
      ? [
          '--append-system-prompt',
          `Additional instructions for this subagent:
${options.instructions.trim()}`,
        ]
      : []),
    ...(options.sessionDir ? ['--session-dir', options.sessionDir] : ['--no-session']),
  ]
}

const DESCRIPTION = `Launch a subagent to handle a self-contained task on its own, then get its final report back.

Use it to keep your own context small: broad searches across many files, investigating one question in depth, or an independent piece of work that can be described completely up front. The subagent starts with no memory of this conversation, so the prompt must contain everything it needs (goal, relevant paths, constraints, what to report). It has the same tools and permissions as you (its risky actions are approved by the user the same way), but cannot launch further subagents. Several task calls in one message run in parallel.

Do not use it for trivial lookups you can do with one read or grep.`

/** 一个 RPC 子进程：按 \n 切行（不能用 readline，见 docs/own-cli.md §6） */
class RpcChild {
  private buf = ''
  private seq = 0
  private readonly waiting = new Map<string, { resolve(m: Json): void; reject(e: Error): void }>()
  stderr = ''
  exited: Error | null = null
  private exitWaiters: Array<() => void> = []
  readonly proc: ChildProcess
  private readonly onEvent: (m: Json) => void

  constructor(proc: ChildProcess, onEvent: (m: Json) => void) {
    this.proc = proc
    this.onEvent = onEvent
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => {
      this.buf += chunk
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        let m: Json
        try {
          m = object(JSON.parse(line))
        } catch {
          continue
        }
        const id = text(m.id)
        if (m.type === 'response' && this.waiting.has(id)) {
          const w = this.waiting.get(id)!
          this.waiting.delete(id)
          if (m.success === false) w.reject(new Error(text(m.error) || `${text(m.command)} failed`))
          else w.resolve(object(m.data))
        } else this.onEvent(m)
      }
    })
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    const exit = (error: Error) => {
      if (this.exited) return
      this.exited = error
      for (const w of this.waiting.values()) w.reject(error)
      this.waiting.clear()
      for (const w of this.exitWaiters) w()
      this.exitWaiters = []
    }
    proc.on('error', error => exit(error))
    proc.on('exit', code =>
      exit(new Error(`Subagent exited (code ${code})${this.stderr ? ': ' + this.stderr.trim() : ''}`)),
    )
    proc.stdin!.on('error', () => {})
  }

  send(message: Json): void {
    if (!this.exited) this.proc.stdin!.write(JSON.stringify(message) + '\n')
  }

  request(type: string, extra: Json = {}): Promise<Json> {
    if (this.exited) return Promise.reject(this.exited)
    const id = `s${++this.seq}`
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.send({ type, id, ...extra })
    })
  }

  untilExit(): Promise<void> {
    return this.exited ? Promise.resolve() : new Promise(r => this.exitWaiters.push(r))
  }

  async close(): Promise<void> {
    if (this.exited) return
    this.proc.stdin!.end()
    const timer = setTimeout(() => this.proc.kill(), 3000)
    await this.untilExit()
    clearTimeout(timer)
  }
}

export interface SubagentOptions {
  /** 当前权限模式（批准扩展的 currentMode） */
  mode: () => string
  /** 主会话「不再询问」的规则（批准扩展的 allowed / remember）：子智能体的询问也按它答，在子智能体那边选的也记进主会话 */
  rules?: { allowed(key: string): boolean; remember(key: string): void }
  /** 主会话权限模式变了时通知（批准扩展的 onModeChange），返回取消订阅：新模式同步给正在跑的子进程 */
  onModeChange?: (listener: (mode: string) => void) => () => void
  /** 测试用：替换起子进程 */
  spawnChild?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcess
  /** 测试用：替换 process.env（读子智能体的类型、同时运行上限） */
  env?: NodeJS.ProcessEnv
}

/** 子进程里开始了、还没结束的工具调用（按开始顺序） */
interface ChildCall {
  name: string
  args: unknown
  /** 已经对上过一次审批（一个调用最多问一次） */
  asked: boolean
}

/** 子进程的批准询问对应哪次调用：同名、摘要一样、没对上过的最早一个；摘要都对不上时退回同名最早的 */
export function matchChildCall(calls: ReadonlyMap<string, ChildCall>, title: string): [string, ChildCall] | null {
  const tool = approvalTool(title)
  if (!tool) return null
  const summary = title.split('\n').slice(1).join('\n')
  const open = [...calls].filter(([, c]) => c.name === tool && !c.asked)
  return open.find(([, c]) => describeToolCall(c.name, c.args) === summary) ?? open[0] ?? null
}

interface ForwardState {
  calls: Map<string, ChildCall>
  /** 主会话里 task 调用的 id、子智能体的 id 和名字 */
  context: () => Omit<SubagentApproval, 'tool' | 'args'>
  rules?: SubagentOptions['rules']
  /** 主会话当前的权限模式 */
  mode: () => string
}

/** 按主会话当前的模式，子进程要批准的这个工具该放行 / 拒绝 / 问用户 */
function parentDecision(mode: string, tool: string): 'allow' | 'block' | 'ask' {
  if (!isPermissionMode(mode)) return 'ask'
  return decidePermission({ mode, toolName: tool, hasUI: true }).action
}

/** 把子进程的对话框转给主进程的界面 */
async function forwardUi(child: RpcChild, raw: Json, ctx: ExtensionContext, state: ForwardState): Promise<void> {
  const id = text(raw.id),
    method = text(raw.method),
    title = text(raw.title)
  const options = { ...(typeof raw.timeout === 'number' ? { timeout: raw.timeout } : {}) }
  try {
    if (method === 'select') {
      const choices = (Array.isArray(raw.options) ? raw.options : []).map(text)
      const isApproval =
        choices.length === APPROVAL_OPTIONS.length && choices.every((o, i) => o === APPROVAL_OPTIONS[i])
      const approval = isApproval ? matchChildCall(state.calls, title) : null
      const key = approval ? ruleKey(approval[1].name, approval[1].args) : null
      if (approval) approval[1].asked = true
      const tool = approval?.[1].name ?? approvalTool(title)
      // 先按主会话现在的模式判：子进程还带着起来时的模式（同步还没到），主会话已是计划模式就拒绝，不弹、不按规则放行
      const decision = isApproval && tool ? parentDecision(state.mode(), tool) : 'ask'
      if (decision !== 'ask') {
        child.send({ type: 'extension_ui_response', id, value: decision === 'allow' ? ALLOW_OPTION : DENY_OPTION })
        return
      }
      // 主会话已经「不再询问」的：直接允许，不再弹
      if (key && state.rules?.allowed(key)) {
        child.send({ type: 'extension_ui_response', id, value: ALLOW_OPTION })
        return
      }
      // 告诉桌面端这是哪次调用；setStatus 和下面的 select 是紧挨着的两行输出，中间不会插进别的请求
      if (approval && ctx.mode === 'rpc') {
        const payload: SubagentApproval = { ...state.context(), tool: approval[1].name, args: approval[1].args }
        ctx.ui.setStatus(APPROVAL_CONTEXT_STATUS, JSON.stringify(payload))
      }
      const value = await ctx.ui.select(title, choices, options)
      // 弹框期间主会话切到了计划模式：用户点了允许也不放行
      if (isApproval && tool && parentDecision(state.mode(), tool) === 'block') {
        child.send({ type: 'extension_ui_response', id, value: DENY_OPTION })
        return
      }
      if (key && value === ALWAYS_OPTION) state.rules?.remember(key)
      child.send({ type: 'extension_ui_response', id, ...(value === undefined ? { cancelled: true } : { value }) })
    } else if (method === 'confirm') {
      const confirmed = await ctx.ui.confirm(title, text(raw.message), options)
      child.send({ type: 'extension_ui_response', id, confirmed })
    } else if (method === 'input' || method === 'editor') {
      const value = await ctx.ui.input(title, text(raw.placeholder), options)
      child.send({ type: 'extension_ui_response', id, ...(value === undefined ? { cancelled: true } : { value }) })
    } else if (method === 'notify') {
      const level = raw.notifyType === 'error' ? 'error' : raw.notifyType === 'warning' ? 'warning' : 'info'
      if (text(raw.message)) ctx.ui.notify(text(raw.message), level)
    }
  } catch {
    if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor')
      child.send({ type: 'extension_ui_response', id, cancelled: true })
  }
}

export function createSubagentExtension(options: SubagentOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const env = options.env ?? process.env
    const types = subagentTypes(env)
    const fallback = env[SUBAGENT_FALLBACK_ENV] !== '0'
    // 同时运行上限：一个会话（这个进程）里所有 task 调用共用，多出来的排队
    const limit = subagentMaxConcurrent(env)
    let running = 0
    const queue: Array<() => void> = []
    const acquire = (signal: AbortSignal | undefined): Promise<boolean> =>
      new Promise(resolve => {
        if (signal?.aborted) return resolve(false)
        if (running < limit) {
          running++
          return resolve(true)
        }
        const go = () => {
          running++
          resolve(true)
        }
        queue.push(go)
        signal?.addEventListener(
          'abort',
          () => {
            const i = queue.indexOf(go)
            if (i < 0) return
            queue.splice(i, 1)
            resolve(false)
          },
          { once: true },
        )
      })
    const release = () => {
      running--
      queue.shift()?.()
    }
    pi.registerTool({
      name: SUBAGENT_TOOL,
      label: 'Subagent',
      description: taskDescription(types),
      promptSnippet: `Delegate a self-contained task to a subagent (${SUBAGENT_TOOL})`,
      parameters: Type.Object({
        description: Type.String({ minLength: 1, description: 'A short (3-6 word) label for the task' }),
        prompt: Type.String({
          minLength: 1,
          description: 'The complete task for the subagent, with all needed context',
        }),
        ...(types.length > 1
          ? {
              type: Type.Optional(
                Type.String({
                  description: `Subagent type: ${types.map(t => t.id).join(', ')} (default ${GENERAL_TYPE})`,
                }),
              ),
            }
          : {}),
      }),
      async execute(
        toolCallId: string,
        params: { description: string; prompt: string; type?: string },
        signal: AbortSignal | undefined,
        onUpdate:
          | ((partial: { content: Array<{ type: 'text'; text: string }>; details: SubagentProgress }) => void)
          | undefined,
        ctx: ExtensionContext,
      ) {
        const type = types.find(t => t.id === (params.type?.trim() || GENERAL_TYPE))
        if (!type)
          throw new Error(`Unknown subagent type "${params.type}". Available types: ${types.map(t => t.id).join(', ')}`)
        const routed = type.route
        const parent = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null
        const parentFile = ctx.sessionManager.getSessionFile()
        const sessionDir = parentFile ? join(dirname(parentFile), 'subagents') : null
        const progress: SubagentProgress = {
          agentId: toolCallId,
          label: params.description,
          prompt: params.prompt,
          state: 'running',
          type: type.id,
          typeName: type.name,
          model: routed ? routedModelLabel(routed) : parent ? `${parent.provider}/${parent.id}` : '',
          startedAt: Date.now(),
          durationMs: 0,
          tokens: 0,
          toolCalls: 0,
          lastTool: null,
          sessionFile: null,
          result: '',
        }
        const report = () => {
          progress.durationMs = Date.now() - progress.startedAt
          const line = progress.lastTool
            ? `${progress.label}: ${progress.toolCalls} tool calls, last ${progress.lastTool}`
            : progress.queued
              ? `${progress.label}: waiting for a free subagent slot…`
              : `${progress.label}: working…`
          onUpdate?.({ content: [{ type: 'text', text: line }], details: { ...progress } })
        }
        // 起一个子进程跑完这个任务；model 为 null 时用子进程自己的默认模型
        const attempt = async (model: { provider: string; id: string } | null): Promise<void> => {
          const args = childArgs({
            entry: process.argv[1] ?? '',
            mode: options.mode(),
            sessionDir,
            readOnly: type.tools === 'read',
            instructions: type.instructions,
          })
          const childEnv = { ...env, ...mcpChildEnv(), [SUBAGENT_ENV]: '1', [SUBAGENT_TYPE_ENV]: type.id }
          const proc = options.spawnChild
            ? options.spawnChild(args, childEnv, ctx.cwd)
            : spawn(process.execPath, [...process.execArgv, ...args], {
                cwd: ctx.cwd,
                env: childEnv,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
              })
          let settled: () => void = () => {}
          const done = new Promise<void>(r => (settled = r))
          let streaming = ''
          // 最后一条助手消息的错误（认证失败等）：Pi 报在 stopReason / errorMessage 上、照样 settled；
          // 自动重试、压缩后接着跑成功时后面的消息会清掉它
          let failure = ''
          const calls = new Map<string, ChildCall>()
          const forward: ForwardState = {
            calls,
            context: () => ({ toolCallId, agentId: progress.agentId, label: progress.label }),
            rules: options.rules,
            mode: options.mode,
          }
          const child = new RpcChild(proc, m => {
            const type = text(m.type)
            if (type === 'extension_ui_request') void forwardUi(child, m, ctx, forward)
            else if (type === 'tool_execution_start') {
              calls.set(text(m.toolCallId), { name: text(m.toolName), args: m.args, asked: false })
              progress.toolCalls++
              progress.lastTool = text(m.toolName) || null
              report()
            } else if (type === 'tool_execution_end') calls.delete(text(m.toolCallId))
            else if (type === 'message_update') {
              const e = object(m.assistantMessageEvent)
              if (e.type === 'text_delta') streaming += text(e.delta)
            } else if (type === 'message_end' && object(m.message).role === 'assistant') {
              const message = object(m.message)
              progress.tokens += usageTokens(message.usage)
              const reply = messageText(message) || streaming
              streaming = ''
              if (reply.trim()) progress.result = reply.trim()
              failure = message.stopReason === 'error' ? text(message.errorMessage) || 'Model request failed' : ''
              report()
            } else if (type === 'agent_settled') settled()
          })
          // 主会话换模式：扩展命令在子进程里立即执行（正在跑也一样），不进模型。上面读模式到这里之间没有 await，不会漏掉
          const unsubscribe =
            options.onModeChange?.(next => {
              void child.request('prompt', { message: `/${MODE_COMMAND} ${next}` }).catch(() => {})
            }) ?? (() => {})
          const abort = () => {
            progress.state = 'stopped'
            void child.request('abort').catch(() => {})
            settled()
          }
          signal?.addEventListener('abort', abort, { once: true })
          // 起进程前主会话就停了（监听加上之前），addEventListener 不会再触发
          if (signal?.aborted) abort()
          const timer = setTimeout(abort, type.maxMs)
          // 启动的每一步都要等子进程回应，期间可能被停止：停了就不再往下发，尤其不能再发 prompt 去调模型
          const live = () => progress.state === 'running'
          try {
            const state = await child.request('get_state')
            progress.sessionFile = text(state.sessionFile) || null
            progress.agentId = text(state.sessionId) || toolCallId
            if (live() && model) await child.request('set_model', { provider: model.provider, modelId: model.id })
            if (live()) await child.request('set_thinking_level', { level: pi.getThinkingLevel() }).catch(() => {})
            report()
            if (live()) {
              await child.request('prompt', { message: params.prompt })
              await Promise.race([done, child.untilExit()])
            }
            if (child.exited && progress.state === 'running') throw child.exited
            if (failure && progress.state === 'running') throw new Error(failure)
            if (progress.state === 'running') progress.state = 'completed'
          } catch (error) {
            if (progress.state === 'running') {
              progress.state = 'failed'
              // 原因放前面（主模型和追踪里都看得到），已经写出来的回复跟在后面
              const reason = (error as Error).message
              progress.result = progress.result
                ? `${reason}

Partial report:
${progress.result}`
                : reason
            }
          } finally {
            unsubscribe()
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            await child.close()
          }
        }
        // 等空位：排队时报一次，等的时候主会话停了就不起子进程
        progress.queued = running >= limit
        if (progress.queued) report()
        if (!(await acquire(signal))) {
          progress.state = 'stopped'
          progress.queued = false
          progress.durationMs = Date.now() - progress.startedAt
          pi.appendEntry(SUBAGENT_ENTRY, { ...progress, toolCallId })
          return {
            content: [{ type: 'text' as const, text: 'Subagent was stopped before it started.' }],
            details: { ...progress },
          }
        }
        progress.queued = false
        progress.startedAt = Date.now()
        try {
          await attempt(routed ? { provider: SUBAGENT_PROVIDER, id: text(routed.model.id) } : parent)
          // 单独的站点出错、子智能体还没动手（没有工具调用）：改走主会话的模型重来一次，结果里写明
          if (routed && fallback && parent && progress.state === 'failed' && progress.toolCalls === 0) {
            const reason = progress.result
            Object.assign(progress, {
              state: 'running',
              model: `${parent.provider}/${parent.id}`,
              result: '',
              lastTool: null,
            })
            report()
            await attempt(parent)
            const note = `The subagent site "${routed.label}" failed (${reason}); retried on the main session's model.`
            progress.result = progress.result ? `${note}\n\n${progress.result}` : note
          }
        } finally {
          release()
          progress.durationMs = Date.now() - progress.startedAt
          pi.appendEntry(SUBAGENT_ENTRY, { ...progress, toolCallId })
        }
        if (progress.state === 'failed') throw new Error(`Subagent failed: ${progress.result}`)
        const body =
          progress.state === 'stopped'
            ? `Subagent was stopped.${progress.result ? '\n\nPartial report:\n' + progress.result : ''}`
            : progress.result || 'The subagent finished without a final report.'
        return { content: [{ type: 'text' as const, text: body }], details: { ...progress } }
      },
    } as never)
  }
}

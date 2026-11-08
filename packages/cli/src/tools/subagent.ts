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
/** 主模型调度（docs/ui/subagent-model-dispatch.md）：只能向本机网关查候选模型的密钥 */
export const SUBAGENT_OPTIONS_TOKEN_ENV = 'PIXELSKY_SUBAGENT_OPTIONS_TOKEN'
const SUBAGENT_OPTIONS_PATH = '/pixelsky/subagent-options'
/** 主模型选中的路线（JSON，SubagentRoute）：子进程的网关扩展优先用它 */
export const SUBAGENT_ROUTE_ENV = 'PIXELSKY_SUBAGENT_ROUTE'
/** 告诉主模型当前能选哪些模型的隐藏消息 */
export const SUBAGENT_MODELS_CONTEXT = 'pixelsky-subagent-models'
/** 每轮开始都要查一次，不能久等；通常是本机查缓存 */
const OPTIONS_TIMEOUT_MS = 5_000
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
  /** model 里桌面端猜的字段（如按系列定的 contextWindow），Pi 内置表里有同名模型时以内置的为准 */
  inferred?: string[]
}

export interface SubagentTypeDef {
  effort?: string | null
  id: string
  name: string
  description: string
  tools: 'all' | 'read'
  maxMs: number
  instructions: string
  route: SubagentRoute | null
  /** 主模型调度：模型派活时向网关查，主模型可以传 model */
  dispatch?: boolean
}

const TYPE_ID = /^[a-z][a-z0-9-]{0,31}$/
const thinkingEffort = (v: unknown): string | null =>
  typeof v === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(v) ? v : null
const TOKEN_ENV = /^PIXELSKY_PIXEL_SUB_TOKEN_\d{1,3}$/

function parseRoute(raw: unknown): SubagentRoute | null {
  const r = object(raw)
  const model = object(r.model)
  return text(r.api) && text(model.id) && TOKEN_ENV.test(text(r.token))
    ? {
        api: text(r.api),
        model,
        label: text(r.label) || text(model.id),
        token: text(r.token),
        ...(Array.isArray(r.inferred)
          ? { inferred: r.inferred.filter((f): f is string => typeof f === 'string') }
          : {}),
      }
    : null
}

/** 主模型给这个子进程选的路线；没选或不对时 null */
export function chosenRoute(env: NodeJS.ProcessEnv): SubagentRoute | null {
  try {
    return parseRoute(JSON.parse(env[SUBAGENT_ROUTE_ENV] ?? 'null'))
  } catch {
    return null
  }
}

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
    types.push({
      id,
      name: text(o.name) || id,
      description: text(o.description),
      tools: o.tools === 'read' ? 'read' : 'all',
      maxMs: Number.isFinite(ms) && ms >= 60_000 && ms <= 24 * 3600_000 ? ms : MAX_MS,
      instructions: text(o.instructions),
      route: parseRoute(o.route),
      effort: thinkingEffort(o.effort),
      ...(o.dispatch === true ? { dispatch: true } : {}),
    })
  }
  if (!types.some(t => t.id === GENERAL_TYPE)) types.unshift(general)
  return types
}

/** 网关回的候选（桌面端 main/platform/subagent-options.ts） */
export interface DispatchReply {
  override?: { model?: string | null; effort?: string | null; route?: SubagentRoute; secret?: string }
  currentModel: string
  options: Array<{ model: string; note: string; outside: boolean }>
  defaultModel: string | null
  pick?:
    | { outcome: 'self' }
    | { outcome: 'rejected' }
    | { outcome: 'route'; route: SubagentRoute; secret: string; source: 'chosen' | 'default'; outside: boolean }
}

/** 问本机网关现在能选哪些模型；pick 为真时顺便拿到选中模型的路线。回应不对就抛错 */
export async function querySubagentOptions(
  env: NodeJS.ProcessEnv,
  request: { type: string; mainModel?: string; model?: string; pick?: boolean; configure?: boolean },
  signal: AbortSignal | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DispatchReply> {
  const root = env[SUB_BASE_URL_ENV]?.trim().replace(/\/+$/, '')
  const token = env[SUBAGENT_OPTIONS_TOKEN_ENV]
  if (!root || !token) throw new Error('the desktop app did not provide the model list')
  const timeout = AbortSignal.timeout(OPTIONS_TIMEOUT_MS)
  const res = await fetcher(`${root}${SUBAGENT_OPTIONS_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const o = object(await res.json())
  const options = (Array.isArray(o.options) ? o.options : []).map(object).map(x => ({
    model: text(x.model),
    note: text(x.note),
    outside: x.outside === true,
  }))
  const p = object(o.pick)
  const config = object(o.override)
  const configRoute = parseRoute(config.route)
  const route = parseRoute(p.route)
  const pick: DispatchReply['pick'] =
    p.outcome === 'route' && route && text(p.secret)
      ? {
          outcome: 'route',
          route,
          secret: text(p.secret),
          source: p.source === 'chosen' ? 'chosen' : 'default',
          outside: p.outside === true,
        }
      : p.outcome === 'self'
        ? { outcome: 'self' }
        : p.outcome === 'rejected' || p.outcome === 'route'
          ? { outcome: 'rejected' }
          : undefined
  return {
    currentModel: text(o.currentModel),
    options: options.filter(x => x.model),
    defaultModel: text(o.defaultModel) || null,
    ...(o.override && typeof o.override === 'object'
      ? {
          override: {
            ...('model' in config ? { model: text(config.model) || null } : {}),
            ...('effort' in config ? { effort: thinkingEffort(config.effort) } : {}),
            ...(configRoute && text(config.secret) ? { route: configRoute, secret: text(config.secret) } : {}),
          },
        }
      : {}),
    ...(pick ? { pick } : {}),
  }
}

/** 选了不允许的模型时的报错：带上现在能选的，主模型能自己改对 */
export function rejectedModelMessage(typeId: string, model: string, reply: DispatchReply): string {
  const allowed = reply.options.map(o => o.model).join(', ')
  const fallback = reply.defaultModel ?? reply.currentModel
  return `Model "${model}" is not allowed for subagent type "${typeId}" right now. ${
    allowed ? `Allowed: ${allowed}.` : 'No other model can be chosen.'
  } Omit \`model\` to use ${fallback || 'the default'}.`
}

/** 隐藏消息的内容：有候选的类型和它们的模型；都没有时空字符串 */
export function subagentModelsNote(replies: ReadonlyArray<{ type: string; reply: DispatchReply }>): string {
  const lines: string[] = []
  for (const { type, reply } of replies) {
    if (!reply.options.length) continue
    lines.push(`- ${type}: default ${reply.defaultModel ?? `${reply.currentModel} (your current model)`}`)
    for (const o of reply.options) lines.push(`  - ${o.model}${o.note ? `: ${o.note}` : ''}`)
  }
  if (!lines.length) return ''
  const main = replies[0]?.reply.currentModel
  return `Models you can pick for subagents${main ? ` while your model is ${main}` : ''}. This replaces any earlier list. Pass one as \`model\` in the ${SUBAGENT_TOOL} tool when the task suits it; omit \`model\` for the default.
${lines.join('\n')}`
}

/** 之前告诉过主模型有的选，现在没有了 */
const NO_SUBAGENT_MODELS = `There are no models to pick for subagents right now; this replaces any earlier list. Omit \`model\` in the ${SUBAGENT_TOOL} tool.`

/**
 * 子进程里注册的 provider：这个类型单独的站点（地址按协议补 /v1，和桌面端 pixelBaseUrl 一样）。
 * 站点没写明的推理开关、图片按协议猜（Chat 兼容接口多数不收图），网关扩展在 Pi 内置表里找到同名模型时以内置的为准
 */
export function subagentProviderConfig(type: SubagentTypeDef, env: NodeJS.ProcessEnv): Json | null {
  const root = env[SUB_BASE_URL_ENV]?.trim().replace(/\/+$/, '')
  if (!type.route || !root) return null
  const chat = type.route.api === 'openai-completions'
  return {
    baseUrl: type.route.api === 'anthropic-messages' ? root : `${root}/v1`,
    api: type.route.api,
    apiKey: `$${type.route.token}`,
    models: [{ reasoning: !chat, input: chat ? ['text'] : ['text', 'image'], ...type.route.model }],
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
  /** 子进程实际使用的强度；旧版或尚未启动时没有。 */
  effort?: string | null
  /** 子智能体 id：子进程的会话 id（没有会话文件时用工具调用 id） */
  agentId: string
  label: string
  prompt: string
  state: SubagentState
  model: string
  startedAt: number
  durationMs: number
  tokens: number
  /** 按模型分的用量（桌面端把它算进主会话这一轮的用量和花费；老版本没有） */
  usage?: Record<string, SubagentModelUsage>
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
  /** 主模型调度：chosen 主模型自己选的；default 用规则标的默认。出错改走主会话时清掉 */
  modelSource?: 'chosen' | 'default'
  /** 走的是主模型分组以外的模型 */
  outsideGroup?: boolean
}

/** 子智能体在一个模型上的累计用量（字段和 Pi 助手消息的 usage 一样，cost 是美元） */
export interface SubagentModelUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  requests: number
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

/**
 * 一条助手消息的用量加进按模型的累计；返回新对象（进度是浅拷贝发出去的，不能原地改）。
 * 模型名和桌面端主会话用的一样：responseModel，没有就 model
 */
export function addModelUsage(
  usage: Record<string, SubagentModelUsage> | undefined,
  message: unknown,
): Record<string, SubagentModelUsage> | undefined {
  const m = object(message)
  const u = object(m.usage)
  const n = (k: string): number => Number(u[k]) || 0
  const cost = Number(object(u.cost).total) || 0
  if (!n('input') && !n('output') && !n('cacheRead') && !n('cacheWrite') && !cost) return usage
  const model = text(m.responseModel) || text(m.model) || 'Pixel'
  const prior = usage?.[model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 }
  return {
    ...usage,
    [model]: {
      input: prior.input + n('input'),
      output: prior.output + n('output'),
      cacheRead: prior.cacheRead + n('cacheRead'),
      cacheWrite: prior.cacheWrite + n('cacheWrite'),
      cost: prior.cost + cost,
      requests: prior.requests + 1,
    },
  }
}

/** 子进程的启动参数 */
/** 频道流程按会话认人：子代理调了就算主代理这一步交付或提问，所以只留给主代理 */
const PARENT_ONLY_TOOLS = ['task_done', 'member_ask', 'user_ask'].map(name => `mcp__pixelsky_channel__${name}`)

export function childArgs(options: {
  entry: string
  mode: string
  sessionDir: string | null
  /**
   * 只读：只给 READ_ONLY_TOOLS，关掉 MCP（--no-mcp：不连服务器）。只挡 MCP 工具的话服务器照样启动，
   * Pi 还会因为 codemode / tool_search 不在白名单里提示「MCP tools are only reachable from…」
   */
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
      ? ['--tools', READ_ONLY_TOOLS.join(','), '--no-mcp']
      : ['--tools', '+grep,+find,+ls', '--exclude-tools', PARENT_ONLY_TOOLS.join(',')]),
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
  /** 测试用：替换向本机网关查候选的 fetch */
  fetch?: typeof fetch
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
  /** 子智能体结束（完成、停止、超时）时触发：转发到主界面、还没答的对话框跟着撤掉 */
  signal: AbortSignal
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
  const options = { ...(typeof raw.timeout === 'number' ? { timeout: raw.timeout } : {}), signal: state.signal }
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
    const dispatchTypes = types.filter(t => t.dispatch)
    if (dispatchTypes.length) {
      // 工具说明进程启动时就定了，换模型后会过时，所以每轮查一次，变了才告诉主模型。
      // 旧消息不从上下文删（删了提示词缓存就废了），新的写明以它为准；压缩会把消息压掉，新会话、恢复会话、
      // 终端里用 /tree 切到别的分支也可能没有，都重发一次
      let told: string | null = null
      const forget = () => {
        told = null
      }
      pi.on('session_start', forget)
      pi.on('session_compact', forget)
      pi.on('session_tree', forget)
      pi.on('before_agent_start', async (event, ctx) => {
        if (event.messageType !== 'user') return undefined
        let note: string
        try {
          const replies = await Promise.all(
            dispatchTypes.map(async t => ({
              type: t.id,
              reply: await querySubagentOptions(
                env,
                { type: t.id, ...(ctx.model ? { mainModel: ctx.model.id } : {}) },
                undefined,
                options.fetch,
              ),
            })),
          )
          note = subagentModelsNote(replies)
        } catch {
          // 查不到就先不说，派活时还会再查一次，选错了工具报错时带着当前的列表
          return undefined
        }
        if (note === told || (!note && told === null)) return undefined
        told = note
        return { message: { customType: SUBAGENT_MODELS_CONTEXT, content: note || NO_SUBAGENT_MODELS, display: false } }
      })
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
        ...(dispatchTypes.length
          ? {
              model: Type.Optional(
                Type.String({
                  description: `Model for the subagent, from the latest "Models you can pick for subagents" message (types: ${dispatchTypes.map(t => t.id).join(', ')}). Omit to use the default.`,
                }),
              ),
            }
          : {}),
      }),
      async execute(
        toolCallId: string,
        params: { description: string; prompt: string; type?: string; model?: string },
        signal: AbortSignal | undefined,
        onUpdate:
          | ((partial: { content: Array<{ type: 'text'; text: string }>; details: SubagentProgress }) => void)
          | undefined,
        ctx: ExtensionContext,
      ) {
        const type = types.find(t => t.id === (params.type?.trim() || GENERAL_TYPE))
        if (!type)
          throw new Error(`Unknown subagent type "${params.type}". Available types: ${types.map(t => t.id).join(', ')}`)
        const parent = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null
        let selectedModel = parent
        let effort = type.effort ?? pi.getThinkingLevel()
        const requested = params.model?.trim()
        if (requested && !type.dispatch)
          throw new Error(`Subagent type "${type.id}" has a fixed model. Do not pass \`model\` for it.`)
        let routed = type.route
        /** 主模型调度选中的路线的密钥（固定站点的类型在启动环境里就有） */
        let routeSecret: string | null = null
        let chosen: { modelSource: 'chosen' | 'default'; outsideGroup?: boolean } | null = null
        const liveOptions = env.PIXELSKY_SUBAGENT_LIVE_OPTIONS === '1'
        if (type.dispatch || liveOptions) {
          let reply: DispatchReply | null = null
          try {
            reply = await querySubagentOptions(
              env,
              {
                type: type.id,
                pick: true,
                ...(liveOptions ? { configure: true } : {}),
                ...(requested ? { model: requested } : {}),
                ...(parent ? { mainModel: parent.id } : {}),
              },
              signal,
              options.fetch,
            )
          } catch (error) {
            if (liveOptions && !signal?.aborted)
              throw new Error(
                `Could not read the session's subagent settings: ${(error as Error).message}. Retry this task.`,
              )
            // 没指定模型时查不到就用主模型自己；指定了不能悄悄换。主会话停了：下面等空位时按停止收尾
            if (requested && !signal?.aborted)
              throw new Error(
                `Could not check whether model "${requested}" is allowed: ${(error as Error).message}. Retry, or omit \`model\` to use your current model.`,
              )
          }
          if (reply?.pick?.outcome === 'rejected')
            throw new Error(rejectedModelMessage(type.id, requested ?? reply.defaultModel ?? '', reply))
          if (reply?.pick?.outcome === 'route') {
            routed = reply.pick.route
            routeSecret = reply.pick.secret
            chosen = {
              modelSource: reply.pick.source,
              ...(reply.pick.outside ? { outsideGroup: true } : {}),
            }
          }
          const override = reply?.override
          if (override && 'effort' in override) effort = override.effort ?? pi.getThinkingLevel()
          if (override && 'model' in override) {
            routed = override.route ?? null
            routeSecret = override.secret ?? null
            chosen = null
            if (override.model && !routed) {
              const slash = override.model.indexOf('/')
              selectedModel =
                slash > 0
                  ? { provider: override.model.slice(0, slash), id: override.model.slice(slash + 1) }
                  : parent
                    ? { ...parent, id: override.model }
                    : null
            }
          }
        }
        const parentFile = ctx.sessionManager.getSessionFile()
        const sessionDir = parentFile ? join(dirname(parentFile), 'subagents') : null
        const progress: SubagentProgress = {
          agentId: toolCallId,
          label: params.description,
          prompt: params.prompt,
          state: 'running',
          type: type.id,
          typeName: type.name,
          model: routed
            ? routedModelLabel(routed)
            : selectedModel
              ? `${selectedModel.provider}/${selectedModel.id}`
              : '',
          startedAt: Date.now(),
          durationMs: 0,
          tokens: 0,
          toolCalls: 0,
          lastTool: null,
          sessionFile: null,
          result: '',
          ...chosen,
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
          const readOnly = type.tools === 'read'
          const args = childArgs({
            entry: process.argv[1] ?? '',
            mode: options.mode(),
            sessionDir,
            readOnly,
            instructions: type.instructions,
          })
          // 只读的关了 MCP，不给桌面端的服务器文件：不然 mcp.ts 照样注册，Pi 报「no loaded extension connects MCP servers」
          const childEnv = {
            ...env,
            ...(readOnly ? {} : mcpChildEnv()),
            [SUBAGENT_ENV]: '1',
            [SUBAGENT_TYPE_ENV]: type.id,
            ...(routed && routeSecret
              ? { [SUBAGENT_ROUTE_ENV]: JSON.stringify(routed), [routed.token]: routeSecret }
              : {}),
          }
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
          const dialogs = new AbortController()
          const forward: ForwardState = {
            calls,
            context: () => ({ toolCallId, agentId: progress.agentId, label: progress.label }),
            rules: options.rules,
            mode: options.mode,
            signal: dialogs.signal,
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
              progress.usage = addModelUsage(progress.usage, message)
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
            if (live()) await child.request('set_thinking_level', { level: effort }).catch(() => {})
            if (live()) {
              const actual = await child.request('get_state')
              progress.effort = thinkingEffort(actual.thinkingLevel)
            }
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
            // 子智能体结束了：还挂在主界面上的审批 / 提问撤掉（按取消回给子进程）
            dialogs.abort()
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
          await attempt(routed ? { provider: SUBAGENT_PROVIDER, id: text(routed.model.id) } : selectedModel)
          // 单独的站点出错、子智能体还没动手（没有工具调用）：改走主会话的模型重来一次，结果里写明
          if (routed && fallback && parent && progress.state === 'failed' && progress.toolCalls === 0) {
            const reason = progress.result
            Object.assign(progress, {
              state: 'running',
              model: `${parent.provider}/${parent.id}`,
              result: '',
              lastTool: null,
              modelSource: undefined,
              outsideGroup: undefined,
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

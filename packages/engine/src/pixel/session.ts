// 像素星空会话：一个会话一个 `pixelsky --mode rpc` 子进程（docs/own-cli.md §4.1）
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import type {
  ApprovalDecision,
  ApprovalRequest,
  Effort,
  ImageAttachment,
  Item,
  McpOp,
  McpOpResult,
  PermissionMode,
  SessionFlags,
  SessionSettings,
  SkillCommand,
  TurnOutcome,
} from '@pixelsky/protocol'
import { EMPTY_FLAGS, looksVisual, viaGateway, type ContextWindows, type SessionRecord } from '@pixelsky/protocol'
import { QUICK_CLOSE_MS, type CloseOptions, type EngineSession, type Launcher, type SessionContext } from '../adapter'
import type { ChatSeed } from '../chat-log'
import { McpReporter, pixelMcpServers } from '../mcp'
import { crashReason } from '../exec'
import { effortOfLevel, effortsFromLevels, findModel, modelEfforts, piThinkingLevel } from './catalog'
import { pixelWindow } from './context-window'
import {
  APPROVAL_CONTEXT_STATUS,
  SUBAGENT_ENTRY,
  entries,
  runsFromSession,
  subagentTotals,
  subagentApproval,
  subagentItemId,
  type SubagentApproval,
} from './agents'
import { PixelProcess, array, object, string, type Message, type PixelResponse } from './process'
import {
  APPROVAL_OPTIONS,
  EXIT_PLAN_TOOL,
  PLAN_OPTIONS,
  PixelTranslator,
  approvalFor,
  isApprovalSelect,
  isPlanSelect,
  planApproval,
  textError,
  toolItem,
  toolNameFromTitle,
} from './translate'

/** 批准扩展里运行中切换权限模式的命令（packages/cli/src/extensions/approval.ts 的 MODE_COMMAND） */
const MODE_COMMAND = 'pixelsky-mode'
/** 批准扩展报当前权限模式的状态键（approval.ts 的 MODE_STATUS），例如计划确认后它自己退出了计划模式 */
const MODE_STATUS = 'pixelsky-mode'
/** 连接器（docs/ui/connectors.md）：命令行 MCP 扩展的命令、报状态和操作结果的状态键（packages/cli/src/extensions/mcp.ts） */
const MCP_COMMAND = 'pixelsky-mcp'
const MCP_STATUS = 'pixelsky-mcp'
const MCP_RESULT_STATUS = 'pixelsky-mcp-result'
const MCP_OP_TIMEOUT_MS = 95_000
/** 命令末尾带上的请求号，命令行原样放回结果里（packages/cli/src/extensions/mcp.ts） */
const MCP_REQ_FLAG = '--req='
/** 适配器自己用的扩展命令，不进斜杠菜单（用户自己装的扩展命令照常列出） */
const INTERNAL_COMMANDS = new Set([MODE_COMMAND, MCP_COMMAND])
/**
 * 发出提示后等 Pi 开始处理（prompt 的回应）最多等多久没动静。Pi 回应前要做发送前的准备，可能先压缩一次上下文
 * （整段对话做一次总结请求）：压缩中、等审批时不算没动静，收到别的事件也重新计时
 */
export const PROMPT_START_MS = 60_000

interface McpWaiter {
  req: string
  op: string
  name: string
  resolve: (result: { error: string; url?: string }) => void
}

/**
 * 结果交给谁：带请求号的按请求号找；旧版命令行不带请求号，按操作 + 服务器名找最早的一个，都对不上才给最早发出的。
 * 请求号对不上任何等待者（已超时撤掉）就丢掉，不能顺手给别的操作
 */
export function mcpWaiterFor<W extends Omit<McpWaiter, 'resolve'>>(
  waiters: readonly W[],
  req: string,
  op: string,
  name: string,
): W | undefined {
  if (req) return waiters.find(w => w.req === req)
  return waiters.find(w => w.op === op && w.name === name) ?? waiters[0]
}

/** 我们的权限模式 → 批准扩展的 --permission-mode */
export const PIXEL_MODES: Record<PermissionMode, string> = {
  ask: 'default',
  edits: 'acceptEdits',
  plan: 'plan',
  full: 'bypassPermissions',
}

/** 平台 / 自定义 API 会话经本机网关：宿主（sessionEnv）给的环境变量，写进每个会话自己的 models.json（不含密钥） */
export const GATEWAY_ENV = {
  baseUrl: 'PIXELSKY_PIXEL_BASE_URL',
  /** 会话密钥：只放环境变量，models.json 里写 $PIXELSKY_PIXEL_TOKEN 让 Pi 自己展开 */
  token: 'PIXELSKY_PIXEL_TOKEN',
  /** anthropic-messages（默认）/ openai-responses / openai-completions */
  api: 'PIXELSKY_PIXEL_API',
  /** 可选：JSON 数组，元素是模型 id 或完整的 models.json 模型定义；不给就只有会话选的那个模型 */
  models: 'PIXELSKY_PIXEL_MODELS',
} as const
export const GATEWAY_PROVIDER = 'pixelsky'
/** 交给命令行网关扩展的 provider 配置（packages/cli/src/extensions/gateway.ts 的 PROVIDERS_ENV） */
export const PROVIDERS_ENV = 'PIXELSKY_PIXEL_PROVIDERS'
/** 模型定义里哪些字段是这里猜的（packages/cli/src/extensions/builtin-models.ts 的 INFERRED_ENV） */
export const INFERRED_ENV = 'PIXELSKY_PIXEL_INFERRED'
/** 桌面端管理的 MCP 服务器文件（packages/cli/src/extensions/mcp.ts 的 MCP_FILE_ENV） */
export const MCP_FILE_ENV = 'PIXELSKY_MCP_FILE'
/** 不用问就放行的工具（approval.ts 的 ALLOW_TOOLS_ENV），例如只读的对话历史服务器 */
export const ALLOW_TOOLS_ENV = 'PIXELSKY_ALLOW_TOOLS'

export interface PixelLaunchOptions {
  /** 用户追加的启动参数 */
  args?: string[]
  /** 设置 › 模型通道里给模型填的上下文窗口（云端线路用 platform 那份，context-window.ts） */
  contextWindows?: ContextWindows
  /** 设置 › 引擎「自动压缩阈值」（百分比）：经环境变量交给 Pi 补丁里的 shouldCompact（docs/own-cli.md §15） */
  autoCompactPct?: number | null
  /** 测试用：等 Pi 开始处理一条提示最多多久没动静（默认 PROMPT_START_MS） */
  promptStartMs?: number
}

/** 网关 / 自定义地址的模型配置交给命令行的网关扩展（PROVIDERS_ENV、INFERRED_ENV）；会话进程和旁聊共用 */
export function applyPixelModels(
  environment: NodeJS.ProcessEnv,
  record: SessionRecord,
  contextWindows: ContextWindows | undefined,
): void {
  const models = pixelModelsConfig(environment, record.model, id => pixelWindow(record, id, contextWindows))
  if (models) environment[PROVIDERS_ENV] = JSON.stringify(models.providers)
  else delete environment[PROVIDERS_ENV]
  if (models?.inferred) environment[INFERRED_ENV] = JSON.stringify(models.inferred)
  else delete environment[INFERRED_ENV]
}

/** 用户自己选工具的参数（这时不追加 SEARCH_TOOLS，以用户为准） */
const TOOL_SELECTION_ARGS = ['--tools', '-t', '--no-tools', '-nt', '--no-builtin-tools', '-nbt']

/**
 * Pi 默认只开 read / bash / edit / write；桌面端再开 grep / find / ls（只读、批准扩展直接放行，
 * 对话里显示成搜索 / 读取卡片，用的是随包 bin/ 里的 rg / fd）。只含 +name 的 --tools 是在默认选择上加，不会覆盖用户的 defaultTools。
 */
export function searchToolArgs(userArgs: readonly string[]): string[] {
  const own = userArgs.some(a => TOOL_SELECTION_ARGS.some(name => a === name || a.startsWith(name + '=')))
  return own ? [] : ['--tools', '+grep,+find,+ls']
}

/** 用户追加的参数里第一个由像素星空控制的；都允许时返回 null */
export function reservedPixelArg(args: readonly string[]): string | null {
  for (const arg of args) {
    for (const name of [
      '--mode',
      '--permission-mode',
      '--session-dir',
      '--no-session',
      '--session',
      '--continue',
      '--resume',
    ])
      if (arg === name || arg.startsWith(name + '=')) return name
  }
  return null
}

/**
 * 需要自定义地址时生成 provider 配置（结构同 models.json）；不需要返回 null。
 * - 网关会话（PIXELSKY_PIXEL_BASE_URL）：自定义 provider "pixelsky"，密钥用 $PIXELSKY_PIXEL_TOKEN
 * - 用户自己配了 ANTHROPIC_BASE_URL / OPENAI_BASE_URL（Pi 不认这两个环境变量）：覆盖内置 provider 的 baseUrl，密钥照常用 ANTHROPIC_API_KEY / OPENAI_API_KEY
 * windowOf：没带 contextWindow 的网关模型要告诉 Pi 的窗口（context-window.ts）；null 时交给 Pi 的默认值。
 * inferred：每个网关模型里这里猜的字段（推理开关、图片、按系列定的窗口）加上宿主在模型的 inferred 里标的（如 compat），
 * 命令行在 Pi 内置表里找到同名模型时以内置的为准
 */
export function pixelModelsConfig(
  env: NodeJS.ProcessEnv,
  model: string | null,
  windowOf?: (id: string) => { window: number; auto: boolean } | null,
): { providers: Message; inferred?: Record<string, Record<string, string[]>> } | null {
  const inferred: Record<string, string[]> = {}
  const providers: Message = {}
  const base = env[GATEWAY_ENV.baseUrl]?.trim()
  if (base) {
    const api = env[GATEWAY_ENV.api]?.trim() || 'anthropic-messages'
    let models: unknown[]
    try {
      models = array(JSON.parse(env[GATEWAY_ENV.models] ?? '[]'))
    } catch {
      models = []
    }
    const id = model?.replace(new RegExp(`^${GATEWAY_PROVIDER}/`), '') ?? ''
    const defs: Message[] = models.map(m => (typeof m === 'string' ? { id: m } : object(m))).filter(m => string(m.id))
    if (id && !defs.some(m => string(m.id) === id)) defs.push({ id })
    providers[GATEWAY_PROVIDER] = {
      baseUrl: base,
      api,
      apiKey: `$${GATEWAY_ENV.token}`,
      models: defs.map(({ inferred: marked, ...m }) => {
        const window = m.contextWindow === undefined ? (windowOf?.(string(m.id)) ?? null) : null
        // 宿主自己标的猜的字段（inferred，不是 Pi 的字段，不写进模型定义），例如按接口地址认出的 compat
        const guessed = [
          ...(m.reasoning === undefined ? ['reasoning'] : []),
          ...(m.input === undefined ? ['input'] : []),
          ...(window?.auto ? ['contextWindow'] : []),
          ...array(marked).filter((f): f is string => typeof f === 'string'),
        ]
        if (guessed.length) inferred[string(m.id)] = [...new Set(guessed)]
        const chat = api === 'openai-completions'
        return {
          // Chat 的兼容接口多数不收图片、不开思考：默认只给文字（名字一看就能看图的除外），Pi 内置表里有这个模型时以内置的为准；
          // 用户在设置里指定了「看图」的，桌面端写明 input，不算猜的
          reasoning: !chat,
          input: chat && !looksVisual(string(m.id)) ? ['text'] : ['text', 'image'],
          ...m,
          ...(window ? { contextWindow: window.window } : {}),
        }
      }),
    }
  } else {
    if (env.ANTHROPIC_BASE_URL?.trim()) providers.anthropic = { baseUrl: env.ANTHROPIC_BASE_URL.trim() }
    if (env.OPENAI_BASE_URL?.trim()) providers.openai = { baseUrl: env.OPENAI_BASE_URL.trim() }
  }
  if (!Object.keys(providers).length) return null
  return Object.keys(inferred).length ? { providers, inferred: { [GATEWAY_PROVIDER]: inferred } } : { providers }
}

type Pending = {
  request: ApprovalRequest
  /** confirm / select / input / editor；approval 是批准扩展的三选一（select） */
  method: string
  options: string[]
  timer: NodeJS.Timeout | null
}

/** 正在进行的一轮 */
interface ActiveTurn {
  id: string
  started: number
  promptSent: boolean
  /** 提示一直没开始、已经让 Pi 停下：之后的 agent_settled（aborted）按失败结束，带上这个原因 */
  failure?: string
}

/** Pi 取消等着的重试时报的 finalError（用户停止、超过重试次数设置时）：不是请求错误 */
const RETRY_CANCELLED = 'Retry cancelled'

export class PixelSession implements EngineSession {
  private proc: PixelProcess | null = null
  private opening: Promise<void> | null = null
  private closed = false
  private ready = false
  private active: ActiveTurn | null = null
  private settings: SessionSettings
  /** get_available_models 的原始结果（set_model 要 provider 和 modelId） */
  private models: Message[] = []
  private modelInfo: Message = {}
  /** 经网关（云端线路 / 自定义 API）：只能用网关注册的 pixelsky/<id>，进程的环境在创建时就定了 */
  private readonly gateway: boolean
  /** 创建时的模型：网关环境（sessionEnv）是按它生成的 */
  private readonly launchModel: string | null
  /** 进程里实际在用的模型（会话记录里的写法）；没选过为 null */
  private appliedModel: string | null = null
  /** 当前模型支持的强度（get_available_thinking_levels）；还不知道为 null */
  private efforts: Effort[] | null = null
  private flags: SessionFlags = EMPTY_FLAGS
  /** 自己在改模型 / 强度（期间 Pi 报的 thinking_level_changed 是中间状态，不当作被夹紧） */
  private syncing = 0
  /** 启动时没接上原来的会话文件：exists 是文件还在不在，reason 是原因；由这一轮发送前处理 */
  private resumeFailure: { exists: boolean; reason: string } | null = null
  /** 最近一次收到 Pi 的事件（等提示开始处理时判断有没有动静） */
  private lastEvent = 0
  private readonly approvals = new Map<string, Pending>()
  /** 已经挂到某张审批卡片上的工具条目（批准请求里没有 toolCallId，按工具名找最早的没挂过的） */
  private readonly linked = new Map<string, string>()
  /**
   * 本轮问过的工具条目：一个调用最多问一次，卡片答完了也不能再挂（否则同一条消息里两条命令，
   * 第二张卡会挂到已经批准、还在跑的第一条上）
   */
  private readonly asked = new Set<string>()
  /** 子智能体转来的下一条审批是哪次调用（APPROVAL_CONTEXT_STATUS），只管紧接着的那一条 */
  private approvalContext: SubagentApproval | null = null
  /** 等 Pi 交付的引导消息（按发送顺序），交付时 Pi 会发一条用户消息 */
  private readonly guidance: string[] = []
  private promptUserSeen = false
  private translator: PixelTranslator
  private turnWaiters: Array<() => void> = []
  /** 会话里的 MCP 服务器：命令行状态变了自己推（setStatus），不用轮询 */
  private readonly mcpReporter: McpReporter
  /** 等 /pixelsky-mcp 操作结果的（按发送顺序），值是报错，成功为空 */
  /** 等命令行回传的 MCP 操作；按请求号对号（几个操作可以同时在跑，完成顺序和发出顺序不一定一样） */
  private mcpWaiters: McpWaiter[] = []
  private mcpSeq = 0

  constructor(
    private readonly launcher: Launcher,
    private readonly env: NodeJS.ProcessEnv,
    private readonly ctx: SessionContext,
    private readonly options: PixelLaunchOptions = {},
  ) {
    this.settings = { ...ctx.record() }
    this.gateway = viaGateway(ctx.record())
    this.launchModel = ctx.record().model
    this.mcpReporter = new McpReporter(e => ctx.emit(e), ['reconnect', 'toggle', 'login'])
    this.translator = new PixelTranslator(event => this.ctx.emit(event), {
      cwd: ctx.record().cwd,
      userMessage: () => this.userMessage(),
      contextWindow: () => {
        const w = this.modelInfo.contextWindow
        return typeof w === 'number' && w > 0 ? w : null
      },
      model: () => string(this.modelInfo.id) || null,
    })
  }

  /** 会话记录里的模型 → Pi 的模型；经网关的只认网关注册的 */
  private pickModel(ref: string): Message | undefined {
    return findModel(this.models, ref, this.gateway ? GATEWAY_PROVIDER : undefined)
  }

  restartsForModel(model: string | null): boolean {
    // 本机的模型 Pi 都认得，不用换进程
    if (!this.gateway || !model) return false
    if (this.ready && this.proc?.alive) return !this.pickModel(model)
    // 进程没在跑：再起来用的还是创建时的环境（协议、注册的模型都按当时的模型定），只有当时的模型能直接用
    const bare = (m: string | null): string => m?.replace(new RegExp(`^${GATEWAY_PROVIDER}/`), '') ?? ''
    return bare(model) !== bare(this.launchModel)
  }

  private async open(): Promise<void> {
    if (this.closed) throw new Error('Pixel session is closed')
    if (this.ready && this.proc?.alive) return
    if (this.opening) return this.opening
    this.opening = this.connect().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async connect(): Promise<void> {
    const record = this.ctx.record(),
      environment: NodeJS.ProcessEnv = { ...this.env },
      args = ['--mode', 'rpc', '--permission-mode', PIXEL_MODES[this.settings.permissionMode] ?? 'default']
    Object.assign(environment, this.ctx.extensions?.env)
    if (this.ctx.extensions?.pathDirs.length) {
      const key = Object.keys(environment).find(k => k.toLowerCase() === 'path') ?? 'PATH'
      environment[key] = [...this.ctx.extensions.pathDirs, environment[key] ?? ''].join(delimiter)
    }
    // 自定义地址：交给命令行的网关扩展 pi.registerProvider()（packages/cli/src/extensions/gateway.ts）。
    // 配置目录始终是用户自己的 ~/.pixelsky-cli/agent/，里面的 mcp.json、技能、扩展、bin/ 才会生效
    applyPixelModels(environment, record, this.options.contextWindows)
    // 桌面端管理的 MCP（设置 › 插件）：文件交给命令行的 MCP 扩展注册；应用自己的只读服务器不用问
    const ext = this.ctx.extensions
    if (ext?.mcpFile) environment[MCP_FILE_ENV] = ext.mcpFile
    else delete environment[MCP_FILE_ENV]
    if (ext?.allowTools?.length) environment[ALLOW_TOOLS_ENV] = ext.allowTools.join(',')
    else delete environment[ALLOW_TOOLS_ENV]
    // 桌面端管理的技能：每个技能目录一个 --skill（Pi 认 SKILL.md 所在的目录）
    for (const root of ext?.skillRoots ?? []) args.push('--skill', root)
    args.push(...searchToolArgs(this.options.args ?? []), ...(this.options.args ?? []))
    const proc = new PixelProcess(this.launcher, args, record.cwd, environment, {
      event: event => this.event(event),
      exit: (_code, tail) => {
        if (this.proc !== proc) return
        this.ready = false
        this.rejectApprovals()
        this.mcpReporter.stale()
        for (const w of this.mcpWaiters.splice(0)) w.resolve({ error: '引擎进程已退出' })
        // 界面只显示「Error: …」那句，不显示 Node 印出来的压缩源码和调用栈（完整的 stderr 在进程日志里）
        if (!this.closed && this.active) this.finish('failed', crashReason(tail) || 'Pixel process exited')
      },
    })
    this.proc = proc
    try {
      let state = object((await proc.request('get_state')).data)
      // 续接：引擎会话 id 是会话文件路径
      const resume = record.engineSessionId
      this.resumeFailure = null
      if (resume && string(state.sessionFile) !== resume) {
        let resumed = false,
          reason = ''
        const exists = existsSync(resume)
        if (exists)
          try {
            resumed = object((await proc.request('switch_session', { sessionPath: resume })).data).cancelled !== true
            if (!resumed) reason = '切换会话被取消了'
          } catch (error) {
            if (!proc.alive) throw error
            reason = (error as Error).message
          }
        // 接不上：这一轮发送前再处理（run），要看这条消息是不是斜杠命令、宿主带没带上之前的聊天
        if (!resumed) this.resumeFailure = { exists, reason: reason || `会话文件不在了：${resume}` }
      }
      this.models = array((await proc.request('get_available_models')).data.models).map(object)
      this.syncing++
      try {
        if (record.model) {
          const model = this.pickModel(record.model)
          // 经网关的会话找不到网关注册的模型就报错，不能退回同名的内置模型（那会用本机的密钥直连厂商）
          if (!model) throw new Error(`Model not found: ${this.gateway ? `${GATEWAY_PROVIDER}/` : ''}${record.model}`)
          await proc.request('set_model', { provider: string(model.provider), modelId: string(model.id) })
        }
        if (this.settings.effort)
          await proc.request('set_thinking_level', { level: piThinkingLevel(this.settings.effort) })
      } finally {
        this.syncing--
      }
      this.appliedModel = record.model
      // 重试次数不用 set_auto_retry：它会写进用户自己的 ~/.pixelsky-cli/agent/settings.json，终端里也跟着不重试了；
      // 改成超过次数时 abort_retry（event 里的 auto_retry_start）
      state = object((await proc.request('get_state')).data)
      this.modelInfo = object(state.model)
      await this.syncEfforts(proc, string(state.thinkingLevel))
      this.ctx.setEngineSessionId(string(state.sessionFile) || string(state.sessionId))
      // 以前的子智能体：之后的 runs 事件是整份替换，要带上它们
      // 只要子智能体的条目：主会话文件可能有几百 MB，其余的行不解析
      const saved = entries(string(state.sessionFile), SUBAGENT_ENTRY)
      this.translator.seedRuns(
        runsFromSession(string(state.sessionFile), saved).map(({ sessionFile: _, ...run }) => run),
      )
      // 切回旧会话：用 Pi 记的累计作基线，用量不从零开始
      const stats = object(
        (await proc.request('get_session_stats').catch(() => ({ command: 'get_session_stats', data: {} as Message })))
          .data,
      )
      const tokens = object(stats.tokens)
      // Pi 的统计只有主进程自己的请求，子智能体（子进程）的用量从会话文件里的记录补上
      const agents = subagentTotals(saved)
      this.translator.totals = {
        input: (Number(tokens.input) || 0) + agents.input,
        output: (Number(tokens.output) || 0) + agents.output,
        cacheRead: (Number(tokens.cacheRead) || 0) + agents.cacheRead,
        cacheWrite: (Number(tokens.cacheWrite) || 0) + agents.cacheWrite,
        cost: (Number(stats.cost) || 0) + agents.cost,
      }
      const used = object(stats.contextUsage).tokens
      this.translator.setContext(typeof used === 'number' ? used : null)
      if (this.translator.lastContext !== null) this.translator.emitUsage()
      this.flags = {
        ...EMPTY_FLAGS,
        compactAvailable: true,
        contextAvailable: false,
        steerAvailable: true,
        fastAvailable: false,
        fastState: 'off',
        fastBlocked: 'Fast mode is not supported',
        ultracodeAvailable: false,
      }
      this.emitFlags()
      if (this.settings.fast) {
        this.settings.fast = false
        this.ctx.setFast(false)
      }
      await this.emitCommands(proc)
      this.ready = true
    } catch (error) {
      this.proc = null
      await proc.close()
      throw error
    }
  }

  private async emitCommands(proc: PixelProcess): Promise<void> {
    const found = await proc.request('get_commands').catch(() => ({ command: 'get_commands', data: {} as Message }))
    const commands: SkillCommand[] = [
      {
        name: 'compact',
        description: 'Summarize the conversation to free up context',
        source: 'engine',
        builtin: true,
        invocation: 'slash',
      },
    ]
    for (const raw of array(found.data.commands)) {
      const c = object(raw)
      const name = string(c.name)
      // 适配器自己用的扩展命令（切换权限模式、连接器操作）不列；用户自己装的扩展命令、技能和提示词模板照常给用户
      if (!name || (c.source === 'extension' && INTERNAL_COMMANDS.has(name))) continue
      commands.push({
        name,
        description: string(c.description),
        source: 'engine',
        invocation: c.source === 'skill' ? 'skill' : 'slash',
        ...(string(object(c.sourceInfo).path) ? { path: string(object(c.sourceInfo).path) } : {}),
      })
    }
    this.ctx.emit({ type: 'commands', commands })
  }

  /**
   * 换模型 / 强度之后：问 Pi 当前模型支持哪些强度（报给界面，flags.efforts），再看实际用的思考级别，
   * 选的档位被夹到别的档时记录跟着改（clamped）。level 是已经拿到的 get_state.thinkingLevel，不给就再问一次
   */
  private async syncEfforts(proc: PixelProcess, level?: string): Promise<void> {
    const [levels, actual] = await Promise.all([
      proc.request('get_available_thinking_levels').then(
        r => array(r.data.levels).map(string),
        () => null,
      ),
      level !== undefined
        ? Promise.resolve(level)
        : proc.request('get_state').then(
            r => string(r.data.thinkingLevel),
            () => '',
          ),
    ])
    // 旧版命令行没有 get_available_thinking_levels：按模型定义自己算（规则同 Pi）
    this.efforts = levels ? effortsFromLevels(levels) : modelEfforts(this.modelInfo)
    this.clamped(effortOfLevel(actual))
  }

  /**
   * Pi 把选的强度夹到了这个模型支持的档位（set_thinking_level 不报错，悄悄改）：记录改成实际用的。
   * 模型不支持推理（实际是 off）时不改，换回能推理的模型还用原来选的
   */
  private clamped(actual: Effort | null): void {
    const chosen = this.settings.effort
    if (!chosen || !actual || actual === piThinkingLevel(chosen)) return
    this.settings.effort = actual
    this.ctx.setEffort?.(actual)
  }

  private emitFlags(): void {
    this.ctx.emit({
      type: 'flags',
      flags: {
        ...this.flags,
        ...(this.efforts ? { efforts: { model: this.appliedModel, efforts: this.efforts } } : {}),
      },
    })
  }

  // ---------------------------------------------------------------------------
  // 发送
  // ---------------------------------------------------------------------------

  send(
    text: string,
    turnId: string,
    userItemId: string,
    attachments: ImageAttachment[] = [],
    _seed?: ChatSeed,
    handoffImages: ImageAttachment[] = [],
  ): void {
    if (this.active) {
      this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'failed', error: 'Pixel turn already running' })
      return
    }
    const active: ActiveTurn = { id: turnId, started: Date.now(), promptSent: false }
    this.active = active
    this.promptUserSeen = false
    this.guidance.length = 0
    this.asked.clear()
    this.translator.beginTurn()
    void this.run(active, text, userItemId, attachments, handoffImages).catch(error => {
      if (this.active === active) this.finish('failed', (error as Error).message)
    })
  }

  private async run(
    active: ActiveTurn,
    text: string,
    userItemId: string,
    attachments: ImageAttachment[],
    handoffImages: ImageAttachment[],
  ): Promise<void> {
    await this.open()
    if (this.active !== active || this.closed) return
    const sees = array(this.modelInfo.input).includes('image')
    if (attachments.length && !sees) throw new Error('This model does not support images')
    // 原来的会话没接上：之前的聊天做成交接材料放在最前面（宿主已经带上的不再带）
    const recovered = this.recoverLost(text, userItemId, sees)
    const message = recovered ? `${recovered.seed.fallback}\n\n${text}` : text
    const earlier = [...(recovered?.seed.fallbackImages ?? []), ...handoffImages]
    // 交接带的更早消息的图片排在前面；模型不能看图就不带，交接材料里说明过也只当文字理解
    const images = sees ? [...earlier, ...attachments] : attachments
    if (!sees && earlier.length)
      this.translator.notice(
        'warn',
        `The current model can't view images, so ${earlier.length} earlier image(s) were not actually passed along`,
      )
    const proc = this.proc!
    const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim())
    active.promptSent = true
    if (compact) {
      // Pi 内置的 /compact 只在终端里有，RPC 里用 compact 命令；没有 agent_settled，回应就是结束
      const instructions = compact[1]?.trim()
      await proc.request('compact', instructions ? { customInstructions: instructions } : {}, 10 * 60_000)
      this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'consumed', mode: 'normal' })
      if (this.active === active) this.finish('completed', null)
      return
    }
    const response = await this.startPrompt(proc, active, {
      message,
      ...(images.length
        ? { images: images.map(i => ({ type: 'image', data: i.dataBase64, mimeType: i.mediaType })) }
        : {}),
    })
    if (this.active !== active) return
    this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'consumed', mode: 'normal' })
    // handled：被扩展命令或输入处理器吃掉，不会有这一轮的 agent_settled
    if (string(response.data.disposition) === 'handled') this.finish('completed', null)
  }

  /**
   * 发提示，等 Pi 回应。回应要等发送前的准备做完才来：可能先压缩一次上下文（整段对话做一次总结请求），
   * 压缩中、等审批时不算没动静，收到别的事件也重新计时。一直没动静就先让 Pi 停下（不然它在后台接着跑，
   * 之后的事件对不上这一轮、下一条消息还会被拒「Agent is already processing」），再按失败结束这一轮
   */
  private async startPrompt(proc: PixelProcess, active: ActiveTurn, params: Message): Promise<PixelResponse> {
    const limit = this.options.promptStartMs ?? PROMPT_START_MS
    this.lastEvent = Date.now()
    const request = proc.request('prompt', params, 0)
    let timer: NodeJS.Timeout | undefined
    const stalled = new Promise<'stalled'>(resolve => {
      const check = (): void => {
        // 这一轮已经结束（停止、进程退出）：不再计时，请求自己会有结果
        if (this.active !== active || !proc.alive) return
        const busy = this.translator.compacting || this.approvals.size > 0
        const quiet = Date.now() - this.lastEvent
        if (!busy && quiet >= limit) return resolve('stalled')
        timer = setTimeout(check, busy ? Math.min(limit, 1_000) : limit - quiet)
      }
      timer = setTimeout(check, limit)
    })
    try {
      const result = await Promise.race([request, stalled])
      if (result !== 'stalled') return result
    } finally {
      clearTimeout(timer)
    }
    const reason = `Pixel ${Math.round(limit / 1000)} 秒没有开始处理这条消息，已让它停下`
    // 停下后 Pi 会报 agent_settled（aborted）：按失败结束、带上原因，不当作用户停的（event 里看 active.failure）
    active.failure = reason
    try {
      await proc.request('abort', {}, 10_000)
    } catch {
      // 连中断也不回应：结束进程，下一条消息重新起
      proc.kill()
      throw new Error(reason)
    }
    // 等它报完 agent_settled 再结束这一轮，不然那条事件会落到下一轮头上；一直不报（还没开始跑）就结束进程，
    // 免得它准备完又自己跑起来
    if (this.active === active && !(await this.waitTurnEnd(5_000))) proc.kill()
    throw new Error(reason)
  }

  /**
   * 启动时没接上原来的会话文件（connect 记下的 resumeFailure），这一轮发送前处理：
   * - 斜杠命令（/compact、技能）前面不能加东西：清掉宿主的游标，下一条普通消息把整段聊天带过去
   * - 文件没了、宿主有接力游标：宿主派发前已经发现（hasNativeSession），整段聊天已经交接进这条消息并提示过
   * - 其他（文件还在却接不上、旧记录没有游标）：请宿主把之前的聊天做成交接材料（lostSeed），由调用方加在消息前面
   */
  private recoverLost(text: string, userItemId: string, sees: boolean): { seed: ChatSeed; notice: Item } | null {
    const failure = this.resumeFailure
    this.resumeFailure = null
    if (!failure) return null
    if (text.trimStart().startsWith('/')) {
      this.ctx.forgetSeen?.()
      this.translator.notice(
        'warn',
        '没能接上原来的 Pixel 会话，已改开新会话；下一条消息会把之前的聊天一起带过去',
        failure.reason,
      )
      return null
    }
    if (!failure.exists && this.ctx.record().engineSessions) return null
    const recovered = this.ctx.lostSeed?.(userItemId, sees) ?? null
    if (!recovered) {
      this.translator.notice(
        'warn',
        '没能接上原来的 Pixel 会话，已改开新会话（之前的上下文没有带过去）',
        failure.reason,
      )
      return null
    }
    const notice = recovered.notice
    this.ctx.emit({
      type: 'item_completed',
      item:
        notice.kind === 'notice'
          ? { ...notice, detail: [failure.reason, notice.detail].filter(Boolean).join('\n\n') }
          : notice,
    })
    return recovered
  }

  async steer(text: string, id: string, attachments: ImageAttachment[] = []): Promise<void> {
    if (!this.active || !this.proc?.alive || !this.ready) throw new Error('Pixel active turn cannot accept guidance')
    if (attachments.length && !array(this.modelInfo.input).includes('image'))
      throw new Error('This model does not support images')
    this.guidance.push(id)
    try {
      const response = await this.proc.request('steer', {
        message: text,
        ...(attachments.length
          ? { images: attachments.map(i => ({ type: 'image', data: i.dataBase64, mimeType: i.mediaType })) }
          : {}),
      })
      // handled：输入处理器吃掉了，不会再有用户消息
      if (string(response.data.disposition) === 'handled') this.consume(id)
    } catch (error) {
      this.guidance.splice(this.guidance.indexOf(id), 1)
      throw error
    }
  }

  private consume(id: string): void {
    const index = this.guidance.indexOf(id)
    if (index >= 0) this.guidance.splice(index, 1)
    this.ctx.emit({ type: 'input_ack', id, state: 'consumed', mode: 'guidance' })
  }

  /** Pi 把一条用户消息放进上下文：这一轮的第一条是提示本身，之后的是交付了的引导 */
  private userMessage(): void {
    if (!this.promptUserSeen) {
      this.promptUserSeen = true
      return
    }
    const id = this.guidance.shift()
    if (id) this.ctx.emit({ type: 'input_ack', id, state: 'consumed', mode: 'guidance' })
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  private event(raw: Message): void {
    const type = string(raw.type)
    this.lastEvent = Date.now()
    if (type === 'extension_ui_request') return this.uiRequest(raw)
    if (type === 'thinking_level_changed') {
      // 不是我们自己在改（扩展换了强度、Pi 换模型时夹紧了）：记录跟着改成实际用的
      if (this.ready && !this.syncing) this.clamped(effortOfLevel(string(raw.level)))
      return
    }
    if (!this.active) return
    if (type === 'agent_settled') {
      if (raw.aborted === true) {
        // 提示一直没开始、是我们让它停的：按失败结束，说明原因
        const failure = this.active.failure
        return failure ? this.finish('failed', failure) : this.finish('interrupted', null)
      }
      const error = this.translator.takeError()
      return error ? this.finish('failed', error) : this.finish('completed', null)
    }
    if (type === 'auto_retry_start') {
      const attempt = Number(raw.attempt) || null
      const most = Number(raw.maxAttempts) || null
      // 设置 › 重试次数：Pi 的 RPC 只能整个关掉重试（还会写进用户的配置文件），超过次数就取消这次等着的重试，
      // 这一轮以原来的错误结束
      const limit = typeof this.ctx.maxRetries === 'number' ? this.ctx.maxRetries : null
      if (limit !== null && attempt !== null && attempt > limit) {
        void this.proc?.request('abort_retry').catch(() => {})
        return
      }
      this.ctx.emit({
        type: 'request_retry',
        retry: {
          turnId: this.active.id,
          attempt,
          maxRetries: limit !== null && most !== null ? Math.min(limit, most) : (most ?? limit),
          retryAt: Date.now() + (Number(raw.delayMs) || 0),
          reason: string(raw.errorMessage),
        },
      })
      return
    }
    if (type === 'auto_retry_end') {
      this.ctx.emit({ type: 'request_retry', retry: null })
      // 重试用完：错误只在这一轮结束时显示一次（finish）。用户停止、超过次数设置时 Pi 报的「Retry cancelled」
      // 不是错误：停止按中断结束，超过次数按原来的请求错误结束
      const final = string(raw.finalError)
      if (raw.success === false && final !== RETRY_CANCELLED) this.translator.failWith(final)
      return
    }
    // queue_update 不转成 queue 事件：排队由宿主管理，引导的交付以用户消息为准（userMessage）
    this.translator.event(raw)
  }

  private uiRequest(raw: Message): void {
    const id = string(raw.id),
      method = string(raw.method)
    if (method === 'notify') {
      const level = raw.notifyType === 'error' ? 'error' : raw.notifyType === 'warning' ? 'warn' : 'info'
      const text = string(raw.message)
      if (text) this.translator.notice(level, text)
      return
    }
    if (method === 'setStatus') {
      const key = string(raw.statusKey)
      if (key === MODE_STATUS) this.syncMode(string(raw.statusText))
      else if (key === APPROVAL_CONTEXT_STATUS) this.approvalContext = subagentApproval(string(raw.statusText))
      else if (key === MCP_STATUS) {
        const servers = pixelMcpServers(string(raw.statusText))
        if (servers) this.mcpReporter.set(servers)
      } else if (key === MCP_RESULT_STATUS) {
        let result: { error: string; url?: string } = { error: '' }
        let r: Record<string, unknown> = {}
        try {
          r = object(JSON.parse(string(raw.statusText)))
          result = { error: string(r.error), ...(/^https?:\/\//i.test(string(r.url)) ? { url: string(r.url) } : {}) }
        } catch {
          // 格式不对当作成功，状态以推来的为准
        }
        const waiter = mcpWaiterFor(this.mcpWaiters, string(r.req), string(r.op), string(r.name))
        if (waiter) {
          this.mcpWaiters = this.mcpWaiters.filter(w => w !== waiter)
          waiter.resolve(result)
        }
      }
      return
    }
    if (method !== 'confirm' && method !== 'select' && method !== 'input' && method !== 'editor') return
    const context = this.approvalContext
    this.approvalContext = null
    if (!this.active || !this.proc?.alive) {
      this.proc?.respondUi(id, { cancelled: true })
      return
    }
    const title = string(raw.title)
    let request: ApprovalRequest
    const options: string[] = array(raw.options).map(string)
    let kind = method
    const approval = method === 'confirm' || (method === 'select' && isApprovalSelect(title, options))
    const taken = new Set([...this.linked.values(), ...this.asked])
    if (method === 'select' && isPlanSelect(title, options)) {
      kind = 'plan'
      const item = this.translator.runningTool(EXIT_PLAN_TOOL, taken)
      request = planApproval(id, title, item)
      if (item) this.link(id, item.id)
    } else if (approval) {
      if (method === 'select') kind = 'approval'
      const tool = toolNameFromTitle(title)
      const summary = title.split('\n').slice(1).join('\n')
      // 子智能体里的调用：主会话没有它的条目，按子进程报来的参数拼一个（不进对话），卡片挂在 task 条目上
      const sub = context && context.tool === tool ? context : null
      const item = sub
        ? toolItem(`${subagentItemId(sub.toolCallId)}-${id}`, sub.tool, sub.args, this.ctx.record().cwd)
        : this.translator.runningTool(tool, taken, method === 'select' ? summary : undefined)
      request = approvalFor(
        id,
        title,
        method === 'confirm' ? string(raw.message) : summary,
        item,
        method === 'select' ? ['session'] : [],
      )
      if (sub) {
        const task = subagentItemId(sub.toolCallId)
        request = {
          ...request,
          itemId: this.translator.items.has(task) ? task : null,
          ...(request.kind === 'tool' ? { input: sub.args } : {}),
        }
      } else if (item) this.link(id, item.id)
    } else {
      request = {
        requestId: id,
        itemId: null,
        kind: 'question',
        title,
        questions: [
          {
            question: title,
            header: '',
            multiSelect: false,
            allowOther: method !== 'select',
            secret: false,
            options: options.map(label => ({ label, description: '' })),
          },
        ],
        alwaysScopes: [],
      }
    }
    // 对话框自带超时（Pi 到时自己按取消处理）：卡片也跟着收掉
    const timeout = typeof raw.timeout === 'number' && raw.timeout > 0 ? raw.timeout : 0
    const timer = timeout ? setTimeout(() => this.dropApproval(id), timeout) : null
    timer?.unref()
    this.approvals.set(id, { request, method: kind, options, timer })
    this.ctx.emit({ type: 'approval_request', request })
  }

  private link(requestId: string, itemId: string): void {
    this.linked.set(requestId, itemId)
    this.asked.add(itemId)
  }

  /** 命令行自己换了权限模式（计划确认后退出计划模式）：记下来并告诉宿主，不再发 /pixelsky-mode */
  private syncMode(text: string): void {
    const mode = (Object.keys(PIXEL_MODES) as PermissionMode[]).find(m => PIXEL_MODES[m] === text)
    if (!mode || mode === this.settings.permissionMode) return
    this.settings.permissionMode = mode
    this.ctx.setPermissionMode(mode)
  }

  private dropApproval(id: string): void {
    const approval = this.approvals.get(id)
    if (!approval) return
    if (approval.timer) clearTimeout(approval.timer)
    this.approvals.delete(id)
    this.linked.delete(id)
    this.ctx.emit({ type: 'approval_resolved', requestId: id })
  }

  /** 把所有等待中的审批按取消回给 Pi 并收掉卡片（停止、一轮结束、进程退出） */
  private rejectApprovals(): void {
    for (const id of [...this.approvals.keys()]) {
      this.proc?.respondUi(id, { cancelled: true })
      this.dropApproval(id)
    }
  }

  answer(requestId: string, decision: ApprovalDecision): void {
    if (decision.type === 'allow_all')
      throw new Error('This engine does not support enabling full access from an approval')
    const approval = this.approvals.get(requestId)
    if (!approval || !this.proc?.alive) {
      // 找不到审批或进程已退出：同样结束这张卡片，不留下点不动的审批
      this.dropApproval(requestId)
      return
    }
    const allow = decision.type === 'allow' || decision.type === 'allow_always'
    if (approval.method === 'confirm') {
      this.proc.respondUi(requestId, { confirmed: allow })
    } else if (approval.method === 'plan') {
      const [start, refine] = PLAN_OPTIONS
      this.proc.respondUi(requestId, { value: allow ? start : refine })
    } else if (approval.method === 'approval') {
      const [once, always, deny] = APPROVAL_OPTIONS
      this.proc.respondUi(requestId, {
        value: decision.type === 'allow_always' ? always : decision.type === 'allow' ? once : deny,
      })
    } else if (approval.method === 'select') {
      const answers = decision.type === 'answer' ? Object.values(decision.answers) : []
      const value = answers[0] ?? (allow ? approval.options[0] : undefined)
      this.proc.respondUi(requestId, value !== undefined ? { value } : { cancelled: true })
    } else {
      const value = decision.type === 'answer' ? Object.values(decision.answers)[0] : undefined
      this.proc.respondUi(requestId, value !== undefined ? { value } : { cancelled: true })
    }
    this.dropApproval(requestId)
  }

  private finish(outcome: TurnOutcome, error: string | null): void {
    const active = this.active
    if (!active) return
    this.active = null
    const info = error ? textError(error) : undefined
    if (outcome === 'failed' && error)
      this.ctx.emit({
        type: 'item_completed',
        item: {
          kind: 'notice',
          id: 'px-error-' + active.id,
          level: 'error',
          text: error,
          detail: null,
          ...(info ? { error: info } : {}),
        },
      })
    this.translator.finish(outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed')
    this.rejectApprovals()
    this.ctx.emit({ type: 'request_retry', retry: null })
    for (const id of this.guidance) this.ctx.emit({ type: 'input_ack', id, state: 'uncertain', mode: 'guidance' })
    this.guidance.length = 0
    this.ctx.emit({
      type: 'turn_completed',
      turnId: active.id,
      outcome,
      error,
      usage: this.translator.turnUsage(Date.now() - active.started),
    })
    const waiters = this.turnWaiters
    this.turnWaiters = []
    for (const w of waiters) w()
  }

  /** 等当前一轮结束，超时返回 false */
  private waitTurnEnd(timeoutMs: number): Promise<boolean> {
    if (!this.active) return Promise.resolve(true)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.turnWaiters = this.turnWaiters.filter(w => w !== done)
        resolve(false)
      }, timeoutMs)
      const done = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.turnWaiters.push(done)
    })
  }

  async interrupt(): Promise<void> {
    const active = this.active
    if (!active) return
    if (!active.promptSent || !this.proc?.alive) {
      // 提示还没发出去（进程在启动、连接要发好几个请求）：不等连接完，本地直接结束；run() 发现已结束就不发了，
      // 连接在后台照常做完，进程留给下一轮（close() 会直接关掉它，连接中的请求跟着失败）
      this.finish('interrupted', null)
      return
    }
    // 等批准的对话框会让 abort 一直等：先全部按取消回掉
    this.rejectApprovals()
    try {
      await this.proc.request('abort', {}, 10_000)
    } catch {
      // 中断请求本身失败：不再等待，直接结束进程，下次发消息时恢复
      this.proc?.kill()
      this.finish('interrupted', null)
      return
    }
    // agent_settled(aborted) 通常紧跟其后；最多再等 5 秒，超时才强制结束进程
    if (this.active && !(await this.waitTurnEnd(5_000))) {
      this.proc?.kill()
      this.finish('interrupted', null)
    }
  }

  async update(patch: Partial<SessionSettings>, strict = false): Promise<void> {
    if (this.opening) await this.opening.catch(() => {})
    const before = this.settings
    this.settings = { ...before, ...patch }
    const proc = this.proc
    if (!proc?.alive || !this.ready) return
    this.syncing++
    try {
      let thinking = false
      if (patch.model !== undefined && patch.model !== this.appliedModel && patch.model) {
        const model = this.pickModel(patch.model)
        // 经网关、启动时没注册这个模型：这个进程换不过去，宿主下一条消息前换进程（restartsForModel）。
        // 先只记下来，不假装换了；强度是给新模型选的，也等新进程再套用
        const later = !model && this.gateway && !strict
        if (!later) {
          if (!model) throw new Error(`Model not found: ${this.gateway ? `${GATEWAY_PROVIDER}/` : ''}${patch.model}`)
          const response = await proc.request('set_model', {
            provider: string(model.provider),
            modelId: string(model.id),
          })
          this.modelInfo = object(response.data)
          this.appliedModel = patch.model
          // 换模型后 Pi 会按新模型夹紧思考级别：重新套用选的强度
          if (this.settings.effort)
            await proc.request('set_thinking_level', { level: piThinkingLevel(this.settings.effort) })
          thinking = true
        }
      } else if (patch.effort !== undefined && patch.effort !== before.effort && patch.effort) {
        await proc.request('set_thinking_level', { level: piThinkingLevel(patch.effort) })
        thinking = true
      }
      // 新模型支持哪些强度、选的档位有没有被夹紧
      if (thinking) {
        await this.syncEfforts(proc)
        this.emitFlags()
      }
      if (patch.permissionMode !== undefined && patch.permissionMode !== before.permissionMode) {
        // 批准扩展的命令：prompt 里以 / 开头的扩展命令立即执行，不进模型，回应 disposition 为 handled
        const response = await proc.request('prompt', {
          message: `/${MODE_COMMAND} ${PIXEL_MODES[patch.permissionMode]}`,
        })
        if (string(response.data.disposition) !== 'handled') throw new Error('Pixel did not switch the permission mode')
      }
    } catch (error) {
      // 没生效：退回原值，下一轮开始前（strict）报错；宽松调用只记设置
      this.settings = before
      if (strict) throw error
    } finally {
      this.syncing--
    }
  }

  async mcp(op: McpOp): Promise<McpOpResult> {
    const proc = this.proc
    if (!proc?.alive || !this.ready) {
      if (op.kind === 'refresh') return { report: this.mcpReporter.report }
      throw new Error('引擎没有在运行')
    }
    const action =
      op.kind === 'refresh'
        ? 'status'
        : op.kind === 'reconnect' || op.kind === 'login'
          ? `${op.kind} ${op.name}`
          : `${op.enabled ? 'enable' : 'disable'} ${op.name}`
    let resolve!: (result: { error: string; url?: string }) => void
    const result = new Promise<{ error: string; url?: string }>(r => (resolve = r))
    let url: string | undefined
    const req = String(++this.mcpSeq)
    const waiter: McpWaiter = { req, op: action.split(' ')[0], name: op.kind === 'refresh' ? '' : op.name, resolve }
    this.mcpWaiters.push(waiter)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // 扩展命令立即执行、不进模型（disposition: handled）；结果从 pixelsky-mcp-result 状态回来，带着请求号
      const response = await proc.request('prompt', { message: `/${MCP_COMMAND} ${action} ${MCP_REQ_FLAG}${req}` })
      if (string(response.data.disposition) !== 'handled') throw new Error('Pixel did not run the MCP command')
      // 登录：拿到授权链接就回来，由桌面端在浏览器里打开；命令行在本机端口等回调，登录完自己重新连接
      const done = await Promise.race([
        result,
        new Promise<{ error: string }>(
          r => (timer = setTimeout(() => r({ error: '等命令行回应超时' }), MCP_OP_TIMEOUT_MS)),
        ),
      ])
      if (done.error) throw new Error(done.error)
      url = 'url' in done ? done.url : undefined
    } finally {
      clearTimeout(timer)
      this.mcpWaiters = this.mcpWaiters.filter(w => w !== waiter)
    }
    return url ? { report: this.mcpReporter.report, url } : { report: this.mcpReporter.report }
  }

  async close(opts: CloseOptions = {}): Promise<void> {
    this.closed = true
    this.mcpReporter.dispose()
    await this.interrupt()
    this.rejectApprovals()
    await this.proc?.close(opts.quick ? QUICK_CLOSE_MS : undefined)
    this.ctx.extensions?.dispose?.()
  }
}

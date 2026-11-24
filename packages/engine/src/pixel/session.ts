// 像素星空会话：一个会话一个 `pixelsky --mode rpc` 子进程（docs/own-cli.md §4.1）
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ContextDiagnostic,
  Effort,
  GoalAction,
  ImageAttachment,
  InterruptOptions,
  Item,
  McpOp,
  McpOpResult,
  PermissionMode,
  SessionFlags,
  SessionGoal,
  SessionSettings,
  SkillCommand,
  TurnOutcome,
} from '@pixelsky/protocol'
import {
  EMPTY_FLAGS,
  GOAL_NO_ENGINE,
  GOAL_NO_PROCESS,
  codedError,
  looksVisual,
  parseGoalCommand,
  viaGateway,
  pixelSpeedCapability,
  pixelSpeedOf,
  type PixelSpeed,
  type ContextWindows,
  type SessionRecord,
} from '@pixelsky/protocol'
import { QUICK_CLOSE_MS, type CloseOptions, type EngineSession, type Launcher, type SessionContext } from '../adapter'
import type { ChatSeed } from '../chat-log'
import { McpReporter, pixelMcpServers } from '../mcp'
import { NATIVE_TEXT } from '../native/text'
import { describeError, logger } from '../log'
import { queueSettings } from '../queue'
import { crashReason } from '../exec'
import { effortOfLevel, effortsFromLevels, findModel, modelEfforts, piThinkingLevel } from './catalog'
import { pixelWindow } from './context-window'
import {
  APPROVAL_CONTEXT_STATUS,
  SUBAGENT_ENTRY,
  SUBAGENT_TOOL,
  entries,
  runsFromSession,
  subagentTotals,
  subagentApproval,
  subagentItemId,
  type SubagentApproval,
} from './agents'
import { PixelProcess, array, object, string, type Message, type PixelResponse } from './process'
import { ompRunsFromSession } from '../omp/agents'
import { OMP_SUB_STATUS } from '../omp/subagent-ext'
import { ompDropGoal, ompForkFile, ompHasGoal } from '../omp/branch'
import { OMP_CONTEXT_COMMAND, ompContext, ompNoContext } from '../omp/context'
import { ompGoal, ompOutput, sameGoal } from '../omp/goal'
import { ompCwd } from '../omp/native'
import { OMP_TURN_COMMAND } from '../omp/turn-ext'
import { OmpBtw } from '../omp/btw'
import {
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
import type { Totals } from './translate'

const log = logger('engine.omp')

/** 批准扩展里运行中切换权限模式的命令（packages/cli/src/extensions/approval.ts 的 MODE_COMMAND） */
const MODE_COMMAND = 'pixelsky-mode'
/** 批准扩展报当前权限模式的状态键（approval.ts 的 MODE_STATUS），例如计划确认后它自己退出了计划模式 */
const MODE_STATUS = 'pixelsky-mode'
/** 连接器（docs/ui/connectors.md）：命令行 MCP 扩展的命令、报状态和操作结果的状态键（packages/cli/src/extensions/mcp.ts） */
const MCP_COMMAND = 'pixelsky-mcp'
const SPEED_COMMAND = 'pixelsky-speed'
const MCP_STATUS = 'pixelsky-mcp'
const MCP_RESULT_STATUS = 'pixelsky-mcp-result'
const MCP_OP_TIMEOUT_MS = 95_000
/** 命令末尾带上的请求号，命令行原样放回结果里（packages/cli/src/extensions/mcp.ts） */
const MCP_REQ_FLAG = '--req='
/** 适配器自己用的扩展命令，不进斜杠菜单（用户自己装的扩展命令照常列出） */
const INTERNAL_COMMANDS = new Set([MODE_COMMAND, MCP_COMMAND, SPEED_COMMAND, OMP_TURN_COMMAND])
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

/** 停主智能体时最多花多久停它的子智能体 */
const STOP_AGENTS_MS = 5_000

/** 我们的权限模式 → 批准扩展的 --permission-mode */
export const PIXEL_MODES: Record<PermissionMode, string> = {
  ask: 'default',
  edits: 'acceptEdits',
  plan: 'plan',
  full: 'bypassPermissions',
  // Pixel 没有这一档，换引擎时带过来的按每次询问（放最后：按值反查时先命中 ask）
  auto: 'default',
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
  /**
   * oh-my-pi（docs/omp-engine.md）：协议大体同 Pi，几处不同——先协商第 2 版协议、命令表叫 get_available_commands、
   * 一轮以 prompt_result 结束、确认选项是它自己的英文、换权限档要重启进程、没有我们的 MCP / 速度扩展命令
   */
  flavor?: 'omp'
  /** 启动参数和环境（omp 用自己的 ompLaunch）；不给用 pixelLaunch */
  launch?: typeof pixelLaunch
  /** omp 经网关时 -e 加载的扩展文件（omp/gateway-ext.ts 写出来的） */
  extensionFile?: string
  /** omp 的计划扩展文件（omp/plan-ext.ts），权限档是计划时加载 */
  planFile?: string
  /** omp 记每一轮位置的扩展（omp/turn-ext.ts） */
  turnFile?: () => string
  /** omp 注册应用自己的工具的扩展（omp/tools-ext.ts） */
  toolsFile?: () => string
  /** omp 子智能体的模型和强度（omp/subagent-ext.ts） */
  subagentFile?: () => string
  /** omp 的插件目录：桌面端管理的 MCP、技能（omp/plugin-dir.ts）；没有要给的返回 null */
  pluginDir?: (ext: import('@pixelsky/protocol').ExtensionLaunch) => { dir: string; remove: () => void } | null
  /** omp 这一档用的 --approval-mode（omp/launch.ts ompApproval）：批准计划后看要不要换进程 */
  approvalMode?: (mode: PermissionMode) => string
  /** omp 按会话开关（显示思考、Ultracode）写出的 --config 叠加设置（omp/overlay.ts），返回文件路径；isolated 时停掉用户级的 MCP 等来源，
   * pickEffort 时让主模型给子任务选强度 */
  configFile?: (
    settings: Pick<SessionSettings, 'thinkingSummaries' | 'ultracode'>,
    isolated: boolean,
    pickEffort: boolean,
  ) => string
}

/** omp 这几项改了要换进程（--approval-mode、--config 叠加设置都只在启动时读），这一轮结束后生效 */
export function ompRestarts(before: SessionSettings, patch: Partial<SessionSettings>): boolean {
  if (
    (['permissionMode', 'thinkingSummaries', 'ultracode'] as const).some(
      key => patch[key] !== undefined && patch[key] !== before[key],
    )
  )
    return true
  // 计划中改了「批准后回到哪一档」：进程的 --approval-mode 和要报的档都按它定
  const mode = patch.permissionMode ?? before.permissionMode
  return mode === 'plan' && patch.planReturn !== undefined && patch.planReturn !== before.planReturn
}

/**
 * omp 一个能用的模型都没有（没登录、没设 Key）时一启动就退出，标准错误里是一整段说明（19.1.0 实测）；
 * crashReason 只留最后几行会丢掉原因，换成一句照着做的话。不是这种情况返回 null
 */
export function ompStartupHint(stderr: string): string | null {
  return stderr.includes('No default model selected')
    ? 'oh-my-pi 还没有能用的模型：在终端里运行 omp，用 /login 登录或设置 API Key；也可以在模型菜单里改用平台线路'
    : null
}

/** omp 把会话改存到新文件时的提示（中文原文，英文界面按 ompMessages.ts 翻） */
export const OMP_SESSION_MOVED =
  '这个会话的文件被别的程序占用或改过（比如终端里的 omp），之后的内容存到新的会话文件，对话照常继续'

/** omp 的 Fast 档关不掉时这一轮不发（中文原文，英文界面按 ompMessages.ts 翻） */
export const OMP_FAST_STUCK = 'oh-my-pi 的 Fast 档关不掉，为免按 Fast 加价扣费，这条消息没有发出'

/** omp 第 2 版协议才把超过 1 MiB 的消息拆块发（第 1 版直接报错丢掉），模型表、长历史都可能超 */
export async function negotiateOmp(proc: PixelProcess): Promise<void> {
  // 旧版只会第 1 版：报错照第 1 版用
  await proc.request('negotiate_protocol', { protocolVersion: 2 }).catch(() => {})
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
  /** omp：prompt_result 到了但会话还没安定（sessionSettled 为假），等 session_settled 再按这个结果结束 */
  result?: Message
  /** omp：用户按了停止。主智能体只是在等子智能体时，omp 照样报完成（实测），要按中断记 */
  stopped?: boolean
  /** omp 自己跑的（目标接着做）：没有 prompt_result，到会话安定或下一次接着做时结束 */
  own?: boolean
  /** own 的一轮不是用户发的消息开的：宿主这时派发来的消息可以接管它（send） */
  auto?: boolean
  /** auto 的一轮已经告诉宿主了（turn_started） */
  announced?: boolean
  /** 用户的消息接管了 omp 自己开的一轮，还没送进去 */
  taken?: boolean
  /** omp 开始跑了（agent_start） */
  began?: boolean
  /** 这一轮里目标已经接着做过一次：再来一次算下一轮 */
  continued?: boolean
}

/** Pi 取消等着的重试时报的 finalError（用户停止、超过重试次数设置时）：不是请求错误 */
const RETRY_CANCELLED = 'Retry cancelled'

/**
 * 会话进程和终端模式（index.ts tuiLaunch）共用的启动参数和环境：权限档、技能、搜索工具、用户追加的参数，
 * 扩展的 env / PATH、网关模型、桌面端管理的 MCP。返回的 args 不含 --mode（会话进程是 rpc，终端是交互界面）
 */
export function pixelLaunch(
  base: NodeJS.ProcessEnv,
  record: SessionRecord,
  permissionMode: PermissionMode,
  ext: import('@pixelsky/protocol').ExtensionLaunch | undefined,
  options: PixelLaunchOptions,
): { args: string[]; env: NodeJS.ProcessEnv; cleanup?: () => void } {
  const env: NodeJS.ProcessEnv = { ...base, ...ext?.env }
  const args = ['--permission-mode', PIXEL_MODES[permissionMode] ?? 'default']
  if (ext?.pathDirs.length) {
    const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
    env[key] = [...ext.pathDirs, env[key] ?? ''].join(delimiter)
  }
  // 自定义地址：交给命令行的网关扩展 pi.registerProvider()（packages/cli/src/extensions/gateway.ts）。
  // 配置目录始终是用户自己的 ~/.pixelsky-cli/agent/，里面的 mcp.json、技能、扩展、bin/ 才会生效
  applyPixelModels(env, record, options.contextWindows)
  // 桌面端管理的 MCP（设置 › 插件）：文件交给命令行的 MCP 扩展注册；应用自己的只读服务器不用问
  if (ext?.mcpFile) env[MCP_FILE_ENV] = ext.mcpFile
  else delete env[MCP_FILE_ENV]
  if (ext?.allowTools?.length) env[ALLOW_TOOLS_ENV] = ext.allowTools.join(',')
  else delete env[ALLOW_TOOLS_ENV]
  // 桌面端管理的技能：每个技能目录一个 --skill（Pi 认 SKILL.md 所在的目录）
  for (const root of ext?.skillRoots ?? []) args.push('--skill', root)
  args.push(...searchToolArgs(options.args ?? []), ...(options.args ?? []))
  return { args, env }
}

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
  private speedSupported = false
  private speedReply: Message | null = null
  private speedApplied: PixelSpeed = 'off'
  private speedSeq = 0
  private settingsRevision = 0
  /** 发出去还没应答的 /pixelsky-mode 有几次：命令行先报状态、再应答，这期间报的都是自己切换的回声或更早的 */
  private modeChanges = 0
  private speedQueue: Promise<void> = Promise.resolve()
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
  /** oh-my-pi（docs/omp-engine.md） */
  private readonly omp: boolean
  /** omp 换了权限档、当时有一轮在跑：这一轮结束后关掉进程，下一轮按新档重启（续接同一会话） */
  private modeRestart = false
  /** omp 进程启动时的 --approval-mode */
  private launchedApproval: string | null = null
  /** omp 的计划卡还没挂上 exit_plan_mode 条目（等它的 tool_execution_start） */
  private planUnlinked: string | null = null
  /** omp 的旁聊（btw，OmpAdapter.sideQuestion 找到活着的会话对象时在这里问） */
  private readonly btw = new OmpBtw()
  /** omp 正在核对会话文件换没换（syncFile） */
  private fileSync: Promise<void> = Promise.resolve()
  /** 这个进程里有记轮次位置的命令（用户的参数可能关掉了扩展） */
  private turnCommand = false
  /** 这次启动给分叉复制的会话文件；启动完就清空 */
  private forkCopy = ''
  /** 发出去还没做完的轮次标记：命令 id → 做完 */
  private readonly marking = new Map<string, () => void>()
  /** 正在关的旧 omp 进程（recycle）：关掉之前会话文件的租约还在它手里 */
  private closing: Promise<void> = Promise.resolve()
  /** 已经提示过的会话文件通知（omp 会重放） */
  private movedNotice = ''
  /** omp 的目标（docs/omp-engine.md §13.1）；没有为 null */
  private goalState: SessionGoal | null = null
  /** 这个 omp 进程有没有自带的 /context（没有的话发过去会进模型，花钱） */
  private contextBuiltin = false
  /** 正在取上下文明细；发出去到应答之间收到的内置命令输出先放 contextOutputs */
  private contextRead: Promise<ContextDiagnostic | null> | null = null
  private contextOutputs: string[] | null = null
  /** 有没有目标接口；null 是还没问过 */
  private goalSupported: boolean | null = null
  private goalSeq = 0
  /** 已经提醒过目标会一直用平台额度 */
  private goalWarned = false
  /** omp 各模型（provider/id）能不能开 Fast：试开一次记下来 */
  private readonly ompFastModels = new Map<string, boolean>()

  constructor(
    private readonly launcher: Launcher,
    private readonly env: NodeJS.ProcessEnv,
    private readonly ctx: SessionContext,
    private readonly options: PixelLaunchOptions = {},
  ) {
    this.settings = { ...ctx.record() }
    this.omp = options.flavor === 'omp'
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
      ...(this.omp ? { sessionFile: () => this.ctx.record().engineSessionId ?? null } : {}),
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
    // 等上一个进程核对完会话文件并退出：不然接的是旧文件，或租约还没放、又被改存到新文件
    if (this.omp) {
      await this.fileSync
      await this.closing
      if (this.closed) throw new Error('Pixel session is closed')
    }
    const record = this.ctx.record()
    const cwd = this.omp ? await ompCwd(record.engineSessionId, record.cwd) : record.cwd
    if (this.closed) throw new Error('Pixel session is closed')
    const launch = (this.options.launch ?? pixelLaunch)(
      this.env,
      record,
      this.settings.permissionMode,
      this.ctx.extensions,
      this.options,
    )
    const environment = launch.env,
      args = ['--mode', 'rpc', ...launch.args]
    // 会话里有过目标：启动时就打开这个文件，进行中的目标读回来是暂停的；switch_session 切过去的话，
    // omp 不等用户发消息就接着做（实测）
    if (this.omp && record.engineSessionId && ompHasGoal(record.engineSessionId))
      args.push('--session', record.engineSessionId)
    if (this.omp) this.launchedApproval = args[args.indexOf('--approval-mode') + 1] ?? null
    // 命令 id 每个进程从头数：上个进程没等到的标记不能吞掉这个进程的结束
    this.marking.clear()
    const proc = new PixelProcess(this.launcher, args, cwd, environment, {
      event: event => this.event(event),
      exit: (_code, tail) => {
        launch.cleanup?.()
        if (this.proc !== proc) return
        this.ready = false
        this.btw.abort('oh-my-pi 进程退出了，旁聊没有答完')
        if (this.omp) this.translator.stopOmpAgents()
        this.setGoal(null, false)
        this.rejectApprovals()
        this.mcpReporter.stale()
        for (const w of this.mcpWaiters.splice(0)) w.resolve({ error: '引擎进程已退出' })
        // 界面只显示「Error: …」那句，不显示 Node 印出来的压缩源码和调用栈（完整的 stderr 在进程日志里）
        if (!this.closed && this.active)
          this.finish('failed', (this.omp && ompStartupHint(tail)) || crashReason(tail) || 'Pixel process exited')
      },
    })
    this.proc = proc
    try {
      if (this.omp) await negotiateOmp(proc)
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
      const branch = this.omp ? await this.ompBranch(proc, record, cwd, string(state.sessionFile)) : null
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
      if (this.omp) await this.ompFastOff(proc)
      // 重试次数不用 set_auto_retry：它会写进用户自己的 ~/.pixelsky-cli/agent/settings.json，终端里也跟着不重试了；
      // 改成超过次数时 abort_retry（event 里的 auto_retry_start）
      state = object((await proc.request('get_state')).data)
      this.modelInfo = object(state.model)
      await this.syncEfforts(proc, string(state.thinkingLevel))
      this.ctx.setEngineSessionId(string(state.sessionFile) || string(state.sessionId))
      // 以前的子智能体：之后的 runs 事件是整份替换，要带上它们
      // 只要子智能体的条目：主会话文件可能有几百 MB，其余的行不解析
      const saved = this.omp ? [] : entries(string(state.sessionFile), SUBAGENT_ENTRY)
      if (this.omp) this.translator.seedOmpRuns(ompRunsFromSession(string(state.sessionFile), branch))
      // 换了分支：显示着的可能有回退掉的、或者（分叉）还没有
      if (branch) this.translator.emitRuns()
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
      const agents = this.omp ? this.translator.ompAgentTotals : subagentTotals(saved)
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
        fastAvailable: this.omp ? null : false,
        fastState: 'off',
        fastBlocked: this.omp ? null : 'pixel_speed_old_cli',
        ultracodeAvailable: this.omp ? this.ompUltracode(state) : false,
      }
      this.emitFlags()
      if (this.omp) await this.readGoal(proc, !!branch)
      await this.emitCommands(proc)
      // 回退只移动了内存里的位置，在树上落一条才留得住（重新打开从最后一条接着）
      if (branch) await this.markTurn(proc, '')
      if (this.omp && record.pendingRewind) this.ctx.clearPendingRewind?.()
      if (this.omp && record.pendingFork) this.ctx.clearPendingFork?.()
      this.ready = true
      this.forkCopy = ''
      this.refreshContext()
    } catch (error) {
      this.proc = null
      await proc.close()
      this.dropForkCopy()
      throw error
    }
  }

  /** 切终端前落实回退 / 分叉：起一次进程，不发消息 */
  async warm(): Promise<void> {
    await this.open()
    if (!this.resumeFailure) return
    // 没接上：下一条消息带交接
    const { reason } = this.resumeFailure
    this.resumeFailure = null
    this.ctx.forgetSeen?.()
    throw new Error(reason)
  }

  /**
   * omp：落实还没做的回退 / 分叉（omp/branch.ts），返回移到的位置。做不成就改用新会话（发送前带上交接，recoverLost），
   * 不能带着没截断的上下文继续
   */
  private async ompBranch(
    proc: PixelProcess,
    record: SessionRecord,
    cwd: string,
    ownFile: string,
  ): Promise<string | null> {
    const fork = record.engineSessionId ? null : record.pendingFork
    // 上次启动已经换到副本、后面失败了：engineSessionId 有了，位置还要再移一次
    let at = record.pendingRewind ?? record.pendingFork?.at
    if (!at || this.resumeFailure) return null
    try {
      if (fork) {
        // 自己的会话文件所在的文件夹就是 omp 给这个工作目录的；新会话还没写盘，文件夹可能也没有
        mkdirSync(dirname(ownFile), { recursive: true })
        const copy = (this.forkCopy = ompForkFile(fork.from, dirname(ownFile), cwd))
        // 来源的目标不带过去：切过去会马上接着做，变成两个会话同时做同一个目标
        at = ompDropGoal(copy, at)
        if (object((await proc.request('switch_session', { sessionPath: copy })).data).cancelled === true)
          throw new Error('切换会话被取消了')
      }
      if (object((await proc.request('navigate_tree', { entryId: at })).data).cancelled === true)
        throw new Error('移动位置被取消了')
      return at
    } catch (error) {
      if (!proc.alive) throw error
      this.resumeFailure = { exists: true, reason: (error as Error).message }
      await proc.request('new_session')
      this.dropForkCopy()
      return null
    }
  }

  /** 分叉没做成：复制出来的会话文件删掉，不留在用户的会话列表里 */
  private dropForkCopy(): void {
    const copy = this.forkCopy
    this.forkCopy = ''
    // 已经记成这个会话的文件：留着，下次接着用
    if (!copy || this.ctx.record().engineSessionId === copy) return
    try {
      rmSync(copy, { force: true })
      rmSync(copy.replace(/\.jsonl$/, ''), { recursive: true, force: true })
    } catch {
      // 还被占着：留一份没用的副本
    }
  }

  /** omp：在会话树上记一条轮次标记（omp/turn-ext.ts）。命令做完会另报一条 prompt_result，按 id 认，不算这一轮的 */
  private async markTurn(proc: PixelProcess, userItemId: string): Promise<void> {
    if (!this.turnCommand) return
    const limit = this.options.promptStartMs ?? PROMPT_START_MS
    let timer: NodeJS.Timeout | undefined
    const request = proc.request('prompt', { message: `/${OMP_TURN_COMMAND} ${userItemId}` }, limit)
    const id = proc.lastId
    const done = new Promise<void>((resolve, reject) => {
      this.marking.set(id, resolve)
      timer = setTimeout(() => reject(new Error(`oh-my-pi ${Math.round(limit / 1000)} 秒没有回应`)), limit)
      void proc.exitPromise.then(() => reject(new Error('oh-my-pi 进程退出了')))
    })
    try {
      await Promise.all([request, done])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * omp 的旁聊：进程没在跑就先起（续接同一会话），再用 btw 问。omp 把旁聊的用量算进会话统计，但不发主轮的用量事件：
   * 问前问后各取一次统计，扣掉这期间主轮自己记的，剩下的加进累计（不然下次重连用统计当基线时数字会跳）
   */
  get isClosed(): boolean {
    return this.closed
  }

  async ompSide(prompt: string, signal: AbortSignal): Promise<string> {
    if (!this.omp) throw new Error('当前引擎暂不支持旁聊')
    if (this.closed) throw new Error('会话已关闭')
    await this.open()
    // 进程是为这次旁聊新起的、没接上原来的会话：问了也是空的上下文
    if (this.resumeFailure) throw new Error('没能接上原来的 oh-my-pi 会话，先在主对话里发一条消息')
    const proc = this.proc
    if (!proc?.alive) throw new Error('oh-my-pi 没有在运行')
    const stats = async (): Promise<Totals | null> => {
      try {
        const data = (await proc.request('get_session_stats')).data
        const t = object(data.tokens)
        return {
          input: Number(t.input) || 0,
          output: Number(t.output) || 0,
          cacheRead: Number(t.cacheRead) || 0,
          cacheWrite: Number(t.cacheWrite) || 0,
          cost: Number(data.cost) || 0,
        }
      } catch {
        return null
      }
    }
    const before = await stats(),
      mainBefore = { ...this.translator.totals },
      agentsBefore = { ...this.translator.ompAgentTotals }
    const answer = await this.btw.ask(proc, prompt, signal)
    const after = before && this.proc === proc ? await stats() : null
    if (before && after) {
      const totals = this.translator.totals
      let added = false
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const) {
        // 统计里没有子智能体的：累计里它们这期间加的不能当成主轮的扣掉
        const agents = this.translator.ompAgentTotals[key] - agentsBefore[key]
        const extra = after[key] - before[key] - (totals[key] - mainBefore[key] - agents)
        if (extra > 0) {
          totals[key] += extra
          added = true
        }
      }
      if (added) this.translator.emitUsage()
    }
    return answer
  }

  /**
   * omp 的 Fast（docs/omp-engine.md §11.3）：set_fast_mode，以 get_state.fastModeActive 为准。能不能开按 omp 自己的规则
   * （OpenAI 家族的模型、用户自己的 anthropic / openai 账号；平台 Messages 线路上的 Claude「开」了也不生效），
   * 每个模型先试开一次记下来。开不了的退回关并提示；没有 Ultrafast
   */
  private async ompSpeed(proc: PixelProcess): Promise<void> {
    const wanted = pixelSpeedOf(this.settings) !== 'off'
    const modelInfo = this.modelInfo
    const key = `${string(modelInfo.provider)}/${string(modelInfo.id)}`
    let available = this.ompFastModels.get(key)
    // 只在要开时试：试开那一下，后台还在跑的子智能体发出的请求可能按 Fast 走
    if (available === undefined && wanted) {
      const probe = await proc.request('set_fast_mode', { enabled: true }).catch(() => null)
      available = object(probe?.data).active === true
      this.ompFastModels.set(key, available)
    }
    const enable = wanted && available === true
    await proc.request('set_fast_mode', { enabled: enable }).catch(() => {})
    const active = object((await proc.request('get_state')).data).fastModeActive === true
    // 要关却关不掉：不能带着 Fast 档发（§11.1）
    if (active && !enable) {
      proc.kill()
      throw new Error(OMP_FAST_STUCK)
    }
    if (enable && !active) this.ompFastModels.set(key, (available = false))
    // 没试过（一直关着）：不知道能不能开，开关照常可点
    const known = available ?? null
    this.speedApplied = active ? 'fast' : 'off'
    this.flags = {
      ...this.flags,
      fastAvailable: known,
      fastBlocked: known === false ? 'omp_fast_unavailable' : 'omp_fast_cost',
      fastState: active ? 'on' : 'off',
    }
    // 用户在 await 期间又改了：不能拿旧决定覆盖新选择
    if (wanted && !active && this.modelInfo === modelInfo && pixelSpeedOf(this.settings) !== 'off') {
      this.settings = { ...this.settings, fast: false, ultrafast: false }
      this.ctx.setFast(false)
      this.ctx.setUltrafast?.(false)
      this.translator.notice('warn', 'oh-my-pi 的这个模型不支持 Fast，已关闭')
    }
    this.emitFlags()
  }

  /** Ultracode 要 task 工具：用户用 --tools / --no-tools 关掉了就开不了，已开着的关掉并提示（同 Claude 不支持时） */
  private ompUltracode(state: Message): boolean {
    const available = array(state.dumpTools).some(t => string(object(t).name) === 'task')
    if (!available && this.settings.ultracode) {
      this.settings = { ...this.settings, ultracode: false }
      this.ctx.setUltracode(false)
      this.translator.notice('warn', 'oh-my-pi 没有 task 工具（启动参数关掉了），Ultracode 已关闭')
    }
    return available
  }

  /**
   * omp 的服务档位以我们的开关为准（打开进程、换模型后先关，每轮发送前 ompSpeed 再按开关设）：用户自己配置里的 tier.openai: priority、
   * 在 omp 终端里对这个会话用过的 /fast（记在会话文件里，续接时恢复）都会让请求悄悄带 service_tier: "priority"，
   * 平台按 Fast 加价扣费，界面却显示没开（实测，docs/omp-engine.md §11）。set_fast_mode 只改这个会话、不写配置；
   * 没有档位的模型它会报错，以 get_state.fastModeActive 为准，关不掉就不发这一轮
   */
  private async ompFastOff(proc: PixelProcess): Promise<void> {
    await proc.request('set_fast_mode', { enabled: false }).catch(() => {})
    const state = object((await proc.request('get_state')).data)
    if (state.fastModeActive !== true) return
    // 运行中换模型时也可能走到这里：结束进程，下一条消息重新连接时会再检查，不能带着 Fast 档留着
    proc.kill()
    throw new Error(OMP_FAST_STUCK)
  }

  private async emitCommands(proc: PixelProcess): Promise<void> {
    const name = this.omp ? 'get_available_commands' : 'get_commands'
    const found = await proc.request(name).catch(() => ({ command: name, data: {} as Message }))
    this.speedSupported = array(found.data.commands).some(c => object(c).name === SPEED_COMMAND)
    this.turnCommand = this.omp && array(found.data.commands).some(c => object(c).name === OMP_TURN_COMMAND)
    this.contextBuiltin =
      this.omp && array(found.data.commands).some(c => object(c).name === 'context' && object(c).source === 'builtin')
    const commands: SkillCommand[] = [
      {
        name: 'compact',
        description: 'Summarize the conversation to free up context',
        source: 'engine',
        builtin: true,
        invocation: 'slash',
      },
    ]
    if (this.goalSupported)
      commands.push({
        name: 'goal',
        description: 'Set a goal oh-my-pi keeps working toward (/goal pause · resume · clear)',
        source: 'engine',
        builtin: true,
        invocation: 'slash',
      })
    const own = new Set(commands.map(c => c.name))
    for (const raw of array(found.data.commands)) {
      const c = object(raw)
      const name = string(c.name)
      // omp 自己也列 /compact：只留一条
      if (own.has(name)) continue
      // 适配器自己用的扩展命令（切换权限模式、连接器操作）不列；用户自己装的扩展命令、技能和提示词模板照常给用户
      if (!name || (c.source === 'extension' && INTERNAL_COMMANDS.has(name))) continue
      commands.push({
        name,
        description: string(c.description),
        source: 'engine',
        // 这两条我们接过来做（run 里的交接、界面的导出），菜单里用我们的说明
        ...(this.omp && c.source === 'builtin' && (name === 'handoff' || name === 'export') ? { builtin: true } : {}),
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
        fastPending: pixelSpeedOf(this.settings) !== this.speedApplied,
        ...(this.efforts ? { efforts: { model: this.appliedModel, efforts: this.efforts } } : {}),
      },
    })
  }

  /** 串行同步，轮内修改只保留选择；run 在发送前固定本轮档位。 */
  private syncSpeed(proc: PixelProcess, forTurn = false): Promise<void> {
    const operation = async () => {
      if (!forTurn && this.active?.promptSent) {
        this.emitFlags()
        return
      }
      if (this.omp) return this.ompSpeed(proc)
      const wanted = pixelSpeedOf(this.settings)
      const modelInfo = this.modelInfo
      const caps = this.speedSupported ? pixelSpeedCapability(modelInfo) : { fast: false, ultrafast: false }
      const next: PixelSpeed =
        wanted === 'ultrafast' && caps.ultrafast ? wanted : wanted !== 'off' && caps.fast ? 'fast' : 'off'
      this.flags = {
        ...this.flags,
        fastAvailable: caps.fast,
        fastBlocked: !this.speedSupported
          ? 'pixel_speed_old_cli'
          : !caps.fast
            ? 'pixel_speed_unavailable'
            : 'pixel_speed_cost',
        pixelSpeed: { model: this.appliedModel, ...caps },
      }
      if (this.speedSupported) {
        const req = String(++this.speedSeq)
        const response = await proc.request('prompt', { message: `/${SPEED_COMMAND} ${next} ${req}` })
        const reply = this.speedReply
        if (response.data.disposition !== 'handled' || reply?.req !== req || reply.error || reply.speed !== next)
          throw new Error(string(reply?.error) || 'Pixel did not apply the service tier')
      }
      this.speedApplied = next
      // 用户在 await 期间又改了：不能拿旧决定覆盖新选择。
      if (this.modelInfo === modelInfo && pixelSpeedOf(this.settings) === wanted && next !== wanted) {
        this.settings = { ...this.settings, fast: next !== 'off', ultrafast: false }
        this.ctx.setUltrafast?.(false)
        this.ctx.setFast(next !== 'off')
        this.translator.notice('warn', 'Pixel speed was reset because this model or route has no confirmed support')
      }
      this.flags.fastState = next === 'off' ? 'off' : 'on'
      this.emitFlags()
    }
    const next = this.speedQueue.then(operation)
    this.speedQueue = next.catch(() => {})
    return next
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
    let active: ActiveTurn
    if (this.active?.auto) {
      // 目标自己接着做的一轮还在跑（宿主派发这条时它刚开始）：这条消息接管它，run() 再送进那一轮（同 Codex）
      active = this.active
      Object.assign(active, { id: turnId, auto: false, announced: true, taken: true })
    } else {
      if (this.active) {
        this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'failed', error: 'Pixel turn already running' })
        return
      }
      active = { id: turnId, started: Date.now(), promptSent: false }
      this.active = active
      this.asked.clear()
      this.translator.beginTurn()
    }
    this.promptUserSeen = false
    this.guidance.length = 0
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
    await this.syncSpeed(this.proc!, true)
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
    // omp 的交接（docs/omp-engine.md §13.2）：写一份交接文档代替前面的历史；当提示发的话等不到它做完
    const handoff = this.omp ? /^\/(?:handoff|compact\s+handoff)(?:\s+([\s\S]*))?$/.exec(text.trim()) : null
    if (this.omp) {
      await this.markTurn(proc, userItemId)
      if (this.active !== active || this.closed) return
    }
    active.promptSent = true
    const goal = this.omp ? parseGoalCommand(text) : null
    if (goal) return this.runGoal(goal, active, userItemId, attachments)
    // 接管的一轮：从这里起以这条消息的 prompt_result 结束
    Object.assign(active, { own: false, taken: false })
    if (this.omp && (handoff ?? compact)) {
      const instructions = (handoff ?? compact)![1]?.trim()
      this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'consumed', mode: 'normal' })
      return this.ompCompact(proc, active, handoff ? 'handoff' : 'compact', instructions)
    }
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
      // 目标正接着做时并进那一轮；空闲时和普通的一样（实测）
      ...(this.omp ? { streamingBehavior: 'steer' } : {}),
      ...(images.length
        ? { images: images.map(i => ({ type: 'image', data: i.dataBase64, mimeType: i.mediaType })) }
        : {}),
    })
    if (this.active !== active) return
    this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'consumed', mode: 'normal' })
    if (this.omp) void this.releaseGoal(proc)
    // handled：被扩展命令或输入处理器吃掉，不会有这一轮的 agent_settled；
    // omp 的 agentInvoked: false 是在本地做完了（内置斜杠命令等），不会再有 prompt_result
    if (string(response.data.disposition) === 'handled' || (this.omp && response.data.agentInvoked === false))
      this.finish('completed', null)
  }

  /** omp 的压缩、交接：回应就是结束；没成的原因写在压缩条目上 */
  private async ompCompact(
    proc: PixelProcess,
    active: ActiveTurn,
    type: 'handoff' | 'compact',
    instructions: string | undefined,
  ): Promise<void> {
    try {
      await proc.request(type, instructions ? { customInstructions: instructions } : {}, 10 * 60_000)
      const used = await this.contextTokens(proc)
      if (this.active === active && used !== null) this.translator.compactedTo(used)
    } catch (error) {
      if (this.active !== active) return
      if (active.stopped) return this.finish('interrupted', null)
      if (!this.translator.compactionShown) throw error
    }
    if (this.active === active) this.finish('completed', null)
  }

  private contextTokens(proc: PixelProcess): Promise<number | null> {
    return proc.request('get_session_stats', {}, 10_000).then(
      r => {
        const used = object(r.data.contextUsage).tokens
        return typeof used === 'number' ? used : null
      },
      () => null,
    )
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
    const reason = `${this.omp ? 'oh-my-pi' : 'Pixel'} ${Math.round(limit / 1000)} 秒没有开始处理这条消息，已让它停下`
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
        `没能接上原来的 ${this.omp ? 'oh-my-pi' : 'Pixel'} 会话，已改开新会话；下一条消息会把之前的聊天一起带过去`,
        failure.reason,
      )
      return null
    }
    if (!failure.exists && this.ctx.record().engineSessions) return null
    const recovered = this.ctx.lostSeed?.(userItemId, sees) ?? null
    if (!recovered) {
      this.translator.notice(
        'warn',
        `没能接上原来的 ${this.omp ? 'oh-my-pi' : 'Pixel'} 会话，已改开新会话（之前的上下文没有带过去）`,
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
    // 旁聊的帧不算主轮的动静（startPrompt 判断有没有开始处理）
    if (this.omp && this.btw.event(raw)) return
    const type = string(raw.type)
    this.lastEvent = Date.now()
    const marked = this.omp && type === 'prompt_result' ? this.marking.get(string(raw.id)) : undefined
    if (marked) {
      this.marking.delete(string(raw.id))
      return marked()
    }
    if (type === 'extension_ui_request') return this.uiRequest(raw)
    if (this.omp && type === 'notice' && string(raw.source) === 'session-persistence') this.sessionNotice(raw)
    if (type === 'thinking_level_changed') {
      // 不是我们自己在改（扩展换了强度、Pi 换模型时夹紧了）：记录跟着改成实际用的
      if (this.ready && !this.syncing) this.clamped(effortOfLevel(string(raw.level)))
      return
    }
    // 主智能体停了、子智能体还在后台跑：进度照样更新（omp 不会因此再让主智能体接着跑，实测）
    if (this.omp && !this.active && type === 'tool_execution_update' && string(raw.toolName) === SUBAGENT_TOOL)
      return this.translator.event(raw)
    if (this.omp && this.ompOwn(type, raw)) return
    if (!this.active) return
    if (type === 'agent_settled' && !this.omp) return this.settled(raw.aborted === true, '')
    if (this.omp && type === 'prompt_result') {
      // 会话还没安定（还有排着的后续）：等 session_settled
      if (raw.sessionSettled === false) this.active.result = raw
      else this.ompSettled(raw)
      return
    }
    if (this.omp && type === 'session_settled') {
      if (this.active.result) this.ompSettled(this.active.result)
      else if (this.active.own && !(this.active.taken && !this.active.stopped)) this.settled(false, '')
      return
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
    const proc = this.proc
    if (this.omp && proc && type === 'auto_compaction_end' && raw.aborted !== true)
      void this.contextTokens(proc).then(used => {
        if (used !== null && this.proc === proc) this.translator.compactedTo(used)
        this.refreshContext()
      })
    if (this.planUnlinked && type === 'tool_execution_start' && string(raw.toolName) === EXIT_PLAN_TOOL)
      this.linkPlanLate()
  }

  /** omp 自己开的轮次、目标、内置命令的输出；处理完、不用再往下走的返回 true */
  private ompOwn(type: string, raw: Message): boolean {
    if (type === 'goal_updated') {
      const goal = ompGoal(raw.goal)
      this.setGoal(goal, true)
      // 做完的目标 omp 那边就没有了
      if (goal?.status === 'complete') this.setGoal(null, false)
      return true
    }
    if (type === 'command_output') {
      if (this.contextOutputs) this.contextOutputs.push(string(raw.text))
      else this.showOutput(string(raw.text))
      return true
    }
    if (!this.ready || this.closed) return false
    // 安定了目标还在进行：omp 觉得没有进展（没调工具、只重复同样的），不再自己接着做
    if (type === 'session_settled' && this.goalState?.status === 'active' && this.active?.own && !this.active.stopped)
      this.goalNotice(NATIVE_TEXT.ompGoalIdle, 'warn')
    if (type === 'agent_start') {
      if (!this.active) this.beginAuto()
      this.active!.began = true
    } else if (type === 'message_start' && object(raw.message).customType === 'goal-continuation') this.continueGoal()
    return false
  }

  private showOutput(text: string): void {
    const output = ompOutput(text)
    if (output) this.translator.notice('info', output.text, output.detail)
  }

  /** 上下文明细（docs/omp-engine.md §15）：omp 自带的 /context，本机算、不进对话，运行中也能取 */
  async context(): Promise<ContextDiagnostic> {
    await this.open()
    const diagnostic = this.proc ? await this.readContext(this.proc) : null
    if (!diagnostic) throw new Error('oh-my-pi 没有给出上下文明细')
    return diagnostic
  }

  /** 连上、一轮结束、压缩、换模型之后自动取；取不到不提示 */
  private refreshContext(): void {
    const proc = this.proc
    if (proc?.alive && this.ready) void this.readContext(proc).catch(() => {})
  }

  private readContext(proc: PixelProcess): Promise<ContextDiagnostic | null> {
    if (!this.contextBuiltin) return Promise.resolve(null)
    this.contextRead ??= this.askContext(proc).finally(() => (this.contextRead = null))
    return this.contextRead
  }

  private async askContext(proc: PixelProcess): Promise<ContextDiagnostic | null> {
    const used = await this.contextTokens(proc)
    const outputs: string[] = (this.contextOutputs = [])
    try {
      // 不限时：前一条消息还在做发送前的准备（压缩）时排在它后面，放弃的话迟到的输出会显示到对话里
      const reply = await proc.request('prompt', { message: OMP_CONTEXT_COMMAND }, 0)
      // 输出紧挨在应答之前，最后一条合格的是自己的；别的（用户同时跑的 /usage 等）照常显示
      const model = string(this.modelInfo.id) || 'oh-my-pi'
      const parsed = outputs.map(text => ompContext(text, model, used))
      const own = parsed.findLastIndex(d => d !== null)
      // 进了模型、认不出格式：这个进程不再取
      const broken = own < 0 && outputs.length > 0 && !outputs.some(ompNoContext)
      if (reply.data.agentInvoked === true || broken) this.contextBuiltin = false
      if (own >= 0 || !broken)
        outputs.forEach((text, i) => {
          if (i !== own && !ompNoContext(text)) this.showOutput(text)
        })
      if (this.proc !== proc) return null
      const live = own >= 0
      if (live || !this.contextBuiltin) {
        if (!!this.flags.contextLive !== live) {
          this.flags = { ...this.flags, contextLive: live }
          this.emitFlags()
        }
      }
      if (live) this.translator.setDiagnostic(parsed[own]!)
      return live ? parsed[own]! : null
    } finally {
      this.contextOutputs = null
    }
  }

  /** 目标接着做了一次：用户那一轮、上一次接着做的那一轮到这里结束，另开一轮 */
  private continueGoal(): void {
    const active = this.active
    if (active?.own && !active.taken && !active.continued) {
      active.continued = true
      return
    }
    if (active) {
      // 用户的消息还没做完（刚接管、排着等送进去）：不算结束
      if (active.taken || (!active.own && !active.result)) return
      if (active.result) this.ompSettled(active.result)
      else this.settled(false, '')
    }
    // 结束时换了进程（权限档、模型变了）：不接着做了
    if (!this.ready) return
    // 结束时宿主可能马上派发了排队的消息（send）：那条消息并进这一轮
    if (!this.active) this.beginAuto()
    if (this.active) Object.assign(this.active, { began: true, continued: true })
  }

  /** omp 自己开了一轮：照普通的一轮显示、统计、收尾。晚一个宏任务告诉宿主，让它先派发排队的消息（同 Codex beginAuto） */
  private beginAuto(): void {
    const active: ActiveTurn = { id: randomUUID(), started: Date.now(), promptSent: true, own: true, auto: true }
    this.active = active
    // 这一轮没有提示：之后的用户消息都是引导
    this.promptUserSeen = true
    this.guidance.length = 0
    this.asked.clear()
    this.translator.beginTurn()
    setTimeout(() => this.announce(active), 0)
  }

  private announce(active: ActiveTurn): void {
    if (this.active !== active || !active.auto || active.announced) return
    active.announced = true
    this.ctx.emit({ type: 'turn_started', turnId: active.id, execution: queueSettings(this.ctx.record()) })
  }

  // ---------------------------------------------------------------------------
  // 目标（docs/omp-engine.md §13.1）
  // ---------------------------------------------------------------------------

  async goal(action: GoalAction): Promise<SessionGoal | null> {
    if (!this.omp) throw codedError(GOAL_NO_ENGINE)
    if (this.opening) await this.opening.catch(() => {})
    const proc = this.proc
    if (this.closed || !proc?.alive || !this.ready) throw codedError(GOAL_NO_PROCESS)
    return this.applyGoal(proc, action)
  }

  private async applyGoal(proc: PixelProcess, action: GoalAction): Promise<SessionGoal | null> {
    if (this.goalSupported === false) throw new Error(NATIVE_TEXT.ompGoalUnsupported)
    // 用户自己动了目标：关进程时记下的暂停作废
    if (action.kind !== 'get' && this.ctx.record().goalHeldAt != null) this.ctx.holdGoal?.(null)
    const op = async (name: string, extra: Message = {}): Promise<SessionGoal | null> => {
      const { data } = await proc.request('goal', { op: name, ...extra })
      this.setGoal(ompGoal(data.goal), false)
      return this.goalState
    }
    if (action.kind === 'get') return op('get')
    if (action.kind === 'clear') return this.goalState ? op('drop') : null
    if (action.kind === 'pause') {
      if (!this.goalState) throw new Error(NATIVE_TEXT.goalNone)
      return op('pause')
    }
    // 计划档是我们自己的扩展，omp 不知道，不会替我们拦
    if (this.settings.permissionMode === 'plan') throw new Error(NATIVE_TEXT.ompGoalPlan)
    if (action.kind === 'resume') {
      if (!this.goalState) throw new Error(NATIVE_TEXT.goalNone)
      if (this.goalState.status === 'active') return this.goalState
      return op('resume')
    }
    if (this.goalState) await op('drop')
    const goal = await op('create', { objective: action.objective })
    if (this.ctx.record().platform && !this.goalWarned) {
      this.goalWarned = true
      this.translator.notice('warn', NATIVE_TEXT.ompGoalCost)
    }
    return goal
  }

  /** 打开会话后读一次目标。接上的会话里目标该是暂停的：万一还在进行（换过文件），先停下，等用户发消息 */
  private async readGoal(proc: PixelProcess, branched: boolean): Promise<void> {
    // 回退、分叉：之前记下的暂停不作数
    if (branched && this.ctx.record().goalHeldAt != null) this.ctx.holdGoal?.(null)
    try {
      const { data } = await proc.request('goal', { op: 'get' }, 10_000)
      this.goalSupported = true
      const goal = ompGoal(data.goal)
      this.setGoal(goal, false)
      if (goal?.status !== 'active') return
      this.holdGoal()
      await proc.request('abort', {}, 10_000)
    } catch (error) {
      this.goalSupported = false
      log.info('读不到 oh-my-pi 的目标', { error: describeError(error) })
    }
  }

  /** 要关进程了、目标还在进行：记下来，下次发消息时接着做（omp 重新打开时目标是暂停的） */
  private holdGoal(): void {
    // 记成负数：和 Codex 的分开，换引擎后不会把对方停下的当成自己的
    if (this.goalState?.status === 'active') this.ctx.holdGoal?.(-Math.max(1, this.goalState.updatedAt))
  }

  /** 关进程时停下的目标：消息已经送进去了，改回进行中，这一轮做完 omp 接着做 */
  private async releaseGoal(proc: PixelProcess): Promise<void> {
    const held = this.ctx.record().goalHeldAt
    if (held == null || held >= 0 || this.settings.permissionMode === 'plan') return
    this.ctx.holdGoal?.(null)
    if (this.goalState?.status !== 'paused' || !proc.alive) return
    await this.applyGoal(proc, { kind: 'resume' }).catch(error =>
      log.info('目标没能改回进行中', { error: describeError(error) }),
    )
  }

  /** 目标变了：告诉界面；announce 时（omp 自己报的）完成、预算用完在对话里说一句 */
  private setGoal(next: SessionGoal | null, announce: boolean): void {
    const prev = this.goalState
    if (sameGoal(prev, next)) return
    this.goalState = next
    this.ctx.emit({ type: 'goal', goal: next })
    if (!announce || !next || prev?.status === next.status) return
    if (next.status === 'complete') this.goalNotice(NATIVE_TEXT.goalComplete(next.objective))
    else if (next.status === 'budgetLimited') this.goalNotice(NATIVE_TEXT.goalBudgetLimited, 'warn')
  }

  private goalNotice(text: string, level: 'info' | 'warn' = 'info'): void {
    this.ctx.emit({
      type: 'item_completed',
      item: { kind: 'notice', id: `px-goal-${Date.now()}-${++this.goalSeq}`, level, text, detail: null },
    })
  }

  /** 输入框发来的 /goal（进程没在跑时按普通消息发过来的）：做完说一句；设目标 / 继续后 omp 自己开跑，就接在这一轮里 */
  private async runGoal(
    action: GoalAction,
    active: ActiveTurn,
    userItemId: string,
    attachments: ImageAttachment[],
  ): Promise<void> {
    this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'consumed', mode: 'normal' })
    // 接管的一轮照旧由 omp 跑完；自己开的这一轮只在 omp 开跑时留着
    const running = !!active.taken
    Object.assign(active, { own: true, taken: false })
    const end = (): void => {
      if (this.active === active && !active.began && !running) this.finish('completed', null)
    }
    if (attachments.length) {
      this.goalNotice(NATIVE_TEXT.goalImages, 'warn')
      return end()
    }
    let goal: SessionGoal | null
    try {
      goal = await this.applyGoal(this.proc!, action)
    } catch (error) {
      this.goalNotice((error as Error).message, 'warn')
      return end()
    }
    if (this.active !== active) return
    if (action.kind === 'get')
      this.goalNotice(
        goal ? NATIVE_TEXT.goalShow(goal.objective, NATIVE_TEXT.goalStatus[goal.status]) : NATIVE_TEXT.goalNone,
      )
    else if (action.kind === 'pause') this.goalNotice(NATIVE_TEXT.goalPaused)
    else if (action.kind === 'clear') this.goalNotice(NATIVE_TEXT.goalCleared)
    else {
      this.goalNotice(
        action.kind === 'set' ? NATIVE_TEXT.goalSet(action.objective, 'oh-my-pi') : NATIVE_TEXT.goalResumed,
      )
      for (let i = 0; i < 30 && this.active === active && !active.began && !this.closed; i++)
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    end()
  }

  /** omp 的会话文件通知：被别的进程占着、在外面被改过时，它把会话改存到新文件 */
  private sessionNotice(raw: Message): void {
    this.syncFile()
    const text = string(raw.message)
    if (!text.includes('now saves to') || text === this.movedNotice) return
    this.movedNotice = text
    this.translator.notice('warn', OMP_SESSION_MOVED, text)
  }

  /**
   * omp 的会话文件可能在运行中换掉（被别的 omp 进程占着、用户发了 /new 之类）：记录跟着改，
   * 不然下次起进程接的是旧文件，之后聊的都不见了
   */
  private syncFile(): void {
    const proc = this.proc
    if (!this.omp || !this.ready || !proc?.alive) return
    this.fileSync = proc.request('get_state', {}, 5_000).then(
      ({ data }) => {
        // 期间换了进程、会话关了或换了引擎：不是现在这个会话的文件
        if (this.closed || (this.proc && this.proc !== proc) || this.ctx.record().engine !== 'omp') return
        const file = string(data.sessionFile)
        if (file && file !== this.ctx.record().engineSessionId) this.ctx.setEngineSessionId(file)
      },
      () => {},
    )
  }

  /** 计划卡先到、exit_plan_mode 条目后到（omp）：挂到条目上，卡片重发一次（同一个 requestId 是替换） */
  private linkPlanLate(): void {
    const id = this.planUnlinked!
    this.planUnlinked = null
    const pending = this.approvals.get(id)
    if (!pending) return
    const item = this.translator.runningTool(EXIT_PLAN_TOOL, new Set([...this.linked.values(), ...this.asked]))
    if (!item) return
    this.link(id, item.id)
    pending.request = { ...pending.request, itemId: item.id }
    this.ctx.emit({ type: 'approval_request', request: pending.request })
  }

  /** 一轮结束：停下的（提示一直没开始、是我们让它停的按失败结束，说明原因）、出错的、完成的 */
  private settled(aborted: boolean, error: string): void {
    const failure = this.active?.failure
    if (this.active?.stopped && !failure) return this.finish('interrupted', null)
    if (aborted) return failure ? this.finish('failed', failure) : this.finish('interrupted', null)
    const reason = this.translator.takeError() || error
    return reason ? this.finish('failed', reason) : this.finish('completed', null)
  }

  /** omp 的 prompt_result：status 是 completed / aborted / error（error.message 是原因） */
  private ompSettled(result: Message): void {
    const status = string(result.status)
    this.settled(
      status === 'aborted',
      status === 'error' ? string(object(result.error).message) || 'oh-my-pi 出错了' : '',
    )
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
      else if (key === SPEED_COMMAND) {
        try {
          const value = object(JSON.parse(string(raw.statusText)))
          if (value.version !== 1) return
          if (value.req) this.speedReply = value
          if (
            typeof value.requestedTier === 'string' &&
            value.model === `${this.modelInfo.provider}/${this.modelInfo.id}` &&
            this.flags.pixelSpeed
          ) {
            this.flags.pixelSpeed = {
              ...this.flags.pixelSpeed,
              requestedTier: value.requestedTier,
              actualTier: typeof value.actualTier === 'string' ? value.actualTier : null,
            }
            this.emitFlags()
          }
        } catch {
          /* 不把扩展错误输出当成成功 */
        }
      } else if (key === OMP_SUB_STATUS && this.omp) {
        try {
          const used = object(JSON.parse(string(raw.statusText)))
          this.translator.ompAgentUses(string(used.id), string(used.model), string(used.effort))
        } catch {
          // 格式不对：不显示
        }
      } else if (key === APPROVAL_CONTEXT_STATUS) this.approvalContext = subagentApproval(string(raw.statusText))
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
      // omp：扩展工具的对话框比它的 tool_execution_start 先到（实测），条目来了再挂上（event 里）
      else if (this.omp) this.planUnlinked = id
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
    if (!mode || mode === this.settings.permissionMode || this.modeChanges > 0) return
    this.settings.permissionMode = mode
    this.ctx.setPermissionMode(mode)
    // omp 批准计划后：进程的 --approval-mode 和回到的档不一致（回到「完全放行」时计划阶段最多是自动改文件）就换进程，
    // 这一轮做完再换（ompApproval）
    const approval = this.options.approvalMode?.(mode)
    if (this.omp && this.launchedApproval && approval && approval !== this.launchedApproval) {
      if (this.active) this.modeRestart = true
      else this.recycle()
    }
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
      // 照它给的选项回（isApprovalSelect 认过结构）：Pi 是我们批准扩展的中文三项，omp 是它自己的英文三项
      const [once, always, deny] = approval.options
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
    this.announce(active)
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
    this.syncFile()
    // 换了要换进程的模型（网关注册的不一样）：目标不能用旧进程、旧模型接着做
    const stale = this.goalState?.status === 'active' && this.restartsForModel(this.ctx.record().model)
    if (this.modeRestart || stale) this.recycle()
    else this.refreshContext()
  }

  /** omp 没有运行中改权限档的命令：关掉进程，下一轮按新档重启，续接同一会话（engineSessionId 是会话文件） */
  private recycle(): void {
    this.modeRestart = false
    const proc = this.proc
    if (!proc) return
    if (this.goalState?.status === 'active') {
      this.holdGoal()
      this.goalNotice(NATIVE_TEXT.ompGoalHeld, 'warn')
    }
    this.proc = null
    this.ready = false
    this.rejectApprovals()
    this.btw.abort('oh-my-pi 换了进程（权限档、设置变了），旁聊被打断，请再问一次')
    this.translator.stopOmpAgents()
    this.setGoal(null, false)
    this.closing = this.fileSync.then(() => proc.close())
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

  async interrupt(opts?: InterruptOptions): Promise<void> {
    if (!this.active) return
    await this.interruptTurn()
    // 先停主轮再停子智能体：反过来的话，子智能体「被停了」的结果会让主智能体接着请求
    if (this.omp && opts?.background) await this.stopWithMain()
  }

  /**
   * 停主智能体时连同 omp 的子智能体一起停（docs/ui/subagent-stop.md）：排队的取消不了（cancel_subagent 只认在跑的，实测），
   * 补上来再停，停到列表空为止；到时间还没停干净就结束进程，它们跟着没了，下一条消息再接上
   */
  private async stopWithMain(): Promise<void> {
    const proc = this.proc
    if (!proc?.alive) return
    const stopped = new Map<string, string>()
    const deadline = Date.now() + STOP_AGENTS_MS
    while (Date.now() < deadline && proc.alive) {
      const list = await this.ompAgents(proc)
      if (!list) break
      if (!list.length && !this.translator.ompLive().length) break
      await Promise.all(
        list.map(async a => {
          const id = string(a.id)
          if (!stopped.has(id) && (await this.cancelAgent(proc, id))) stopped.set(id, string(a.description) || id)
        }),
      )
      await new Promise(r => setTimeout(r, 30))
    }
    for (const r of this.translator.ompLive()) stopped.set(r.id, r.label)
    // 没停干净（或问不到）：结束进程，退出时把还在跑的记成已停止
    if (proc.alive && this.translator.ompLive().length) proc.kill()
    if (stopped.size)
      this.translator.notice(
        'info',
        `已停止，连同 ${stopped.size} 个后台子智能体（${[...stopped.values()].join('、')}）`,
      )
  }

  /** omp 还没结束的子智能体（含嵌套的）；问不到为 null */
  private ompAgents(proc: PixelProcess): Promise<Message[] | null> {
    return proc.request('get_subagents', {}, 2_000).then(
      r =>
        array(r.data.subagents)
          .map(object)
          .filter(a => a.status === 'running' || a.status === 'pending'),
      () => null,
    )
  }

  private cancelAgent(proc: PixelProcess, subagentId: string): Promise<boolean> {
    return proc.request('cancel_subagent', { subagentId }, 5_000).then(
      r => r.data.cancelled === true,
      () => false,
    )
  }

  /** 只停一个子智能体（omp）：主智能体会收到「被停了」的结果，自己决定怎么接 */
  async stopTask(taskId: string): Promise<void> {
    const proc = this.proc
    if (!this.omp) throw new Error('这个引擎没有后台任务')
    if (!proc?.alive || !this.ready) throw new Error('引擎没有在运行')
    if (await this.cancelAgent(proc, taskId)) return
    // 没停成：已经结束的不算错
    if (this.translator.ompLive().some(r => r.id === taskId)) throw new Error('这个子智能体没有停下来')
  }

  private async interruptTurn(): Promise<void> {
    const active = this.active
    if (!active) return
    if (!active.promptSent || !this.proc?.alive) {
      // 提示还没发出去（进程在启动、连接要发好几个请求）：不等连接完，本地直接结束；run() 发现已结束就不发了，
      // 连接在后台照常做完，进程留给下一轮（close() 会直接关掉它，连接中的请求跟着失败）
      this.finish('interrupted', null)
      return
    }
    if (this.omp) active.stopped = true
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
    const revision = ++this.settingsRevision
    const before = this.settings
    this.settings = { ...before, ...patch }
    const proc = this.proc
    if (!proc?.alive || !this.ready) return
    this.syncing++
    const speedChanged = patch.fast !== undefined || patch.ultrafast !== undefined
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
          // omp 的档位按模型家族记（tier.openai / tier.anthropic）：换到另一家的模型要重新关
          if (this.omp) await this.ompFastOff(proc)
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
      if (speedChanged || thinking) await this.syncSpeed(proc)
      if (thinking) this.refreshContext()
      if (this.omp && ompRestarts(before, patch)) {
        // 有一轮在跑就等它结束（finish 里关），否则马上关；下一轮 connect 带新的 --approval-mode / --config
        if (this.active) this.modeRestart = true
        else this.recycle()
      } else if (patch.permissionMode !== undefined && patch.permissionMode !== before.permissionMode) {
        // 批准扩展的命令：prompt 里以 / 开头的扩展命令立即执行，不进模型，回应 disposition 为 handled
        this.modeChanges++
        const response = await proc
          .request('prompt', { message: `/${MODE_COMMAND} ${PIXEL_MODES[patch.permissionMode]}` })
          .finally(() => this.modeChanges--)
        if (string(response.data.disposition) !== 'handled') throw new Error('Pixel did not switch the permission mode')
      }
    } catch (error) {
      // 没生效：退回原值，下一轮开始前（strict）报错；宽松调用只记设置
      if (speedChanged) {
        if (revision === this.settingsRevision) {
          this.settings = {
            ...this.settings,
            fast: this.speedApplied !== 'off',
            ultrafast: this.speedApplied === 'ultrafast',
          }
          this.ctx.setFast(this.settings.fast)
          this.ctx.setUltrafast?.(this.settings.ultrafast === true)
        }
        this.emitFlags()
        throw error
      }
      if (revision === this.settingsRevision) this.settings = before
      if (strict) throw error
    } finally {
      this.syncing--
    }
  }

  async mcp(op: McpOp): Promise<McpOpResult> {
    const proc = this.proc
    // omp 的 MCP 照它自己的配置走，没有我们的 /pixelsky-mcp 命令（发过去会当成一条消息交给模型）
    if (this.omp) {
      if (op.kind === 'refresh') return { report: null }
      throw new Error('这个引擎不报告连接器状态')
    }
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
    if (this.omp) this.holdGoal()
    this.closed = true
    this.btw.abort('会话已关闭')
    this.mcpReporter.dispose()
    await this.interrupt()
    this.rejectApprovals()
    if (this.omp) this.translator.stopOmpAgents()
    await this.proc?.close(opts.quick ? QUICK_CLOSE_MS : undefined)
    this.ctx.extensions?.dispose?.()
  }
}

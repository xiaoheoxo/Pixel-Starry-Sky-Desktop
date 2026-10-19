// 一个会话对应的 Claude Code 进程：启动 / 恢复、发消息、审批、中断、改设置（docs/engines.md §9）
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  codedError,
  contextDiagnostic,
  EMPTY_FLAGS,
  type ContextDetailLevel,
  type ContextDiagnostic,
  type ApprovalDecision,
  type ImageAttachment,
  type InterruptOptions,
  type PermissionMode,
  type SessionFlags,
  type SessionSettings,
  type McpOp,
  type McpOpResult,
  type TaskOutput,
  parseCodedError,
  viaGateway,
} from '@pixelsky/protocol'
import { queueSettings } from '../queue'
import { NO_REPLY, seedTurns, type ChatSeed } from '../chat-log'
import { QUICK_CLOSE_MS, type CloseOptions, type EngineSession, type Launcher, type SessionContext } from '../adapter'
import type { QuotaReading } from '../quota'
import { claudeMcpServers, McpReporter } from '../mcp'
import { ClaudeProcess, ownClaudePids, type ControlRequestFromCli } from './process'
import { parseClaudeRateLimitEvent, parseClaudeUsage, unknownControl } from './quota'
import { liveClaudeSession } from './native'
import { loadSavedRuns } from './runs'
import { alwaysPermissions, approvalFor } from './tools'
import {
  anchorPosition,
  claudeSessionDir,
  claudeTranscriptExists,
  copyTranscriptUntil,
  findClaudeTranscript,
  seedTranscript,
} from './transcript'
import { ClaudeTranslator } from './translate'
import { obj, str } from './shape'
import { claudeModelName, type ModelSettings } from './long-context'

type Msg = Record<string, unknown>

/** 我们的权限模式 → Claude 的 --permission-mode */
export const TO_CLAUDE_MODE: Record<PermissionMode, string> = {
  ask: 'default',
  edits: 'acceptEdits',
  plan: 'plan',
  full: 'bypassPermissions',
}

/**
 * 固定参数：
 * - stream-json 双向 + 流式增量；
 * - 审批走 stdio 上的 control 协议（can_use_tool）；
 * - --allow-dangerously-skip-permissions 只是「允许中途切到完全放行」，本身不放行任何操作。
 */
const BASE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--replay-user-messages',
  '--permission-prompt-tool',
  'stdio',
  '--allow-dangerously-skip-permissions',
]

/**
 * 像素星空自己控制的参数（docs/ui/engine-launch.md §3），用户追加的参数里不能出现：
 * 协议和流式输出、审批、模型与推理强度（输入框里选）、会话恢复、--settings（输出风格和平台网关用它传）。
 */
const CLAUDE_RESERVED = new Set([
  '-p',
  '--print',
  '--input-format',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--replay-user-messages',
  '--permission-prompt-tool',
  '--allow-dangerously-skip-permissions',
  '--dangerously-skip-permissions',
  '--permission-mode',
  '--model',
  '--effort',
  '-r',
  '--resume',
  '-c',
  '--continue',
  '--session-id',
  '--resume-session-at',
  '--fork-session',
  '--settings',
])

/** 用户追加的参数里第一个由像素星空控制的参数（--x=y 写法、连写的短参数 -pc 也算）；都允许时返回 null */
export function reservedClaudeArg(args: readonly string[]): string | null {
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0]
      if (CLAUDE_RESERVED.has(name)) return name
    } else if (/^-[A-Za-z]+$/.test(arg)) {
      for (const ch of arg.slice(1)) if (CLAUDE_RESERVED.has(`-${ch}`)) return `-${ch}`
    }
  }
  return null
}

/** 设置 › 本机引擎里对 Claude Code 的引擎级选项（docs/ui/engine-settings-redesign.md §3.2） */
export interface ClaudeLaunchOptions {
  /** 输出风格；null 跟随 Claude Code 自己的设置 */
  outputStyle: string | null
  /** false 时禁用 AskUserQuestion：遇到需要选择的地方自己拿主意 */
  askQuestions: boolean
  /** 用户追加的启动参数，放在所有参数最后（docs/ui/engine-launch.md） */
  args?: string[]
  /** 云端 / 本机模型填了上下文窗口时按模型的自动压缩窗口，进 --settings（GitHub #20） */
  modelSettings?: ModelSettings | null
}

export function claudeArgs(
  settings: SessionSettings,
  sessionId: string,
  resume: boolean,
  launch?: ClaudeLaunchOptions,
  rewindAt?: string | null,
  fork?: { from: string; at: string } | null,
): string[] {
  const args = [...BASE_ARGS, '--permission-mode', TO_CLAUDE_MODE[settings.permissionMode]]
  if (settings.model) args.push('--model', settings.model)
  if (settings.effort) args.push('--effort', settings.effort)
  if (launch && !launch.askQuestions) args.push('--disallowedTools', 'AskUserQuestion')
  // 分叉：从原会话的截断点复制出一份，用新的 id 保存（docs/ui/rewind-fork-sidechat.md §2）
  if (!resume && fork)
    args.push('--resume', fork.from, '--fork-session', '--session-id', sessionId, `--resume-session-at=${fork.at}`)
  else args.push(resume ? '--resume' : '--session-id', sessionId)
  // 回退：只恢复到这条记录为止，之后的对话不再进入上下文（docs/ui/chat-fixes-queue-actions-cost.md §2.3）
  if (resume && rewindAt) args.push(`--resume-session-at=${rewindAt}`)
  return args
}

export interface ClaudeSessionDeps {
  extensions?: import('@pixelsky/protocol').ExtensionLaunch
  maxRetries?: number | null
  /** 引擎级选项（输出风格、允许提问） */
  launch?: ClaudeLaunchOptions
  launcher: Launcher
  env: NodeJS.ProcessEnv
  projectsDir: string
  steeringValidated?: boolean
  /** initialize 回包到了（宿主拿去更新模型目录缓存） */
  onInitialize?: (init: Record<string, unknown>) => void
}

/** 进程在回应 initialize 之前就退出了 */
/** 截断点在上下文压缩之前、又没能复制记录时的提示（docs/ui/rewind-fork-sidechat.md §2.4） */
const COMPACTED_NOTICE =
  '这条消息在上下文压缩之前，Claude Code 没法从这里接着，已开始新的引擎会话（之前的上下文没有带过去）'

class StartupError extends Error {
  constructor(readonly stderr: string) {
    super(lastLines(stderr) || 'Claude Code 启动失败')
  }
}

function lastLines(text: string, n = 6): string {
  return text.trim().split(/\r?\n/).slice(-n).join('\n')
}

/** Fast 模式开不了的原因（CLI 的 fast_mode_disabled_reason） */
const FAST_BLOCKED: Record<string, string> = {
  free: '免费账号不能使用',
  preference: '账号没有开启 Fast 模式',
  extra_usage_disabled: '账号没有开启额外用量',
  network_error: '网络错误',
  not_first_party: '只支持 Anthropic 官方接口',
  disabled_by_env: '被环境变量关闭了',
  model_not_allowed: '当前模型不支持',
  pending: '正在确认账号状态',
  unknown: '原因未知',
}

export function fastBlockedText(reason: string | null): string {
  return reason ? (FAST_BLOCKED[reason] ?? reason) : ''
}

/**
 * --settings 的值：平台网关配置、重试次数、引擎级设置（如 outputStyle）合在一起。
 * 用进程级 settings 的 env 覆盖本机配置，同时保留平台回环代理设置。
 * 什么都不用加时原样返回网关配置文件（或 null）；带网关配置时合并结果写进临时文件，只把路径放进 argv。
 */
export function claudeSettingsArgument(
  gatewayFile: string | undefined,
  maxRetries: number | null,
  extra: Record<string, unknown> = {},
): string | null {
  if (maxRetries === null && Object.keys(extra).length === 0) return gatewayFile ?? null
  const settings = gatewayFile ? (JSON.parse(readFileSync(gatewayFile, 'utf8')) as Record<string, unknown>) : {}
  const configured = obj(settings.env)
  const env = maxRetries === null ? configured : { ...configured, CLAUDE_CODE_MAX_RETRIES: String(maxRetries) }
  // modelSettings 按模型合并：网关文件里自定义 API 的和设置里云端 / 本机的各管各的模型
  const models = { ...obj(settings.modelSettings), ...obj(extra.modelSettings) }
  const merged = JSON.stringify({
    ...settings,
    ...extra,
    ...(Object.keys(models).length > 0 ? { modelSettings: models } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  })
  if (!gatewayFile) return merged
  // 平台配置含本机回环凭据，只把文件路径放进 argv。
  const retryFile = `${gatewayFile}.retry-${randomUUID()}.json`
  writeFileSync(retryFile, merged, { mode: 0o600 })
  return retryFile
}

/** 没有原因，或只差 SDK 的显式开启（开启请求本身就是），就能开 */
function fastCanTurnOn(state: string, blocked: string): boolean {
  return state === 'on' || blocked === '' || blocked === 'sdk_opt_in_required'
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

interface PendingApproval {
  toolName: string
  toolUseId: string | null
  input: Msg
  suggestions: unknown[]
}

export class ClaudeSession implements EngineSession {
  private contextJob: {
    id: string
    value: ContextDiagnostic | null
    resolve: (value: ContextDiagnostic) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null
  private retrySettingsFile: string | null = null
  /** 控制请求 get_context_usage 能不能用；null 是还没试过（旧版 CLI 不认识它，退回 /context） */
  private usageRequest: boolean | null = null
  /** 仅显式引导进入 CLI 的队列；普通消息一直留在 EngineHost。 */
  private guidance = new Map<string, { text: string }>()
  private capabilities = new Set<string>()
  /** 这一轮发出去的用户消息 id，等 CLI 回显（--replay-user-messages）确认收到；回显到了或没有这一轮时为 null，每轮只确认一次 */
  private ackPending: string | null = null
  private proc: ClaudeProcess | null = null
  /** 会话里的 MCP 服务器（控制请求 mcp_status），docs/ui/connectors.md */
  private readonly mcpReporter: McpReporter
  /** 当前进程启动时是不是走本机网关：额度的来源按它判断，不读当前记录（换通道要等下一条消息才换进程） */
  private procViaGateway = false
  private starting: Promise<ClaudeProcess> | null = null
  /** 跨引擎接力还没注入的聊天：启动进程时写进会话记录；进程已经在跑或写不进去时，发消息时退回文字交接 */
  private seed: ChatSeed | null = null
  private readonly translator: ClaudeTranslator
  private readonly approvals = new Map<string, PendingApproval>()
  private turnWaiters: Array<() => void> = []
  private closed = false
  /** 中断超时、正在强制结束进程 */
  private killing = false
  private flags: SessionFlags = { ...EMPTY_FLAGS }

  constructor(
    private readonly ctx: SessionContext,
    private readonly deps: ClaudeSessionDeps,
  ) {
    this.mcpReporter = new McpReporter(
      e => ctx.emit(e),
      ['reconnect', 'toggle', 'login'],
      async () => {
        const proc = this.proc
        return proc?.alive ? claudeMcpServers(await proc.request('mcp_status', {}, 10_000)) : null
      },
    )
    this.translator = new ClaudeTranslator(ctx.record().cwd, {
      emit: e => ctx.emit(e),
      sessionId: id => {
        if (id !== ctx.record().engineSessionId) ctx.setEngineSessionId(id)
      },
      permissionMode: mode => {
        if (mode !== ctx.record().permissionMode) ctx.setPermissionMode(mode)
      },
      fastState: (state, blocked) => this.onFastState(state, blocked),
      turnEnded: () => {
        this.approvals.clear()
        const waiters = this.turnWaiters
        this.turnWaiters = []
        for (const w of waiters) w()
        // 每轮结束顺手取一次明细（summary 不调接口），弹窗打开就有 MCP / Skills 等分类
        if (this.proc?.alive && this.usageRequest) void this.usage(this.proc, 'summary').catch(() => undefined)
        void this.mcpReporter.refresh().catch(() => undefined)
      },
    })
  }

  private setFlags(patch: Partial<SessionFlags>): void {
    const next = { ...this.flags, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.flags)) return
    this.flags = next
    this.ctx.emit({ type: 'flags', flags: { ...next } })
  }

  private onFastState(state: string, blocked: string): void {
    const fastState = state === 'on' || state === 'cooldown' ? state : 'off'
    this.setFlags({ fastState, fastBlocked: blocked || null, fastAvailable: fastCanTurnOn(state, blocked) })
  }

  /** 以前的编排和子智能体放进追踪数据（只读一次） */
  private seeded = false
  private seedRuns(): void {
    if (this.seeded) return
    this.seeded = true
    const rec = this.ctx.record()
    const dir = claudeSessionDir(this.deps.projectsDir, rec.cwd, rec.engineSessionId ?? rec.id)
    if (dir) this.translator.runs.seed(loadSavedRuns(dir))
  }

  send(text: string, turnId: string, userItemId: string, attachments?: ImageAttachment[], seed?: ChatSeed): void {
    this.translator.startTurn(turnId)
    this.ackPending = userItemId
    if (seed) this.seed = seed
    this.ensureProcess().then(
      // 启动期间用户已停止时，不让延迟完成的 spawn 再把原文送出。
      proc => {
        if (this.closed || this.translator.activeTurn !== turnId) return
        // 启动时没注入进记录（进程本来就在跑、有待执行的回退 / 分叉、写入失败）：交接材料加在消息前面，
        // 材料里说明过的更早消息的图片排在消息自己的图片前面一起发
        const left = this.seed
        this.seed = null
        proc.sendUserMessage(
          left ? `${left.fallback}\n\n${text}` : text,
          userItemId,
          left?.fallbackImages?.length ? [...left.fallbackImages, ...(attachments ?? [])] : attachments,
        )
      },
      // 带代码的错误（resume.live）原样给界面，界面按代码给出「复制一份接着聊」
      (err: Error) =>
        this.translator.abortTurn(parseCodedError(err.message) ? err.message : `无法启动 Claude Code：${err.message}`),
    )
  }

  /**
   * 上下文明细。新版 CLI 用控制请求 get_context_usage：不进对话，运行中也能取（docs/ui/context-window.md §6）；
   * 旧版退回发 /context，只能在空闲时由宿主调用。
   */
  async context(detail: ContextDetailLevel = 'full'): Promise<ContextDiagnostic> {
    if (this.contextJob) throw new Error('上下文明细正在刷新')
    const proc = await this.ensureProcess()
    if (this.usageRequest !== false) {
      const diagnostic = await this.usage(proc, detail)
      if (diagnostic) return diagnostic
    }
    if (this.translator.activeTurn) throw new Error('等待当前任务和排队消息结束后刷新明细')
    if (!this.flags.contextAvailable) throw new Error('当前 Claude Code 未提供上下文诊断')
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        if (this.contextJob?.id !== id) return
        this.contextJob = null
        // 超时诊断可能仍在运行，不让后续普通消息与迟到 result 混在一起。
        proc.kill()
        void proc.exitPromise.then(() => reject(new Error('上下文诊断超时，原会话记录保留，可重试')))
      }, 15000)
      this.contextJob = { id, value: null, resolve, reject, timer }
      proc.sendUserMessage('/context', id)
    })
  }

  /** 发 get_context_usage；CLI 不认识或回的不是结构化明细时记下来，返回 null 让调用方退回 /context */
  private async usage(proc: ClaudeProcess, detail: ContextDetailLevel): Promise<ContextDiagnostic | null> {
    let raw: Msg
    try {
      raw = await proc.request('get_context_usage', { detail }, detail === 'full' ? 60_000 : 10_000)
    } catch (err) {
      if (!proc.alive || /没有回应/.test((err as Error).message)) throw err
      this.markUsage(false)
      return null
    }
    const diagnostic = this.translator.context.diagnostic(raw, detail)
    this.markUsage(!!diagnostic)
    return diagnostic
  }

  /**
   * 借活着的进程问账号额度（get_usage 不进对话、不占队列，运行中也能发）；没有进程或走网关时返回 null，
   * 绝不为它起会话进程（不能用 ensureProcess：会为此起进程并 --resume 对话）。会话里拿不到账号邮箱，account 填 null
   */
  accountQuota(): Promise<QuotaReading> | null {
    const proc = this.proc
    if (this.closed || !proc?.alive || this.procViaGateway) return null
    return proc.request('get_usage', { skip_behaviors: true }, 20_000).then(
      raw => parseClaudeUsage(raw, Date.now()),
      err => (unknownControl(err) ? { kind: 'no-request' as const } : Promise.reject(err)),
    )
  }

  /** 每次请求后的 rate_limit_event：平台 / 自定义接口经本机网关，事件里是上游账号或网关的数据，不能算到用户自己的账号上 */
  private onRateLimit(msg: Msg): void {
    if (this.procViaGateway) return
    const patch = parseClaudeRateLimitEvent(msg.rate_limit_info, Date.now())
    if (patch) this.ctx.reportQuota?.(patch)
  }

  private markUsage(ok: boolean): void {
    this.usageRequest = ok
    this.setFlags({ contextLive: ok })
  }

  private contextFrame(msg: Msg): boolean {
    const job = this.contextJob
    if (!job) return false
    if (msg.type === 'assistant' && obj(msg.local_command_run).command === 'context') {
      job.value = contextDiagnostic(msg.context_usage)
      if (job.value) this.translator.context.diagnostic(msg.context_usage)
      return true
    }
    if (
      msg.type === 'result' &&
      (msg.local_command === 'context' ||
        msg.user_message_uuid === job.id ||
        (Array.isArray(msg.user_message_uuids) && msg.user_message_uuids.includes(job.id)))
    ) {
      clearTimeout(job.timer)
      this.contextJob = null
      if (msg.is_error === true || !job.value) job.reject(new Error(str(msg.result) || '引擎未提供结构化的上下文明细'))
      else job.resolve(job.value)
      return true
    }
    return msg.command_uuid === job.id || (msg.type === 'user' && msg.uuid === job.id)
  }

  private ensureProcess(): Promise<ClaudeProcess> {
    if (this.closed) return Promise.reject(new Error('会话已关闭'))
    if (this.proc?.alive) return Promise.resolve(this.proc)
    if (!this.starting) {
      this.starting = this.spawn().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private async spawn(): Promise<ClaudeProcess> {
    const rec = this.ctx.record()
    if (!isDir(rec.cwd)) throw new Error(`工作目录不存在：${rec.cwd}`)
    const sid = rec.engineSessionId ?? rec.id
    // 原地接着终端里的会话：那边正开着就不能往同一个文件里写（docs/ui/claude-resume.md §4.6），要放在接力写入之前
    if (rec.imported && !rec.imported.forked && rec.imported.engine === 'claude' && rec.imported.sessionId === sid) {
      const live = liveClaudeSession(dirname(this.deps.projectsDir), sid, ownClaudePids)
      if (live === 'terminal' || live === 'other') throw codedError('resume.live', { source: live })
    }
    const seeded = await this.injectSeed(rec.cwd, sid, rec.pendingRewind ?? null, rec.pendingFork ?? null)
    const resume = claudeTranscriptExists(this.deps.projectsDir, rec.cwd, sid)
    const rewindAt = resume ? (rec.pendingRewind ?? null) : null
    const fork = resume ? null : (rec.pendingFork ?? null)
    const copy = await this.copyCompacted(rec.cwd, sid, rewindAt, fork)
    try {
      if (copy === 'failed') throw new StartupError(COMPACTED_NOTICE)
      return copy ? await this.launch(copy.sid, true) : await this.launch(sid, resume, rewindAt, fork)
    } catch (err) {
      if (!(err instanceof StartupError)) throw err
      if (copy && copy !== 'failed') rmSync(copy.file, { force: true })
      // 分叉失败（原会话的记录没了或截断点不认）：用同一个 id 开新会话，提示没带上前文
      if (fork) {
        const proc = await this.launch(sid, false)
        this.ctx.clearPendingFork?.()
        this.translator.notice(
          'warn',
          copy ? COMPACTED_NOTICE : '无法从原会话分叉，已开始新的引擎会话（之前的上下文没有带过去）',
        )
        return proc
      }
      // 截断点在记录里找不到或被 CLI 拒绝（不带回退的上下文不可信）、恢复失败（Claude 那边的记录没了）或 id 被占用：
      // 换一个新的引擎会话 id 再试一次
      if (!resume && !/already in use/i.test(err.stderr)) throw err
      // 新会话也起不来就不是记录的问题（例如追加了它不认的参数）：直接报这次的错，
      // 不提示「没带过去」，待执行的回退也留着（launch 成功时才清），改对后照常接上（docs/ui/engine-launch.md §9.1）
      const proc = await this.launch(randomUUID(), false)
      if (rewindAt)
        this.translator.notice(
          'warn',
          copy
            ? COMPACTED_NOTICE
            : '无法在 Claude Code 记录中回退到这条消息，已开始新的引擎会话（之前的上下文没有带过去）',
        )
      else if (seeded) {
        // 注入的记录没被认出来：新会话里改用文字交接，这一轮照样带上之前的对话
        this.seed = seeded
        this.translator.notice('warn', '没能把之前的对话写进 Claude Code 的会话记录，这一轮改用文字交接')
      } else if (resume)
        this.translator.notice('warn', '无法恢复 Claude Code 的会话记录，已开始新的引擎会话（之前的上下文没有带过去）')
      return proc
    }
  }

  /**
   * 跨引擎接力：把还没注入的聊天写进这个引擎会话的记录（没有就新建），之后照常 --resume。
   * 有待执行的回退 / 分叉时不写（截断点之后的条目加载不到），留给发消息时的文字交接。返回写进去的那份，没写为 null
   */
  private async injectSeed(
    cwd: string,
    sid: string,
    rewindAt: string | null,
    fork: { from: string; at: string } | null,
  ): Promise<ChatSeed | null> {
    const seed = this.seed
    if (!seed || rewindAt || fork) return null
    try {
      await seedTranscript(this.deps.projectsDir, cwd, sid, seedTurns(seed), NO_REPLY)
      if (this.seed === seed) this.seed = null
      return seed
    } catch {
      return null
    }
  }

  /**
   * 分叉 / 回退的截断点在最近一次压缩之前：Claude Code 加载不到那里（--resume-session-at 报找不到），
   * 自己把记录复制到截断点为止，存成新的引擎会话再 --resume（docs/ui/rewind-fork-sidechat.md §2.4）。
   * 分叉用分支自己的 id，回退换一个新 id（原会话的记录不动）。不需要复制时返回 null，复制不成返回 'failed'。
   */
  private async copyCompacted(
    cwd: string,
    sid: string,
    rewindAt: string | null,
    fork: { from: string; at: string } | null,
  ): Promise<{ sid: string; file: string } | 'failed' | null> {
    const at = fork?.at ?? rewindAt
    const source = fork
      ? findClaudeTranscript(this.deps.projectsDir, cwd, fork.from)
      : rewindAt
        ? findClaudeTranscript(this.deps.projectsDir, cwd, sid)
        : null
    if (!at || !source) return null
    try {
      if ((await anchorPosition(source, at)) !== 'compacted') return null
      const target = fork ? sid : randomUUID()
      const file = await copyTranscriptUntil(source, at, target)
      return file ? { sid: target, file } : 'failed'
    } catch {
      return 'failed'
    }
  }

  private async launch(
    sid: string,
    resume: boolean,
    rewindAt?: string | null,
    fork?: { from: string; at: string } | null,
  ): Promise<ClaudeProcess> {
    const rec = this.ctx.record()
    // 新进程的 modelUsage 重新累计，算每轮用量的基线也要清零；--resume 时 Claude Code 可能恢复旧的累计值（docs/ui/usage.md §6.1）
    this.translator.resetUsageBaseline(resume || !!fork)
    // 上下文超过 200K 的自定义模型带 [1m] 启动（docs/ui/custom-api.md §10）
    const model = rec.model ? claudeModelName(rec.model, this.deps.env) : rec.model
    const args = claudeArgs({ ...rec, model }, sid, resume, this.deps.launch, rewindAt, fork)
    // 项目的附加文件夹（docs/ui/multi-root-projects.md §3.3）：Claude Code 能读写，也会告诉模型
    for (const dir of rec.extraDirs ?? []) args.push('--add-dir', dir)
    for (const path of this.deps.extensions?.pluginDirs ?? []) args.push('--plugin-dir', path)
    if (this.deps.extensions?.mcpFile) args.push('--mcp-config', this.deps.extensions.mcpFile)
    if (this.retrySettingsFile) {
      rmSync(this.retrySettingsFile, { force: true })
      this.retrySettingsFile = null
    }
    const gateway = viaGateway(rec) ? this.deps.env.PIXELSKY_GATEWAY_SETTINGS : undefined
    // 网关模式下凭证只在网关里：没有网关设置文件就不能启动，否则会落到引擎自己的登录上
    if (viaGateway(rec) && !gateway) throw new Error('本机网关不可用，请重启应用')
    const extra = {
      ...(this.deps.launch?.outputStyle ? { outputStyle: this.deps.launch.outputStyle } : {}),
      ...(this.deps.launch?.modelSettings ? { modelSettings: this.deps.launch.modelSettings } : {}),
      ...(this.deps.extensions?.allowTools?.length ? { permissions: { allow: this.deps.extensions.allowTools } } : {}),
    }
    const settingsArg = claudeSettingsArgument(gateway, this.deps.maxRetries ?? null, extra)
    // 合并网关配置时写了临时文件，进程换掉或退出时删掉
    if (gateway && settingsArg && settingsArg !== gateway) this.retrySettingsFile = settingsArg
    if (settingsArg) args.push('--settings', settingsArg)
    args.push(...(this.deps.launch?.args ?? []))
    const launchedViaGateway = viaGateway(rec)
    const proc: ClaudeProcess = new ClaudeProcess(this.deps.launcher, args, rec.cwd, this.deps.env, {
      onMessage: m => {
        if (this.proc === proc) {
          // 额度事件不进对话：只汇报给宿主（账号额度，docs/ui/account-quota.md）
          if (m.type === 'rate_limit_event') return this.onRateLimit(m)
          if (this.contextFrame(m)) return
          this.onInputFrame(m)
          this.translator.handle(m)
        }
      },
      onControlRequest: r => this.onControlRequest(proc, r),
      onControlCancel: id => this.onControlCancel(id),
      onExit: (code, tail) => this.onExit(proc, code, tail),
    })
    try {
      // 输入建议、子智能体进度摘要、每个后台任务单独停止
      const init = await proc.request(
        'initialize',
        { promptSuggestions: true, agentProgressSummaries: true, perTaskStopAffordance: true },
        30_000,
      )
      this.deps.onInitialize?.(init)
      const commands = Array.isArray(init.commands) ? init.commands.map(v => str(obj(v).name)) : []
      this.ctx.emit({
        type: 'commands',
        commands: Array.isArray(init.commands)
          ? init.commands.flatMap(v => {
              const c = obj(v)
              return typeof c.name === 'string'
                ? [
                    {
                      name: c.name,
                      description: str(c.description),
                      source: 'engine' as const,
                      ...(typeof c.builtin === 'boolean' ? { builtin: c.builtin } : {}),
                    },
                  ]
                : []
            })
          : [],
      })
      this.setFlags({ contextAvailable: commands.includes('context'), compactAvailable: commands.includes('compact') })
      if (typeof init.fast_mode_state === 'string')
        this.onFastState(init.fast_mode_state, str(init.fast_mode_disabled_reason))
    } catch (err) {
      if (!proc.alive) throw new StartupError(proc.stderrTail || (err as Error).message)
      // 进程还在但没回应 initialize：继续用，真有问题会在发消息时暴露
    }
    if (!proc.alive) throw new StartupError(proc.stderrTail)
    this.proc = proc
    this.procViaGateway = launchedViaGateway
    if (sid !== rec.engineSessionId) this.ctx.setEngineSessionId(sid)
    if (rec.pendingRewind) this.ctx.clearPendingRewind?.()
    if (rec.pendingFork) this.ctx.clearPendingFork?.()
    this.seedRuns()
    // Ultracode / Fast 不是命令行参数，启动后用 flag settings 打开，再确认是否生效
    if (rec.ultracode)
      await proc.request('apply_flag_settings', { settings: { ultracode: true } }).catch(() => undefined)
    if (rec.fast) await this.applyFast(proc, true)
    await this.applyThinking(proc, rec.thinkingSummaries)
    await this.syncSettings(proc)
    // 启动就取一次明细：确认这个版本能不能用 get_context_usage，也让第一轮之前就有系统提示 / 工具 / Skills 的分类
    this.usageRequest = null
    void this.usage(proc, 'summary').catch(() => undefined)
    // 连接器状态：服务器在后台连，还在连的由 McpReporter 过一会儿再取
    void this.mcpReporter.refresh().catch(() => undefined)
    return proc
  }

  /** 开 / 关 Fast 模式，再发一次 initialize 读实际状态；开不了就关掉开关并提示原因 */
  private async applyFast(proc: ClaudeProcess, on: boolean): Promise<void> {
    try {
      await proc.request('apply_flag_settings', { settings: { fastMode: on } })
      const init = await proc.request('initialize', {}, 15_000)
      const state = str(init.fast_mode_state)
      const blocked = str(init.fast_mode_disabled_reason)
      if (state) this.onFastState(state, blocked)
      if (on && state && state === 'off') {
        this.translator.notice('warn', 'Fast 模式暂时不可用' + (blocked ? '：' + fastBlockedText(blocked) : ''))
        this.ctx.setFast(false)
      }
    } catch (err) {
      this.translator.notice('warn', 'Fast 模式没能' + (on ? '打开' : '关闭') + '：' + (err as Error).message)
    }
  }

  /** 显示思考摘要：summarized / omitted */
  private async applyThinking(proc: ClaudeProcess, on: boolean): Promise<void> {
    await proc
      .request('set_max_thinking_tokens', { thinking_display: on ? 'summarized' : 'omitted' })
      .catch(() => undefined)
  }

  /** 问 CLI 实际生效的设置（get_settings），同步 Ultracode 的可用性和开关 */
  private async syncSettings(proc: ClaudeProcess): Promise<void> {
    let applied: Msg
    try {
      applied = obj((await proc.request('get_settings', {}, 10_000)).applied)
    } catch {
      return // 老版本没有 get_settings：不知道支不支持 Ultracode
    }
    const available = applied.ultracodeAvailable === true
    this.setFlags({ ultracodeAvailable: available })
    const on = applied.ultracode === true
    if (this.ctx.record().ultracode && !on) {
      this.translator.notice('warn', available ? 'Ultracode 没能打开' : '当前模型不支持 Ultracode，已关闭')
      this.ctx.setUltracode(false)
    }
  }

  private onExit(proc: ClaudeProcess, code: number | null, tail: string): void {
    if (this.proc !== proc) return
    if (this.contextJob) {
      clearTimeout(this.contextJob.timer)
      this.contextJob.reject(new Error('上下文诊断进程已退出'))
      this.contextJob = null
    }
    // 启动失败的进程由 spawn() 处理
    this.proc = null
    this.mcpReporter.stale()
    this.setFlags({ steerAvailable: false })
    for (const id of this.guidance.keys()) this.ctx.emit({ type: 'input_ack', id, state: 'uncertain' })
    this.guidance.clear()
    this.approvals.clear()
    this.translator.processGone()
    this.translator.context.reset()
    if (this.closed || this.killing) {
      this.translator.interruptTurn()
      return
    }
    if (this.translator.activeTurn) {
      const detail = lastLines(tail)
      this.translator.abortTurn(`Claude Code 意外退出（退出码 ${code ?? '未知'}）${detail ? `：\n${detail}` : ''}`)
    }
  }

  private onControlRequest(proc: ClaudeProcess, req: ControlRequestFromCli): void {
    const r = req.request
    if (r.subtype === 'can_use_tool') {
      const toolName = str(r.tool_name)
      const input = obj(r.input)
      const toolUseId = str(r.tool_use_id) || null
      const suggestions = Array.isArray(r.permission_suggestions) ? r.permission_suggestions : []
      this.approvals.set(req.requestId, { toolName, input, toolUseId, suggestions })
      this.ctx.emit({
        type: 'approval_request',
        request: approvalFor(req.requestId, toolName, input, toolUseId, this.ctx.record().cwd),
      })
      return
    }
    // 其他请求（MCP 表单、对话框等）v1 不支持，回错误，免得 CLI 一直等
    proc.respondError(req.requestId, `像素星空暂不支持 ${r.subtype ?? '这个请求'}`)
  }

  private onControlCancel(requestId: string): void {
    if (this.approvals.delete(requestId)) this.ctx.emit({ type: 'approval_resolved', requestId })
  }

  answer(requestId: string, decision: ApprovalDecision): void {
    if (decision.type === 'allow_all')
      throw new Error('This engine does not support enabling full access from an approval')
    const a = this.approvals.get(requestId)
    const proc = this.proc
    this.approvals.delete(requestId)
    if (!a || !proc) {
      this.ctx.emit({ type: 'approval_resolved', requestId })
      return
    }
    const toolUseID = a.toolUseId ?? undefined
    let response: Msg
    switch (decision.type) {
      case 'form':
        response = { behavior: 'deny', message: 'This request does not accept structured form input', toolUseID }
        break
      case 'allow':
        response = { behavior: 'allow', updatedInput: a.input, toolUseID }
        break
      case 'allow_always':
        // 「始终允许」：本会话 / 本项目（.claude/settings.local.json）/ 所有项目（~/.claude/settings.json）
        response = {
          behavior: 'allow',
          updatedInput: a.input,
          updatedPermissions: alwaysPermissions(a.toolName, a.suggestions, decision.scope),
          toolUseID,
        }
        break
      case 'answer':
        response = { behavior: 'allow', updatedInput: { ...a.input, answers: decision.answers }, toolUseID }
        break
      case 'deny': {
        const fallback =
          a.toolName === 'ExitPlanMode' ? '用户希望继续完善计划，先不要开始执行。' : '用户拒绝了这次操作。'
        response = { behavior: 'deny', message: decision.message || fallback, toolUseID }
        if (a.toolUseId) this.translator.markDeclined(a.toolUseId)
        break
      }
    }
    proc.respond(requestId, response)
    this.ctx.emit({ type: 'approval_resolved', requestId })
  }

  private waitTurnEnd(timeoutMs: number): Promise<boolean> {
    if (!this.translator.activeTurn) return Promise.resolve(true)
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
    const proc = this.proc
    if (!this.translator.activeTurn && !this.guidance.size) return
    if (!proc) {
      // 还在启动：等启动完再中断太慢，直接结束这一轮
      this.translator.interruptTurn()
      return
    }
    // 连同后台子智能体一起停：先发 stop_task，让停止通知排在 interrupt 前面，interrupt 的 cancel_queued 会丢掉它们，不会触发新一轮
    const targets = opts?.background && proc.alive ? this.translator.backgroundTargets() : []
    const stops = targets.map(t =>
      proc.request('stop_task', { task_id: t.id }, 5_000).then(
        () => true,
        () => false,
      ),
    )
    if (targets.length > 0) {
      this.translator.muteStopNotices(targets.map(t => t.id))
      const ids = targets.map(t => t.id)
      const deadline = Date.now() + 1_500
      await Promise.race([Promise.all(stops), new Promise<void>(r => setTimeout(r, 1_500))])
      // 回复到了不等于停止通知到了：再等通知落地（最多到 deadline），免得 interrupt 之后才来
      while (this.translator.pendingStopNotices(ids) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    }
    await this.interruptTurnProcess(proc)
    if (targets.length === 0) return
    const ok = await Promise.all(stops)
    this.translator.unmuteStopNotices(targets.filter((_, i) => !ok[i]).map(t => t.id))
    const killed = !this.proc?.alive
    const labels = targets.filter((_, i) => killed || ok[i]).map(t => t.label)
    if (labels.length > 0) this.translator.stoppedWithMain(labels)
  }

  private async interruptTurnProcess(proc: ClaudeProcess): Promise<void> {
    try {
      const receipt = await proc.request(
        'interrupt',
        this.capabilities.has('interrupt_cancel_queued_v1') ? { cancel_queued: true } : {},
        5_000,
      )
      if (Array.isArray(receipt.cancelled))
        for (const id of receipt.cancelled) {
          if (typeof id === 'string' && this.guidance.delete(id))
            this.ctx.emit({ type: 'input_ack', id, state: 'cancelled' })
        }
    } catch {
      // 没回应就走下面的强制结束
    }
    if ((await this.waitTurnEnd(5_000)) && this.guidance.size === 0) return
    // 5 秒还没结束：强制结束进程，下次发消息时恢复会话
    this.killing = true
    proc.kill()
    await proc.exitPromise
    this.killing = false
  }

  async update(patch: Partial<SessionSettings>, strict = false): Promise<void> {
    const proc = this.proc
    if (!proc?.alive) return // 下次启动时按新设置启动
    if ('model' in patch || 'platform' in patch) this.translator.context.reset(false, true)
    try {
      if ('model' in patch)
        await proc.request('set_model', {
          model: patch.model ? claudeModelName(patch.model, this.deps.env) : 'default',
        })
      if (patch.effort) await proc.request('apply_flag_settings', { settings: { effortLevel: patch.effort } })
      if (patch.permissionMode)
        await proc.request('set_permission_mode', { mode: TO_CLAUDE_MODE[patch.permissionMode] })
      if (patch.ultracode !== undefined) {
        await proc.request('apply_flag_settings', { settings: { ultracode: patch.ultracode } })
      }
      if (patch.fast !== undefined) await this.applyFast(proc, patch.fast)
      if (patch.thinkingSummaries !== undefined) await this.applyThinking(proc, patch.thinkingSummaries)
      // 换模型可能改变能不能开 Ultracode
      if ('model' in patch || patch.ultracode !== undefined) await this.syncSettings(proc)
    } catch (err) {
      if (strict) throw err
      this.translator.notice('warn', `设置没能立即生效：${(err as Error).message}`)
    }
  }

  async steer(text: string, userItemId: string, attachments?: ImageAttachment[]): Promise<void> {
    if (!this.flags.steerAvailable || !this.proc?.alive || !this.translator.activeTurn)
      throw new Error('当前 Claude 进程尚未通过引导验证')
    if (this.guidance.has(userItemId)) return
    this.guidance.set(userItemId, { text })
    // 同一存活进程追加 UUID 输入，不调用 startTurn 清掉当前流式块。
    this.proc.sendUserMessage(text, userItemId, attachments)
  }

  private onInputFrame(msg: Msg): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.capabilities = new Set(
        Array.isArray(msg.capabilities) ? msg.capabilities.filter((x): x is string => typeof x === 'string') : [],
      )
      this.setFlags({
        steerAvailable:
          this.deps.steeringValidated === true &&
          ['msg_lifecycle_v1', 'interrupt_receipt_v1', 'interrupt_cancel_queued_v1'].every(c =>
            this.capabilities.has(c),
          ),
      })
    }
    // CLI 把收到的用户消息原样回显（isReplay）：说明这一轮的原文引擎已经收到，宿主据此判断断线时有没有送达
    if (
      msg.type === 'user' &&
      (msg.isReplay === true || msg.is_replay === true) &&
      this.ackPending !== null &&
      msg.uuid === this.ackPending
    ) {
      const id = this.ackPending
      this.ackPending = null
      this.ctx.emit({ type: 'input_ack', id, state: 'consumed', mode: 'normal' })
    }
    if (msg.type === 'command_lifecycle') {
      const id = str(msg.command_uuid)
      if (!this.guidance.has(id)) return
      if (msg.state === 'cancelled') {
        this.guidance.delete(id)
        this.ctx.emit({ type: 'input_ack', id, state: 'cancelled' })
      } else if (msg.state === 'started') this.consumeGuidance(id)
    }
    // 有些消息在当前轮内折叠，直接通过回复上的 UUID 列表确认消费。
    const ids = Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : [msg.user_message_uuid]
    for (const id of ids) if (typeof id === 'string' && this.guidance.has(id)) this.consumeGuidance(id)
  }

  private consumeGuidance(id: string): void {
    if (!this.guidance.delete(id)) return
    const folded = !!this.translator.activeTurn
    if (!folded) {
      // CLI 将补充输入作为后一轮消费时，尊重它的真实 result 边界。
      const turnId = randomUUID()
      this.translator.startTurn(turnId)
      this.ctx.emit({ type: 'turn_started', turnId, execution: queueSettings(this.ctx.record()) })
    }
    this.ctx.emit({ type: 'input_ack', id, state: 'consumed', mode: folded ? 'guidance' : 'normal' })
  }

  async stopTask(taskId: string): Promise<void> {
    if (!this.proc?.alive) throw new Error('引擎没有在运行')
    await this.proc.request('stop_task', { task_id: taskId })
  }

  async taskOutput(taskId: string): Promise<TaskOutput> {
    if (!this.proc?.alive) throw new Error('引擎没有在运行')
    const r = await this.proc.request('get_task_output', { task_id: taskId })
    return { output: str(r.output), truncated: r.truncated === true }
  }

  async mcp(op: McpOp): Promise<McpOpResult> {
    const proc = this.proc
    if (!proc?.alive) {
      if (op.kind === 'refresh') return { report: this.mcpReporter.report }
      throw new Error('引擎没有在运行')
    }
    let url: string | undefined
    if (op.kind === 'reconnect') await proc.request('mcp_reconnect', { serverName: op.name }, 60_000)
    else if (op.kind === 'toggle')
      await proc.request('mcp_toggle', { serverName: op.name, enabled: op.enabled }, 30_000)
    else if (op.kind === 'login') {
      // CLI 在本机端口等授权回调，浏览器里登录完自己接上；之后的状态靠刷新取
      const r = await proc.request('mcp_authenticate', { serverName: op.name }, 30_000)
      url = str(r.authUrl) || undefined
      if (!url && r.requiresUserAction !== false) throw new Error('这个连接器不支持登录')
    }
    const report = await this.mcpReporter.refresh()
    return url ? { report, url } : { report }
  }

  async close(opts: CloseOptions = {}): Promise<void> {
    this.closed = true
    this.mcpReporter.dispose()
    const starting = this.starting
    if (starting) await starting.catch(() => null)
    try {
      await this.proc?.close(opts.quick ? QUICK_CLOSE_MS : undefined)
    } finally {
      if (this.retrySettingsFile) {
        rmSync(this.retrySettingsFile, { force: true })
        this.retrySettingsFile = null
      }
      this.deps.extensions?.dispose?.()
    }
  }
}

// Claude Code 适配器
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  EFFORTS,
  codedError,
  type AgentRuns,
  type ContextWindows,
  type Effort,
  type EngineCatalog,
  type EngineInfo,
  type EngineModel,
  type EngineUpdateResult,
  type Item,
  type SessionRecord,
  viaGateway,
} from '@pixelsky/protocol'
import { QUICK_CLOSE_MS } from '../adapter'
import type {
  AccountProbe,
  CloseOptions,
  EngineAdapter,
  EngineSession,
  Launcher,
  LoginProcess,
  SessionContext,
} from '../adapter'
import type { QuotaReading } from '../quota'
import { engineEnv, systemProxyEnv } from '../env'
import { globalNpm, npmForInstall, npmInstallGlobal, withPath, type NodeRuntime } from '../npm'
import { outputTail, run, runInteractive, runStream, startupReason } from '../exec'
import { engineBase } from '../registry'
import {
  ClaudeUserRules,
  claudeAccountEnv,
  configDirBusy,
  holdConfigDir,
  nativeMcpServers,
  prepareClaudeAccount,
} from './accounts'
import { claudeInstaller, customClaude, discoverClaude, parseAuthStatus, type ClaudeDiscovery } from './discover'
import { claudePlanFor } from './tier'
import { rewindFilesOnce, sideQuestionOnce, type HelperTarget, type RewindFilesReply } from './helper'
import { ClaudeProcess, ownClaudePids } from './process'
import { parseClaudeUsage, unknownControl } from './quota'
import { obj, str } from './shape'
import { ClaudeSession, reservedClaudeArg, type ClaudeLaunchOptions } from './session'
import { loadSavedRuns, loadSubagentTranscript } from './runs'
import {
  anchorPosition,
  claudeSessionDir,
  claudeTranscriptExists,
  defaultProjectsDir,
  findClaudeTranscript,
  findRewindAnchor,
  pointLastPrompt,
} from './transcript'
import {
  liveClaudeSessions,
  listClaudeSessions,
  newerTurns,
  readClaudeSession,
  type ClaudeSessionList,
  type ListOptions,
  type LiveState,
  type NativeRead,
  type NewerTurns,
  type ReadOptions,
} from './native'
import { LONG_CONTEXT_ENV, claudeModelName, windowSettings } from './long-context'

export interface ClaudeAdapterOptions {
  sessionEnv?: (record: SessionRecord) => NodeJS.ProcessEnv
  /** 用户在设置里替换的命令（绝对路径或 PATH 上的命令名，docs/ui/engine-launch.md） */
  overridePath?: () => string | null
  /** 基础环境变量（默认 process.env，启动前会清理） */
  env?: NodeJS.ProcessEnv
  /** 用户在设置里追加的环境变量（在清理后的基础环境之上；平台会话的网关变量仍然最后覆盖） */
  extraEnv?: () => Record<string, string>
  /** 系统代理（http://主机:端口）；没开代理、开关关了时为 null。用户自己设了代理变量时不用（env.ts systemProxyEnv） */
  systemProxy?: () => string | null
  /** 设置 › 本机引擎里的引擎级选项（输出风格、允许提问、自动压缩触发点、追加参数），每次启动进程时读 */
  launchOptions?: () => ClaudeLaunchOptions & { autoCompactPct: number | null; contextWindows?: ContextWindows }
  /** 桌面端的私有 Node.js：官方安装器装不上时改用 npm，没装 Node.js 就先装它；补在 PATH 最后（docs/ui/engine-update.md §7） */
  nodeRuntime?: NodeRuntime
  /** 测试用：直接指定要启动的程序，跳过查找和检测 */
  launcher?: Launcher
  /** 测试用：Claude 会话记录目录 */
  projectsDir?: string
  /** 明确通过真实追加输入验证后由宿主开放；桌面正式配置当前不设置。 */
  steeringValidated?: boolean
  /** 当前订阅账号的目录（docs/ui/engine-accounts-claude.md）；null 是原来的配置目录 */
  account?: () => string | null
  /** 引擎数据目录：「始终允许（所有项目）」在添加的账号下记在这里（claude-user-rules.json） */
  dataDir?: string
}

/** 输出风格 / 模型列表的缓存时间；过期后先返回旧值、后台刷新（每次刷新都要起一个 claude.exe 握手） */
const CATALOG_TTL = 30 * 60_000
/** 后台刷新握手失败、留着旧列表时，隔多久再试 */
const CATALOG_RETRY = 60_000

function isEffort(x: unknown): x is Effort {
  return typeof x === 'string' && (EFFORTS as readonly string[]).includes(x)
}

/**
 * 握手回包里的 models（Claude Code 的字段：value、displayName、description、resolvedModel、supportsEffort、supportedEffortLevels）
 * 转成目录模型。value 为 default 的一项不进列表（界面已有「默认」行）。
 */
export function claudeModels(raw: unknown): EngineModel[] {
  if (!Array.isArray(raw)) return []
  const out: EngineModel[] = []
  for (const m of raw as unknown[]) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    if (typeof o.value !== 'string' || o.value === 'default') continue
    const levels = o.supportsEffort === false || !Array.isArray(o.supportedEffortLevels) ? [] : o.supportedEffortLevels
    out.push({
      id: o.value,
      label: typeof o.displayName === 'string' && o.displayName ? o.displayName : o.value,
      description: typeof o.description === 'string' ? o.description : undefined,
      resolved: typeof o.resolvedModel === 'string' ? o.resolvedModel : undefined,
      efforts: levels.filter(isEffort),
      defaultEffort: null,
      inputModalities: ['text', 'image'],
      isDefault: false,
    })
  }
  return out
}

/** 平台线路在请求重试设置为「跟随引擎」时的上限；自定义了就按自定义（docs/ui/error-retry.md） */
export const PLATFORM_MAX_RETRIES = 3

export class ClaudeAdapter implements EngineAdapter {
  private cached: ClaudeDiscovery | null = null
  private detecting: Promise<ClaudeDiscovery> | null = null
  private catalogCache: { at: number; value: EngineCatalog } | null = null
  private probing: Promise<EngineCatalog> | null = null
  private probingForce = false
  /** 额度的临时进程（没有会话进程时问 get_usage 用，问完就关）：同一时间最多一个；应用退出时 close() 杀掉 */
  private quotaProbe: { account: string; promise: Promise<QuotaReading> } | null = null
  /** 额度临时进程（当前账号的、账号表里别的账号的）：应用退出时杀掉 */
  private readonly quotaProcs = new Set<ClaudeProcess>()
  /** close() 之后（应用退出）不再起任何额度临时进程 */
  private closedForQuota = false
  /** 这个版本认不认识 get_usage；null 还没试过。dropCatalog()（重新检测 / 更新 / 安装）时清回 null，升级后重新试 */
  private usageRequest: boolean | null = null
  /** 清缓存时自增：握手期间缓存被清过（重新检测 / 更新 / 安装），旧握手的结果不再写进缓存 */
  private catalogGen = 0
  /** 原生安装器和 npm 装的版本号一致，都按这个包查最新版本 */
  readonly npmPackage = '@anthropic-ai/claude-code'
  /** 跨引擎接力：别的引擎期间的聊天直接写进 Claude Code 的会话记录（chat-log.ts） */
  readonly seedsHistory = true

  /** 「始终允许（所有项目）」在添加的账号下由像素星空记（所有账号的会话启动时带上） */
  private readonly userRules: ClaudeUserRules | null

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {
    this.userRules = opts.dataDir ? new ClaudeUserRules(join(opts.dataDir, 'claude-user-rules.json')) : null
  }

  /** 不带订阅账号的环境：配置目录是用户原来的 */
  private baseEnv(): NodeJS.ProcessEnv {
    const base = engineEnv(this.opts.env ?? process.env)
    const extra = this.opts.extraEnv?.() ?? {}
    // 补的代理变量放最后：只在用户没设代理时才有，NO_PROXY 已经并进了用户原有的
    return withPath(
      { ...base, ...extra, ...systemProxyEnv(base, extra, this.opts.systemProxy?.() ?? null) },
      this.opts.nodeRuntime?.paths() ?? [],
    )
  }

  /** 启动 Claude Code 用的环境：选了别的订阅账号时 CLAUDE_CONFIG_DIR 换成那个账号的目录（先准备好目录） */
  private env(dir: string | null | undefined = this.opts.account?.()): NodeJS.ProcessEnv {
    const env = this.baseEnv()
    if (!dir) return env
    this.prepareAccount(env, dir)
    return claudeAccountEnv(env, dir)
  }

  /** 账号目录接回原目录、空闲时同步设置：同一个目录 2 秒内只做一次（env() 调得很频繁）；有进程在用时跳过、下次再做 */
  private readonly prepared = new Map<string, number>()
  private prepareAccount(env: NodeJS.ProcessEnv, dir: string): void {
    if (Date.now() - (this.prepared.get(dir) ?? 0) < 2000) return
    if (prepareClaudeAccount(env, dir)) this.prepared.set(dir, Date.now())
  }

  /** 用这个环境跑一段（子进程）：期间登记这个配置目录在用 */
  private async holding<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
    const release = holdConfigDir(env.CLAUDE_CONFIG_DIR)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private discover(force: boolean): Promise<ClaudeDiscovery> {
    if (this.cached && !force) return Promise.resolve(this.cached)
    // 重新检测时命令或参数可能变了，输出风格列表也要重新握手
    if (force) this.dropCatalog()
    if (!this.detecting) {
      this.detecting = this.detect()
        .then(d => (this.cached = d))
        .finally(() => {
          this.detecting = null
        })
    }
    return this.detecting
  }

  private async detect(): Promise<ClaudeDiscovery> {
    const d: ClaudeDiscovery = this.opts.launcher
      ? {
          info: {
            ...engineBase('claude'),
            status: 'ready',
            version: null,
            path: this.opts.launcher.command,
            message: null,
          },
          launcher: this.opts.launcher,
          projectsDir: this.opts.projectsDir ?? null,
        }
      : await this.detectWith(this.env())
    // 没有 PowerShell / curl 也能一键安装：改用 npm（没装 Node.js 时桌面端先装私有的）；用户替换了命令的不给装
    if (d.info.status === 'missing' && d.info.launch === 'stock' && this.opts.nodeRuntime)
      d.info = { ...d.info, installable: true }
    // 追加了参数：再握手一次。--version 不检查其它参数，写错的参数要以会话的方式启动才报（docs/ui/engine-launch.md §9.2）。
    // 失败只记原因、不标为不可用：这里在主目录启动，相对路径的参数在项目目录里可能是对的
    if (d.launcher && this.launchArgs().length && (d.info.status === 'ready' || d.info.status === 'unauthenticated')) {
      const r = await this.handshake(d.launcher)
      if (r && 'error' in r) d.info.launchError = r.error
      else if (r) this.catalogCache = { at: Date.now(), value: r.catalog }
    }
    return d
  }

  private detectWith(env: NodeJS.ProcessEnv): Promise<ClaudeDiscovery> {
    return this.holding(env, () => discoverClaude(this.opts.overridePath?.() ?? null, env))
  }

  /** 用户追加的启动参数 */
  private launchArgs(): string[] {
    return this.opts.launchOptions?.().args ?? []
  }

  async info(force = false): Promise<EngineInfo> {
    return (await this.discover(force)).info
  }

  checkLaunch(command: string | null, args: readonly string[]): void {
    if (command) {
      const custom = customClaude(command, this.env())
      if ('error' in custom) throw new Error(custom.error)
    }
    const reserved = reservedClaudeArg(args)
    if (reserved) throw codedError('launch.reserved', { arg: reserved })
  }

  /**
   * 对话记录目录：固定用原目录的（docs/ui/engine-accounts-claude.md §2.5）。账号目录里的 projects 是联接回来的，
   * 内容一样，但路径换了会让缓存、「同一个会话」的判断对不上
   */
  private projectsDir(): string {
    if (this.opts.projectsDir) return this.opts.projectsDir
    if (this.opts.account?.()) return defaultProjectsDir(this.baseEnv())
    return this.cached?.projectsDir ?? defaultProjectsDir(this.baseEnv())
  }

  private sessionDir(record: SessionRecord): string | null {
    return claudeSessionDir(this.projectsDir(), record.cwd, record.engineSessionId ?? record.id)
  }

  loadRuns(record: SessionRecord): AgentRuns {
    const dir = this.sessionDir(record)
    return dir ? loadSavedRuns(dir) : { workflows: [], agents: [] }
  }

  async rewindAnchor(record: SessionRecord, userItemIds: string[]): Promise<{ at: string | null } | null> {
    const file = findClaudeTranscript(this.projectsDir(), record.cwd, record.engineSessionId ?? record.id)
    return file ? findRewindAnchor(file, userItemIds) : null
  }

  async beforeCompaction(record: SessionRecord, userItemId: string): Promise<boolean> {
    const file = findClaudeTranscript(this.projectsDir(), record.cwd, record.engineSessionId ?? record.id)
    return !!file && (await anchorPosition(file, userItemId)) === 'compacted'
  }

  nativeSessions(cwd: string, opts?: ListOptions): Promise<ClaudeSessionList> {
    return listClaudeSessions(this.projectsDir(), cwd, opts)
  }

  readNativeSession(cwd: string, id: string, opts?: ReadOptions): Promise<NativeRead | null> {
    return readClaudeSession(this.projectsDir(), cwd, id, opts)
  }

  newerNativeTurns(
    cwd: string,
    id: string,
    after: string,
    opts?: { turns?: number; afterTurn?: boolean },
  ): Promise<NewerTurns | null> {
    return newerTurns(this.projectsDir(), cwd, id, after, opts)
  }

  hasNativeSession(record: SessionRecord): boolean {
    return claudeTranscriptExists(this.projectsDir(), record.cwd, record.engineSessionId ?? record.id)
  }

  /** pid 登记在 Claude Code 配置目录（projects 的上一级）的 sessions 下 */
  nativeLive(rows: readonly { id: string; mtimeMs: number }[]): Map<string, LiveState> {
    return liveClaudeSessions(dirname(this.projectsDir()), rows, ownClaudePids)
  }

  subagentTranscript(record: SessionRecord, agentId: string): Item[] {
    const dir = this.sessionDir(record)
    if (!dir) throw new Error('这个会话还没有保存记录')
    return loadSubagentTranscript(dir, agentId, record.cwd)
  }

  /** 会话进程和辅助进程共用的环境：平台网关变量、重试次数、自动压缩点、文件检查点、插件 PATH */
  private launchEnv(
    record: SessionRecord,
    maxRetries: number | null,
    pathDirs: readonly string[] = [],
  ): NodeJS.ProcessEnv {
    // 走网关的会话（像素星空平台、自定义接口）不用订阅账号，配置目录是原来的
    const env = viaGateway(record) ? this.baseEnv() : this.env()
    const platformEnv = this.opts.sessionEnv?.(record)
    if (viaGateway(record)) {
      if (!platformEnv?.PIXELSKY_GATEWAY_SETTINGS) throw new Error('本机网关不可用，请重启应用')
      for (const key of Object.keys(env)) {
        if (
          /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)/i.test(
            key,
          )
        )
          delete env[key]
      }
      Object.assign(env, platformEnv)
    }
    if (maxRetries !== null) env.CLAUDE_CODE_MAX_RETRIES = String(maxRetries)
    const launch = this.opts.launchOptions?.()
    // 自动压缩触发点（docs/ui/engine-settings-redesign.md §3.2）：上下文用到窗口的这个百分比时压缩
    if (launch?.autoCompactPct) env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(launch.autoCompactPct)
    // 云端 / 本机模型填的上下文窗口超过 200K 时带 [1m]（GitHub #20）；自定义 API 的名单由网关给
    const long = this.windows(record)?.long ?? []
    if (long.length) env[LONG_CONTEXT_ENV] = JSON.stringify(long)
    // 文件检查点：-p 模式默认不记，回退时要靠它恢复代码（docs/ui/rewind-fork-sidechat.md §1）；
    // 用户设了 CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING 时 Claude Code 自己会关掉
    env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = 'true'
    if (pathDirs.length) env.PATH = [...pathDirs, env.PATH ?? env.Path ?? ''].join(delimiter)
    return env
  }

  /** 这个会话的来源（云端 / 本机）在设置里填的模型窗口；自定义 API 的在接口配置里，由网关处理 */
  private windows(record: SessionRecord): ReturnType<typeof windowSettings> | null {
    if (record.provider) return null
    const windows = this.opts.launchOptions?.().contextWindows
    if (!windows) return null
    const list = { ...windows[record.platform ? 'platform' : 'self'] }
    // 本机模型列表里是别名（opus）：按别名指向的完整模型名也写一份，Claude Code 按哪个名字查都对得上
    for (const m of this.catalogCache?.value.models ?? [])
      if (m.resolved && list[m.id] && !(m.resolved in list)) list[m.resolved] = list[m.id]
    return windowSettings(list)
  }

  /**
   * 会话 initialize 回包里的模型列表更新缓存里的 models；缓存还没有（没握手过）就不管。
   * 注意：本机会话在项目目录里启动、带项目设置（.claude/settings.json 的 env / availableModels），
   * 这份列表可能是项目限定过的，会覆盖全局目录，最多持续到下一次握手刷新（30 分钟内）
   */
  private refreshModels(raw: unknown): void {
    if (!this.catalogCache || !Array.isArray(raw)) return
    const models = claudeModels(raw)
    if (!models.length) return
    // at 不动：只换了 models，输出风格的有效期不能被顺带延长
    this.catalogCache = { at: this.catalogCache.at, value: { ...this.catalogCache.value, models } }
  }

  private readyLauncher(record: SessionRecord): Launcher {
    const d = this.cached
    if (!d?.launcher || (d.info.status !== 'ready' && !(viaGateway(record) && d.info.status === 'unauthenticated')))
      throw new Error(d?.info.message ?? 'Claude Code 不可用')
    return d.launcher
  }

  createSession(ctx: SessionContext): EngineSession {
    const launcher = this.readyLauncher(ctx.record())
    const d = this.cached!
    // 设置是「跟随引擎」时，平台线路也只重试 PLATFORM_MAX_RETRIES 次：Claude Code 自己默认约 10 次，
    // 网络中途断开时每次都重发整段上下文、重新计费（压缩请求不走缓存，一次就要几毛钱）
    const maxRetries = ctx.maxRetries ?? (ctx.record().platform ? PLATFORM_MAX_RETRIES : null)
    const env = this.launchEnv(ctx.record(), maxRetries, ctx.extensions?.pathDirs)
    const launch = this.opts.launchOptions?.()
    // 添加的订阅账号（走网关的会话不用账号目录）：原文件里的 MCP 服务器每次启动现读，「所有项目」的规则像素星空自己记
    const accountDir = viaGateway(ctx.record()) ? null : (this.opts.account?.() ?? null)
    const base = this.baseEnv()
    return new ClaudeSession(ctx, {
      account: accountDir ? { dir: accountDir, mcpServers: cwd => nativeMcpServers(base, cwd) } : undefined,
      userRules: this.userRules ?? undefined,
      maxRetries,
      launch: launch
        ? {
            outputStyle: launch.outputStyle,
            askQuestions: launch.askQuestions,
            args: launch.args,
            modelSettings: this.windows(ctx.record())?.modelSettings ?? null,
          }
        : undefined,
      launcher,
      env,
      projectsDir:
        this.opts.projectsDir ?? (accountDir ? defaultProjectsDir(base) : (d.projectsDir ?? defaultProjectsDir(env))),
      steeringValidated: this.opts.steeringValidated,
      extensions: ctx.extensions,
      // 本机账号的会话自己的 initialize 回包里有模型列表，顺手更新缓存，省得过期后再起进程握手；
      // 平台线路和自定义 API 走网关，模型列表不同，不能写进本机目录（回包到达时再按当前来源判断，会话中途换来源也对）。
      // 输出风格受项目设置影响，也不动
      onInitialize: init => {
        if (!viaGateway(ctx.record())) this.refreshModels(init.models)
      },
    })
  }

  /**
   * 辅助进程：--resume 这个会话，平台会话带网关设置。要读当前分支（GitHub #82）：回退了还没发新消息时
   * 用 --resume-session-at 截到回退点（和主会话下次启动一样）；否则先让记录的 last-prompt 指向当前末端（pointLastPrompt）
   */
  private async helperTarget(record: SessionRecord): Promise<HelperTarget> {
    const sid = record.engineSessionId
    const file = sid ? findClaudeTranscript(this.projectsDir(), record.cwd, sid) : null
    if (!sid || !file) throw new Error('这个会话还没有 Claude Code 记录')
    // 回退点在压缩之前时 Claude Code 读不到那里（主会话下次启动会自己复制记录接上），辅助进程就按默认的读
    const pending =
      record.pendingRewind && (await anchorPosition(file, record.pendingRewind)) === 'loaded'
        ? record.pendingRewind
        : null
    if (!record.pendingRewind)
      try {
        pointLastPrompt(file, sid)
      } catch {
        // 写不了就按 Claude Code 默认的读
      }
    const env = this.launchEnv(record, null)
    const gateway = viaGateway(record) ? env.PIXELSKY_GATEWAY_SETTINGS : undefined
    return {
      launcher: this.readyLauncher(record),
      cwd: record.cwd,
      env,
      resumeArgs: [
        '--resume',
        sid,
        ...(pending ? [`--resume-session-at=${pending}`] : []),
        ...(gateway ? ['--settings', gateway] : []),
      ],
    }
  }

  /** 回退恢复代码：预览（dryRun）或真的还原到这条用户消息之前（docs/ui/rewind-fork-sidechat.md §1） */
  async rewindFiles(
    record: SessionRecord,
    userItemId: string,
    dryRun: boolean,
    beforeRestore?: (files: string[]) => void,
  ): Promise<RewindFilesReply> {
    return rewindFilesOnce(await this.helperTarget(record), userItemId, dryRun, beforeRestore)
  }

  /** 旁聊：带着这个会话的上下文单独问一次，没有工具、不写记录（docs/ui/rewind-fork-sidechat.md §3） */
  async sideQuestion(record: SessionRecord, prompt: string, signal: AbortSignal): Promise<string> {
    const target = await this.helperTarget(record)
    return sideQuestionOnce(target, prompt, record.model && claudeModelName(record.model, target.env), signal)
  }

  /**
   * 输出风格列表：启动一个 Claude Code 进程，只做初始化握手（initialize 控制请求）就结束，
   * 不发消息、不调用模型。握手回包里有 available_output_styles 和 output_style（docs/ui/engine-settings-redesign.md §5）。
   */
  async catalog(force = false): Promise<EngineCatalog> {
    const hit = this.catalogCache
    if (!force && hit) {
      // 过期了也先给旧值，后台刷新一次（同一时间只刷一个，失败就留着旧值）
      if (Date.now() - hit.at >= CATALOG_TTL) void this.refreshCatalog(false).catch(() => undefined)
      return hit.value
    }
    return this.refreshCatalog(force)
  }

  private dropCatalog(): void {
    this.catalogCache = null
    this.catalogGen++
    this.usageRequest = null
  }

  /**
   * 没有会话进程时读一次账号额度（docs/ui/account-quota.md §3.2）：起一个临时进程问 get_usage，问完就关。
   * 有会话进程时宿主改借会话的进程（EngineSession.accountQuota），不走这里
   */
  async accountQuota(): Promise<QuotaReading> {
    if (this.closedForQuota) throw new Error('Claude Code unavailable: 应用正在退出')
    const d = await this.discover(false)
    if (!d.launcher || d.info.status !== 'ready') return { kind: 'unsupported' }
    if (this.usageRequest === false) return { kind: 'no-request' }
    // 同一时间只起一个，且按账号区分：别的账号的读取还在跑时等它结束再起，不拿它的结果顶替
    const account = d.info.account?.email?.trim().toLowerCase() ?? ''
    for (let running = this.quotaProbe; running; running = this.quotaProbe) {
      if (running.account === account) return running.promise
      await running.promise.catch(() => undefined)
    }
    if (this.closedForQuota) throw new Error('Claude Code unavailable: 应用正在退出')
    const promise = this.probeQuota(d.launcher, this.env(), true).finally(() => {
      if (this.quotaProbe?.promise === promise) this.quotaProbe = null
    })
    this.quotaProbe = { account, promise }
    return promise
  }

  /**
   * 和握手一样在主目录、用自己的账号环境（不带网关变量）；initialize 30 秒、get_usage 20 秒；无论成败都杀掉进程。
   * current 为假是读别的订阅账号（账号表）：模型列表和「认不认识 get_usage」不记进缓存
   */
  private async probeQuota(launcher: Launcher, env: NodeJS.ProcessEnv, current: boolean): Promise<QuotaReading> {
    if (this.closedForQuota) throw new Error('Claude Code unavailable: 应用正在退出')
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    const proc = new ClaudeProcess(launcher, [...args, ...this.launchArgs()], homedir(), env, {
      onMessage: () => undefined,
      onControlRequest: () => undefined,
      onControlCancel: () => undefined,
      onExit: () => undefined,
    })
    this.quotaProcs.add(proc)
    try {
      const init = await proc.request('initialize', {}, 30_000)
      if (current) this.refreshModels(init.models)
      const email = str(obj(init.account).email) || null
      let raw: Record<string, unknown>
      try {
        raw = await proc.request('get_usage', { skip_behaviors: true }, 20_000)
      } catch (err) {
        if (!unknownControl(err)) throw err
        if (current) this.usageRequest = false
        return { kind: 'no-request' }
      }
      const reading = parseClaudeUsage(raw, Date.now())
      if (current) this.usageRequest = reading.kind !== 'no-request'
      return reading.kind === 'ok' ? { ...reading, account: email, plan: claudePlanFor(reading.plan, env) } : reading
    } finally {
      proc.kill()
      this.quotaProcs.delete(proc)
    }
  }

  /** 应用退出：杀掉还在问额度的临时进程 */
  async close(opts: CloseOptions = {}): Promise<void> {
    this.closedForQuota = true
    const procs = [...this.quotaProcs]
    this.quotaProcs.clear()
    if (!procs.length) return
    for (const proc of procs) proc.kill()
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(procs.map(p => p.exitPromise)),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, opts.quick ? QUICK_CLOSE_MS : 5_000)
      }),
    ])
    clearTimeout(timer)
  }

  private refreshCatalog(force: boolean): Promise<EngineCatalog> {
    if (this.probing) {
      // 正在跑的是后台刷新（可能按旧参数握手）时，force 要等它结束后重新握手一次
      if (force && !this.probingForce) return this.probing.catch(() => undefined).then(() => this.refreshCatalog(true))
      return this.probing
    }
    this.probingForce = force
    const gen = this.catalogGen
    this.probing = this.probe(force)
      .then(({ value, failed }) => {
        // 握手期间缓存被清过：这份结果是按旧参数 / 旧版本得到的，只返回、不缓存
        if (gen !== this.catalogGen) return value
        // 握手失败（引擎可用但没握上手）不当成新鲜：1 分钟后再试，不用等满 30 分钟；
        // 后台刷新时留着旧值，别把能用的列表换成空的（引擎真的不可用时走下面，正常写入空目录）
        if (failed) {
          const old = this.catalogCache
          const keep = !force && old?.value.models?.length ? old.value : value
          this.catalogCache = { at: Date.now() - CATALOG_TTL + CATALOG_RETRY, value: keep }
          return keep
        }
        this.catalogCache = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        this.probing = null
        this.probingForce = false
      })
    return this.probing
  }

  private async probe(force: boolean): Promise<{ value: EngineCatalog; failed: boolean }> {
    // 检测正在进行时（追加了参数会握手）等它做完，它的握手结果就是这里要的
    const d = await (this.detecting ?? this.discover(false))
    if (!force && this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL)
      return { value: this.catalogCache.value, failed: false }
    const usable = !!d.launcher && (d.info.status === 'ready' || d.info.status === 'unauthenticated')
    const r = usable ? await this.handshake(d.launcher!) : null
    if (r && 'catalog' in r) return { value: r.catalog, failed: false }
    return { value: { outputStyles: [], currentOutputStyle: null }, failed: usable }
  }

  /**
   * 以会话的方式启动一个 Claude Code 进程（带上追加的参数），只做初始化握手就结束。
   * 回应前进程就退出了给出原因；超时或别的失败返回 null。
   */
  private async handshake(launcher: Launcher): Promise<{ catalog: EngineCatalog } | { error: string } | null> {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    const proc = new ClaudeProcess(launcher, [...args, ...this.launchArgs()], homedir(), this.env(), {
      onMessage: () => undefined,
      onControlRequest: () => undefined,
      onControlCancel: () => undefined,
      onExit: () => undefined,
    })
    try {
      const init = await proc.request('initialize', {}, 30_000)
      const styles = Array.isArray(init.available_output_styles)
        ? init.available_output_styles.filter((x): x is string => typeof x === 'string')
        : []
      return {
        catalog: {
          outputStyles: styles,
          currentOutputStyle: typeof init.output_style === 'string' ? init.output_style : null,
          models: claudeModels(init.models),
        },
      }
    } catch (err) {
      if (proc.alive) return null
      return { error: startupReason(proc.stderrTail) || (err as Error).message }
    } finally {
      proc.kill()
    }
  }

  /** 检查更新：运行 claude update（最多 5 分钟） */
  async update(onLine: (line: string) => void = () => undefined): Promise<EngineUpdateResult> {
    const d = await this.discover(false)
    if (!d.launcher) throw new Error(d.info.message ?? '没找到 Claude Code')
    const env = this.env()
    const r = await this.holding(env, () => runStream(d.launcher!, ['update'], env, 5 * 60_000, onLine))
    this.dropCatalog()
    // 版本由宿主重新检测后填上（重新检测会广播给界面）
    return { ok: r.ok, output: outputTail(r), version: null }
  }

  /** 授权登录：claude auth login（浏览器登录；命令自己会打开浏览器，粘贴授权码从 stdin 写入） */
  async login(method: 'browser' | 'device', onLine: (line: string) => void): Promise<LoginProcess> {
    return this.accountLogin(undefined, method, onLine)
  }

  /** 取消授权：claude auth logout */
  async logout(): Promise<EngineUpdateResult> {
    return this.accountLogout(undefined)
  }

  /** 登录到某个订阅账号的目录（添加账号、重新登录）；dir 为 null 是原来的目录，不传是当前账号 */
  async accountLogin(
    dir: string | null | undefined,
    method: 'browser' | 'device',
    onLine: (line: string) => void,
  ): Promise<LoginProcess> {
    if (method !== 'browser') throw new Error('Claude Code 不支持设备码登录')
    const launcher = await this.loginLauncher()
    const env = this.env(dir)
    const release = holdConfigDir(env.CLAUDE_CONFIG_DIR)
    const proc = runInteractive(launcher, ['auth', 'login'], env, onLine)
    void proc.done.finally(release).catch(() => undefined)
    return proc
  }

  /** 退出某个订阅账号（移除账号）；dir 为 null 是原来的目录，不传是当前账号 */
  async accountLogout(dir: string | null | undefined): Promise<EngineUpdateResult> {
    const launcher = await this.loginLauncher()
    const env = this.env(dir)
    const r = await this.holding(env, () => run(launcher, ['auth', 'logout'], env))
    return { ok: r.ok, output: outputTail(r), version: null }
  }

  /** 所有 Claude Code 进程（会话、额度临时进程、登录等）都在登记处记着用哪个配置目录 */
  accountInUse(dir: string): boolean {
    return configDirBusy(dir)
  }

  /**
   * 临时读一个账号（docs/ui/engine-accounts-claude.md §2.4）：claude auth status 拿登录状态、邮箱、套餐（不调用模型）；
   * 是订阅登录时再起额度临时进程问 get_usage（不发消息，问完就关）
   */
  async accountProbe(dir: string | null): Promise<AccountProbe> {
    const launcher = await this.loginLauncher()
    const env = this.env(dir)
    const r = await this.holding(env, () => run(launcher, ['auth', 'status', '--json'], env))
    const status = parseAuthStatus(r.stdout)
    if (!status) throw new Error(outputTail(r) || '读不到 Claude Code 的登录状态')
    const email = status.account?.email ?? null
    const plan = claudePlanFor(status.account?.plan, env)
    if (!status.loggedIn) return { signedIn: false, email, plan, quota: null }
    if (status.method !== 'claude.ai') return { signedIn: true, email, plan, quota: null }
    let quota: QuotaReading | null = null
    try {
      quota = await this.probeQuota(launcher, env, false)
    } catch (error) {
      // 登录失效：读额度时才发现
      if (/401|unauthori[sz]ed|authentication|log ?in/i.test((error as Error).message))
        return { signedIn: false, email, plan, quota: null }
      throw error
    }
    return { signedIn: true, email, plan, quota }
  }

  private async loginLauncher(): Promise<Launcher> {
    const d = await this.discover(false)
    if (!d.launcher) throw new Error(d.info.message ?? '没找到 Claude Code')
    return d.launcher
  }

  /**
   * 一键安装：先跑官方安装器（最多 10 分钟），装到 ~/.local/bin，检测本来就会找那里；
   * 没有安装器或没装成（常见是连不上 claude.ai）时改用 npm 装 @anthropic-ai/claude-code，
   * 没装 Node.js 就用桌面端给的私有那份（docs/ui/engine-update.md §7）
   */
  async install(onLine: (line: string) => void = () => undefined): Promise<EngineUpdateResult> {
    const env = this.env()
    const installer = claudeInstaller(env)
    const canNpm = !!this.opts.nodeRuntime || !!globalNpm(env)
    if (!installer && !canNpm) throw new Error('没找到 PowerShell / curl，请按提示在终端安装 Claude Code')
    let official: EngineUpdateResult | null = null
    if (installer) {
      const r = await this.holding(env, () => runStream(installer, [], env, 10 * 60_000, onLine))
      official = { ok: r.ok, output: outputTail(r), version: null }
    }
    if (!official?.ok && canNpm) {
      if (official) onLine('官方安装器没装成，改用 npm 安装 Claude Code')
      const npm = await npmForInstall(env, this.opts.nodeRuntime, onLine)
      if (npm) {
        const r = await npmInstallGlobal(npm, this.npmPackage, env, onLine, 10 * 60_000)
        // 两种都没装成：把官方安装器的输出也带上，方便看是哪一步出的错
        official = r.ok || !official ? r : { ...r, output: `${official.output}\n${r.output}`.trim() }
      }
    }
    this.dropCatalog()
    return official!
  }
}

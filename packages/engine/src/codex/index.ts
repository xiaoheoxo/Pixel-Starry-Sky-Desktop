import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  AccountProbe,
  CloseOptions,
  EngineAdapter,
  EngineSession,
  Launcher,
  LoginProcess,
  RewindAnchor,
  SessionContext,
  TuiLaunch,
} from '../adapter'
import type { QuotaReading } from '../quota'
import type { ListOptions, LiveState, NativeRead, NativeSessionList, NewerTurns, ReadOptions } from '../native/types'
import {
  type AgentRuns,
  codedError,
  type EngineCatalog,
  type EngineInfo,
  type EngineUpdateResult,
  type Item,
  type ResetCreditOutcome,
  type SessionRecord,
  viaGateway,
} from '@pixelsky/protocol'
import { engineEnv, systemProxyEnv } from '../env'
import { withPath, type NodeRuntime } from '../npm'
import { outputTail, run, runInteractive, startupReason } from '../exec'
import { engineBase } from '../registry'
import { customCodex, discoverCodex, toolEnvironment } from './discover'
import { codexOneShot } from './oneshot'
import { OneShotError, type OneShotReply, type OneShotRequest } from '../oneshot'
import { codexAnchor, readCodexTurns } from './branch'
import { CodexProcess, object, string } from './process'
import { parseCodexRateLimits } from './quota'
import { codexCatalog } from './catalog'
import { CodexCatalog } from './model-catalog'
import { CodexSession, codexLaunchConfig, reservedCodexArg, tomlValue, type CodexLaunchOptions } from './session'
import { CodexReader } from './reader'
import { codexThreadExists, liveCodexThreads, listCodexThreads, newerCodexTurns, readCodexThread } from './native'
import { CodexTranslator, interruptedAgent } from './translate'
import { loadCodexRuns } from './runs'
import { CODEX_NPM_PACKAGE, installCodexWithNpm, updateCodexWithNpm } from './update'
import { array } from './process'
import { codexViewedImage } from './images'
import { accountEnv, forgetCodexAccount, prepareAccountHome } from './accounts'
import { Rerun } from '../rerun'

export interface CodexAdapterOptions {
  /** 用户在设置里替换的命令（绝对路径或 PATH 上的命令名，docs/ui/engine-launch.md） */
  overridePath?: () => string | null
  env?: NodeJS.ProcessEnv
  extraEnv?: () => Record<string, string>
  /** 系统代理（http://主机:端口）；没开代理、开关关了时为 null。用户自己设了代理变量时不用（env.ts systemProxyEnv） */
  systemProxy?: () => string | null
  sessionEnv?: (record: SessionRecord) => NodeJS.ProcessEnv
  launcher?: Launcher
  launchOptions?: () => CodexLaunchOptions
  /** 桌面端的私有 Node.js：没装 Node.js 时一键安装先装它；它和装在里面的 Codex 补在 PATH 最后（docs/ui/engine-update.md §7） */
  nodeRuntime?: NodeRuntime
  /** 当前订阅账号的目录（docs/ui/engine-accounts.md）；null 是原来的 CODEX_HOME */
  account?: () => string | null
}

export class CodexAdapter implements EngineAdapter {
  private cached: { info: EngineInfo; launcher: Launcher | null } | null = null
  private readonly detection = new Rerun(() => this.detect())
  private catalogCache: EngineCatalog | null = null
  /** Codex 带着 Default 模式提问开关起不来过：之后的会话不再带（重新检测时清掉，升级后可能就认得了） */
  private askRejected = false
  /** Codex 报过的各模型窗口（GitHub #20）：设了自动压缩、没填窗口时按它算 token 数 */
  private readonly knownWindows = new Map<string, number>()
  /** 经网关时交给 model_catalog_json 的模型目录（model-catalog.ts）：自带目录和默认提示词按 Codex 版本缓存 */
  private readonly modelCatalog = new CodexCatalog()
  /** 只读的 app-server（列线程、读历史，docs/ui/codex-resume.md §3.5）：每个适配器一个，空闲 60 秒自己关 */
  private readonly reader = new CodexReader(async () => {
    await this.info()
    const found = this.cached
    // 没登录不影响读历史；没装好 / 检测出错读不了
    if (!found?.launcher || (found.info.status !== 'ready' && found.info.status !== 'unauthenticated')) return null
    return {
      launcher: found.launcher,
      args: this.launchArgs(),
      // 读取进程不带网关变量，跟着当前订阅账号走（CODEX_HOME 是账号目录；sessions 等联接回原目录，sqlite 用原目录）：
      // 输入框底栏读当前账号的额度靠它，不能固定成原来的目录
      env: toolEnvironment(found.launcher, this.env()),
      cwd: homedir(),
    }
  })
  /** 像素星空自己的会话正占着的线程（CodexSession 拿到线程 id 时登记、关闭时撤销）：列表上「正开着」不算它们 */
  private readonly ownThreads = new Set<string>()
  /** 最近列出过的线程的来源（终端 / 其他程序）：锁文件只说被占着，是谁占的按来源近似 */
  private readonly listed = new Map<string, 'terminal' | 'other'>()
  readonly npmPackage = CODEX_NPM_PACKAGE
  readonly updateNeedsIdle = true
  /** thread id 由 Codex 分配：宿主不预先塞 id（docs/codex-engine.md 回退 / 分叉一节） */
  readonly enginePicksSessionId = true
  /** 跨引擎接力：别的引擎期间的聊天用 thread/inject_items 注入线程（chat-log.ts） */
  readonly seedsHistory = true
  /** 不带订阅账号的环境：CODEX_HOME 是用户原来的目录 */
  private baseEnv(): NodeJS.ProcessEnv {
    const base = engineEnv(this.opts.env ?? process.env)
    const extra = this.opts.extraEnv?.() ?? {}
    // 补的代理变量放最后：只在用户没设代理时才有，NO_PROXY 已经并进了用户原有的
    return withPath(
      { ...base, ...extra, ...systemProxyEnv(base, extra, this.opts.systemProxy?.() ?? null) },
      this.opts.nodeRuntime?.paths() ?? [],
    )
  }
  /** 启动 Codex 用的环境：选了别的订阅账号时 CODEX_HOME 换成那个账号的目录 */
  private env(dir: string | null | undefined = this.opts.account?.()): NodeJS.ProcessEnv {
    const env = this.baseEnv()
    if (!dir) return env
    const real = env.CODEX_HOME || join(homedir(), '.codex')
    this.prepareHome(real, dir)
    return { ...env, ...accountEnv(real, dir, env) }
  }
  /** 账号目录接回原目录：同一个目录 2 秒内只做一次（env() 调得很频繁） */
  private readonly prepared = new Map<string, number>()
  private prepareHome(real: string, dir: string): void {
    const key = `${real}|${dir}`
    const at = this.prepared.get(key) ?? 0
    if (Date.now() - at < 2000) return
    // 准备失败（账号目录建不起来）不记时间：下一次照样再试
    if (prepareAccountHome(real, dir)) this.prepared.set(key, Date.now())
  }
  constructor(private readonly opts: CodexAdapterOptions = {}) {}
  checkLaunch(command: string | null, args: readonly string[]): void {
    if (command) {
      const custom = customCodex(command, this.env())
      if ('error' in custom) throw new Error(custom.error)
    }
    const reserved = reservedCodexArg(args)
    if (reserved) throw codedError('launch.reserved', { arg: reserved })
  }
  /** 用户追加的启动参数（检测握手、读子智能体记录也带上，参数让进程起不来时检测就能看到） */
  private launchArgs(): string[] {
    return this.opts.launchOptions?.().args ?? []
  }
  /** 一键更新：npm 全局装的用 npm install -g（docs/ui/engine-update.md）；宿主随后重新检测 */
  async update(onLine?: (line: string) => void): Promise<EngineUpdateResult> {
    await this.info()
    // 读取进程也占着 codex.exe：Windows 上 npm 换不了被占用的程序
    await this.reader.close()
    const exe = this.cached?.info.path
    if (!exe) throw new Error(this.cached?.info.message ?? '没找到 Codex')
    const result = await updateCodexWithNpm(exe, this.env(), onLine)
    this.catalogCache = null
    return result
  }
  /** 授权登录：codex login（浏览器）或 codex login --device-auth（设备码）；用检测到的原生程序，npm 垫片不经 shell 起不来 */
  async login(method: 'browser' | 'device', onLine: (line: string) => void): Promise<LoginProcess> {
    const launcher = await this.loginLauncher()
    const args = method === 'device' ? ['login', '--device-auth'] : ['login']
    // 只读进程会缓存启动时的登录状态：登录前后各关一次，下次读额度重新起，不会还是旧账号
    await this.reader.close()
    const proc = runInteractive(launcher, args, toolEnvironment(launcher, this.env()), onLine)
    void proc.done.finally(() => this.reader.close()).catch(() => undefined)
    return proc
  }
  /** 取消授权：codex logout */
  async logout(): Promise<EngineUpdateResult> {
    return this.accountLogout(undefined)
  }
  /** 登录到某个订阅账号的目录（添加账号、重新登录）；dir 为 null 是原来的目录 */
  async accountLogin(
    dir: string | null,
    method: 'browser' | 'device',
    onLine: (line: string) => void,
  ): Promise<LoginProcess> {
    const launcher = await this.loginLauncher()
    const args = method === 'device' ? ['login', '--device-auth'] : ['login']
    await this.reader.close()
    const proc = runInteractive(launcher, args, toolEnvironment(launcher, this.env(dir)), onLine)
    void proc.done.finally(() => this.reader.close()).catch(() => undefined)
    return proc
  }
  /** 退出某个订阅账号（移除账号）；dir 不传是当前账号，null 是原来的目录 */
  async accountLogout(dir: string | null | undefined): Promise<EngineUpdateResult> {
    const launcher = await this.loginLauncher()
    await this.reader.close()
    const r = await run(launcher, ['logout'], toolEnvironment(launcher, this.env(dir)))
    await this.reader.close()
    return { ok: r.ok, output: outputTail(r), version: null }
  }
  /** 会话的 CODEX_HOME 在创建时定好（换账号后重建）：还有进程活着、用的是这个目录就算在用 */
  private readonly liveSessions = new Set<{ home: string; alive: () => boolean }>()
  accountInUse(dir: string): boolean {
    const want = resolve(dir).toLowerCase()
    for (const s of this.liveSessions) if (s.home && resolve(s.home).toLowerCase() === want && s.alive()) return true
    return false
  }
  /** 删除账号：只删账号目录里本机的凭据文件（不退出登录、不联网）；目录骨架留着，线程索引里记着这里的路径 */
  accountForget(dir: string): void {
    forgetCodexAccount(dir)
  }

  /**
   * 临时起一个 app-server 读某个账号：登录了没有、邮箱、套餐、额度（docs/ui/engine-accounts.md §3）。
   * 不复用读取进程：它跟着当前账号走
   */
  async accountProbe(dir: string | null): Promise<AccountProbe> {
    const launcher = await this.loginLauncher()
    const proc = new CodexProcess(
      launcher,
      ['app-server', '--listen', 'stdio://', ...this.launchArgs()],
      homedir(),
      toolEnvironment(launcher, this.env(dir)),
      { notification() {}, request: id => proc.respondError(id, 'No interactive session'), exit() {} },
    )
    try {
      await proc.initialize()
      const auth = await proc.request('account/read', { refreshToken: false })
      const account = object(auth.account)
      const email = string(account.email).trim() || null
      const plan = string(account.planType).trim() || null
      const signedIn = Object.keys(account).length > 0
      if (account.type !== 'chatgpt') return { signedIn, email, plan, quota: null }
      try {
        const res = await proc.request('account/rateLimits/read', { excludeResetCreditDetails: true })
        return { signedIn, email, plan, quota: parseCodexRateLimits(res, Date.now()) }
      } catch (error) {
        // 登录失效：读额度时才发现
        if (/authentication required|unauthori[sz]ed|401/i.test((error as Error).message))
          return { signedIn: false, email, plan, quota: null }
        throw error
      }
    } finally {
      await proc.close()
    }
  }
  private async loginLauncher(): Promise<Launcher> {
    await this.info()
    const launcher = this.cached?.launcher
    if (!launcher) throw new Error(this.cached?.info.message ?? '没找到 Codex')
    return launcher
  }
  /** 一键安装：npm install -g（找得到 npm、或桌面端能给私有 Node.js 时 info.installable 才为真） */
  async install(onLine: (line: string) => void = () => undefined): Promise<EngineUpdateResult> {
    await this.reader.close()
    const result = await installCodexWithNpm(this.env(), onLine, this.opts.nodeRuntime)
    this.catalogCache = null
    return result
  }
  async info(force = false): Promise<EngineInfo> {
    if (this.cached && !force) return this.cached.info
    // 强制检测碰上在跑的那次：那次的环境可能是换号前的，跑完再检测一次
    return this.detection.run(force)
  }
  private async detect(): Promise<EngineInfo> {
    this.askRejected = false
    const before = this.cached?.info.path
    const result = this.opts.launcher
      ? {
          info: {
            ...engineBase('codex'),
            status: 'ready' as const,
            version: null,
            path: this.opts.launcher.command,
            message: null,
          },
          launcher: this.opts.launcher,
        }
      : await discoverCodex(this.opts.overridePath?.() ?? null, this.env())
    // 没装 Node.js 也能一键安装：桌面端先装一份私有的（用户替换了命令的不给装）
    if (result.info.status === 'missing' && result.info.launch === 'stock' && this.opts.nodeRuntime)
      result.info = { ...result.info, installable: true }
    this.cached = result
    // Codex 换了位置（用户在设置里换了命令、重装）：读取进程还是旧程序，马上关掉，不占着旧的 codex.exe。
    // 参数、环境变量（CODEX_HOME）变了由读取进程自己在下次请求前核对、换进程（reader.ts readerLaunchKey）
    if (before !== undefined && before !== result.info.path) void this.reader.close()
    if (!result.launcher || result.info.status !== 'ready') return result.info
    let stderr = ''
    const proc = new CodexProcess(
      result.launcher,
      ['app-server', '--listen', 'stdio://', ...this.launchArgs()],
      process.cwd(),
      toolEnvironment(result.launcher, this.env()),
      {
        notification() {},
        request: id => proc.respondError(id, 'No interactive session'),
        exit: (_code, tail) => (stderr = tail),
      },
    )
    try {
      await proc.initialize()
      this.catalogCache = await codexCatalog(proc)
      // 目录那边已经读账号失败（连 ChatGPT 超时）：不再等第二次；引擎照常算可用，不然消息发不出去
      const auth =
        this.catalogCache.authType === undefined ? null : await proc.request('account/read', { refreshToken: false })
      // 已授权的账号（ChatGPT 登录有邮箱和套餐；API Key 登录没有）
      const account = object(auth?.account)
      const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
      const found = { email: text(account.email), plan: text(account.planType) }
      const filled = Object.fromEntries(Object.entries(found).filter(([, v]) => v))
      if (Object.keys(filled).length) result.info.account = filled
      if (auth?.requiresOpenaiAuth === false) {
        // config.toml 里配了自己的接口：不用登录也能跑，codex logout 取消不掉它
        result.info.auth = { kind: 'provider', provider: this.catalogCache.currentProvider ?? undefined }
      } else if (account.type === 'apiKey') result.info.auth = { kind: 'apiKey' }
      else if (Object.keys(account).length) result.info.auth = { kind: 'login' }
      else if (auth?.requiresOpenaiAuth === true) {
        result.info.status = 'unauthenticated'
        result.info.message = 'Codex is not signed in. Run codex login.'
      }
    } catch (error) {
      result.info.status = 'error'
      result.info.message = startupReason(stderr) || (error as Error).message
      // 追加了参数或替换了命令：原因也显示在「启动」卡片上（docs/ui/engine-launch.md §9.3）
      if (this.launchArgs().length || result.info.launch === 'custom') result.info.launchError = result.info.message
    } finally {
      await proc.close()
    }
    return result.info
  }
  async catalog(force = false): Promise<EngineCatalog> {
    await this.info(force)
    return this.catalogCache ?? { outputStyles: [], currentOutputStyle: null }
  }
  /**
   * 子智能体的记录（详情面板跑着时每 2.5 秒读一次）：用常驻的读取进程读，不再每次新起一个 codex.exe
   * （以前一个子智能体开着详情两分钟就起了五十多个进程）
   */
  /** 不带会话、用当前登录的账号单独问一次（AI 写提交信息，docs/ui/ai-commit-channels.md §4） */
  async oneShot(req: OneShotRequest, signal: AbortSignal): Promise<OneShotReply> {
    const info = await this.info()
    const launcher = this.cached?.launcher
    if (!launcher || info.status === 'missing' || info.status === 'outdated' || info.status === 'unsupported')
      throw new OneShotError('notInstalled', info.message ?? 'Codex 没有安装')
    if (info.status === 'unauthenticated') throw new OneShotError('notAuthorized', info.message ?? 'Codex 没有登录')
    if (info.status !== 'ready') throw new OneShotError('failed', info.message ?? 'Codex 不可用')
    return codexOneShot(launcher, this.launchArgs(), toolEnvironment(launcher, this.env()), req, signal)
  }

  /** 旁聊：从会话的线程临时分叉、只读不审批，问一次就关（docs/ui/codex-sidechat.md）；启动配置和会话进程一样（走网关的也是） */
  async sideQuestion(record: SessionRecord, prompt: string, signal: AbortSignal): Promise<string> {
    if (!record.engineSessionId) throw new Error('先在主对话里发一条消息')
    await this.info()
    const result = this.cached
    if (
      !result?.launcher ||
      (result.info.status !== 'ready' && !(viaGateway(record) && result.info.status === 'unauthenticated'))
    )
      throw new Error(result?.info.message ?? 'Codex is unavailable')
    const launched = await codexLaunchConfig(
      record,
      this.sessionEnvironment(result.launcher, record),
      { maxRetries: null },
      this.sessionOptions(result.launcher, result.info.version ?? null),
      false,
    )
    const reply = await codexOneShot(
      result.launcher,
      launched.args,
      launched.env,
      { prompt, model: record.model },
      signal,
      {
        threadId: record.engineSessionId,
        // 回退了还没发新消息：线程要下次启动才截断，旁聊先截到保留的最后一轮
        lastTurnId: record.pendingRewind ?? null,
        cwd: record.cwd,
        effort: record.effort,
        // 和会话进程一样显式带来源，不然沿用线程存的来源，平台会话可能绕过网关
        modelProvider: launched.gatewayProvider ?? (launched.env.PIXELSKY_CODEX_PROVIDER || null),
      },
    )
    return reply.text
  }

  async subagentTranscript(record: SessionRecord, agentId: string): Promise<Item[]> {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(agentId)) throw new Error('Invalid Codex subagent')
    const result = await this.reader.request('thread/read', { threadId: agentId, includeTurns: true })
    const translator = new CodexTranslator(
      () => {},
      undefined,
      undefined,
      string(object(result.thread).cwd) || record.cwd,
    )
    for (const turn of array(object(result.thread).turns))
      for (const item of array(object(turn).items)) translator.item(object(item), true, false)
    return [...translator.items.values()]
  }
  /**
   * 回退 / 分叉的截断点：起一个临时 app-server 冷读线程的轮次（不 resume），按用户消息 clientId 求「最后保留的一轮」。
   * 读不到（没装、线程没了、没有 clientId）返回 null，宿主按「找不到」处理
   */
  async rewindAnchor(record: SessionRecord, userItemIds: string[]): Promise<RewindAnchor | null> {
    if (!record.engineSessionId) return null
    let proc: CodexProcess | undefined
    try {
      await this.info()
      const launcher = this.cached?.launcher
      if (!launcher || this.cached?.info.status === 'error') return null
      const p: CodexProcess = (proc = new CodexProcess(
        launcher,
        ['app-server', '--listen', 'stdio://', ...this.launchArgs()],
        record.cwd,
        this.sessionEnvironment(launcher, record),
        { notification() {}, request: id => p.respondError(id, 'Read-only history'), exit() {} },
      ))
      await p.initialize()
      // 从终端导入的线程：用户条目的 id 就是 turn id，每一轮都能对位
      return codexAnchor(await readCodexTurns(p, record.engineSessionId), userItemIds, {
        byTurnId: record.imported?.engine === 'codex',
      })
    } catch {
      return null
    } finally {
      await proc?.close()
    }
  }
  /** 界面进程和终端模式共用的启动选项（用户追加参数、上下文窗口、模型目录等） */
  private sessionOptions(launcher: Launcher, version: string | null): CodexLaunchOptions {
    return {
      version,
      askRejected: () => this.askRejected,
      rejectAsk: () => (this.askRejected = true),
      ...(this.opts.launchOptions?.() ?? { askQuestions: true }),
      defaultModel: () => this.catalogCache?.currentModel ?? null,
      knownWindows: this.knownWindows,
      modelCatalog: (model, window, auto) =>
        this.modelCatalog.file(launcher, version, toolEnvironment(launcher, this.baseEnv()), model, window, auto),
    }
  }
  /**
   * 终端（TUI）模式启动参数（docs/ui/tui-toggle.md §5.2）：codex resume <线程>，配置和界面进程一样（codexLaunchConfig），
   * 权限、模型、推理强度按对话的设置给。Codex 不能预先指定线程 id，还没有线程的新对话由宿主先拦下（tuiBlock 的 fresh）
   */
  async tuiLaunch(
    record: SessionRecord,
    extensions?: import('@pixelsky/protocol').ExtensionLaunch,
  ): Promise<TuiLaunch> {
    if (record.engine !== 'codex') throw new Error('不是 Codex 对话')
    const thread = record.engineSessionId
    if (!thread) throw new Error('Codex 新对话先在界面里聊一句，再切到终端')
    await this.info()
    const result = this.cached
    if (
      !result?.launcher ||
      (result.info.status !== 'ready' && !(viaGateway(record) && result.info.status === 'unauthenticated'))
    )
      throw new Error(result?.info.message ?? 'Codex is unavailable')
    // shortcut: 扩展的技能根（skills/extraRoots/set）只能经 app-server 设置，终端里没有；要的话得等 Codex 命令行支持
    const launched = await codexLaunchConfig(
      record,
      this.sessionEnvironment(result.launcher, record),
      { maxRetries: null, extensions },
      this.sessionOptions(result.launcher, result.info.version ?? null),
      false,
    )
    const mode = record.permissionMode
    const sandbox = mode === 'full' ? 'danger-full-access' : mode === 'plan' ? 'read-only' : 'workspace-write'
    const args = [
      ...result.launcher.args,
      'resume',
      thread,
      ...launched.args,
      '-C',
      record.cwd,
      // 命令行的 -a 只认 on-request / never（0.164 起 untrusted 连配置项也不认了）：询问档在终端里按 on-request
      '-a',
      mode === 'full' ? 'never' : 'on-request',
      '-s',
      sandbox,
      // 接管到终端也按自动审核走（docs/ui/codex-auto-review.md）
      ...(mode === 'auto' ? ['-c', `approvals_reviewer=${tomlValue('auto_review')}`] : []),
      ...(record.model ? ['-m', record.model] : []),
      ...(record.effort ? ['-c', `model_reasoning_effort=${tomlValue(record.effort)}`] : []),
      ...(record.extraDirs ?? []).flatMap(dir => ['--add-dir', dir]),
    ]
    return { command: result.launcher.command, args, env: launched.env, cwd: record.cwd, engineSessionId: thread }
  }
  /** 会话和读历史的临时进程共用的环境：平台 / 自定义接口会话去掉 OpenAI 登录变量，带上网关变量 */
  private sessionEnvironment(launcher: Launcher, record: SessionRecord): NodeJS.ProcessEnv {
    const env = toolEnvironment(launcher, this.env())
    env.PIXELSKY_CODEX_PROVIDER = this.catalogCache?.currentProvider ?? 'openai'
    if (viaGateway(record)) {
      for (const key of Object.keys(env)) if (/^(OPENAI_|CODEX_ACCESS_TOKEN|CHATGPT_)/i.test(key)) delete env[key]
      Object.assign(env, this.opts.sessionEnv?.(record) ?? {})
    }
    return env
  }
  restoreItem(record: SessionRecord, item: Item): Item {
    if (item.kind !== 'tool' || item.name !== 'imageView' || item.status !== 'completed' || item.images?.length)
      return item
    const image = codexViewedImage(item.title, item.id, record.cwd)
    return image ? { ...item, images: [image] } : item
  }
  createSession(ctx: SessionContext): EngineSession {
    const result = this.cached
    if (
      !result?.launcher ||
      (result.info.status !== 'ready' && !(viaGateway(ctx.record()) && result.info.status === 'unauthenticated'))
    )
      throw new Error(result?.info.message ?? 'Codex is unavailable')
    const env = this.sessionEnvironment(result.launcher, ctx.record())
    const session = new CodexSession(result.launcher, env, ctx, {
      ...this.sessionOptions(result.launcher, result.info.version ?? null),
      // 宿主的运行时里已经有（打开会话时从 rollout 读过，之后实时更新）：直接用，不再整读一遍 rollout。
      // 没有进程可接着跑了，还停在 running 的标成已中断（与 loadCodexRuns 一致）
      savedAgents: () =>
        ctx.runs
          ? ctx.runs().agents.map(agent => ({ ...interruptedAgent(agent) }))
          : this.loadRuns(ctx.record()).agents,
      ownThread: (id, own) => {
        if (own) this.ownThreads.add(id)
        else this.ownThreads.delete(id)
      },
    })
    // 记下活着的会话和它的 CODEX_HOME（移除账号前查 accountInUse）；关掉时撤掉
    const entry = { home: env.CODEX_HOME ?? '', alive: () => session.processAlive }
    this.liveSessions.add(entry)
    const close = session.close.bind(session)
    session.close = async opts => {
      this.liveSessions.delete(entry)
      return close(opts)
    }
    return session
  }
  /** Codex 的数据目录（env.CODEX_HOME，没有就是 ~/.codex）；用了订阅账号时是原来的目录（账号目录里的 sessions 等联接回这里） */
  codexHome(record?: SessionRecord): string {
    // 订阅账号的目录里 sessions 等是接回原目录的，扫描、找线程都用原目录
    const env = record && viaGateway(record) ? { ...this.baseEnv(), ...this.opts.sessionEnv?.(record) } : this.baseEnv()
    return env.CODEX_HOME || join(homedir(), '.codex')
  }
  /**
   * 没有会话进程时读一次账号额度（docs/ui/account-quota.md §3.3）：复用只读的 app-server（空闲 60 秒自己关、请求排队、不拿线程锁），
   * 不另起进程。没用 ChatGPT 登录（API Key、自己配置的接口）→ unsupported
   */
  async accountQuota(): Promise<QuotaReading> {
    await this.info()
    if (this.cached?.info.status !== 'ready') return { kind: 'unsupported' }
    const signal = AbortSignal.timeout(10_000)
    const auth = await this.reader.request('account/read', { refreshToken: false }, signal)
    const account = object(auth.account)
    if (account.type !== 'chatgpt') return { kind: 'unsupported' }
    try {
      // 不排除重置卡明细：额度弹层要显示每张的到期时间（docs/ui/codex-reset-card.md）
      const res = await this.reader.request('account/rateLimits/read', { excludeResetCreditDetails: false }, signal)
      const reading = parseCodexRateLimits(res, Date.now())
      return reading.kind === 'ok' ? { ...reading, account: string(account.email) || null } : reading
    } catch (error) {
      if (/authentication required/i.test((error as Error).message)) return { kind: 'unsupported' }
      throw error
    }
  }
  /** 用一张重置卡：走只读进程（它跟着当前账号），不借会话进程 */
  async consumeResetCredit(creditId: string | null, idempotencyKey: string): Promise<ResetCreditOutcome> {
    const res = await this.reader.request(
      'account/rateLimitResetCredit/consume',
      { idempotencyKey, ...(creditId ? { creditId } : {}) },
      AbortSignal.timeout(20_000),
    )
    const outcome = string(object(res).outcome)
    return outcome === 'reset' ||
      outcome === 'nothingToReset' ||
      outcome === 'noCredit' ||
      outcome === 'alreadyRedeemed'
      ? outcome
      : 'noCredit'
  }
  /** 关掉适配器自己的常驻进程（应用退出）：读取进程 */
  close(opts?: CloseOptions): Promise<void> {
    return this.reader.close(opts)
  }
  // ---------- 接着终端里的 Codex 会话（docs/ui/codex-resume.md） ----------
  async nativeSessions(cwd: string, opts?: ListOptions): Promise<NativeSessionList> {
    const list = await listCodexThreads(this.reader, cwd, opts)
    for (const s of list.sessions) {
      this.listed.delete(s.id)
      this.listed.set(s.id, s.source)
    }
    // 只留最近列出的一批，旧的不再需要
    while (this.listed.size > 2000) this.listed.delete(this.listed.keys().next().value!)
    return list
  }
  readNativeSession(cwd: string, id: string, opts?: ReadOptions): Promise<NativeRead | null> {
    return readCodexThread(this.reader, cwd, id, opts)
  }
  newerNativeTurns(
    cwd: string,
    id: string,
    after: string,
    opts?: { turns?: number; afterTurn?: boolean },
  ): Promise<NewerTurns | null> {
    // 终端里正开着：末尾还没结束的那一轮不补（和导入时一样），等它结束了下次 check 再补
    const live = this.nativeLive([{ id, mtimeMs: 0 }]).get(id) != null
    return newerCodexTurns(this.reader, cwd, id, after, { turns: opts?.turns, live })
  }
  hasNativeSession(record: SessionRecord): boolean {
    return !record.engineSessionId || codexThreadExists(this.codexHome(record), record.engineSessionId)
  }
  nativeLive(rows: readonly { id: string; mtimeMs: number }[]): Map<string, LiveState> {
    return liveCodexThreads(this.codexHome(), rows, this.ownThreads, this.listed)
  }
  /** 子智能体追踪从线程的 rollout 还原（读不到就是空的） */
  loadRuns(record: SessionRecord): AgentRuns {
    if (!record.engineSessionId) return { workflows: [], agents: [] }
    return loadCodexRuns(this.codexHome(record), record.engineSessionId)
  }
}

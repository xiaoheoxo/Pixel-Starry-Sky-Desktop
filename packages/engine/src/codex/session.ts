import { delimiter } from 'node:path'
import type {
  ApprovalDecision,
  AgentRun,
  ApprovalRequest,
  ContextWindows,
  EngineCatalog,
  ImageAttachment,
  RequestRetryState,
  NoticeError,
  SessionSettings,
  SkillCommand,
  TurnOutcome,
} from '@pixelsky/protocol'
import { EMPTY_FLAGS, codedError, isQuietWarning, noticeErrorOf, viaGateway } from '@pixelsky/protocol'
import { versionAtLeast } from '../exec'
import { QUICK_CLOSE_MS, type CloseOptions, type EngineSession, type Launcher, type SessionContext } from '../adapter'
import { NO_REPLY, seedImageCount, seedTurns, type ChatSeed, type ChatTurn } from '../chat-log'
import { CodexProcess, array, object, string, type Message } from './process'
import { readCodexTurns, revertTarget } from './branch'
import { codexCatalog } from './catalog'
import { codexThreadName } from './native'
import { codexCommandParts } from './command'
import { codexChanges, CodexTranslator, tokenCounts } from './translate'
import { CODEX_WINDOW_ENV, codexContextConfig } from './context-config'

export interface CodexLaunchOptions {
  askQuestions: boolean
  steeringValidated?: boolean
  /** 用户追加的启动参数，放在 app-server --listen stdio:// 后面、像素星空自己的 -c 前面（docs/ui/engine-launch.md §3） */
  args?: string[]
  /** 自动压缩触发点（百分比）；null 用 Codex 自己的（GitHub #20） */
  autoCompactPct?: number | null
  /** 云端 / 本机模型填的上下文窗口 */
  contextWindows?: ContextWindows
  /** 检测到的 Codex 版本；null 是读不到（替换的命令不一定报版本） */
  version?: string | null
  /** Codex 带着 Default 模式提问开关起不来时记在适配器上：之后新开的会话不用再失败一次（重新检测后清掉） */
  askRejected?: () => boolean
  rejectAsk?: () => void
  /** 会话用默认模型时，Codex 报的当前模型 */
  defaultModel?: () => string | null
  /** Codex 报过的各模型窗口（没改窗口时记下），算自动压缩的 token 数用 */
  knownWindows?: Map<string, number>
  /** 以前派出过的子智能体（从 rollout 还原）：接着跑完时在原来的追踪上更新 */
  savedAgents?: () => AgentRun[]
  /** 这个会话占着的线程：拿到线程 id 时登记、换线程 / 进程退出 / 关闭时撤销（适配器的 ownThreads，列表上「正开着」不算它们） */
  ownThread?: (id: string, own: boolean) => void
}

/** 用户追加的参数里第一个由像素星空控制的（docs/ui/engine-launch.md §3）：--listen，改平台线路的 -c；都允许时返回 null */
export function reservedCodexArg(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--listen' || arg.startsWith('--listen=')) return '--listen'
    let value: string | undefined
    if (arg === '-c' || arg === '--config') value = args[i + 1]
    else if (arg.startsWith('--config=')) value = arg.slice('--config='.length)
    else if (arg.startsWith('-c') && !arg.startsWith('--')) value = arg.slice(2).replace(/^=/, '')
    if (value === undefined) continue
    const key = value.split('=')[0].trim()
    if (key === 'model_provider' || key === 'model_providers' || key.startsWith('model_providers.pixelsky'))
      return `-c ${key}`
  }
  return null
}
/** 「允许中途向我提问」时打开的 Codex 开发中功能：Default 模式（非计划）下模型也有 request_user_input */
const DEFAULT_MODE_ASK = 'default_mode_request_user_input'
/** 这个开关最早出现的版本（0.110.0 的 features.rs 里已有，更早的没核实），比 CODEX_MIN_VERSION 低 */
export const DEFAULT_MODE_ASK_MIN_VERSION = '0.110.0'
/** 这个版本的 Codex 认不认得开关；版本读不到时照常带，不认得的老版本靠「启动失败重试」和警告过滤兜底 */
export function defaultModeAskSupported(version: string | null | undefined): boolean {
  return !version || versionAtLeast(version, DEFAULT_MODE_ASK_MIN_VERSION)
}
/** 不认识的设置项警告里指向开关的那一行（形如 "  session-flags: `features.default_mode_request_user_input` is ignored."） */
const OWN_FEATURE_LINE = /`(?:features\.)?default_mode_request_user_input`/
/**
 * Codex 的配置类警告去掉像素星空自己打开的那项（只在开关是我们加的才去：用户自己的 config.toml / 参数也开了就原样留着）：
 * 开发中功能的警告去掉这一项，不认识的设置项（旧版 Codex 不认得开关）的警告去掉这一行并减掉个数；只剩它时返回 null 不报
 */
export function withoutOwnFeatures(text: string, added: boolean): string | null {
  if (!added) return text
  // isQuietWarning 认警告时先去掉开头的空白，这里也一样，不然开头带换行的警告匹配不上
  const body = text.trimStart()
  const features = /^Under-development features? enabled: ([^.]*)\./i.exec(body)
  if (features) {
    const rest = features[1]
      .split(',')
      .map(key => key.trim())
      .filter(key => key && key !== DEFAULT_MODE_ASK)
    if (!rest.length) return null
    return body.replace(features[1], rest.join(', '))
  }
  const [head, ...lines] = body.split('\n')
  const ignoring = /^(Codex is ignoring )(\d+)( unrecognized configuration setting)s?\b(.*)$/i.exec(head)
  const kept = lines.filter(line => !OWN_FEATURE_LINE.test(line))
  if (!ignoring || kept.length === lines.length) return text
  const count = Number(ignoring[2]) - (lines.length - kept.length)
  if (count <= 0) return null
  return [`${ignoring[1]}${count}${ignoring[3]}${count === 1 ? '' : 's'}${ignoring[4]}`, ...kept].join('\n')
}
/** Codex TurnError 里 message 之外的原始信息（附加说明、错误类型、HTTP 状态码），给界面「详情」用；没有时为 null */
export function turnErrorDetail(raw: unknown, willRetry?: unknown): string | null {
  const error = object(raw),
    lines: string[] = []
  const details = string(error.additionalDetails).trim()
  if (details) lines.push(details)
  const info = error.codexErrorInfo
  if (typeof info === 'string' && info) lines.push(`type: ${info}`)
  else if (info && typeof info === 'object')
    for (const [kind, value] of Object.entries(info as Record<string, unknown>)) {
      lines.push(`type: ${kind}`)
      const status = object(value).httpStatusCode
      if (typeof status === 'number') lines.push(`HTTP status: ${status}`)
    }
  if (!lines.length) return null
  if (typeof willRetry === 'boolean') lines.push(`will retry: ${willRetry ? 'yes' : 'no'}`)
  return lines.join('\n')
}

/**
 * Codex 自己在重连（error 通知带 willRetry: true，message 是「Reconnecting... 2/5」）：转成界面的「正在重试 n/m」状态条。
 * 原因优先写 HTTP 状态码，其次附加说明的第一行；Codex 不报等多久，retryAt 为 null
 */
export function codexRetryState(raw: unknown, turnId: string): RequestRetryState {
  const error = object(raw)
  const message = string(error.message).trim()
  const count = /(\d+)\s*\/\s*(\d+)/.exec(message)
  let status: number | null = null
  const info = error.codexErrorInfo
  if (info && typeof info === 'object')
    for (const value of Object.values(info as Record<string, unknown>)) {
      const code = object(value).httpStatusCode
      if (typeof code === 'number') status = code
    }
  const details = string(error.additionalDetails).trim().split('\n')[0].trim()
  const reason =
    status !== null
      ? `HTTP ${status}`
      : details
        ? details.slice(0, 300)
        : message.replace(/^Reconnecting\.*\s*(\d+\s*\/\s*\d+)?\s*/i, '').trim() || 'Connection lost'
  return {
    turnId,
    attempt: count ? Number(count[1]) : null,
    maxRetries: count ? Number(count[2]) : null,
    retryAt: null,
    reason,
  }
}

/** Codex 这一轮换了模型（model/rerouted）：给对话里的提示；原因认不出时写在详情里 */
export function codexRerouteNotice(params: Message): { text: string; detail: string | null } | null {
  const from = string(params.fromModel),
    to = string(params.toModel),
    reason = string(params.reason)
  if (!to || to === from) return null
  const text = `Codex switched the model from ${from || 'the selected model'} to ${to}`
  if (reason === 'highRiskCyberActivity')
    return { text: `${text}: the request was flagged as high-risk cybersecurity activity`, detail: null }
  return { text, detail: reason ? `reason: ${reason}` : null }
}

/**
 * Codex TurnError 的结构化信息（notice.error）：codexErrorInfo 的类型名（协议里是 camelCase，如 contextWindowExceeded）当错误代码，带 HTTP 状态码的取出来；
 * 归类走协议里的同一张代码表，没有可用信息时 undefined
 */
export function turnNoticeError(raw: unknown, text: string): NoticeError | undefined {
  const info = object(raw).codexErrorInfo
  let code: string | undefined, status: number | undefined
  if (typeof info === 'string' && info) code = info
  else if (info && typeof info === 'object') {
    const [kind, value] = Object.entries(info as Record<string, unknown>)[0] ?? []
    code = kind || undefined
    const http = object(value).httpStatusCode
    if (typeof http === 'number') status = http
  }
  return noticeErrorOf({ code, status, text })
}

/** extraDirs：项目的附加文件夹，和工作目录一样可写（docs/ui/multi-root-projects.md §3.3） */
export function codexPermission(mode: string, cwd?: string, extraDirs: readonly string[] = []): Message {
  return mode === 'full'
    ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }
    : mode === 'plan'
      ? { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
      : {
          approvalPolicy: mode === 'ask' ? 'untrusted' : 'on-request',
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: cwd ? [cwd, ...extraDirs] : [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        }
}
type Approval = { id: string | number; method: string; params: Message; request: ApprovalRequest }
export function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(tomlValue).join(', ') + ']'
  if (value && typeof value === 'object')
    return (
      '{ ' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([key, v]) => JSON.stringify(key) + ' = ' + tomlValue(v))
        .join(', ') +
      ' }'
    )
  return JSON.stringify(value)
}
export class CodexSession implements EngineSession {
  private proc: CodexProcess | null = null
  private opening: Promise<void> | null = null
  private closed = false
  private threadId: string | null = null
  /** 线程现在在 Codex 里的名字（syncThreadName 用来判断要不要改） */
  private threadName = ''
  /** 已经向 options.ownThread 登记的线程 id */
  private ownedThread: string | null = null
  /** 恢复线程失败、改开了新线程的英文提示：要等聊天注入之后才发（注入成功且宿主已经说过「记录不在了」就不发） */
  private resumeNotice: string | null = null
  private nativeTurnId: string | null = null
  private readonly finishedTurns = new Set<string>()
  private active: {
    id: string
    started: number
    model: string
    baseline: ReturnType<typeof tokenCounts>
    usageSeen: boolean
    activity: boolean
  } | null = null
  private settings: SessionSettings
  private catalog: EngineCatalog | null = null
  private readonly approvals = new Map<string, Approval>()
  private readonly guidance = new Map<
    string,
    { text: string; attachments: ImageAttachment[]; accepted: boolean; observed: boolean }
  >()
  private readonly earlyConsumed = new Set<string>()
  private skills: SkillCommand[] = []
  private totals = tokenCounts({})
  private last = tokenCounts({})
  private contextWindow: number | null = null
  private compacting = false
  private translator: CodexTranslator
  /** 派出过的子智能体：每轮换新翻译器也要保留 */
  private readonly agents = new Map<string, AgentRun>()
  private reportedError: string | null = null
  /** 这一轮正显示着 Codex 的重连状态条（codexRetryState）：有新输出或一轮结束时清掉 */
  private retryShown = false
  /** 同一毫秒内的多条报错也要各自保留，id 不能只靠时间戳 */
  private noticeSeq = 0
  /** 启动时带了 model_context_window：报上来的窗口是设置的值，不记成 Codex 自己的 */
  private windowOverridden = false
  /** 线程当前沿用的协作模式（turn/start 成功带过的或恢复时报的）；null 是还没带过，线程用的是没有模式指令的 Default */
  private modeSent: 'plan' | 'default' | null = null
  /** 协作模式里最后带的模型和推理强度：它优先于 turn/start 外层的 model / effort，中途换了就要重新带 */
  private modeModel: string | null = null
  private modeEffort: string | null = null
  /** thread/start 报的模型：会话跟随引擎默认、目录也没写当前模型时，计划模式用它 */
  private threadModel: string | null = null
  /** thread/start 报的推理强度（含 config.toml 里的 model_reasoning_effort）：会话跟随引擎默认时带协作模式用它，不能带 null 冲掉 */
  private threadEffort: string | null = null
  /** 当前 Codex 进程带了 Default 模式提问开关：带了才给模型 Default 模式的提问指令 */
  private askFlag = false
  /** 开关是像素星空加的（用户自己的 config.toml / 参数没开）：警告里才去掉这一项 */
  private ownAskFlag = false
  /** Codex 因为开关起不来：之后重连也不再带 */
  private askFlagRejected = false
  /** 当前这次启动的 initialize 进度：只有 initialize 失败（进程起不来）才可能是开关引起的 */
  private startup: 'pending' | 'done' | 'failed' = 'pending'
  /** 停止后等待 turn/completed 的回调，finish() 时统一唤醒 */
  private turnWaiters: Array<() => void> = []

  constructor(
    private readonly launcher: Launcher,
    private readonly env: NodeJS.ProcessEnv,
    private readonly ctx: SessionContext,
    private readonly options: CodexLaunchOptions,
  ) {
    this.settings = { ...ctx.record() }
    try {
      for (const agent of options.savedAgents?.() ?? []) this.agents.set(agent.id, agent)
    } catch {
      // 读不到以前的追踪不影响会话
    }
    this.translator = new CodexTranslator(
      event => this.ctx.emit(event),
      () => this.last.total || null,
      this.agents,
    )
  }
  private async open(): Promise<void> {
    if (this.closed) throw new Error('Codex session is closed')
    if (this.threadId && this.proc?.alive) return
    if (this.opening) return this.opening
    this.opening = this.connect().finally(() => {
      this.opening = null
    })
    return this.opening
  }
  private async connect(): Promise<void> {
    const ask =
      this.options.askQuestions &&
      !this.askFlagRejected &&
      !this.options.askRejected?.() &&
      defaultModeAskSupported(this.options.version)
    if (!ask) return this.launch(false)
    try {
      return await this.launch(true)
    } catch (error) {
      // 开关让 Codex 起不来（以后改名 / 去掉了）：不带开关重试一次，之后也不再带，也不再带 Default 模式的协作模式；
      // 开关只是锦上添花，起得来之后的失败（线程、网络）和它无关，照常报错
      if (this.closed || this.startup !== 'failed') throw error
      this.askFlagRejected = true
      this.options.rejectAsk?.()
      return this.launch(false)
    }
  }
  private async launch(askFlag: boolean): Promise<void> {
    this.askFlag = askFlag
    this.startup = 'pending'
    const record = this.ctx.record(),
      environment = { ...this.env },
      // 用户追加的参数放在像素星空自己的 -c 前面：同一个配置项写两次时后写的生效
      args = ['app-server', '--listen', 'stdio://', ...(this.options.args ?? [])]
    const config = (key: string, value: unknown): void => {
      args.push('-c', `${key}=${tomlValue(value)}`)
    }
    // 平台和自定义 API 都经本机网关；provider 名分开，Codex 按 provider 存的状态互不串
    const gatewayProvider = record.platform ? 'pixelsky' : record.provider ? 'pixelsky-custom' : null
    if (gatewayProvider) {
      const base = environment.PIXELSKY_CODEX_BASE_URL
      if (!base || !environment.PIXELSKY_CODEX_TOKEN) throw new Error('Codex gateway is unavailable')
      const p = `model_providers.${gatewayProvider}`
      config('model_provider', gatewayProvider)
      config(`${p}.name`, record.platform ? 'Pixel Starry Sky' : 'Custom API')
      config(`${p}.base_url`, base)
      config(`${p}.wire_api`, 'responses')
      config(`${p}.env_key`, 'PIXELSKY_CODEX_TOKEN')
      config(`${p}.requires_openai_auth`, false)
      config(`${p}.supports_websockets`, false)
    }
    if (this.ctx.maxRetries !== null && this.ctx.maxRetries !== undefined) {
      const provider = gatewayProvider ?? string(environment.PIXELSKY_CODEX_PROVIDER)
      // 两层同时使用 N 会放大为 (N+1)² 次请求。自定义仅控制 HTTP
      // 请求层，禁用整条流重新发起；null 保留原生两层策略。
      if (provider) {
        config(`model_providers.${provider}.request_max_retries`, this.ctx.maxRetries)
        config(`model_providers.${provider}.stream_max_retries`, 0)
      }
    }
    Object.assign(environment, this.ctx.extensions?.env)
    if (this.ctx.extensions?.pathDirs.length) {
      const key = Object.keys(environment).find(k => k.toLowerCase() === 'path') ?? 'PATH'
      environment[key] = [...this.ctx.extensions.pathDirs, environment[key] ?? ''].join(delimiter)
    }
    const ext = this.ctx.extensions
    for (const [key, value] of Object.entries(ext?.codexConfig ?? {})) config(key, value)
    if (askFlag) config(`features.${DEFAULT_MODE_ASK}`, true)
    // 用户追加的参数 / 配置也开了同一个功能时警告不是我们的；config.toml 要等 config/read 才知道，警告可能先到，先按我们的算
    this.ownAskFlag =
      askFlag &&
      !(this.options.args ?? []).some(arg => arg.includes(DEFAULT_MODE_ASK)) &&
      !JSON.stringify(ext?.codexConfig ?? {}).includes(DEFAULT_MODE_ASK)
    // 上下文窗口和自动压缩（GitHub #20）：放在用户追加的参数后面，同一项以设置为准
    const model = record.model ?? this.options.defaultModel?.() ?? null
    const context = codexContextConfig({
      record,
      model,
      windows: this.options.contextWindows,
      autoCompactPct: this.options.autoCompactPct,
      providerWindow: environment[CODEX_WINDOW_ENV],
      known: model ? this.options.knownWindows?.get(model) : null,
    })
    delete environment[CODEX_WINDOW_ENV]
    if (context.window) config('model_context_window', context.window)
    if (context.limit) config('model_auto_compact_token_limit', context.limit)
    this.windowOverridden = !!context.window
    const proc = new CodexProcess(this.launcher, args, record.cwd, environment, {
      notification: (method, params) => this.notification(method, params),
      request: (id, method, params) => this.request(id, method, params),
      exit: (_code, tail) => {
        // 带开关启动时在 initialize 前退出：connect() 会不带开关重试，不在这里结束这一轮
        if (this.proc !== proc || (askFlag && this.startup === 'pending')) return
        if (!this.closed && this.active) this.finish('failed', tail || 'Codex process exited')
        this.threadId = null
        this.own(null)
      },
    })
    this.proc = proc
    try {
      // 额外技能根、turn/start 的 collaborationMode（计划模式）都是实验字段，一律声明实验接口（docs/codex-engine.md §3.5）
      await proc.initialize(true).catch(error => {
        this.startup = 'failed'
        throw error
      })
      this.startup = 'done'
      if (ext?.skillRoots?.length) await proc.request('skills/extraRoots/set', { extraRoots: ext.skillRoots })
      this.catalog = await codexCatalog(proc)
      // 用户自己的 config.toml 也开了同一个功能：警告是他们的，不替他们去掉
      if (this.ownAskFlag && (await this.userEnabledAsk(proc))) this.ownAskFlag = false
      const requirements = await proc.request('configRequirements/read').catch(() => ({}))
      const allowed = array(object(object(requirements).requirements).allowedApprovalPolicies)
      const policy = codexPermission(this.settings.permissionMode)
      if (allowed.length && !allowed.includes(policy.approvalPolicy))
        throw new Error('Codex managed requirements prohibit this permission mode')
      const modelProvider = gatewayProvider ?? (string(environment.PIXELSKY_CODEX_PROVIDER) || undefined)
      const threadParams = {
        cwd: record.cwd,
        // 显式带上来源：resume / fork 不带时 Codex 沿用线程自己存的来源，平台会话接以前用别的来源开的线程会绕过网关
        ...(modelProvider ? { modelProvider } : {}),
        // 附加文件夹：Codex 只靠可写目录不知道它们在哪，开线程时说一声
        ...(record.extraDirs?.length ? { developerInstructions: extraDirsNote(record.extraDirs) } : {}),
        ...(record.model ? { model: record.model } : {}),
        approvalPolicy: policy.approvalPolicy,
        sandbox:
          this.settings.permissionMode === 'full'
            ? 'danger-full-access'
            : this.settings.permissionMode === 'plan'
              ? 'read-only'
              : 'workspace-write',
      }
      let thread: Message,
        resumeFailed = false,
        rewindFailed = false,
        forkFailed = false
      if (record.engineSessionId)
        try {
          thread = await proc.request('thread/resume', { threadId: record.engineSessionId, ...threadParams })
          // 回退：下次启动才真正截断（thread/revert 会改写记录），撤销回退因此还来得及
          if (record.pendingRewind)
            try {
              const target = revertTarget(await readCodexTurns(proc, record.engineSessionId), record.pendingRewind)
              if (target === 'missing') throw new Error('Codex rewind point not found')
              if (target)
                await proc.request('thread/revert', { threadId: record.engineSessionId, beforeTurnId: target })
            } catch (error) {
              if (!proc.alive) throw error
              // 找不到截断点或回退失败：不能带着没截断的上下文继续，改用新线程
              thread = await proc.request('thread/start', threadParams)
              rewindFailed = true
            }
        } catch (error) {
          // 进程已经退出说明是连接问题，照常报错；进程还在说明线程找不到或已损坏，改用新线程
          if (!proc.alive) throw error
          // 另一个进程（例如终端里的 codex）正写着这个线程：改开新线程会丢上下文，报给界面让用户选
          if (/already has an active writer/i.test((error as Error).message))
            throw codedError('resume.live', { source: record.imported?.source ?? 'other' })
          thread = await proc.request('thread/start', threadParams)
          resumeFailed = true
        }
      else if (record.pendingFork)
        try {
          // 分叉：从原线程保留到 at 这一轮为止（含），新线程带同样的启动参数
          thread = await proc.request('thread/fork', {
            threadId: record.pendingFork.from,
            lastTurnId: record.pendingFork.at,
            ...threadParams,
          })
        } catch (error) {
          if (!proc.alive) throw error
          thread = await proc.request('thread/start', threadParams)
          forkFailed = true
        }
      else thread = await proc.request('thread/start', threadParams)
      this.threadId = string(object(thread.thread).id)
      this.threadName = string(object(thread.thread).name)
      this.threadModel = string(thread.model) || null
      // 恢复的线程会报它实际的协作模式（新建的不报）：可能还停在计划模式（上次退出前选的计划），下一轮需要时切回 default
      const held = object(thread.collaborationMode),
        heldSettings = object(held.settings)
      this.threadEffort = string(thread.reasoningEffort) || string(heldSettings.reasoning_effort) || null
      // 没开提问时线程里的 default 不是这次要带的，但它的模型和强度仍优先于外层，记下来换了才会重新带
      const heldDefault = string(held.mode) === 'default' && !this.asks()
      this.modeSent = string(held.mode) === 'plan' ? 'plan' : heldDefault ? 'default' : null
      this.modeModel = heldDefault ? string(heldSettings.model) || null : null
      this.modeEffort = heldDefault ? string(heldSettings.reasoning_effort) || null : null
      if (!this.threadId) throw new Error('Codex did not return a thread ID')
      this.ctx.setEngineSessionId(this.threadId)
      this.own(this.threadId)
      this.syncThreadName()
      // 恢复失败的提示等聊天注入之后再发（run()），其余的这里就发
      this.resumeNotice = resumeFailed
        ? 'Could not resume the Codex thread; started a new thread (previous context was not carried over)'
        : null
      const warning = rewindFailed
        ? 'Could not rewind the Codex thread to this message; started a new thread (previous context was not carried over)'
        : forkFailed
          ? 'Could not fork the Codex thread; started a new thread (previous context was not carried over)'
          : null
      if (warning)
        this.ctx.emit({
          type: 'item_completed',
          item: {
            kind: 'notice',
            id: `cx-resume-${Date.now()}-${++this.noticeSeq}`,
            level: 'warn',
            text: warning,
            detail: null,
          },
        })
      // 截断点已处理（成功或改成新线程）：清掉记录里的 pendingRewind / pendingFork
      if (record.pendingRewind) this.ctx.clearPendingRewind?.()
      if (record.pendingFork) this.ctx.clearPendingFork?.()
      this.emitFlags()
      const skills = await proc
        .request('skills/list', {
          cwds: [record.cwd],
          forceReload: !!ext?.skillRoots?.length,
          ...(ext?.skillRoots?.length ? { perCwdExtraUserRoots: { [record.cwd]: ext.skillRoots } } : {}),
        })
        .catch(() => ({}))
      this.skills = array(object(skills).data)
        .flatMap(raw => array(object(raw).skills))
        .flatMap(raw => {
          const skill = object(raw)
          return skill.enabled === false || !string(skill.name) || !string(skill.path)
            ? []
            : [
                {
                  name: string(skill.name),
                  description: string(skill.description),
                  source: 'engine' as const,
                  invocation: 'skill' as const,
                  path: string(skill.path),
                },
              ]
        })
      this.ctx.emit({
        type: 'commands',
        commands: [
          {
            name: 'compact',
            description: 'Summarize the conversation to free up context',
            source: 'engine',
            builtin: true,
            invocation: 'slash',
          },
          ...this.skills,
        ],
      })
    } catch (error) {
      this.proc = null
      await proc.close()
      throw error
    }
  }
  /**
   * 经网关的线程在 Codex 自己的列表里打不开：名字带上「[像素星空]」前缀，跟着会话标题改；
   * 改用自己的账号接着聊时去掉前缀。改名失败（老版本 Codex 没有这个接口）不影响对话
   */
  private syncThreadName(): void {
    const proc = this.proc,
      id = this.threadId
    if (!proc?.alive || !id) return
    const record = this.ctx.record()
    const name = codexThreadName(this.threadName, record.title, viaGateway(record))
    if (name === null) return
    // 先记下，同一个名字不重复发
    this.threadName = name
    void proc.request('thread/name/set', { threadId: id, name }).catch(() => {})
  }
  /** 登记 / 撤销这个会话占着的线程（换了线程先撤销旧的；null 是不再占着） */
  private own(id: string | null): void {
    if (this.ownedThread === id) return
    if (this.ownedThread) this.options.ownThread?.(this.ownedThread, false)
    this.ownedThread = id
    if (id) this.options.ownThread?.(id, true)
  }
  /** 把恢复失败的英文提示发出去（只发一次） */
  private flushResumeNotice(): void {
    const text = this.resumeNotice
    this.resumeNotice = null
    if (!text) return
    this.ctx.emit({
      type: 'item_completed',
      item: { kind: 'notice', id: `cx-resume-${Date.now()}-${++this.noticeSeq}`, level: 'warn', text, detail: null },
    })
  }
  /** 给模型 Default 模式的提问指令：允许提问且 Codex 带着开关启动 */
  private asks(): boolean {
    return this.options.askQuestions && this.askFlag
  }
  /** 用户自己的配置层（config.toml 等，不含命令行 -c）是否开了 Default 模式提问；读不到按没开算 */
  private async userEnabledAsk(proc: CodexProcess): Promise<boolean> {
    const result = await proc.request('config/read', { includeLayers: true }).catch(() => ({}))
    return array(object(result).layers).some(raw => {
      const layer = object(raw)
      return (
        string(object(layer.name).type) !== 'sessionFlags' &&
        object(object(layer.config).features)[DEFAULT_MODE_ASK] === true
      )
    })
  }
  private input(text: string, attachments: ImageAttachment[]): Message[] {
    const input: Message[] = text ? [{ type: 'text', text, text_elements: [] }] : []
    for (const image of attachments)
      input.push({ type: 'image', url: `data:${image.mediaType};base64,${image.dataBase64}` })
    const match = /^\$([^\s]+)(?:\s|$)/.exec(text)
    const skill = this.skills.find(s => s.name === match?.[1])
    if (skill?.path) input.push({ type: 'skill', name: skill.name, path: skill.path })
    return input
  }
  send(text: string, turnId: string, userItemId: string, attachments: ImageAttachment[] = [], seed?: ChatSeed): void {
    if (this.active) {
      this.ctx.emit({ type: 'turn_completed', turnId, outcome: 'failed', error: 'Codex turn already running' })
      return
    }
    this.active = {
      id: turnId,
      started: Date.now(),
      model: this.settings.model ?? this.catalog?.currentModel ?? '',
      baseline: { ...this.totals },
      usageSeen: false,
      activity: false,
    }
    this.translator = new CodexTranslator(
      event => this.ctx.emit(event),
      () => this.last.total || null,
      this.agents,
    )
    this.nativeTurnId = null
    this.reportedError = null
    this.retryShown = false
    const active = this.active
    void this.run(text, userItemId, attachments, seed).catch(error => {
      if (this.active === active) this.finish('failed', (error as Error).message)
    })
  }
  private async run(text: string, userItemId: string, attachments: ImageAttachment[], seed?: ChatSeed): Promise<void> {
    const active = this.active
    await this.open()
    if (!this.active || this.active !== active || this.closed) return
    const selected = this.catalog?.models?.find(m => m.id === (this.settings.model ?? this.catalog?.currentModel))
    this.active.baseline = { ...this.totals }
    const sees = !!selected?.inputModalities.includes('image')
    if (attachments.length && !sees) throw new Error('This Codex model does not support images')
    if (this.settings.effort && selected && !selected.efforts.includes(this.settings.effort))
      throw new Error('This Codex model does not support the selected effort')
    this.active.model = this.settings.model ?? this.catalog?.currentModel ?? 'Codex'
    if (text === '/compact') {
      this.compacting = true
      this.ctx.emit({
        type: 'context',
        context: {
          model: this.active.model,
          used: this.last.total || null,
          window: null,
          input: null,
          cacheRead: null,
          cacheWrite: null,
          output: null,
          observedAt: Date.now(),
          source: 'request',
          stale: true,
          compacting: true,
          diagnostic: null,
          diagnosticStale: true,
        },
      })
      this.flushResumeNotice()
      await this.proc!.request('thread/compact/start', { threadId: this.threadId })
    } else {
      // 跨引擎接力：别的引擎期间的聊天先注入线程；注入不了就把交接材料加在消息前面
      const injected = !seed || (await this.injectSeed(seed, sees))
      // 线程记录没了、宿主已经把整段聊天写进新线程并说过一句：不再重复报「没能恢复」；注入失败照旧报
      if (injected && seed?.recreated) this.resumeNotice = null
      else this.flushResumeNotice()
      const body = injected ? text : `${seed.fallback}\n\n${text}`
      // 退回文字交接时，材料里说明过的更早消息的图片排在消息自己的图片前面；模型不能看图就不带
      const images = !injected && sees ? [...(seed.fallbackImages ?? []), ...attachments] : attachments
      // 模型不能看图：host 以为带上的图片被丢掉了，告诉用户
      if (seed && !sees) this.droppedImages(injected ? seedImageCount(seed) : (seed.fallbackImages?.length ?? 0))
      if (!this.active || this.active !== active || this.closed) return
      const collab = this.collaboration()
      const result = await this.proc!.request('turn/start', {
        threadId: this.threadId,
        clientUserMessageId: userItemId,
        input: this.input(body, images),
        ...codexPermission(this.settings.permissionMode, this.ctx.record().cwd, this.ctx.record().extraDirs),
        ...(this.settings.model ? { model: this.settings.model } : {}),
        ...(this.settings.effort ? { effort: this.settings.effort } : {}),
        summary: this.settings.thinkingSummaries ? 'concise' : 'none',
        ...collab.params,
        ...this.serviceTier(),
      })
      // turn/start 被拒绝时不记：Codex 那边没收到，下一轮要照样重带
      collab.commit()
      const turnId = string(object(result.turn).id)
      if (this.active === active) this.nativeTurnId = turnId || this.nativeTurnId
      else if (turnId) {
        // 开轮途中已经停止（本地已结束），原生那一轮可能仍在执行：补发中断，并丢弃它之后的事件
        this.markFinished(turnId)
        this.proc?.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {})
      }
      this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'consumed', mode: 'normal' })
    }
  }
  async update(patch: Partial<SessionSettings>): Promise<void> {
    if (this.active) return
    this.settings = { ...this.settings, ...patch }
    // 换模型、换线路后 Fast 能不能开跟着变；目录还没读到时等 open() 再报
    if (
      this.catalog &&
      (patch.model !== undefined ||
        patch.fast !== undefined ||
        patch.platform !== undefined ||
        patch.provider !== undefined)
    )
      this.emitFlags()
  }
  /** 当前模型开 Fast 用的服务档位 */
  private fastTier(): string | undefined {
    const id = this.settings.model ?? this.catalog?.currentModel ?? this.threadModel
    return this.catalog?.models?.find(m => m.id === id)?.fastTier
  }
  /**
   * Fast 不设门禁（docs/codex-engine.md §3.5，2026-10-17 用户要求）：开关什么时候都能开，拿不准支不支持时只提示原因
   * （fastBlocked 带原因、fastAvailable 仍是 true）；确认支持（自己的 openai 登录、模型有 Fast 档位）时 null。
   * - codex_gateway：走平台 / 像素星空接口（用户要求照样带档位：接口支持就生效，不支持的开了也没效果）
   * - codex_unverified：provider 不是 openai 或目录里这个模型没有 Fast 档位
   * 两种都是开着照样带 priority，接口支持就生效
   */
  private fastHint(): string | null {
    if (viaGateway(this.ctx.record())) return 'codex_gateway'
    if ((this.catalog?.currentProvider ?? 'openai') !== 'openai' || !this.fastTier()) return 'codex_unverified'
    return null
  }
  private emitFlags(): void {
    const hint = this.fastHint()
    this.ctx.emit({
      type: 'flags',
      flags: {
        ...EMPTY_FLAGS,
        compactAvailable: true,
        contextAvailable: false,
        steerAvailable: this.options.steeringValidated === true,
        fastAvailable: true,
        fastState: this.settings.fast ? 'on' : 'off',
        fastBlocked: hint,
        ultracodeAvailable: false,
      },
    })
  }
  /**
   * 计划模式用 Codex 原生的计划协作模式（模型有提问工具 request_user_input）；它会一直沿用，
   * 所以从计划切到别的权限后要带一次 default 切回来。允许提问时 Default 模式也有这个工具，
   * 第一轮就带一次 default，模型才拿到 Default 模式「少问、只问可选问题」的指令。
   * 协作模式里的模型和推理强度优先于 turn/start 外层的 model / effort，所以带过之后中途换了模型或强度也要重新带，
   * 不然线程还按旧的跑。developer_instructions 为 null 时用 Codex 内置的指令。
   * 带过什么要等 turn/start 成功后才记（commit），被拒绝的下一轮照样重带
   */
  private collaboration(): { params: Message; commit: () => void } {
    const none = { params: {}, commit: () => {} }
    const mode = this.settings.permissionMode === 'plan' ? 'plan' : 'default'
    const model = this.settings.model ?? this.catalog?.currentModel ?? this.threadModel
    // 会话跟随引擎默认时用 thread/start 报的实际强度（含 config.toml 里的），带 null 不知道会不会冲成模型默认
    const effort = this.settings.effort ?? this.threadEffort
    if (mode === 'default') {
      // 从计划切回来必须带；其余只在提问指令还没带过、或带过的模型 / 强度和现在的不一样时带
      const first = !this.modeSent && this.asks()
      const stale = this.modeSent === 'default' && (model !== this.modeModel || effort !== this.modeEffort)
      if (this.modeSent !== 'plan' && !first && !stale) return none
      // 只为提问指令或跟上模型带的 default 不是必须的：还不知道模型时先不带
      if (!model && this.modeSent !== 'plan') return none
      // 强度不知道、模型又有强度可选时也不带，宁可没有提问指令，也不带 null 去冲掉用户配置的强度；
      // 模型没有强度可选（目录里 efforts 为空）时 null 就是实际情况
      const supported = this.catalog?.models?.find(m => m.id === model)?.efforts.length
      if (effort === null && supported && this.modeSent !== 'plan') return none
    }
    if (!model) throw new Error('Codex plan mode needs a model')
    return {
      params: {
        collaborationMode: { mode, settings: { model, reasoning_effort: effort, developer_instructions: null } },
      },
      commit: () => {
        this.modeSent = mode
        this.modeModel = model
        this.modeEffort = effort
      },
    }
  }
  /**
   * Fast：开着时每轮带档位；关着时只在确认支持时写明 default（盖过 config.toml 里的档位），
   * 拿不准时不带，用 Codex 自己的配置
   */
  private serviceTier(): Message {
    if (this.settings.fast) return { serviceTier: this.fastTier() ?? 'priority' }
    return this.fastHint() ? {} : { serviceTier: 'default' }
  }
  async steer(text: string, id: string, attachments: ImageAttachment[] = []): Promise<void> {
    if (!this.active || !this.nativeTurnId || !this.options.steeringValidated)
      throw new Error('Codex active turn cannot accept guidance')
    this.guidance.set(id, { text, attachments, accepted: false, observed: false })
    try {
      const result = await this.proc!.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.nativeTurnId,
        clientUserMessageId: id,
        input: this.input(text, attachments),
      })
      if (string(result.turnId) !== this.nativeTurnId && this.active) throw new Error('Codex guidance turn mismatch')
      const pending = this.guidance.get(id)
      if (pending) {
        pending.accepted = true
        if (pending.observed) this.consume(id)
      }
    } catch (error) {
      this.guidance.delete(id)
      throw error
    }
  }
  private droppedImages(count: number): void {
    if (count <= 0) return
    this.ctx.emit({
      type: 'item_completed',
      item: {
        kind: 'notice',
        id: `cx-images-${Date.now()}-${++this.noticeSeq}`,
        level: 'warn',
        text: `The current model can't view images, so ${count} earlier image(s) were not actually passed along`,
        detail: null,
      },
    })
  }
  /** 把聊天作为原始 Responses 消息追加进线程的模型历史（thread/inject_items）；旧版 Codex 没有这个方法时返回 false */
  private async injectSeed(seed: ChatSeed, sees: boolean): Promise<boolean> {
    const message = (role: 'user' | 'assistant', text: string, images: readonly ImageAttachment[] = []): Message => ({
      type: 'message',
      role,
      content: [
        { type: role === 'user' ? 'input_text' : 'output_text', text },
        ...images.map(image => ({
          type: 'input_image',
          image_url: `data:${image.mediaType};base64,${image.dataBase64}`,
        })),
      ],
    })
    // 模型不能看图：只注入文字，用户话里写明图片没带上，不能让它以为看过
    const user = (turn: ChatTurn): Message =>
      turn.images?.length && !sees
        ? message('user', `${turn.user}（上面这些图片没有带上：当前模型不能看图）`)
        : message('user', turn.user, turn.images)
    try {
      await this.proc!.request('thread/inject_items', {
        threadId: this.threadId,
        items: seedTurns(seed).flatMap(turn => [user(turn), message('assistant', turn.assistant ?? NO_REPLY)]),
      })
      return true
    } catch (error) {
      if (!this.proc?.alive) throw error
      this.ctx.emit({
        type: 'item_completed',
        item: {
          kind: 'notice',
          id: `cx-seed-${Date.now()}-${++this.noticeSeq}`,
          level: 'warn',
          text: 'Could not add the previous conversation to the Codex thread; sent it as a text handoff instead',
          detail: null,
        },
      })
      return false
    }
  }
  private clearRetry(): void {
    if (!this.retryShown) return
    this.retryShown = false
    this.ctx.emit({ type: 'request_retry', retry: null })
  }
  private consume(id: string): void {
    if (this.guidance.delete(id)) this.ctx.emit({ type: 'input_ack', id, state: 'consumed', mode: 'guidance' })
  }
  private notification(method: string, params: Message): void {
    // 子智能体的审批也在这里结束，先于按线程过滤
    if (method === 'serverRequest/resolved') {
      const id = String(params.requestId)
      if (this.approvals.delete(id)) this.ctx.emit({ type: 'approval_resolved', requestId: id })
      return
    }
    const eventThread = string(params.threadId)
    // 子智能体线程的事件只记进追踪（工具次数、token）
    if (eventThread && this.agents.has(eventThread)) return this.translator.child(eventThread, method, params)
    if (eventThread && this.threadId && eventThread !== this.threadId) return
    // 子智能体可能在主轮结束后才跑完：没有进行中的轮次也要更新追踪
    if (!this.active && method === 'item/completed' && object(params.item).type === 'subAgentActivity')
      return this.translator.subagent(object(params.item), true)
    if (!this.active) return
    const eventTurn = string(params.turnId || object(params.turn).id)
    if (eventTurn && this.finishedTurns.has(eventTurn)) return
    if (eventTurn && this.nativeTurnId && eventTurn !== this.nativeTurnId) return
    if (method === 'turn/started') this.nativeTurnId = string(object(params.turn).id)
    else if (method === 'turn/completed') {
      const turn = object(params.turn)
      this.finish(
        turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed',
        string(object(turn.error).message) || null,
        turnErrorDetail(turn.error),
        turnNoticeError(turn.error, string(object(turn.error).message)),
      )
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item)
      if (item.type === 'userMessage') {
        const id = string(item.clientId || item.clientUserMessageId),
          pending = this.guidance.get(id)
        if (pending) {
          pending.observed = true
          if (pending.accepted) this.consume(id)
        }
      } else {
        this.active.activity = true
        this.clearRetry()
        this.translator.item(item, method === 'item/completed')
      }
    } else if (
      /^item\/(agentMessage|plan)\/delta$|^item\/reasoning\/summaryTextDelta$|^item\/commandExecution\/outputDelta$/.test(
        method,
      )
    ) {
      this.clearRetry()
      this.translator.delta(method, params)
    } else if (method === 'turn/plan/updated') this.translator.plan(params)
    else if (method === 'thread/tokenUsage/updated') {
      const usage = object(params.tokenUsage)
      this.totals = tokenCounts(usage.total)
      this.last = tokenCounts(usage.last)
      this.translator.usage(this.last.total)
      if (!this.active.activity) {
        this.active.baseline = { ...this.totals }
        this.active.usageSeen = true
      } else if (!this.active.usageSeen) {
        for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'total'] as const)
          this.active.baseline[key] = Math.max(0, this.totals[key] - this.last[key])
        this.active.usageSeen = true
      }
      const window = typeof usage.modelContextWindow === 'number' ? usage.modelContextWindow : null
      this.contextWindow = window
      if (window && !this.windowOverridden && this.active.model)
        this.options.knownWindows?.set(this.active.model, window)
      this.ctx.emit({
        type: 'usage',
        usage: {
          inputTokens: this.totals.input,
          outputTokens: this.totals.output,
          cacheReadTokens: this.totals.cacheRead,
          cacheWriteTokens: this.totals.cacheWrite,
          contextTokens: this.last.total,
          contextWindow: window,
          costUsd: null,
        },
      })
      this.ctx.emit({
        type: 'context',
        context: {
          model: this.active.model,
          used: this.last.total,
          window,
          input: this.last.input,
          cacheRead: this.last.cacheRead,
          cacheWrite: this.last.cacheWrite,
          output: this.last.output,
          observedAt: Date.now(),
          source: 'request',
          stale: false,
          compacting: false,
          diagnostic: null,
          diagnosticStale: true,
        },
      })
    } else if (method === 'error' && params.willRetry === true) {
      // Codex 自己在重连：显示成「正在重试 n/m」状态条，不再每次一条红色报错；最后还是失败时 turn/completed 会报
      this.retryShown = true
      this.ctx.emit({ type: 'request_retry', retry: codexRetryState(params.error, this.active.id) })
    } else if (method === 'model/rerouted') {
      const notice = codexRerouteNotice(params)
      if (!notice) return
      // 之后的用量、上下文窗口都记在实际用的模型上
      this.active.model = string(params.toModel)
      this.ctx.emit({
        type: 'item_completed',
        item: {
          kind: 'notice',
          id: `cx-reroute-${Date.now()}-${++this.noticeSeq}`,
          level: 'warn',
          text: notice.text,
          detail: notice.detail,
        },
      })
    } else if (method === 'error' || method === 'warning') {
      const text = string(object(params.error).message || params.message)
      if (method === 'error') this.reportedError = text
      const noticeError = method === 'error' ? turnNoticeError(params.error, text) : undefined
      // 用户 config.toml 引起、不影响使用的警告（每轮都发）：和这一轮无关，不进对话，报给宿主显示在设置里
      if (method === 'warning' && isQuietWarning(text)) {
        const own = withoutOwnFeatures(text, this.ownAskFlag)
        return own === null ? undefined : this.ctx.reportConfigWarning?.(own)
      }
      this.ctx.emit({
        type: 'item_completed',
        item: {
          kind: 'notice',
          id: `cx-${method}-${Date.now()}-${++this.noticeSeq}`,
          level: method === 'error' ? 'error' : 'warn',
          text,
          detail: turnErrorDetail(params.error, params.willRetry),
          ...(method === 'error' && noticeError ? { error: noticeError } : {}),
        },
      })
    }
  }
  private request(id: string | number, method: string, params: Message): void {
    // 每个会话一个 app-server 进程，里面别的线程只能是这一轮派出的子智能体：照常弹审批，标题带上是哪个
    const thread = string(params.threadId),
      subagent = !!thread && !!this.threadId && thread !== this.threadId
    if (!this.active || (!subagent && params.turnId && this.nativeTurnId && params.turnId !== this.nativeTurnId)) {
      this.proc?.respondError(id, 'No matching active turn')
      return
    }
    const agent = this.translator.agents.get(thread)?.label ?? thread.slice(0, 8)
    const title = (main: string, sub: string): string => (subagent ? sub.replace('{agent}', agent) : main)
    const key = String(id),
      // 子智能体的条目不在主对话里，卡片不挂到条目上
      itemId = params.itemId && !subagent ? 'cx-' + string(params.itemId) : null
    let request: ApprovalRequest
    if (method === 'item/commandExecution/requestApproval') {
      const { command, wrapper } = codexCommandParts(string(params.command))
      request = {
        requestId: key,
        itemId,
        kind: 'command',
        title: params.networkApprovalContext
          ? title('Codex network access', 'Codex subagent {agent} network access')
          : title('Codex command approval', 'Codex subagent {agent} command approval'),
        command,
        ...(wrapper ? { wrapper } : {}),
        description: string(params.reason),
        input: params.networkApprovalContext,
        alwaysScopes: ['session'],
      }
    } else if (method === 'item/fileChange/requestApproval')
      request = {
        requestId: key,
        itemId,
        kind: 'file_change',
        title: title('Codex file changes', 'Codex subagent {agent} file changes'),
        changes: codexChanges(params.changes ?? (itemId && object(this.translator.items.get(itemId)).changes)),
        description: string(params.reason),
        alwaysScopes: ['session'],
      }
    else if (method === 'item/tool/requestUserInput') {
      if (!this.options.askQuestions) {
        this.proc?.respond(id, { answers: {} })
        return
      }
      request = {
        requestId: key,
        itemId,
        kind: 'question',
        title: title('Codex question', 'Codex subagent {agent} question'),
        questions: array(params.questions).map(raw => {
          const question = object(raw)
          return {
            id: string(question.id),
            question: string(question.question),
            header: string(question.header),
            multiSelect: false,
            allowOther: question.isOther === true,
            secret: question.isSecret === true,
            options: array(question.options).map(o => ({
              label: string(object(o).label),
              description: string(object(o).description),
            })),
          }
        }),
        alwaysScopes: [],
      }
    } else if (method === 'item/permissions/requestApproval' || method === 'mcpServer/elicitation/request')
      request = {
        requestId: key,
        itemId,
        kind: 'tool',
        title: method.includes('permissions')
          ? title('Codex permission request', 'Codex subagent {agent} permission request')
          : title('MCP input request', 'MCP input request (subagent {agent})'),
        toolName: string(params.serverName) || 'Codex',
        input: params.permissions ?? params,
        description: string(params.reason || params.message),
        alwaysScopes: [],
        ...(params.requestedSchema ? { formSchema: params.requestedSchema } : {}),
      }
    else {
      this.proc?.respondError(id, 'Unsupported client request')
      return
    }
    if (Array.isArray(params.availableDecisions)) {
      request.canAllow = params.availableDecisions.includes('accept')
      request.canDeny = params.availableDecisions.includes('decline')
      if (!params.availableDecisions.includes('acceptForSession')) request.alwaysScopes = []
    }
    request.canAllowAll =
      request.canAllow !== false &&
      (request.kind === 'command' || request.kind === 'file_change' || method === 'item/permissions/requestApproval')
    this.approvals.set(key, { id, method, params, request })
    // 当前轮次的原生沙箱设置不能热切换，完全放行后在适配层处理其余审批。
    // 问答和 MCP 输入仍交给用户填写。
    if (this.settings.permissionMode === 'full' && request.canAllowAll) {
      this.answer(key, { type: 'allow' })
      return
    }
    this.ctx.emit({ type: 'approval_request', request })
  }
  answer(id: string, decision: ApprovalDecision): void {
    const approval = this.approvals.get(id)
    if (!approval || !this.proc?.alive) {
      // 找不到审批或进程已退出：同样结束这张卡片，不留下点不动的审批
      this.approvals.delete(id)
      this.ctx.emit({ type: 'approval_resolved', requestId: id })
      return
    }
    if (decision.type === 'allow_all') {
      if (!approval.request.canAllowAll) throw new Error('This request cannot enable full access')
      this.settings.permissionMode = 'full'
      this.ctx.setPermissionMode('full')
    }
    const allow = decision.type === 'allow' || decision.type === 'allow_always' || decision.type === 'allow_all'
    if (allow && approval.request.canAllow === false) return
    if (decision.type === 'allow_always' && !approval.request.alwaysScopes.includes(decision.scope)) return
    let response: unknown
    if (approval.method === 'item/tool/requestUserInput')
      response = {
        answers: Object.fromEntries(
          (approval.request.questions ?? []).map(q => [
            q.id!,
            { answers: decision.type === 'answer' ? [decision.answers[q.question] ?? ''] : [] },
          ]),
        ),
      }
    else if (approval.method === 'item/permissions/requestApproval')
      response = {
        permissions: allow ? approval.params.permissions : {},
        scope: decision.type === 'allow_always' || decision.type === 'allow_all' ? 'session' : 'turn',
      }
    else if (approval.method === 'mcpServer/elicitation/request')
      response = {
        action: decision.type === 'form' || allow ? 'accept' : 'decline',
        content: decision.type === 'form' ? decision.content : null,
      }
    else
      response = {
        decision:
          decision.type === 'allow_always'
            ? 'acceptForSession'
            : allow
              ? 'accept'
              : approval.request.canDeny === false
                ? 'cancel'
                : 'decline',
      }
    this.proc.respond(approval.id, response)
    this.approvals.delete(id)
    this.ctx.emit({ type: 'approval_resolved', requestId: id })
    if (decision.type === 'allow_all')
      for (const [pendingId, pending] of this.approvals)
        if (pending.request.canAllowAll) this.answer(pendingId, { type: 'allow' })
  }
  private finish(outcome: TurnOutcome, error: string | null, detail: string | null = null, info?: NoticeError): void {
    const active = this.active
    if (!active) return
    if (this.nativeTurnId) this.markFinished(this.nativeTurnId)
    this.active = null
    // 状态条由 turn_completed 一起清掉
    this.retryShown = false
    // 第一轮开始时标题才从第一句话定下来；用户改了标题也在这里跟上
    this.syncThreadName()
    if (this.compacting) {
      this.compacting = false
      this.ctx.emit({
        type: 'context',
        context: {
          model: active.model,
          used: this.last.total || null,
          window: this.contextWindow,
          input: null,
          cacheRead: null,
          cacheWrite: null,
          output: null,
          observedAt: Date.now(),
          source: 'request',
          stale: true,
          compacting: false,
          diagnostic: null,
          diagnosticStale: true,
        },
      })
    }
    if (outcome === 'failed' && error && error !== this.reportedError)
      this.ctx.emit({
        type: 'item_completed',
        item: {
          kind: 'notice',
          id: 'cx-error-' + active.id,
          level: 'error',
          text: error,
          detail,
          ...(info ? { error: info } : {}),
        },
      })
    this.translator.finish(outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'interrupted' : 'failed')
    for (const id of this.approvals.keys()) this.ctx.emit({ type: 'approval_resolved', requestId: id })
    this.approvals.clear()
    for (const id of this.guidance.keys())
      this.ctx.emit({ type: 'input_ack', id, state: 'uncertain', mode: 'guidance' })
    this.guidance.clear()
    this.earlyConsumed.clear()
    const difference = (key: 'input' | 'cacheRead' | 'cacheWrite' | 'output'): number =>
      Math.max(0, this.totals[key] - active.baseline[key])
    this.ctx.emit({
      type: 'turn_completed',
      turnId: active.id,
      outcome,
      error,
      usage: {
        durationMs: Date.now() - active.started,
        models: {
          [active.model || 'Codex']: {
            input: difference('input'),
            cacheRead: difference('cacheRead'),
            cacheWrite: difference('cacheWrite'),
            output: difference('output'),
            costUsd: null,
          },
        },
      },
    })
    this.nativeTurnId = null
    const waiters = this.turnWaiters
    this.turnWaiters = []
    for (const w of waiters) w()
  }
  private markFinished(turnId: string): void {
    this.finishedTurns.add(turnId)
    if (this.finishedTurns.size > 200) this.finishedTurns.delete(this.finishedTurns.values().next().value!)
  }
  /** 等待当前轮次结束（turn/completed 或本地 finish），超时返回 false */
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
    if (this.opening) await this.opening.catch(() => {})
    if (!this.active) return
    if (!this.nativeTurnId) {
      // turn/start 还没返回：本地先结束，返回后 run() 会补发 turn/interrupt
      this.finish('interrupted', null)
      return
    }
    try {
      await this.proc?.request('turn/interrupt', { threadId: this.threadId, turnId: this.nativeTurnId })
    } catch {
      // 中断请求本身失败：不再等待，直接结束进程，下次发消息时恢复
      this.proc?.kill()
      this.finish('interrupted', null)
      return
    }
    // 和 Claude 一致：等原生结束轮次（turn/completed）最多 5 秒，超时才强制结束进程
    if (this.active && !(await this.waitTurnEnd(5_000))) {
      this.proc?.kill()
      this.finish('interrupted', null)
    }
  }
  async close(opts: CloseOptions = {}): Promise<void> {
    this.closed = true
    this.own(null)
    await this.interrupt()
    await this.proc?.close(opts.quick ? QUICK_CLOSE_MS : undefined)
    this.ctx.extensions?.dispose?.()
  }
}

/** 告诉 Codex 项目还有哪些文件夹（docs/ui/multi-root-projects.md §3.3） */
export function extraDirsNote(dirs: readonly string[]): string {
  return [
    'This project also includes these folders besides the working directory. You can read and edit files in them:',
    ...dirs.map(dir => `- ${dir}`),
  ].join('\n')
}

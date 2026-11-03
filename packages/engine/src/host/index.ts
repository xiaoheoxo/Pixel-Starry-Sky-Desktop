// EngineHost：管理所有项目和会话（docs/engines.md §3、§8）
//
// - 会话的运行状态（idle / running / waiting）和会话记录由这里维护，适配器只发条目、审批、用量、一轮结束；
// - 每个会话的快照用 @pixelsky/protocol 的 reduce() 折叠，和界面用的是同一个函数；
// - 新会话发第一条消息时才启动引擎；一轮结束后空闲一段时间自动关掉进程，下次发消息时恢复；
// - 只保存完成的条目（item_completed），不保存流式增量。
//
// 这个类只做装配与转发，各职责在同目录的模块里（docs/restructure.md §8.3 P8）：
// guard 工作目录锁、settings 引擎设置、projects 项目、query 搜索与产物、cache 缓存提醒、
// usage 用量与结算、events 事件与运行状态、queue 消息队列、turn 一轮对话、sessions 会话。
import type {
  AccountAutoSwitch,
  AccountPatch,
  AccountQuota,
  EngineAccountQuota,
  EngineAccounts,
  ApprovalDecision,
  ContextDetailLevel,
  ContextDiagnostic,
  EngineCatalog,
  EngineConfig,
  EngineConfigPatch,
  EngineDefaults,
  EngineId,
  EngineInfo,
  EngineLogin,
  EngineQuotaProvider,
  EngineUpdateResult,
  Item,
  MessageInput,
  NativeActionResult,
  NativeImportResult,
  NativeSessionDetail,
  NativeSessionSummary,
  OpenedSession,
  ProjectRecord,
  QueueMove,
  QuotaRefreshOptions,
  AddProjectsResult,
  ForkResult,
  InterruptOptions,
  RewindOptions,
  RewindPreview,
  RewindResult,
  SideTurn,
  SendReceipt,
  SessionRecord,
  SessionSettings,
  SessionSnapshot,
  SessionSummary,
  GoalAction,
  McpOp,
  McpOpResult,
  SessionGoal,
  TaskOutput,
  UsagePage,
  UsageSummary,
} from '@pixelsky/protocol'
import { backgroundAgents } from '@pixelsky/protocol'
import { ClaudeAdapter } from '../claude'
import type { CompactionRequestReport } from '../compaction'
import { CodexAdapter } from '../codex'
import { PixelAdapter } from '../pixel'
import { Store } from '../store'
import { UsageStore, type UsageQuery } from '../usage'
import { HostAccounts } from './accounts'
import { HostBranch } from './branch'
import { HostCheckpoints } from './checkpoints'
import { OneShotError } from '../oneshot'
import { HostCache } from './cache'
import { HostCompaction } from './compaction'
import type { EngineHostOptions, HostContext, HostModules, Runtime } from './context'
import { HostEvents } from './events'
import { HostGuard } from './guard'
import { HostHandoff, lastItemId } from './handoff'
import { HostLogin } from './login'
import { HostNative } from './native'
import { HostProjects } from './projects'
import { HostQuery } from './query'
import { HostQueue } from './queue'
import { HostQuota } from './quota'
import { HostSessions } from './sessions'
import { HostSettings, type SyncableEngineSettings } from './settings'
import { HostTurn } from './turn'
import { HostUsage } from './usage'

export type { EngineHostOptions, PlatformRouteResult } from './context'
export type { SyncableEngineSettings } from './settings'

/** 不能切到终端的原因代码（tuiBlock）：界面按代码显示文字 */
/**
 * fresh：Codex 对话还没有线程（不能预先指定线程 id），或有待落实的回退 / 分叉（Codex 的界面进程不能 warm，切之前落实不了）：
 * 先在界面里发一条消息
 */
export type TuiBlock = 'engine' | 'fresh' | 'busy' | 'liveTerminal' | 'liveOther'

/** 切换时直接报错用的文字（和界面 session.tui.disabled* 的中文一致，界面能翻译） */
const TUI_BLOCK_TEXT: Record<TuiBlock, string> = {
  engine: '当前引擎不支持终端模式',
  fresh: 'Codex 对话先在界面里发一条消息，再切到终端',
  busy: '请先停止当前任务再切换',
  liveTerminal: '外部终端正开着这个会话',
  liveOther: '其他程序正开着这个会话',
}

export class EngineHost {
  private readonly ctx: HostContext
  private readonly m: HostModules
  /** 测试会直接读它（运行时数量），与 ctx.runtimes 是同一个 Map */
  private readonly runtimes: Map<string, Runtime>

  constructor(opts: EngineHostOptions) {
    const store = new Store(opts.dataDir)
    const usage = new UsageStore(opts.dataDir)
    usage.prune()
    const ctx: HostContext = {
      opts,
      store,
      usage,
      idleMs: opts.idleMs ?? 30 * 60_000,
      adapters: {},
      records: new Map(),
      runtimes: new Map(),
      changingSessions: new Set(),
      lockedWorkspaces: new Set(),
      closing: false,
      m: undefined as unknown as HostModules,
    }
    // 读盘顺序与拆分前一致：设置 → 项目 → 会话记录
    const settings = new HostSettings(ctx)
    ctx.adapters = opts.adapters ?? {
      claude: new ClaudeAdapter({
        overridePath: () => settings.file.paths.claude ?? null,
        extraEnv: () => settings.file.env.claude ?? {},
        systemProxy: () => opts.systemProxy?.('claude') ?? null,
        nodeRuntime: opts.nodeRuntime,
        launchOptions: () => settings.launchOptions('claude'),
        sessionEnv: opts.sessionEnv,
        // 当前订阅账号的目录（docs/ui/engine-accounts-claude.md）；模块装好之前（构造时不会启动进程）用原来的
        account: () => ctx.m?.accounts.currentDir('claude') ?? null,
        dataDir: opts.dataDir,
      }),
      codex: new CodexAdapter({
        overridePath: () => settings.file.paths.codex ?? null,
        extraEnv: () => settings.file.env.codex ?? {},
        systemProxy: () => opts.systemProxy?.('codex') ?? null,
        nodeRuntime: opts.nodeRuntime,
        sessionEnv: opts.sessionEnv,
        // 当前订阅账号的目录（docs/ui/engine-accounts.md）；模块装好之前（构造时不会启动进程）用原来的
        account: () => ctx.m?.accounts.currentDir('codex') ?? null,
        launchOptions: () => {
          const o = settings.launchOptions('codex')
          return {
            askQuestions: o.askQuestions,
            args: o.args,
            autoCompactPct: o.autoCompactPct,
            contextWindows: o.contextWindows,
            steeringValidated: true,
          }
        },
      }),
      pixel: new PixelAdapter({
        overridePath: () => settings.file.paths.pixel ?? null,
        extraEnv: () => settings.file.env.pixel ?? {},
        systemProxy: () => opts.systemProxy?.('pixel') ?? null,
        bundledCli: opts.pixelCli,
        sessionEnv: opts.sessionEnv,
        launchOptions: () => {
          const o = settings.launchOptions('pixel')
          return { args: o.args, contextWindows: o.contextWindows, autoCompactPct: o.autoCompactPct }
        },
      }),
    }
    const projects = new HostProjects(ctx)
    ctx.m = {
      guard: new HostGuard(ctx),
      settings,
      projects,
      query: new HostQuery(ctx),
      cache: new HostCache(ctx),
      compaction: new HostCompaction(ctx),
      usage: new HostUsage(ctx),
      events: new HostEvents(ctx),
      queue: new HostQueue(ctx),
      turn: new HostTurn(ctx),
      sessions: new HostSessions(ctx),
      branch: new HostBranch(ctx),
      checkpoints: new HostCheckpoints(ctx),
      handoff: new HostHandoff(ctx),
      login: new HostLogin(ctx),
      native: new HostNative(ctx),
      quota: new HostQuota(ctx),
      accounts: new HostAccounts(ctx),
    }
    for (const r of store.loadRecords()) ctx.records.set(r.id, r)
    this.ctx = ctx
    this.m = ctx.m
    this.runtimes = ctx.runtimes
  }

  /** Capture the execution before the gateway awaits I/O; late requests cannot move to a later turn. */
  platformRequestContext(
    record: SessionRecord,
  ): ((requestId: string, model: string, chargeId?: string) => void) | undefined {
    return this.m.usage.platformRequestContext(record)
  }

  /** 本机网关转发压缩请求时报来的进度（压缩上下文的实时进度） */
  compactionRequest(id: string, report: CompactionRequestReport): void {
    this.m.compaction.report(id, report)
  }

  executionRecord(id: string): SessionRecord | null {
    return this.m.sessions.record(id)
  }

  async withWorkspaceStopped<T>(path: string, action: () => Promise<T>): Promise<T> {
    return this.m.guard.withWorkspaceStopped(path, action)
  }

  // -------------------------------------------------------------------------
  // 引擎
  // -------------------------------------------------------------------------

  async engines(force = false, userDetect = false): Promise<EngineInfo[]> {
    return this.m.settings.engines(force, userDetect)
  }

  /** 新会话默认值：默认引擎 + 这个引擎的默认值 */
  defaults(): EngineDefaults {
    return this.m.settings.defaults()
  }

  /** 设置 › 本机引擎里的引擎级选项，启动引擎进程时读（自带的适配器自动接上；测试里自己建的适配器也可以接它） */
  launchOptions(engine: EngineId): ReturnType<HostSettings['launchOptions']> {
    return this.m.settings.launchOptions(engine)
  }

  /** 各引擎的本机配置：替换的命令、追加的参数和环境变量、压缩模型等（设置 › 本机引擎） */
  engineConfig(): EngineConfig {
    return this.m.settings.engineConfig()
  }

  /** 改一个引擎的本机配置；命令、参数或环境变量变了就重新检测（检测结果会广播） */
  async setEngineConfig(engine: EngineId, patch: EngineConfigPatch): Promise<EngineConfig> {
    return this.m.settings.setEngineConfig(engine, patch)
  }

  /** 设为默认引擎（新会话用它）；默认引擎不能隐藏，所以顺手取消隐藏 */
  setDefaultEngine(engine: EngineId): EngineDefaults {
    return this.m.settings.setDefaultEngine(engine)
  }

  /** 引擎实际报上来的可选项（输出风格）；不发消息、不花钱 */
  async engineCatalog(engine: EngineId, force = false): Promise<EngineCatalog> {
    return this.m.settings.engineCatalog(engine, force)
  }

  /** 检查更新：交给引擎自己的更新命令，结束后重新检测并广播 */
  async updateEngine(engine: EngineId): Promise<EngineUpdateResult> {
    return this.m.settings.updateEngine(engine)
  }

  /** 授权登录（docs/ui/model-channels.md §3）：起登录命令后马上返回当前进度，之后看 engine_login 事件 */
  loginEngine(engine: EngineId, method: 'browser' | 'device' = 'browser'): EngineLogin {
    return this.m.login.loginEngine(engine, method)
  }

  /** 把用户粘贴的授权码写给正在等它的登录命令 */
  loginInput(engine: EngineId, text: string): void {
    this.m.login.loginInput(engine, text)
  }

  cancelLogin(engine: EngineId): void {
    this.m.login.cancelLogin(engine)
  }

  /** 取消授权，随后重新检测 */
  async logoutEngine(engine: EngineId): Promise<EngineUpdateResult> {
    return this.m.login.logoutEngine(engine)
  }

  // -------------------------------------------------------------------------
  // 订阅账号多开（docs/ui/engine-accounts.md）
  // -------------------------------------------------------------------------

  accounts(engine: EngineId): Promise<EngineAccounts> {
    return this.m.accounts.list(engine)
  }

  accountsQuota(engine: EngineId, force = false): Promise<EngineAccountQuota[]> {
    return this.m.accounts.quota(engine, force)
  }

  /** 添加账号：登录进度看 engine_login（target 'add'） */
  addAccount(engine: EngineId, method: 'browser' | 'device' = 'browser'): EngineLogin {
    return this.m.accounts.add(engine, method)
  }

  reloginAccount(engine: EngineId, id: string, method: 'browser' | 'device' = 'browser'): EngineLogin {
    return this.m.accounts.relogin(engine, id, method)
  }

  switchAccount(engine: EngineId, id: string): Promise<EngineAccounts> {
    return this.m.accounts.switchTo(engine, id)
  }

  removeAccount(engine: EngineId, id: string): Promise<EngineAccounts> {
    return this.m.accounts.remove(engine, id)
  }

  showDefaultAccount(engine: EngineId): Promise<EngineAccounts> {
    return this.m.accounts.showDefault(engine)
  }

  updateAccount(engine: EngineId, id: string, patch: AccountPatch): EngineAccounts {
    return this.m.accounts.update(engine, id, patch)
  }

  setAccountAuto(engine: EngineId, patch: Partial<AccountAutoSwitch>): EngineAccounts {
    return this.m.accounts.setAuto(engine, patch)
  }

  /** 一键安装：跑引擎的官方安装方式，过程推 engine_job，结束后重新检测并广播 */
  async installEngine(engine: EngineId): Promise<EngineUpdateResult> {
    return this.m.settings.installEngine(engine)
  }

  /** 设置云同步：引擎设置里可以同步的几项（不含命令路径、参数、环境变量） */
  syncableSettings(): SyncableEngineSettings {
    return this.m.settings.syncable()
  }

  /** 设置云同步：把云端的一项写回本机（走设置页同样的校验） */
  applySyncableSetting(key: string, value: unknown): Promise<void> {
    return this.m.settings.applySyncable(key, value)
  }

  /** 查各引擎在 npm 上的最新版本，有变化时广播引擎列表（桌面端定时调用） */
  checkEngineUpdates(): Promise<void> {
    return this.m.settings.checkEngineUpdates()
  }

  retrySettings(): { maxRetries: number | null } {
    return this.m.settings.retrySettings()
  }

  setRetrySettings(value: unknown): { maxRetries: number | null } {
    return this.m.settings.setRetrySettings(value)
  }

  /** 记住会话里改过的选择：写到 patch.engine（缺省为默认引擎）名下的默认值，不改默认引擎 */
  setDefaults(patch: Partial<EngineDefaults>): EngineDefaults {
    return this.m.settings.setDefaults(patch)
  }

  // -------------------------------------------------------------------------
  // 项目
  // -------------------------------------------------------------------------

  projects(): ProjectRecord[] {
    return this.m.projects.projects()
  }

  /** 添加项目；同一个目录只添加一次 */
  addProject(path: string): ProjectRecord {
    return this.m.projects.addProject(path)
  }

  /** 一次添加多个项目（docs/ui/multi-root-projects.md §2） */
  addProjects(paths: readonly string[]): AddProjectsResult {
    return this.m.projects.addProjects(paths)
  }

  /** 改侧栏显示的项目名；只改名称，不动磁盘上的文件夹 */
  renameProject(id: string, name: unknown): ProjectRecord {
    return this.m.projects.renameProject(id, name)
  }

  /** 改项目的附加文件夹（只对之后新建的对话生效） */
  setProjectFolders(id: string, folders: unknown): ProjectRecord {
    return this.m.projects.setProjectFolders(id, folders)
  }

  /** 从列表里移除项目（不删除磁盘上的任何文件，会话记录保留） */
  removeProject(id: string): void {
    this.m.projects.removeProject(id)
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  sessions(): SessionSummary[] {
    return this.m.sessions.sessions()
  }

  /** 全局搜索只读取已存在的运行时或异步历史，不启动引擎。 */
  search(value: unknown, signal?: AbortSignal) {
    return this.m.query.search(value, signal)
  }

  /** 产物面板：工作区内最近几天的改动和交付（docs/ui/artifacts-panel.md），不启动引擎 */
  artifacts(value: unknown, workspace: string, signal?: AbortSignal) {
    return this.m.query.artifacts(value, workspace, signal)
  }

  /** 一条改文件记录（产物面板看差异用） */
  async artifactItem(sessionId: string, itemId: string): Promise<Extract<Item, { kind: 'file_change' }> | null> {
    return this.m.query.artifactItem(sessionId, itemId)
  }

  /** 这个会话的改动记录里出现过这个路径吗：读取 / 打开工作区外文件前的安全检查 */
  async recordedPath(sessionId: string, absolute: string): Promise<boolean> {
    return this.m.query.recordedPath(sessionId, absolute)
  }

  createSession(
    opts: { projectId: string } & Partial<SessionSettings> & {
        engine?: EngineId
        rememberChoices?: false
        scheduleTaskId?: string
      },
    workspacePath?: string,
  ): SessionRecord {
    return this.m.sessions.createSession(opts, workspacePath)
  }

  /** 引擎自己留下的会话（终端里的 Claude Code……）：第一步，只读头部（docs/ui/claude-resume.md） */
  nativeSessions(
    projectId: string,
    engine: EngineId,
    opts?: { subfolders?: boolean },
  ): Promise<NativeSessionSummary[]> {
    return this.m.native.nativeSessions(projectId, engine, opts)
  }

  /** 第二步：读这几个会话的尾部，补最后一句、标题、模型 */
  nativeSessionDetails(projectId: string, engine: EngineId, ids: unknown): Promise<NativeSessionDetail[]> {
    return this.m.native.nativeSessionDetails(projectId, engine, ids)
  }

  /** 导入成一个新对话；mode 'copy' 是复制一份接着聊（原会话不动） */
  importNativeSession(
    projectId: string,
    engine: EngineId,
    nativeId: string,
    opts?: { mode?: 'inplace' | 'copy'; settings?: Partial<SessionSettings>; token?: string },
  ): Promise<NativeImportResult> {
    return this.m.native.importNative(projectId, engine, nativeId, opts)
  }

  cancelNativeImport(token: string): void {
    this.m.native.cancelNativeImport(token)
  }

  /** 加载更早的 / 补上终端里新聊的 / 检查有没有新聊的 / 改成复制一份接着聊 */
  nativeSessionAction(id: string, kind: unknown): Promise<NativeActionResult> {
    return this.m.native.nativeAction(id, kind)
  }

  /** 当前快照 */
  open(id: string): SessionSnapshot {
    return this.m.sessions.open(id)
  }

  /** 一条完整条目（快照里截掉的图片数据、长输出从磁盘补回）；没载入的会话不创建运行时。没有这一条为 null */
  item(id: string, itemId: string): Item | null {
    return this.m.sessions.item(id, itemId)
  }

  /** 手上已经有这一条（快照里的）：直接从磁盘补回截掉的部分，不按 id 在整个快照里找；补不回来为 null */
  body(id: string, item: Item): Item | null {
    return this.ctx.store.body(id, item)
  }

  /** 已载入的会话的快照；没载入为 null（不创建运行时） */
  loaded(id: string): SessionSnapshot | null {
    return this.runtimes.get(id)?.snapshot ?? null
  }

  /** 会话的全部条目（只读，不复制；已有运行时用内存里的，否则异步流式读存储，都不创建运行时）；给对话历史工具用 */
  historyItems(id: string): Promise<readonly Item[]> {
    return this.m.query.historyItems(id)
  }

  /** 会话里最后一个 todo（没有时 null）；不创建运行时，给任务面板用 */
  lastTodo(id: string): Promise<Extract<Item, { kind: 'todo' }> | null> {
    return this.m.query.lastTodo(id)
  }

  /** 打开前先分块读条目建运行时（不卡主进程），之后的 openSession 不再同步读；已载入的直接返回 */
  prepare(id: string): Promise<void> {
    return this.m.sessions.prepare(id)
  }

  /** 打开会话（给界面用）：快照 + 序号，之后界面只应用序号更大的事件 */
  openSession(id: string): OpenedSession {
    return this.m.sessions.openSession(id)
  }

  async send(id: string, input: string | MessageInput): Promise<SendReceipt> {
    return this.m.queue.send(id, input)
  }

  async inspectContext(id: string, detail?: ContextDetailLevel): Promise<ContextDiagnostic> {
    return this.m.turn.inspectContext(id, detail)
  }

  async compactContext(id: string): Promise<SendReceipt> {
    return this.m.turn.compactContext(id)
  }

  /** 停止：正在等的自动重连也一起停下，那条直接算发送失败 */
  async interrupt(id: string, opts?: InterruptOptions): Promise<void> {
    this.m.queue.stopReconnect(id)
    return this.m.turn.interrupt(id, opts)
  }

  /** 核对轮次后同步进入现有停止和队列锁；旧提醒不能暂停或中断下一轮。 */
  async interruptTurn(id: string, expectedTurnId: string): Promise<boolean> {
    return this.m.turn.interruptTurn(id, expectedTurnId)
  }

  cancelQueued(id: string, queueId: string): string {
    return this.m.queue.cancelQueued(id, queueId)
  }

  dismissQueued(id: string, queueId: string): void {
    this.m.queue.dismissQueued(id, queueId)
  }

  moveQueued(id: string, queueId: string, to: QueueMove): void {
    this.m.queue.moveQueued(id, queueId, to)
  }

  pauseReconnect(id: string): void {
    this.m.queue.pauseReconnect(id)
  }

  resumeQueue(id: string): void {
    this.m.queue.resumeQueue(id)
  }

  async runQueuedNow(id: string, queueId: string): Promise<void> {
    return this.m.queue.runQueuedNow(id, queueId)
  }

  async steerQueued(id: string, queueId: string, expectedTurnId: string): Promise<void> {
    return this.m.queue.steerQueued(id, queueId, expectedTurnId)
  }

  answer(id: string, requestId: string, decision: ApprovalDecision): void {
    this.m.turn.answer(id, requestId, decision)
  }

  /** 会话记录（不创建运行时）；不存在时为 null。平台代理按请求读当前分组用 */
  record(id: string): SessionRecord | null {
    return this.m.sessions.record(id)
  }

  /**
   * 改设置 / 重命名。引擎只能在还没发过消息时改。
   * 额度来源（docs/ui/source-switch.md §3.4）：同一账号内换分组直接生效（平台代理按请求读分组）；
   * 平台 ↔ 自有或换账号要换一份启动环境，所以关掉当前引擎进程，下一条消息重新启动并 --resume 接上原对话。
   */
  async update(
    id: string,
    patch: Partial<SessionSettings> & { title?: string; engine?: EngineId },
  ): Promise<SessionRecord> {
    return this.m.sessions.update(id, patch)
  }

  /** 停止一个后台任务 */
  async stopTask(id: string, taskId: string): Promise<void> {
    return this.m.turn.stopTask(id, taskId)
  }

  async mcp(id: string, op: McpOp): Promise<McpOpResult> {
    return this.m.turn.mcp(id, op)
  }

  /** 目标模式（Codex /goal）：引擎进程在跑时直接操作，返回之后的目标 */
  async goal(id: string, action: GoalAction): Promise<SessionGoal | null> {
    return this.m.turn.goal(id, action)
  }

  /** 读一个后台任务的输出 */
  async taskOutput(id: string, taskId: string): Promise<TaskOutput> {
    return this.m.turn.taskOutput(id, taskId)
  }

  /** 智能体追踪：读一个子智能体的对话（只读） */
  subagentTranscript(id: string, agentId: string): Item[] | Promise<Item[]> {
    return this.m.turn.subagentTranscript(id, agentId)
  }

  renameSession(id: string, title: unknown): SessionRecord {
    return this.m.sessions.renameSession(id, title)
  }

  /** 在会话里加一条提示条目（手机改了设置时留一条记录，docs/mobile-remote.md §21.7） */
  addNotice(id: string, level: 'info' | 'warn' | 'error', text: string): void {
    this.m.sessions.addNotice(id, level, text)
  }

  setSessionBottom(id: string, bottomed: boolean): SessionRecord {
    return this.m.sessions.setSessionBottom(id, bottomed)
  }

  setSessionPinned(id: string, pinned: boolean): SessionRecord {
    return this.m.sessions.setSessionPinned(id, pinned)
  }

  /** 回退前检查代码：要还原哪些文件（docs/ui/rewind-fork-sidechat.md §1） */
  rewindPreview(id: string, userItemId: string): Promise<RewindPreview> {
    return this.m.branch.rewindPreview(id, userItemId)
  }

  /**
   * 回退到某条用户消息之前：对话（移除它及之后的全部对话，引擎下次启动时从它之前接上）和 / 或代码。
   * 只在空闲时可用；回退对话时返回被移除消息的原文和图片，界面放回输入框。
   */
  rewind(id: string, userItemId: string, options?: RewindOptions): Promise<RewindResult> {
    return this.m.branch.rewind(id, userItemId, options)
  }

  /** 撤销最近一次回退（发新消息或重启前） */
  undoRewind(id: string): Promise<void> {
    return this.m.branch.undoRewind(id)
  }

  /** 电脑从待机唤醒：转告各适配器（Claude 待机够久时下一次后台读取前先刷新登录，docs/ui/claude-login-recovery.md） */
  resumed(sleptMs: number): void {
    for (const adapter of Object.values(this.ctx.adapters)) adapter?.resumed?.(sleptMs)
  }

  /** 不带会话、用引擎自己的登录单独问一次（AI 写提交信息的 Claude / ChatGPT 授权通道，docs/ui/ai-commit-channels.md） */
  oneShot(
    engine: EngineId,
    req: import('../oneshot').OneShotRequest,
    signal: AbortSignal,
  ): Promise<import('../oneshot').OneShotReply> {
    const adapter = this.ctx.adapters[engine]
    if (!adapter?.oneShot) return Promise.reject(new OneShotError('failed', '这个引擎不能单独问'))
    return adapter.oneShot(req, signal)
  }

  /** 会话的对话检查点：每轮的快照情况、改动卡片撤回的文件（docs/ui/undo-changes.md） */
  checkpoints(id: string): import('@pixelsky/protocol').CheckpointList {
    return this.m.checkpoints.list(id)
  }

  /** 开始打字时：还没拍过快照就在后台先拍第一次，发消息时不用等 */
  prepareCheckpoints(id: string): void {
    this.m.checkpoints.prepare(id)
  }

  /** 改动卡片撤回文件：改回这一轮开始前的内容；之后又被改过、没确认时只返回冲突 */
  revertFiles(
    id: string,
    userItemId: string,
    paths: string[],
    force: boolean,
  ): Promise<import('@pixelsky/protocol').RevertFilesResult> {
    return this.m.checkpoints.revertFiles(id, userItemId, paths, force)
  }

  /** 恢复改动卡片撤回的文件 */
  restoreFiles(id: string, revertId: string, paths?: string[]): Promise<void> {
    return this.m.checkpoints.restoreFiles(id, revertId, paths)
  }

  /**
   * 从某条用户消息之前分叉出新会话（§2）；userItemId 为 null 时带上整个会话。
   * opts 带工作目录和 branch 时是「开分支」（docs/ui/branch-merge.md §3）
   */
  forkSession(
    id: string,
    userItemId: string | null,
    title?: string,
    opts?: import('@pixelsky/protocol').ForkOptions,
  ): Promise<ForkResult> {
    return this.m.branch.fork(id, userItemId, title, opts)
  }

  /** 分支会话自己的条目（带过来的部分之后，docs/ui/branch-merge.md §5.2） */
  branchItems(id: string): Item[] {
    return this.m.branch.branchItems(id)
  }

  /** 合并回上级之后：上级加合并卡片、等着带摘要，分支会话记下合并（docs/ui/branch-merge.md §5.2） */
  recordMerge(
    id: string,
    merge: import('@pixelsky/protocol').NoticeBranchMerge,
    branchPatch: Partial<import('@pixelsky/protocol').SessionBranch>,
  ): void {
    this.m.branch.recordMerge(id, merge, branchPatch)
  }

  /** 这次不带合并摘要 */
  dropPendingMerge(id: string): void {
    this.m.branch.dropPendingMerge(id)
  }

  /** 从终端模式补轮次（docs/ui/tui-toggle.md §5.4） */
  syncFromTui(id: string): Promise<{ added: number; mismatched: boolean }> {
    return this.m.native.syncFromTui(id)
  }

  /**
   * 现在能不能切到终端（docs/ui/tui-toggle.md §3.1）：不能时返回原因代码，界面按代码显示文字；能切返回 null。
   * 已在终端模式时不算（自己的 TUI 不算占用）
   */
  tuiBlock(id: string): TuiBlock | null {
    const ctx = this.ctx
    const rt = this.m.sessions.runtime(id)
    const record = rt.snapshot.record
    if (record.engine !== 'claude' && record.engine !== 'codex') return 'engine'
    if (record.tui) return null
    if (record.engine === 'codex' && (!record.engineSessionId || record.pendingRewind || record.pendingFork))
      return 'fresh'
    if (
      ctx.closing ||
      ctx.changingSessions.has(id) ||
      rt.snapshot.state !== 'idle' ||
      rt.pumping ||
      rt.stopping ||
      rt.activeId ||
      rt.inspectingContext ||
      rt.snapshot.queue.length ||
      rt.snapshot.pending?.length ||
      // 后台子智能体还在跑：切过去要关界面进程，会把它们一起停掉
      backgroundAgents(rt.snapshot.subagents, rt.snapshot.tasks).length
    )
      return 'busy'
    return this.tuiLiveBlock(record)
  }

  /** 外部终端 / 其他程序占着这个引擎会话 */
  private tuiLiveBlock(record: SessionRecord): TuiBlock | null {
    const sid = record.engineSessionId
    const live = sid
      ? (this.ctx.adapters[record.engine]?.nativeLive?.([{ id: sid, mtimeMs: Date.now() }]).get(sid) ?? null)
      : null
    if (live === 'terminal') return 'liveTerminal'
    // Codex 的 maybe 是非 Windows 上锁文件还在：进程退出后也不删，自己的界面进程、上次的终端都会留下，不能当占用
    if (live === 'other' || (live === 'maybe' && record.engine !== 'codex')) return 'liveOther'
    return null
  }

  async prepareTui(id: string): Promise<import('../adapter').TuiLaunch> {
    const ctx = this.ctx
    const m = this.m
    const rt = m.sessions.runtime(id)
    let record = rt.snapshot.record
    if (record.tui?.terminalId) throw new Error('已经在终端模式')
    const blocked = this.tuiBlock(id)
    if (blocked) throw new Error(TUI_BLOCK_TEXT[blocked])
    const adapter = ctx.adapters[record.engine]
    if (!adapter?.tuiLaunch) throw new Error('当前引擎还不支持终端模式')

    ctx.changingSessions.add(id)
    let extensions: import('@pixelsky/protocol').ExtensionLaunch | undefined
    try {
      // §5.3：有待落实的回退 / 分叉 / 压缩前副本 / 接力 seed 时，先起一次界面进程再关
      const seed = await m.handoff.pendingSeed(id)
      const needsFlush = !!(record.pendingRewind || record.pendingFork || seed)
      if (needsFlush) {
        extensions = await ctx.opts.extensions?.(record)
        // 已有空闲进程时 warm 不会再 spawn，pending / seed 落实不了：先关掉再起干净的一次
        if (rt.session) {
          const prev = rt.session
          rt.session = null
          if (rt.idleTimer) {
            clearTimeout(rt.idleTimer)
            rt.idleTimer = null
          }
          await prev.close()
        }
        rt.session = m.turn.createEngineSession(id, adapter, {
          extensions,
          maxRetries: m.settings.file.maxRetries,
          engineId: record.engine,
        })
        if (!rt.session.warm) {
          throw new Error(
            seed
              ? '还有未写入的接力聊天，当前引擎无法在切终端前自动落实，请先在界面里发一条消息'
              : '还有未落实的回退或分叉，当前引擎无法在切终端前自动落实，请先在界面里发一条消息',
          )
        }
        if (seed) {
          if (!rt.session.queueSeed) {
            throw new Error('还有未写入的接力聊天，当前引擎无法在切终端前自动落实，请先在界面里发一条消息')
          }
          rt.session.queueSeed(seed)
        }
        try {
          await rt.session.warm()
        } catch (err) {
          throw new Error(
            (seed ? '落实接力写入失败，无法切到终端：' : '落实回退或分叉失败，无法切到终端：') +
              (err instanceof Error ? err.message : String(err)),
          )
        }
        if (seed && rt.session.hasQueuedSeed?.()) {
          throw new Error('落实接力写入失败，无法切到终端：seed 未能写入引擎会话记录')
        }
        record = m.sessions.runtime(id).snapshot.record
        if (record.pendingRewind || record.pendingFork) {
          throw new Error('落实回退或分叉后标记仍在，请先在界面里发一条消息再切终端')
        }
        // seed 已写入原生记录：推进游标，避免切回界面后再发消息时重复注入
        if (seed && record.engineSessions) {
          const engine = record.engine
          const entry = record.engineSessions[engine]
          const items = m.sessions.runtime(id).snapshot.items
          m.events.patchRecord(id, {
            engineSessions: {
              ...record.engineSessions,
              [engine]: {
                ...entry,
                id: entry?.id ?? record.engineSessionId,
                seen: lastItemId(items),
              },
            },
          })
          record = m.sessions.runtime(id).snapshot.record
        }
      }

      const old = rt.session
      rt.session = null
      if (rt.idleTimer) {
        clearTimeout(rt.idleTimer)
        rt.idleTimer = null
      }
      await old?.close()

      // 关进程后再查一次外部占用（自己的已关，不算；不能用 tuiBlock：changingSessions 里有自己）
      const live = this.tuiLiveBlock(m.sessions.runtime(id).snapshot.record)
      if (live) throw new Error(TUI_BLOCK_TEXT[live])

      if (!extensions) extensions = await ctx.opts.extensions?.(m.sessions.runtime(id).snapshot.record)
      let current = m.sessions.runtime(id).snapshot.record
      let launch = await adapter.tuiLaunch(current, extensions)
      if (current.engineSessionId !== launch.engineSessionId) {
        m.events.patchRecord(id, { engineSessionId: launch.engineSessionId })
        current = m.sessions.runtime(id).snapshot.record
        launch = await adapter.tuiLaunch(current, extensions)
      }
      rt.tuiLive = true
      m.events.patchRecord(id, { tui: { terminalId: '', since: Date.now() } })
      // extensions.dispose 不在这里调：mcp 临时文件还要给 TUI 进程用；进程退出后由下次 prepare 覆盖或 OS 清临时目录
      return launch
    } catch (err) {
      rt.tuiLive = false
      m.events.patchRecord(id, { tui: null })
      extensions?.dispose?.()
      throw err
    } finally {
      ctx.changingSessions.delete(id)
    }
  }

  /** 桌面主进程起好 pty 后回写 terminalId */
  setTuiTerminal(id: string, terminalId: string): void {
    const record = this.m.sessions.runtime(id).snapshot.record
    if (!record.tui) throw new Error('不在终端模式')
    this.m.events.patchRecord(id, { tui: { ...record.tui, terminalId } })
  }

  /** 切回界面：清 tui 标记（补轮次由 syncFromTui 做） */
  clearTui(id: string): void {
    this.m.sessions.runtime(id).tuiLive = false
    this.m.events.patchRecord(id, { tui: null })
  }

  /** 旁聊：单独问一次，不进主对话（§3） */
  sideQuestion(id: string, question: string, history: SideTurn[]): Promise<string> {
    return this.m.branch.sideQuestion(id, question, history)
  }

  cancelSideQuestion(id: string): void {
    this.m.branch.cancelSideQuestion(id)
  }

  async archiveSession(id: string, archived: boolean, stopRunning = false): Promise<void> {
    return this.m.sessions.archiveSession(id, archived, stopRunning)
  }

  async deleteSession(id: string): Promise<void> {
    return this.m.sessions.deleteSession(id)
  }

  // -------------------------------------------------------------------------
  // 用量与调用记录（docs/ui/usage.md §6.2）
  // -------------------------------------------------------------------------

  usageSummary(q: UsageQuery): UsageSummary {
    return this.m.usage.usageSummary(q)
  }

  /** 旧的云端记录按时间补录实扣（docs/ui/usage.md §11.2）；返回补上的轮次数 */
  backfillPlatformCosts(account: string, signal: AbortSignal): Promise<number> {
    return this.m.usage.backfillPlatformCosts(account, signal)
  }

  usageList(q: UsageQuery & { offset: number; limit: number }): UsagePage {
    return this.m.usage.usageList(q)
  }

  usageCsv(q: UsageQuery): string {
    return this.m.usage.usageCsv(q)
  }

  usageClear(): void {
    this.m.usage.usageClear()
  }

  /** 内存遥测用的计数（docs/ui/renderer-memory.md §3.2.3）：只算本机，SSH 机器上的不算 */
  memoryStats(): { runtimes: number; processes: number; running: number } {
    let processes = 0
    let running = 0
    for (const rt of this.runtimes.values()) {
      if (rt.session !== null) processes++
      if (rt.snapshot.state !== 'idle') running++
    }
    return { runtimes: this.runtimes.size, processes, running }
  }

  /** 当前账号的额度快照（docs/ui/account-quota.md）；不发请求，还没读过为 null */
  accountQuota(provider: EngineQuotaProvider): Promise<AccountQuota | null> {
    return this.m.quota.get(provider)
  }

  /** 按需 / 手动读取账号额度；不抛错，失败时返回 status 'error' 的快照 */
  refreshAccountQuota(provider: EngineQuotaProvider, opts?: QuotaRefreshOptions): Promise<AccountQuota> {
    return this.m.quota.refresh(provider, opts)
  }

  /** 退出应用：关掉所有引擎进程 */
  async shutdown(): Promise<void> {
    this.ctx.closing = true
    this.m.usage.abortSettlements()
    this.m.login.closeAll()
    const all = [...this.runtimes.values()]
    for (const rt of all) {
      if (rt.idleTimer) clearTimeout(rt.idleTimer)
      if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer)
    }
    // 退出时不等引擎收尾：最多等 1 秒就强制结束（原来 Claude 等满 5 秒，更新重启时白等）
    await Promise.all([
      ...all.map(rt => rt.session?.close({ quick: true }).catch(() => undefined)),
      ...Object.values(this.ctx.adapters).map(adapter => adapter?.close?.({ quick: true }).catch(() => undefined)),
      // 对话检查点在后台跑的 git 直接结束，不等它拍完
      this.m.checkpoints.shutdown(),
    ])
  }
}

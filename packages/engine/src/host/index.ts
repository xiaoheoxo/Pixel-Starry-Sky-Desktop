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
  AccountQuota,
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
  McpOp,
  McpOpResult,
  TaskOutput,
  UsagePage,
  UsageSummary,
} from '@pixelsky/protocol'
import { ClaudeAdapter } from '../claude'
import type { CompactionRequestReport } from '../compaction'
import { CodexAdapter } from '../codex'
import { PixelAdapter } from '../pixel'
import { Store } from '../store'
import { UsageStore, type UsageQuery } from '../usage'
import { HostBranch } from './branch'
import { HostCache } from './cache'
import { HostCompaction } from './compaction'
import type { EngineHostOptions, HostContext, HostModules, Runtime } from './context'
import { HostEvents } from './events'
import { HostGuard } from './guard'
import { HostHandoff } from './handoff'
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

export type { EngineHostOptions } from './context'
export type { SyncableEngineSettings } from './settings'

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
      }),
      codex: new CodexAdapter({
        overridePath: () => settings.file.paths.codex ?? null,
        extraEnv: () => settings.file.env.codex ?? {},
        systemProxy: () => opts.systemProxy?.('codex') ?? null,
        nodeRuntime: opts.nodeRuntime,
        sessionEnv: opts.sessionEnv,
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
        launchOptions: () => ({ args: settings.launchOptions('pixel').args }),
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
      handoff: new HostHandoff(ctx),
      login: new HostLogin(ctx),
      native: new HostNative(ctx),
      quota: new HostQuota(ctx),
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
    opts: { projectId: string } & Partial<SessionSettings> & { engine?: EngineId },
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

  /** 会话的全部条目（只读，不复制；已有运行时用内存里的，否则异步流式读存储，都不创建运行时）；给对话历史工具用 */
  historyItems(id: string): Promise<readonly Item[]> {
    return this.m.query.historyItems(id)
  }

  /** 会话里最后一个 todo（没有时 null）；不创建运行时，给任务面板用 */
  lastTodo(id: string): Promise<Extract<Item, { kind: 'todo' }> | null> {
    return this.m.query.lastTodo(id)
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

  /** 从某条用户消息之前分叉出新会话（§2） */
  forkSession(id: string, userItemId: string, title?: string): Promise<ForkResult> {
    return this.m.branch.fork(id, userItemId, title)
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
    ])
  }
}

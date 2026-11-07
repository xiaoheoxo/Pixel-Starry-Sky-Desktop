// 引擎系统：主进程、预加载脚本、渲染进程共用的接口类型。规格见 docs/engines.md §5.1

import type {
  AccountAutoSwitch,
  AccountPatch,
  ApprovalDecision,
  EngineAccountQuota,
  EngineAccounts,
  EngineCatalog,
  EngineConfig,
  EngineConfigPatch,
  EngineDefaults,
  EngineId,
  EngineInfo,
  EngineLogin,
  EngineUpdateResult,
  GoalAction,
  HostEvent,
  Item,
  MessageInput,
  SendReceipt,
  SearchQuery,
  SearchResponse,
  OpenedSession,
  ProjectRecord,
  ProjectFolder,
  AddProjectsResult,
  SessionGoal,
  SessionRecord,
  SessionSettings,
  SessionSummary,
  McpOp,
  McpOpResult,
  TaskOutput,
  UsagePage,
  UsageSummary,
} from '@pixelsky/protocol'
import type { UsageQuery, SessionPatch } from '../shared/types/engine'
import type { ImportCandidates } from '../shared/types/workspace'
import type { ProjectImportBatch, ProjectImportPicker } from '../shared/types/project-import'

export interface EngineBridge {
  search(query: SearchQuery): Promise<SearchResponse>
  cancelSearch(requestId: number): Promise<void>
  /** 各引擎的本机配置：路径、环境变量、压缩模型、新会话默认值、输出风格等（设置 › 本机引擎） */
  config(): Promise<EngineConfig>
  setConfig(engine: EngineId, patch: EngineConfigPatch): Promise<EngineConfig>
  /** 设为默认引擎，返回新的默认设置 */
  setDefaultEngine(engine: EngineId): Promise<EngineDefaults>
  /** 引擎实际报上来的可选项（输出风格）；不发消息 */
  catalog(engine: EngineId, force?: boolean): Promise<EngineCatalog>
  /** 检查更新（Claude Code：claude update），结束后重新检测 */
  updateEngine(engine: EngineId): Promise<EngineUpdateResult>
  /** 一键安装（只在 EngineInfo.installable 时可用）；过程看 engine:event 的 engine_job */
  installEngine(engine: EngineId): Promise<EngineUpdateResult>
  /** 授权登录（docs/ui/model-channels.md §3）：起登录命令后马上返回当前进度，之后看 engine:event 的 engine_login */
  loginEngine(engine: EngineId, method?: 'browser' | 'device'): Promise<EngineLogin>
  /** 把用户粘贴的授权码写给正在等它的登录命令 */
  loginInput(engine: EngineId, text: string): Promise<void>
  cancelLogin(engine: EngineId): Promise<void>
  /** 取消授权（claude auth logout / codex logout），结束后重新检测 */
  logoutEngine(engine: EngineId): Promise<EngineUpdateResult>
  /** 订阅账号多开（docs/ui/engine-accounts.md）：列表变了看 engine:event 的 engine_accounts */
  accounts(engine: EngineId): Promise<EngineAccounts>
  /** 各账号的额度（缓存 60 秒，force 重新读） */
  accountsQuota(engine: EngineId, force?: boolean): Promise<EngineAccountQuota[]>
  /** 添加账号：登录进度看 engine_login（target 'add'） */
  addAccount(engine: EngineId, method?: 'browser' | 'device'): Promise<EngineLogin>
  reloginAccount(engine: EngineId, id: string, method?: 'browser' | 'device'): Promise<EngineLogin>
  switchAccount(engine: EngineId, id: string): Promise<EngineAccounts>
  /** 删除账号（只在像素星空里生效）：添加的账号删本机凭据，原来的账号只是隐藏；删的是当前账号时先换到别的 */
  removeAccount(engine: EngineId, id: string): Promise<EngineAccounts>
  /** 把隐藏的原来的账号放回列表 */
  showDefaultAccount(engine: EngineId): Promise<EngineAccounts>
  updateAccount(engine: EngineId, id: string, patch: AccountPatch): Promise<EngineAccounts>
  setAccountAuto(engine: EngineId, patch: Partial<AccountAutoSwitch>): Promise<EngineAccounts>
  retrySettings(): Promise<{ maxRetries: number | null }>
  /** 系统代理补给本机引擎的状态（会重新查一次系统代理） */
  systemProxy(): Promise<import('../shared/types/system-proxy').SystemProxyStatus>
  setSystemProxy(enabled: boolean): Promise<import('../shared/types/system-proxy').SystemProxyStatus>
  setRetrySettings(maxRetries: number | null): Promise<{ maxRetries: number | null }>
  /** 引擎列表和状态；force 时重新检测 */
  engines(force?: boolean): Promise<EngineInfo[]>
  /** 新会话的默认设置 */
  defaults(): Promise<EngineDefaults>
  projects(): Promise<ProjectRecord[]>
  /** 弹出选择文件夹对话框（可以一次选几个）并添加项目；取消时返回 null */
  addProject(): Promise<AddProjectsResult | null>
  /** 按路径一次加多个项目（「从一个文件夹导入」、拖到侧栏的文件夹） */
  addProjects(paths: string[]): Promise<AddProjectsResult>
  /** 选一个上级文件夹，列出它下面的子文件夹；取消时返回 null */
  importCandidates(): Promise<ImportCandidates | null>
  scanProjectImports(): Promise<ProjectImportBatch>
  pickProjectImports(kind: ProjectImportPicker): Promise<ProjectImportBatch | null>
  previewProjectPaths(text: string): Promise<ProjectImportBatch>
  removeProject(id: string): Promise<void>
  /** 只改显示名，磁盘上的文件夹不变 */
  renameProject(id: string, name: string): Promise<ProjectRecord>
  /** 改项目的附加文件夹（整组替换；只对之后新建的对话生效，docs/ui/multi-root-projects.md §3） */
  setProjectFolders(id: string, folders: ProjectFolder[]): Promise<ProjectRecord>
  /** 选文件夹（可多选），只返回路径、不加成项目；取消时 null */
  pickFolders(): Promise<string[] | null>
  sessions(): Promise<SessionSummary[]>
  createSession(
    opts: {
      projectId: string
      engine?: EngineId
      copyId?: string | null
      workspaceSessionId?: string
    } & Partial<SessionSettings>,
  ): Promise<SessionRecord>
  /** 打开会话：返回快照和序号，之后只应用 onEvent 里序号更大的会话事件 */
  openSession(id: string): Promise<OpenedSession>
  /** 一张图的原图：桌面界面的快照里图片不带数据，显示、复制、重发时按需取；找不到为 null */
  image(id: string, itemId: string, imageId: string): Promise<import('@pixelsky/protocol').ImageAttachment | null>
  /**
   * 一条完整条目：快照里截过的（item.cut）长输出补回原文，不带 cut / cutChars；图片仍不带数据（按 image 取）。
   * 展开、复制、导出时用；没有这一条为 null
   */
  item(id: string, itemId: string): Promise<import('@pixelsky/protocol').Item | null>
  send(id: string, input: string | MessageInput): Promise<SendReceipt>
  /** summary：最近请求加本地估算，不调接口；full（默认）：调 Token 计数接口 */
  context(
    id: string,
    detail?: import('@pixelsky/protocol').ContextDetailLevel,
  ): Promise<import('@pixelsky/protocol').ContextDiagnostic>
  compact(id: string): Promise<SendReceipt>
  cancelQueued(id: string, queueId: string): Promise<string>
  /** 发送失败的消息不重发也不撤回：从队列里拿掉，对话里的那条和错误卡片照旧 */
  dismissQueued(id: string, queueId: string): Promise<void>
  /** to：{ before } 按消息 id 排到某条前面（null = 最后），队列变了会拒绝；数字是旧形态（挪到第几位） */
  moveQueued(id: string, queueId: string, to: import('@pixelsky/protocol').QueueMove): Promise<void>
  runQueuedNow(id: string, queueId: string): Promise<void>
  steerQueued(id: string, queueId: string, expectedTurnId: string): Promise<void>
  resumeQueue(id: string): Promise<void>
  /** 限流等待中取消「恢复后自动继续」：暂停队列、清掉计时器（docs/ui/rate-limit-resume.md） */
  pauseReconnect(id: string): Promise<void>
  /** 回退前检查代码：要还原哪些文件（docs/ui/rewind-fork-sidechat.md §1） */
  rewindPreview(id: string, itemId: string): Promise<import('@pixelsky/protocol').RewindPreview>
  /** 回退到这条用户消息之前（对话和 / 或代码），回退对话时返回它的原文和图片 */
  rewind(
    id: string,
    itemId: string,
    options?: import('@pixelsky/protocol').RewindOptions,
  ): Promise<import('@pixelsky/protocol').RewindResult>
  /** 撤销最近一次回退 */
  undoRewind(id: string): Promise<void>
  /** 对话检查点：每轮的快照情况、改动卡片撤回的文件（docs/ui/undo-changes.md） */
  checkpoints(id: string): Promise<import('@pixelsky/protocol').CheckpointList>
  /** 开始打字时预先拍第一次快照（docs/ui/undo-changes.md §2） */
  prepareCheckpoints(id: string): Promise<void>
  /** 改动卡片撤回文件；之后又被改过、force 不为真时只返回冲突 */
  revertFiles(
    id: string,
    itemId: string,
    paths: string[],
    force: boolean,
  ): Promise<import('@pixelsky/protocol').RevertFilesResult>
  /** 恢复撤回的文件 */
  restoreFiles(id: string, revertId: string, paths?: string[]): Promise<void>
  /** 从这条用户消息之前分叉出新会话（§2） */
  fork(id: string, itemId: string, title?: string): Promise<import('@pixelsky/protocol').ForkResult>
  /** 开分支 / 合并回主会话（docs/ui/branch-merge.md §6） */
  branchPrepare(id: string): Promise<import('../shared/types/branch').BranchPrepare>
  /** itemId 为 null 时带上整个会话 */
  branch(
    id: string,
    itemId: string | null,
    input: import('../shared/types/branch').BranchCreateInput,
  ): Promise<import('@pixelsky/protocol').ForkResult>
  branchStatus(id: string): Promise<import('../shared/types/branch').BranchStatus>
  branchMerge(
    id: string,
    opts: import('../shared/types/branch').BranchMergeOptions,
  ): Promise<import('../shared/types/branch').BranchMergeResult>
  branchSummary(id: string, language: 'zh' | 'en'): Promise<import('../shared/types/branch').BranchSummaryResult>
  dropPendingMerge(id: string): Promise<void>
  /** 接着引擎自己留下的会话（docs/ui/claude-resume.md）：第一步，只读头部；subfolders 连项目子文件夹里开的一起列 */
  nativeSessions(
    projectId: string,
    engine: EngineId,
    opts?: { subfolders?: boolean },
  ): Promise<import('@pixelsky/protocol').NativeSessionSummary[]>
  /** 第二步：读这几个会话的尾部（最后一句、标题、模型）；共用最近一次 nativeSessions 的读取预算 */
  nativeSessionDetails(
    projectId: string,
    engine: EngineId,
    ids: string[],
  ): Promise<import('@pixelsky/protocol').NativeSessionDetail[]>
  /**
   * 导入成一个新对话。mode 'inplace'（默认）原地接着，'copy' 复制一份接着聊；settings 是新对话用的设置（模型、额度来源……）；
   * token 用来取消，也是 native_import 进度事件里的 token
   */
  importNativeSession(
    projectId: string,
    engine: EngineId,
    nativeId: string,
    opts?: { mode?: 'inplace' | 'copy'; settings?: Partial<SessionSettings>; token?: string },
  ): Promise<import('@pixelsky/protocol').NativeImportResult>
  cancelNativeImport(token: string): Promise<void>
  /** 对导入的对话：earlier 加载更早的、sync 补上终端里新聊的、check 只检查（有就在末尾加提示）、copy 改成复制一份接着聊 */
  nativeSessionAction(
    id: string,
    kind: import('@pixelsky/protocol').NativeAction,
  ): Promise<import('@pixelsky/protocol').NativeActionResult>
  /** 旁聊：单独问一次，不进主对话（§3） */
  sideQuestion(id: string, question: string, history: import('@pixelsky/protocol').SideTurn[]): Promise<string>
  cancelSideQuestion(id: string): Promise<void>
  /** 切到终端模式（docs/ui/tui-toggle.md）：返回终端 id */
  /** 切终端前的灰态原因；能切返回 null */
  tuiCheck(sessionId: string): Promise<string | null>
  tuiOpen(sessionId: string): Promise<{ terminalId: string; engineSessionId: string }>
  /** 切回界面；引擎还在跑且未 force 时抛 tui.running */
  tuiClose(sessionId: string, opts?: { force?: boolean }): Promise<{ added: number; mismatched: boolean }>
  /** opts.background：连同后台子智能体一起停 */
  interrupt(id: string, opts?: import('@pixelsky/protocol').InterruptOptions): Promise<void>
  /** 提醒专用：轮次已过期时返回 false，不中断或暂停下一轮。 */
  interruptTurn(id: string, expectedTurnId: string): Promise<boolean>
  answer(id: string, requestId: string, decision: ApprovalDecision): Promise<void>
  /** 自动审核拦下的一步，用户同意再试（docs/ui/codex-auto-review.md） */
  approveReview(id: string, itemId: string): Promise<void>
  updateSession(id: string, patch: SessionPatch): Promise<SessionRecord>
  deleteSession(id: string): Promise<void>
  archiveSession(id: string, archived: boolean, stopRunning?: boolean): Promise<void>
  renameSession(id: string, title: string): Promise<SessionRecord>
  setSessionBottom(id: string, bottomed: boolean): Promise<SessionRecord>
  setSessionPinned(id: string, pinned: boolean): Promise<SessionRecord>
  /** 停止一个后台任务 */
  stopTask(id: string, taskId: string): Promise<void>
  /** 目标模式（Codex /goal，docs/ui/codex-goal.md）：引擎进程在跑时直接操作，返回之后的目标 */
  goal(id: string, action: GoalAction): Promise<SessionGoal | null>
  /** 读一个后台任务的输出（最后一段） */
  taskOutput(id: string, taskId: string): Promise<TaskOutput>
  /** 会话里的 MCP 服务器：取状态或做操作（docs/ui/connectors.md）；会话进程没在跑时刷新返回 report: null 或上次的状态 */
  mcp(id: string, op: McpOp): Promise<McpOpResult>
  /** 智能体追踪：读一个子智能体的对话（只读） */
  subagentTranscript(id: string, agentId: string): Promise<Item[]>
  /** 用量汇总（docs/ui/usage.md §6.3）；tzOffset 目前没用到，按主进程本地时区计算 */
  usageSummary(q: UsageQuery & { now: number; tzOffset?: number }): Promise<UsageSummary>
  /** 热力图：最近 53 周每天的合计（docs/ui/usage-learn.md §2） */
  usageDaily(q: { filter: UsageQuery['filter']; now: number }): Promise<import('@pixelsky/protocol').UsageBucket[]>
  /** 用量明细，最新在前，分页 */
  usageList(q: UsageQuery & { now: number; offset: number; limit: number }): Promise<UsagePage>
  /** 弹出保存对话框导出 CSV；取消时返回 false */
  usageExport(q: UsageQuery & { now: number }): Promise<boolean>
  usageClear(): Promise<void>
  /** 订阅主进程广播的事件；返回取消订阅函数 */
  onEvent(cb: (e: HostEvent) => void): () => void
}

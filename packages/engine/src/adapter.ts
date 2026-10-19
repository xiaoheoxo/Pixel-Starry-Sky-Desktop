// 引擎适配器接口：每种引擎（Claude Code、以后的 Codex）实现一份，EngineHost 只认这个接口。
import type {
  AgentRuns,
  ApprovalDecision,
  ImageAttachment,
  InterruptOptions,
  Item,
  TaskOutput,
  EngineCatalog,
  EngineEvent,
  EngineInfo,
  EngineUpdateResult,
  PermissionMode,
  SessionRecord,
  SessionSettings,
} from '@pixelsky/protocol'
import type { ChatSeed } from './chat-log'
import type { NativeSessionList, ListOptions, LiveState, NativeRead, NewerTurns, ReadOptions } from './native/types'
import type { AccountQuotaPatch, QuotaReading } from './quota'

/** 要启动的程序：可执行文件 + 固定在前面的参数（例如用 node 跑 cli.js 时是 [cli.js]） */
export interface Launcher {
  command: string
  args: string[]
}

/** 正在跑的授权登录命令（docs/ui/model-channels.md §3） */
export interface LoginProcess {
  /** 往命令的 stdin 写（粘贴授权码） */
  write(text: string): void
  kill(): void
  done: Promise<import('./exec').ExecResult>
}

/** 适配器向 EngineHost 汇报的通道 */
export interface SessionContext {
  extensions?: import('@pixelsky/protocol').ExtensionLaunch
  /** 本轮的请求重试策略，创建会话连接时固定，null 跟随引擎。 */
  maxRetries?: number | null
  /** 当前的会话记录（cwd、设置、引擎会话 id 都从这里取最新值） */
  record(): SessionRecord
  /**
   * 条目、审批、用量、一轮结束等事件。
   * 适配器不发 status / record 事件：运行状态和会话记录由 EngineHost 维护。
   */
  emit(event: EngineEvent): void
  /** 宿主里这个会话当前的智能体追踪（运行时快照）：引擎新开会话连接时拿来接着更新，不用再读一遍磁盘 */
  runs?(): AgentRuns
  /** 引擎分配（或确认）了自己的会话 id */
  setEngineSessionId(id: string): void
  /** 引擎自己改了权限模式（例如计划模式下用户同意了计划） */
  setPermissionMode(mode: PermissionMode): void
  /** 引擎实际生效的 Ultracode 状态和我们记录的不一样（例如当前模型不支持） */
  setUltracode(on: boolean): void
  /** Fast 模式开不了（账号或接口不支持），把记录里的开关关掉 */
  setFast(on: boolean): void
  /** 回退截断点已在新进程生效 */
  clearPendingRewind?(): void
  /** 分叉第一次启动成功（或改成新会话）后清掉 pendingFork */
  clearPendingFork?(): void
  /**
   * 原来的引擎会话接不上（恢复 / 回退 / 分叉失败），已经改开了新会话：宿主把这一轮之前的整段聊天做成回放
   * （userItemId 是这一轮自己的用户消息，不算在内），连同要显示的提示一起给适配器注进新会话；没有可带的返回 null
   */
  lostSeed?(userItemId: string, sees: boolean): { seed: ChatSeed; notice: Item } | null
  /** 引擎报了配置类警告（用户 config.toml 引起、不影响使用）：不进对话，交给宿主放进引擎信息 */
  reportConfigWarning?(text: string): void
  /** 对话里顺带收到了账号额度（Claude rate_limit_event、Codex account/rateLimits/updated）；宿主核对来源后合并 */
  reportQuota?(patch: AccountQuotaPatch): void
}

/** 一个会话对应的引擎连接。进程按需启动；close() 之后这个对象不再使用 */
export interface EngineSession {
  /**
   * 开始新的一轮。EngineHost 已经发出了用户消息条目和 turn_started，
   * 适配器负责在这一轮结束时发 turn_completed（带同一个 turnId），出错也要发。
   * seed：跨引擎接力时这一轮之前要补进上下文的聊天，只发给 seedsHistory 的适配器；
   * 注入进原生会话，注入不了就把 seed.fallback 加在 text 前面发，seed.fallbackImages 排在 attachments 前面一起发。
   * handoffImages：不注入的引擎走文字交接时，text 里说明过的更早消息的图片，排在 attachments 前面；
   * 当前模型不能看图就丢掉它们（attachments 不能丢，照旧报错）
   */
  send(
    text: string,
    turnId: string,
    userItemId: string,
    attachments?: ImageAttachment[],
    seed?: ChatSeed,
    handoffImages?: ImageAttachment[],
  ): void
  /** opts.background：连同后台子智能体一起停；没有后台任务的引擎忽略 */
  interrupt(opts?: InterruptOptions): Promise<void>
  answer(requestId: string, decision: ApprovalDecision): void
  /** 改模型 / 强度 / 权限 / 开关：进程在跑就实时生效，否则下次启动时生效 */
  update(patch: Partial<SessionSettings>, strict?: boolean): Promise<void>
  steer?(text: string, userItemId: string, attachments?: ImageAttachment[]): Promise<void>
  /**
   * 上下文明细。flags.contextLive 时运行中也可调用；否则仅宿主确认会话空闲后调用。
   * summary 用最近请求的计数加本地估算，full 调 Token 计数接口。
   */
  context?(
    detail?: import('@pixelsky/protocol').ContextDetailLevel,
  ): Promise<import('@pixelsky/protocol').ContextDiagnostic>
  /** 停止一个后台任务；没有后台任务的引擎不实现（caps.backgroundTasks 为 false） */
  stopTask?(taskId: string): Promise<void>
  /** 读一个后台任务的输出（只给最后一段）；没有后台任务的引擎不实现 */
  taskOutput?(taskId: string): Promise<TaskOutput>
  /**
   * 借这个会话活着的进程主动读一次账号额度（docs/ui/account-quota.md §3.4）；没有进程、走网关时返回 null
   * （宿主改用适配器的临时读取），绝不为它起会话进程
   */
  accountQuota?(): Promise<QuotaReading> | null
  /** quick：应用正在退出（包括更新重启），只给进程很短的时间自己退，不等它收尾（docs/release-update.md §11） */
  close(opts?: CloseOptions): Promise<void>
}

export interface CloseOptions {
  quick?: boolean
}

/**
 * 回退的截断点：at 是最后保留的位置（null = 回到会话开头）。
 * unchanged：被移除的消息都没进过引擎的记录，引擎那边什么都不用动（宿主不改待执行的回退 / 分叉）
 */
export interface RewindAnchor {
  at: string | null
  unchanged?: true
}

/** 应用退出时给引擎进程自己退出的时间：Claude Code 空闲时关掉 stdin 约 0.6 秒就退，在忙时常常 5 秒也不退 */
export const QUICK_CLOSE_MS = 1_000

export interface EngineAdapter {
  /** 检测引擎状态；结果会缓存，force 时重新检测 */
  info(force?: boolean): Promise<EngineInfo>
  /**
   * 保存前校验用户替换的命令和追加的参数（docs/ui/engine-launch.md §3）：命令找不到、不能直接启动，
   * 或参数里有像素星空自己控制的参数时抛出原因。command 为 null 时不查命令。
   */
  checkLaunch?(command: string | null, args: readonly string[]): void
  createSession(ctx: SessionContext): EngineSession
  /** 智能体追踪：从引擎保存的文件读出这个会话以前的编排和子智能体（不需要进程在跑） */
  loadRuns?(record: SessionRecord): AgentRuns
  /** 智能体追踪：读一个子智能体的对话（只读） */
  subagentTranscript?(record: SessionRecord, agentId: string): Item[] | Promise<Item[]>
  /** 引擎实际报上来的可选项（输出风格等）；不发消息、不花钱，force 时不用缓存 */
  catalog?(force?: boolean): Promise<EngineCatalog>
  /** 检查更新并安装（Claude Code：claude update；Codex：npm install -g）；宿主随后重新检测。onLine 收每一行输出 */
  update?(onLine?: (line: string) => void): Promise<EngineUpdateResult>
  /**
   * 没装时一键安装（Claude Code：官方安装器；Codex：npm install -g），只在 info.installable 为真时调用；
   * 宿主随后重新检测。onLine 收每一行输出
   */
  install?(onLine?: (line: string) => void): Promise<EngineUpdateResult>
  /** 授权登录（docs/ui/model-channels.md §3）：起登录命令后马上返回，宿主管超时、取消、之后的重新检测 */
  login?(method: 'browser' | 'device', onLine: (line: string) => void): Promise<LoginProcess>
  /** 取消授权：claude auth logout / codex logout */
  logout?(): Promise<EngineUpdateResult>
  /** npm 上的包名：宿主定时查最新版本，界面提示「有新版本」（docs/ui/engine-update.md） */
  readonly npmPackage?: string
  /**
   * 更新要替换正在用的程序（Windows 上 npm 换不了被占用的 codex.exe）：宿主先关掉这个引擎空闲的进程，
   * 有任务在跑就不更新
   */
  readonly updateNeedsIdle?: boolean
  /**
   * 回退：按要移除的用户消息（按顺序）在引擎记录里找截断点。
   * 返回 null 表示这些消息都没进入引擎上下文；at 为 null 表示回到会话开头（换新的引擎会话）。
   */
  rewindAnchor?(record: SessionRecord, userItemIds: string[]): RewindAnchor | null | Promise<RewindAnchor | null>
  /** 引擎自己分配会话 id（Codex）：宿主不能预先塞 randomUUID，新会话的 engineSessionId 用 null，启动时由引擎新建 */
  readonly enginePicksSessionId?: boolean
  /**
   * 跨引擎接力能把别的引擎期间的聊天直接注入原生会话（send 的 seed）。
   * 不支持的引擎由宿主把交接材料加在消息前面发
   */
  readonly seedsHistory?: boolean
  /**
   * 回退恢复代码：预览或还原到这条用户消息之前的文件（docs/ui/rewind-fork-sidechat.md §1）。
   * 还原时先预览，把要动的文件交给 beforeRestore（存一份当前内容），再还原；返回预览出的文件列表
   */
  rewindFiles?(
    record: SessionRecord,
    userItemId: string,
    dryRun: boolean,
    beforeRestore?: (files: string[]) => void,
  ): Promise<RewindFilesReply>
  /**
   * 这条用户消息在引擎记录里排在最近一次上下文压缩之前（Claude Code 只保留压缩之后的代码检查点，GitHub #82）；
   * 用来把「没有检查点」说清楚
   */
  beforeCompaction?(record: SessionRecord, userItemId: string): boolean | Promise<boolean>
  /** 接着引擎自己留下的会话（docs/ui/claude-resume.md）：列出这个文件夹的会话（第一步），尾部信息靠返回的 details 补 */
  nativeSessions?(cwd: string, opts?: ListOptions): Promise<NativeSessionList>
  /** 把引擎自己的一个会话读成条目（流式，能取消）；记录不在了返回 null */
  readNativeSession?(cwd: string, id: string, opts?: ReadOptions): Promise<NativeRead | null>
  /** 补上：after 之后新增的轮次；after 不在当前分支上或记录不在了返回 null */
  newerNativeTurns?(
    cwd: string,
    id: string,
    after: string,
    opts?: { turns?: number; afterTurn?: boolean },
  ): Promise<NewerTurns | null>
  /** 这个会话在引擎那边的记录还在不在（接力发现记录没了时把聊天写进新的引擎会话用） */
  hasNativeSession?(record: SessionRecord): boolean
  /** 这些会话现在有没有别的进程开着（不含像素星空自己起的进程）；id 不在结果里的按没开着算 */
  nativeLive?(rows: readonly { id: string; mtimeMs: number }[]): Map<string, LiveState>
  /** 不借会话进程读一次账号额度（Claude：临时进程；Codex：只读 app-server）。不支持的引擎不实现 */
  accountQuota?(): Promise<QuotaReading>
  /** 应用退出时关掉适配器自己的常驻进程（Codex 的只读 app-server、Claude 的额度临时进程）；quick 同会话的 close：最多等 1 秒 */
  close?(opts?: CloseOptions): Promise<void>
  /** 旁聊：带着会话上下文单独问一次，没有工具、不写记录（§3） */
  sideQuestion?(record: SessionRecord, prompt: string, signal: AbortSignal): Promise<string>
}

/** 恢复代码的结果；files 是绝对路径 */
export type RewindFilesReply =
  | { ok: true; files: string[]; insertions: number; deletions: number }
  | { ok: false; reason: 'no-checkpoint' | 'failed'; message: string }

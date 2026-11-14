// EngineHost 各模块共享的状态，以及模块之间互相调用的入口（docs/restructure.md §8.3 P8）。
// 模块只在方法调用时经 ctx.m 访问别的模块，不在构造时互相取值。
import type {
  AccountQuota,
  EngineId,
  ExtensionLaunch,
  HostEvent,
  PlatformCharge,
  PlatformSettlement,
  RemoteCall,
  SendReceipt,
  SessionRecord,
  SessionSnapshot,
} from '@pixelsky/protocol'
import type { EngineAdapter, EngineSession } from '../adapter'
import type { Store } from '../store'
import type { UsageStore } from '../usage'
import type { HostAccounts } from './accounts'
import type { HostCache } from './cache'
import type { HostCompaction } from './compaction'
import type { HostEvents } from './events'
import type { HostBranch } from './branch'
import type { HostCheckpoints } from './checkpoints'
import type { HostGuard } from './guard'
import type { HostHandoff } from './handoff'
import type { HostLogin } from './login'
import type { HostNative } from './native'
import type { HostProjects } from './projects'
import type { HostQuery } from './query'
import type { HostQuota } from './quota'
import type { HostQueue } from './queue'
import type { HostSessions } from './sessions'
import type { HostSettings } from './settings'
import type { HostTurn } from './turn'
import type { HostUsage } from './usage'
import type { NodeRuntime } from '../npm'

export interface EngineHostOptions {
  /** 本机的系统代理（http://主机:端口）：补给引擎进程（env.ts systemProxyEnv）；远程机器上不传 */
  systemProxy?: (engine: EngineId) => string | null
  /** 本机的私有 Node.js：没装 Node.js 时一键安装 Codex / Claude Code 先装它（npm.ts）；远程机器上不传 */
  nodeRuntime?: NodeRuntime
  platformCharges?: (settlement: PlatformSettlement, signal: AbortSignal) => Promise<PlatformCharge[]>
  settlementDelays?: number[]
  /** 这个账号在这段时间的全部调用（旧记录按时间补录实扣用，docs/ui/usage.md §11.2）；账号已切换时抛错 */
  platformCalls?: (q: { account: string; from: number; to: number }, signal: AbortSignal) => Promise<RemoteCall[]>
  /** 按项目准备插件 / MCP 配置；返回的临时资源由引擎连接关闭时释放。 */
  extensions?: (record: SessionRecord) => ExtensionLaunch | Promise<ExtensionLaunch>
  /** 这个会话的引擎能不能用 pixelsky_history 工具；交接材料里据此提示新引擎去查更早的对话 */
  historyTool?: (record: SessionRecord) => boolean
  /** 宿主为单个会话提供平台代理环境，空值使用本机认证。 */
  sessionEnv?: (record: SessionRecord) => NodeJS.ProcessEnv
  /** 像素星空命令行的自带入口（开发时 packages/cli/src/cli.ts；PIXELSKY_CLI_BIN 优先于它，再其次是 PATH 上的 pixelsky） */
  pixelCli?: string | null
  /** 对话检查点（docs/ui/undo-changes.md）：每轮前后给工作目录拍快照。桌面端和远程辅助进程打开，测试默认关 */
  checkpoints?: boolean
  /** 测试用：这个目录所在磁盘的剩余字节数（默认 fs.statfs）；少于 5 GiB 不拍新快照（docs/ui/checkpoint-disk.md） */
  diskFree?: (dir: string) => Promise<number>
  /** 保存数据的目录（Electron 里是 userData/engine） */
  dataDir: string
  /** 删「对话」时它的文件夹里有文件：移到回收站（本机系统回收站，远端数据目录 trash/）；不给就直接删 */
  trash?: (path: string) => Promise<void>
  /** 广播事件给界面 */
  emit(event: HostEvent): void
  /** 当前账号的额度快照变了（docs/ui/account-quota.md §4.4）：主进程广播给所有窗口；远程机器上不传，只静默合并 */
  onQuota?: (quota: AccountQuota) => void
  /** 空闲多久关闭引擎进程，默认 30 分钟 */
  idleMs?: number
  /** 测试用：替换适配器 */
  adapters?: Partial<Record<EngineId, EngineAdapter>>
  /** 平台认证 / 路由预检；排队时只保存身份，执行前重新验证。 */
  validateInput?: (record: SessionRecord) => Promise<void>
  /** 自定义 API 会话：这个模型的计价参照（官方模型名）；不给就按模型名自动对（docs/ui/custom-api.md §4.3） */
  priceRef?: (record: SessionRecord, model: string) => string | null | undefined
  /** 自定义 API 会话：估算费用乘的倍率（中转站打折）；不给按 1 */
  costMultiplier?: (record: SessionRecord) => number | null | undefined
  /** npm 包的最新版本号（桌面端用系统代理查 registry）；不给就不提示引擎有新版本（docs/ui/engine-update.md） */
  /** 授权登录最多等多久（毫秒），默认 10 分钟；测试用 */
  loginTimeoutMs?: number
  latestVersion?: (npmPackage: string) => Promise<string | null>
  /** 引擎自己查最新版本用的 fetch（桌面端给 Electron 的 net.fetch，走系统代理）；没有时用 Node 自带的 */
  fetch?: typeof fetch
  /** 断线自动重连时替用户发的那句（按界面语言），默认「继续」 */
  continueText?: () => string
  /** 测试用：第 n 次自动重连前等多久（毫秒），不给按 retry.ts reconnectDelay */
  reconnectDelays?: number[]
  /** 测试用：限流后第 n 次自动继续前等多久（毫秒），不给按 retry.ts limitDelay */
  limitDelays?: number[]
  /**
   * 订阅额度都用完、自动改用平台时挑线路（docs/ui/engine-accounts.md §5.2）：按引擎和这个会话现在的模型选。
   * 本机主进程提供（平台登录和目录在那里）；远程机器上不传，这个功能就不生效
   */
  platformRoute?: (query: { engine: EngineId; model: string | null }) => Promise<PlatformRouteResult>
}

/** platformRoute 的结果：选到的线路（分组 id、显示名、平台账号）和模型；一条都用不了时是原因 */
export type PlatformRouteResult = { groupId: string; group: string; account: string; model: string } | { error: string }

/** 正在跑的这一轮（turn.ts 调 send 前设置，turn_completed 读完清掉）：断线重连判断「引擎收到这条没有 / 有没有进展」用 */
export interface TurnTrack {
  turnId: string
  /** 这一轮对应的队列项 */
  queueId: string
  /** 这一轮发给引擎的用户消息条目 id（引擎确认收到时 input_ack 带的就是它） */
  userItemId: string
  /** 这一轮发的是「继续」（原消息早就送达了） */
  resume: boolean
  /** 引擎确认收到了这一轮的消息，或者已经有输出 */
  delivered: boolean
  /** 这一轮已经有输出（助手 / 推理 / 工具 / 命令）：重连次数从头算 */
  progressed: boolean
  /** 引擎自己重试过这次请求（request_retry）：宿主不再叠加一层重连 */
  engineRetried: boolean
  /** 这一轮报过额度用完（Codex usageLimitExceeded）：失败时看要不要自动换账号（docs/ui/engine-accounts.md §5） */
  usageLimited?: boolean
}

export interface Runtime {
  inspectingContext?: boolean
  /**
   * 这次运行里切到了终端、终端还开着（只在内存里）。记录上的 tui 标记会落盘：重启后标记还在、这个为假，
   * 打开会话时才当作已切回（docs/ui/tui-toggle.md §3.4）；为真时打开会话（切标签、重连）不能清标记
   */
  tuiLive?: boolean
  sessionMaxRetries: number | null | undefined
  snapshot: SessionSnapshot
  /** 事件序号，每应用一个事件加一（见 OpenedSession） */
  seq: number
  session: EngineSession | null
  idleTimer: NodeJS.Timeout | null
  receipts: SendReceipt[]
  pumping: boolean
  stopping: boolean
  generation: number
  activeId: string | null
  turn?: TurnTrack
  execution: SessionRecord | null
  sessionSource: string | null | undefined
  /** 正在为这个会话挑平台线路（订阅额度用完、自动改用平台）：挑完之前不派发，免得又用订阅发一次 */
  sourceSwitching?: boolean
  /** 启动这个进程时的引擎级设置（launchKey）；设置变了，下一条消息前重启进程 */
  sessionLaunch?: string
  /**
   * 启动这个进程时的订阅账号（accounts.currentId）；走平台 / 自定义接口的进程为 null。换账号后正在跑的这一轮和
   * 空闲着的旧进程仍用它（下一条消息前才换进程）：额度用完归到它、借进程读额度也要和当前账号对得上
   */
  sessionAccount?: string | null
  pumpFinished: Promise<void> | null
  /** 这一轮（turnId）是没带交接的斜杠命令：结束时不推进引擎的游标，交接留给下一条普通消息 */
  holdCursor?: string
  /** 队首的自动重连到时间时再派发（queue.ts armReconnect） */
  reconnectTimer?: NodeJS.Timeout | null
}

export interface HostModules {
  guard: HostGuard
  settings: HostSettings
  projects: HostProjects
  query: HostQuery
  cache: HostCache
  compaction: HostCompaction
  usage: HostUsage
  events: HostEvents
  queue: HostQueue
  turn: HostTurn
  sessions: HostSessions
  branch: HostBranch
  checkpoints: HostCheckpoints
  handoff: HostHandoff
  login: HostLogin
  native: HostNative
  quota: HostQuota
  accounts: HostAccounts
}

export interface HostContext {
  readonly opts: EngineHostOptions
  readonly store: Store
  readonly usage: UsageStore
  readonly idleMs: number
  /** 构造时赋值一次（自带的适配器要读设置模块） */
  adapters: Partial<Record<EngineId, EngineAdapter>>
  readonly records: Map<string, SessionRecord>
  readonly runtimes: Map<string, Runtime>
  readonly changingSessions: Set<string>
  readonly lockedWorkspaces: Set<string>
  /** 应用正在退出；异步任务每次都读最新值 */
  closing: boolean
  /** 各模块，构造完成后赋值 */
  m: HostModules
}

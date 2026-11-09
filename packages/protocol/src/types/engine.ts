import type { AlwaysScope, Effort, EngineId, PermissionMode } from './base'
import type { SessionSettings } from './session'

/** 中断选项 */
export interface InterruptOptions {
  /** 连同后台子智能体、多智能体编排一起停（只有 caps.backgroundTasks 的引擎用到） */
  background?: boolean
}

/** 引擎能力表：界面按它决定显示什么，组件里不判断是哪个引擎 */
export interface EngineCaps {
  /** 可直接发送图片内容块；缺省表示未接入。 */
  imageInput?: boolean
  /** 能中断当前这一轮 */
  interrupt: boolean
  /** 能恢复以前的会话 */
  resume: boolean
  /** 运行中引导；普通排队由宿主管理，不依赖这个能力 */
  steer: boolean
  /** 回退到某条用户消息之前（截断对话与引擎上下文） */
  rewind?: boolean
  /** 回退时能恢复代码（引擎自己的文件检查点） */
  rewindCode?: boolean
  /** 从某条用户消息之前分叉出新会话 */
  fork?: boolean
  /** 旁聊：带着上下文单独问一次，不进主对话 */
  sideChat?: boolean
  /** 改模型 / 强度当轮生效（否则下一轮生效） */
  liveModelSwitch: boolean
  livePermissionSwitch: boolean
  /** 支持的权限模式 */
  permissionModes: PermissionMode[]
  /** 支持的推理强度，从低到高（滑块上的停靠点） */
  efforts: Effort[]
  /** 有 Ultracode 开关（Claude Code：每个任务都编排多个子智能体），能和任意推理强度搭配 */
  ultracode: boolean
  /** 有 Fast 模式开关 */
  fast: boolean
  /** 有「显示思考摘要」开关 */
  thinkingSummaries: boolean
  /** 报告后台任务（后台任务条） */
  backgroundTasks: boolean
  /** 有智能体追踪（子智能体条、追踪面板） */
  agentTrace: boolean
  /** 会给出输入建议 */
  promptSuggestions: boolean
  /** 审批时「始终允许」能选的范围；空数组表示没有「始终允许」 */
  alwaysScopes: AlwaysScope[]
  /** 报告花费（美元） */
  costUsd: boolean
  /** 有「检查更新」（Claude Code：claude update） */
  selfUpdate: boolean
  /** 设置里由像素星空管理的启动选项：输出风格、允许提问、自动压缩 */
  launchSettings: boolean
  /** 应用管理插件的命令 */
  pluginCommands: boolean
  /** 自有报错时提供「改用平台」 */
  platformSwitch: boolean
}

/**
 * 引擎状态：
 * - ready 可用
 * - missing 没找到可执行文件
 * - unauthenticated 没登录
 * - outdated 版本太低
 * - error 检测出错
 * - unsupported 像素星空还不支持（即将支持）
 */
export type EngineStatus = 'ready' | 'missing' | 'unauthenticated' | 'outdated' | 'error' | 'unsupported'

export interface EngineInfo {
  id: EngineId
  /** 显示名，例如「Claude Code」 */
  name: string
  /** 输入框里小方块上的两个字母，例如「Cc」 */
  short: string
  status: EngineStatus
  /** 检测到的版本号，例如「2.1.289」 */
  version: string | null
  /** 可执行文件路径 */
  path: string | null
  /** 不可用时告诉用户怎么解决的一句话 */
  message: string | null
  /** 没装时能在软件里一键安装（设置 › 本机引擎的「安装」按钮）；旧版远端没有这个字段，按不能安装 */
  installable?: boolean
  /** 自带程序（自动查找）还是用户替换的命令（docs/ui/engine-launch.md §3）；旧版远端没有这个字段，按自带显示 */
  launch?: 'stock' | 'custom'
  /**
   * 用追加的参数（或替换的命令）试启动、握手失败的原因（docs/ui/engine-launch.md §9.2）。
   * Claude Code 有这个原因时仍算可用：检测在用户主目录里启动，相对路径的参数在项目目录里可能是对的
   */
  launchError?: string
  /**
   * npm 上的最新版本（宿主定时查，docs/ui/engine-update.md）；没查过、查不到或不支持时没有这个字段。
   * 比 version 新时界面提示「有新版本」
   */
  latestVersion?: string
  /** 已授权的账号，探测时顺便填；拿不到就没有 */
  account?: { email?: string; plan?: string; org?: string }
  /**
   * 引擎靠什么调模型（目前只有 Codex 填）：login 账号授权（ChatGPT），apiKey 用 API Key 登录，
   * provider 自己配置的接口（config.toml 的 model_provider，不需要登录，provider 是它的名字）。
   * 没有这个字段时按账号授权显示
   */
  auth?: { kind: 'login' | 'apiKey' | 'provider'; provider?: string }
  /**
   * 引擎运行时报的配置类警告（目前只有 Codex：config.toml 里不认识的设置项、开了开发中的功能），每类一条原文。
   * 不进对话，显示在设置 › 本机引擎的详情里；重新检测时清空，下一轮还有就再报。没有时没有这个字段
   */
  configWarnings?: string[]
  caps: EngineCaps
}

/** 新会话的默认设置：engine 是默认引擎，其余是这个引擎的默认值（会话里改过的选择也会记到所属引擎名下） */
export interface EngineDefaults extends SessionSettings {
  engine: EngineId
}

/** 每个引擎各自记的新会话默认值（设置 › 本机引擎 › 详情，docs/ui/engine-settings-redesign.md §3.2） */
export type SessionDefaults = Pick<
  SessionSettings,
  'model' | 'effort' | 'permissionMode' | 'ultracode' | 'fast' | 'thinkingSummaries'
>

/**
 * 每个引擎的本机配置（设置 › 本机引擎，docs/ui/plan-search-panes-compact.md §1、§3，engine-settings-redesign.md §3.2）：
 * - path：替换的命令，绝对路径或 PATH 上的命令名，覆盖自动查找（docs/ui/engine-launch.md）
 * - args：每次启动引擎进程时追加的参数；像素星空自己控制的参数不能出现
 * - env：在系统环境之上追加的环境变量（平台会话的网关变量仍然最后覆盖）
 * - compactModel：压缩上下文用的模型；null 表示跟随会话模型。目前只对平台会话生效
 * - defaults：新会话的默认值
 * - outputStyle：输出风格；null 表示跟随引擎自己的设置
 * - askQuestions：允许中途向用户提问（Claude 的 AskUserQuestion）；关掉时禁用这个工具
 * - autoPlan：多步任务自动列计划（Claude：启动时追加一段说明，让它不用点名也建任务清单，进度卡片才出得来；
 *   docs/ui/progress-card.md §10）。默认开
 * - autoCompactPct：上下文用到窗口的这个百分比时自动压缩；null 表示引擎内置阈值
 * - contextWindows：每个模型的上下文窗口，按额度来源分开（GitHub #20，docs/ui/context-settings-branch-switch.md §2）
 * - hidden：不在输入框的引擎菜单里显示（默认引擎不能隐藏）
 * - rememberChoices：会话里改推理强度、Ultracode、Fast、思考摘要时同时记成新会话的默认值（旧版的行为，默认关；GitHub #6）
 * - peerMessages：Claude Code 接收本机其他 Claude Code 会话发来的消息（它自带的跨会话消息，默认关：
 *   收到后会自己开一轮，界面看不到消息原文；docs/ui/import-collab.md 第 5 项④）
 * - peekSessions：让 AI 只读地查看本机其他会话（pixelsky_threads 的 list_threads / read_thread，docs/ui/import-collab.md
 *   第 5 项③）：off 关闭（默认），project 同一个项目里的，all 本机所有的。只对 Claude Code、Codex 生效
 * - subagentModel / subagentEffort：Codex 派出的子智能体用的模型和推理强度（docs/ui/codex-subagent-model.md）；
 *   null 跟随主会话。只对 Codex 生效，经 `agents.default_subagent_model` 传给它，角色自带模型的（explorer）不受影响
 * - inputPrediction：Codex 每轮结束后预测用户下一句，显示成灰字按 Tab 填入（docs/ui/codex-input-prediction.md）。只对 Codex 生效
 *
 * 除 defaults 外，改了对已开始的会话也生效：下一条消息开始前用新设置重启引擎进程并接上原对话。
 */
export interface EngineLocalConfig {
  path: string | null
  args: string[]
  env: Record<string, string>
  compactModel: string | null
  defaults: SessionDefaults
  outputStyle: string | null
  askQuestions: boolean
  autoPlan: boolean
  autoCompactPct: number | null
  contextWindows: ContextWindows
  hidden: boolean
  rememberChoices: boolean
  peerMessages: boolean
  peekSessions: PeekScope
  subagentModel: string | null
  subagentEffort: Effort | null
  inputPrediction: InputPrediction
}

/** Codex 输入预测（docs/ui/codex-input-prediction.md）：off 不预测（默认）；cheap 用便宜的模型；same 用会话的模型 */
export type InputPrediction = 'off' | 'cheap' | 'same'
export const INPUT_PREDICTIONS: readonly InputPrediction[] = ['off', 'cheap', 'same']

/** 「查看本机其他会话」的范围 */
export type PeekScope = 'off' | 'project' | 'all'
export const PEEK_SCOPES: readonly PeekScope[] = ['off', 'project', 'all']

/**
 * 每个模型的上下文窗口（token）：platform 是像素星空云端的模型，self 是本机自己的账号；
 * 自定义 API 的存在接口配置里。没写的模型用引擎自己知道的窗口
 */
export interface ContextWindows {
  platform: Record<string, number>
  self: Record<string, number>
}

/** 上下文窗口的取值范围，和自定义 API 的检查一样 */
export const CONTEXT_WINDOW_MIN = 1000
export const CONTEXT_WINDOW_MAX = 100_000_000

export type EngineConfig = Record<EngineId, EngineLocalConfig>

/** contextWindows 按模型合并：值为 null 时删掉这个模型的设置 */
export type EngineConfigPatch = Partial<Omit<EngineLocalConfig, 'defaults' | 'contextWindows'>> & {
  defaults?: Partial<SessionDefaults>
  contextWindows?: Partial<Record<keyof ContextWindows, Record<string, number | null>>>
}

/** 引擎实际报上来的可选项（目前是输出风格），从引擎的初始化握手里读，读不到为空 */
export interface EngineCatalog {
  currentProvider?: string | null
  rateLimits?: unknown
  models?: EngineModel[]
  currentModel?: string | null
  authType?: string | null
  outputStyles: string[]
  /** 引擎自己的当前输出风格（不加我们的设置时） */
  currentOutputStyle: string | null
}

export interface EngineModel {
  id: string
  label: string
  /** 模型说明（引擎报上来的一句话） */
  description?: string
  /** 别名指向的完整模型 id，例如 opus → claude-opus-5-5 */
  resolved?: string
  efforts: Effort[]
  defaultEffort: Effort | null
  inputModalities: string[]
  isDefault: boolean
  /** 开 Fast 时要用的服务档位（Codex：model/list 的 serviceTiers 里的 priority）；没有就是这个模型不支持 Fast */
  fastTier?: string
  /** model/list 的 serviceTiers 里列了 ultrafast */
  ultrafast?: boolean
}

/** 检查更新的结果 */
/**
 * 正在安装 / 更新引擎（docs/ui/engine-update.md）：拿不到真实百分比，只报阶段和最后一行输出，界面据此显示模拟进度。
 * prepare 还没有输出；download / install 按输出里的关键词猜；verify 跑完后重新检测；done / failed 结束
 */
export interface EngineJob {
  engine: EngineId
  action: 'install' | 'update'
  phase: 'prepare' | 'download' | 'install' | 'verify' | 'done' | 'failed'
  startedAt: number
  /** 引擎输出的最后一行（去掉颜色） */
  line: string | null
  error: string | null
}

/** 引擎授权登录的进度（设置 › 模型通道的授权弹窗，docs/ui/model-channels.md §3） */
export interface EngineLogin {
  engine: EngineId
  /** browser 浏览器登录（默认）；device 设备码（只有 Codex 支持） */
  method: 'browser' | 'device'
  phase: 'starting' | 'waiting' | 'verify' | 'done' | 'failed' | 'cancelled'
  startedAt: number
  /** 输出里认出的授权网址（复制链接 / 重新打开用；CLI 自己会开浏览器） */
  url: string | null
  /** 设备码登录要在网页上输入的一次性码 */
  userCode: string | null
  /** 命令在等用户粘贴授权码（Claude 手动流程） */
  awaitingCode: boolean
  /** 输出的最后一行（去掉颜色） */
  line: string | null
  error: string | null
  /** 登录的是哪个订阅账号（docs/ui/engine-accounts.md）：add 是添加新账号，账号 id 是重新登录那个账号；没有是当前账号 */
  target?: 'add' | string
}

export interface EngineUpdateResult {
  ok: boolean
  /** 引擎输出的最后几行，给用户看 */
  output: string
  /** 更新后重新检测到的版本 */
  version: string | null
}

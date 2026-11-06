// 协作频道的数据类型（docs/ui/channels.md §9，Phase B 的改动见 docs/ui/channels-phase-b.md §10.1）。
// 主进程（main/core/channels/）和渲染层共用；演示数据（mock/channels.ts）只填界面要用的字段。
import type { CheckRun } from './checks'
import type {
  ApprovalRequest,
  CostState,
  EngineId,
  FileAttachment,
  FileChange,
  ImageAttachment,
  Item,
  SearchFragment,
  SessionSettings,
} from '@pixelsky/protocol'

export type ChannelAgentStatus = 'idle' | 'running' | 'waiting' | 'offline'

/** 频道的提醒级别（docs/ui/channels-local-ai.md §3.1 #13） */
export type ChannelNotify = 'all' | 'important' | 'mute'

/** 一步做的事：只留显示要用的字段（和对话里工具行的说法一样） */
export type ChannelStepBody =
  | (Pick<Extract<Item, { kind: 'command' }>, 'kind' | 'command' | 'description'> & {
      /** 非 0 退出的退出码 */
      exitCode?: number
    })
  | { kind: 'file_change'; changes: Array<Pick<FileChange, 'kind' | 'path' | 'added' | 'removed'>> }
  | Pick<Extract<Item, { kind: 'tool' }>, 'kind' | 'tool' | 'name' | 'title'>

/**
 * 任务卡上「正在做什么」的一步（docs/ui/channels-live-activity.md）。
 * at 是主进程第一次看到这一步的时间（条目本身不带时间），endedAt 是第一次看到做完的时间
 */
export type ChannelStep = {
  id: string
  at: number
  running: boolean
  /** 失败或被拒绝 */
  failed?: boolean
  /** 没做完就断了（被打断、断线重连）：不算失败，也不算做完 */
  stopped?: boolean
  endedAt?: number
  /** 子智能体这一步：它最近在做什么（它自己的工具调用不单独算一步） */
  inner?: ChannelStepBody
} & ChannelStepBody

/** 两步之间在等什么：看结果、准备下一步、思考（和对话状态行的 waitingFor 同一套） */
export type ChannelWait = 'result' | 'next' | 'thinking'

/** 进行中的任务在做什么：最近几步（先后顺序）、AI 最近说的一句 */
export interface ChannelActivity {
  steps: ChannelStep[]
  say: { text: string; at: number } | null
  /** 计划当前这一步的文字 */
  plan?: string | null
  /** 两步之间在等什么、从什么时候开始；有步骤在跑时不看它 */
  wait?: { kind: ChannelWait; at: number } | null
}

// ── Phase C：多人团队（docs/ui/channels-phase-c.md §5.3） ──

export type TeamRole = 'owner' | 'member' | 'observer'
/** 团队频道里别人 @ 我的 AI 成员时：approve = 要我同意（默认）；team = 团队成员可直接派活 */
export type AgentPolicy = 'approve' | 'team'

export interface TeamMemberInfo {
  /** owner key（u:123 / e:邮箱），也是团队频道里的成员 id */
  id: string
  role: TeamRole
  online: boolean
  /** 毫秒时间戳 */
  lastSeenAt: number | null
  email?: string
}

export interface TeamInviteInfo {
  id: string
  email: string
  role: Exclude<TeamRole, 'owner'>
  expiresAt: number
}

export interface TeamInfo {
  id: string
  name: string
  /** 我的角色 */
  role: TeamRole
  members: TeamMemberInfo[]
  /** 待接受的邀请；只有所有者能看到 */
  invites: TeamInviteInfo[]
}

/** 别人邀请我（频道页最上面的邀请卡） */
export interface PendingInvite {
  id: string
  teamId: string
  teamName: string
  /** 邀请人的显示名 */
  inviter: string
  role: Exclude<TeamRole, 'owner'>
  expiresAt: number
}

/** signed-out 没登录；unavailable 云端没有团队接口（404）；offline 连不上、正在重试 */
export type TeamsConnection = 'signed-out' | 'unavailable' | 'connecting' | 'online' | 'offline'

export interface HumanMember {
  id: string
  kind: 'human'
  name: string
  /** 当前用户自己 */
  you?: boolean
  role?: TeamRole
  /** Phase C：平台用户（owner key） */
  userId?: string
  /** Phase C：团队成员才有 */
  online?: boolean
  lastSeenAt?: number | null
}

/**
 * AI 成员派活时用的会话设置；没写的用引擎默认值。额度来源（docs/ui/channels-local-ai.md §3.1 #1）：
 * 都不写是自有账号；platform 是像素星空平台（分组 + 账号），provider 是自定义接口，两个不能同时有。
 * effort / fast / ultracode 不写 = 跟随引擎设置里的默认（docs/ui/channels-pipeline.md 第 19 项）
 */
export type AgentSettings = Partial<
  Pick<SessionSettings, 'model' | 'effort' | 'permissionMode' | 'platform' | 'provider' | 'fast' | 'ultracode'>
>

/** AI 成员的配置（全局，可以加进多个频道；docs/ui/channels-phase-b.md §2.2），存在 members.json */
export interface AgentConfig {
  id: string
  name: string
  engine: EngineId
  /** 'local' 或 ssh-…（D055）；和 projectId 的机器前缀一致 */
  machineId: string
  projectId: string
  /** 项目的 Git 副本；null 是主工作树 */
  copyId: string | null
  settings: AgentSettings
  /** 职责说明，每次派活都带上 */
  instructions: string
  /** per-task：每项活新开会话；shared：一直用同一个会话 */
  mode: 'per-task' | 'shared'
  /** mode=shared 时用的会话 */
  sharedSessionId: string | null
  /**
   * 从已有的会话加入频道的成员（docs/ui/import-collab.md 第 5 项②）：sharedSessionId 是你自己开的那个会话，
   * 频道派来的活就在里面接着做；没写是频道自己建的成员
   */
  bound?: boolean
  /**
   * 这个成员能用的扩展（docs/ui/channels-collab-v2.md §5）：没写或 null 是跟随全局（设置 › 扩展里开着的都用）；
   * only 是只用列出的扩展（MCP、技能、插件的 id），没列的这个成员的会话里不挂。频道工具（pixelsky_channel）总是有
   */
  tools?: AgentTools | null
  createdAt: number
}

/** 成员只用这些扩展（id 来自设置 › 扩展里像素星空管理的条目） */
export interface AgentTools {
  mode: 'only'
  ids: string[]
}
/** 只用这些扩展时最多勾这么多个 */
export const AGENT_TOOLS_MAX = 100

export interface AgentMember {
  id: string
  kind: 'agent'
  name: string
  engine: EngineId
  model: string | null
  /** 'local' 或 ssh-…（D055） */
  machineId: string
  /** 机器显示名 */
  machine: string
  /** 项目显示名 */
  project?: string | null
  status: ChannelAgentStatus
  /** 当前任务标题 */
  task?: string | null
  /** 当前任务的会话 */
  sessionId?: string | null
  /** Phase C：AI 成员属于哪个真人（owner key） */
  ownerId?: string
  /** Phase C：团队频道里的 ta_…（和 id 相同） */
  teamAgentId?: string
  /** Phase C：主人的显示名（别人的 AI 成员显示「· 林夏的」） */
  ownerName?: string
  /** Phase C：是我自己的 AI 成员（本机频道里的成员都是） */
  mine?: boolean
  /** Phase C：别人 @ 它时要不要我同意 */
  policy?: AgentPolicy
  // 以下只有真实数据才有（主进程按任务汇总后推过来）
  config?: AgentConfig
  /** 当前任务之外还在排队的活 */
  queued?: number
  /** 成员配置有问题（项目不存在等），派活会直接失败 */
  warning?: string | null
  /** 最近一项结束的活 */
  last?: { status: ChannelTaskStatus; at: number } | null
  /** 最近 30 天 */
  stats?: { total: number; done: number; failed: number }
  /** 和这些成员用同一个工作目录（同时改文件可能冲突） */
  sharesDirWith?: string[]
  /** 从已有会话加入的成员：绑定的会话（标题是会话现在的标题；会话被删了是 null） */
  boundSession?: { id: string; title: string } | null
}

export type ChannelMember = HumanMember | AgentMember

export interface Channel {
  id: string
  name: string
  topic: string | null
  /** 默认项目的显示名 */
  project?: string | null
  /** 默认项目：添加 AI 成员时预选（只有真实数据有） */
  projectId?: string | null
  /** local = 本机 AI 协作；team = 团队频道（Phase C） */
  scope: 'local' | 'team'
  /** 频道说明：每次派活都带上（docs/ui/channels-local-ai.md §3.1 #9；只有本机频道有） */
  notes?: string | null
  /** 置顶的消息 id（先后顺序），派活时作为资料带上 */
  pinned?: string[]
  /** 这个频道的系统提醒（§3.1 #13）：全部 / 只提醒要我处理的（等你确认、失败）/ 不提醒；没写是全部 */
  notify?: ChannelNotify
  /** 归档的时间（§3.1 #11）：收进列表底部「已归档」，只读，可恢复；没归档是 null / 没写 */
  archivedAt?: number | null
  /** 允许 AI 成员互相派活（docs/ui/import-collab.md 第 5 项①，§3.2 #4）：AI 回复里的 @成员 会派活；没写是关 */
  relay?: boolean
  /** 互相派活什么时候停下等你（docs/ui/relay-limits-mockup.html）；没写按「标准」 */
  relayRules?: RelayRules
  /** 牵头成员（docs/ui/channels-pipeline.md §8.3）：不带 @ 的需求交给它拆成流程；null / 没写是不启用 */
  lead?: string | null
  /**
   * 不带 @ 的消息里一件简单的活，牵头直接派给职责最合适的成员（docs/ui/channels-auto-route.md）；
   * false：都拆成流程草稿（原来的做法）。没写按开
   */
  leadRoute?: boolean
  /** @ 一个 AI 派新活时先让它出计划，商量好、点开工才动手；没写按默认（开） */
  planFirst?: boolean
  /** 每天定时运行的流程（§10.3），只有本机频道 */
  schedules?: FlowSchedule[]
  /** 主动提醒的规则开关（docs/ui/channels-collab-v2.md §6）；没写的按默认（shared/channels/alerts.ts） */
  alerts?: Partial<Record<ChannelAlertRule, boolean>>
  /** 每日简报几点发（0–23，默认 9） */
  digestHour?: number
  /** Phase C：团队频道属于哪个团队 */
  teamId?: string
  memberIds: string[]
  unread: number
  /** 未读里有人 @你 */
  mentioned?: boolean
  createdAt: number
  /** 最后一条消息的时间，列表按它排序（只有真实数据有） */
  lastAt?: number
}

/** approval：团队频道里等 AI 成员的主人同意（Phase C §4.2） */
export type ChannelTaskStatus = 'queued' | 'approval' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

interface ChannelMessageBase {
  id: string
  channelId: string
  /** 毫秒时间戳 */
  at: number
}

/** 从消息通道（QQ、微信）发进来的（docs/ui/one-click-connectors.md）：哪个平台、最初那条消息的 id；由它引出的流程和任务都带着 */
export interface ChannelChatOrigin {
  via: 'qq' | 'wechat'
  root: string
}

export interface ChannelTextMessage extends ChannelMessageBase {
  kind: 'message'
  chat?: ChannelChatOrigin
  authorId: string
  text: string
  format: 'plain' | 'markdown'
  replyToId?: string | null
  mentions?: string[]
  /** AI 成员发回的任务结果：对应的任务卡 */
  taskId?: string | null
  /**
   * 讨论串（docs/ui/channels-collab-v2.md §3）：发在哪张任务卡 / 哪条消息的串里；有这个字段的消息不在主时间线显示，
   * 只在串里。任务结果（taskId）仍在主时间线，串里也列出来
   */
  threadId?: string | null
  /** AI 成员用频道工具 task_propose 提议的派活（§1）：要你点「派出去」才派 */
  proposal?: ChannelProposal | null
  /** 主动提醒（docs/ui/channels-collab-v2.md §6）：系统发的，authorId 是 SYSTEM_AUTHOR */
  alert?: ChannelAlert | null
  /** 流程（docs/ui/channels-pipeline.md §4）：这条消息就是流程卡，步骤和状态都在这里 */
  flow?: ChannelFlow | null
  /** 带的图片和文件：消息里只有说明，图片数据和文件全文另存，按需用 channels:attachments 读 */
  attached?: ChannelAttachedMeta
}

/** 流程里一步的类型：干活、审查某一步、汇总 */
export type FlowStepKind = 'work' | 'review' | 'summary'

/** 流程里一步的临时设置（第 20 项）：不写的跟随成员 */
export type FlowStepSettings = Partial<Pick<SessionSettings, 'model' | 'effort' | 'fast' | 'ultracode'>>

/** 一步交付的内容（task_done） */
export interface FlowResult {
  summary: string
  files: string[]
  /** 还没做完、没验证到的（task_done 的 open） */
  open?: string[]
  /** 审查步骤：通过 / 打回 */
  verdict?: 'pass' | 'reject'
  issues?: string[]
}

export interface FlowStep {
  id: string
  title: string
  memberId: string
  /** 这些步骤都交付了才开始 */
  deps: string[]
  kind: FlowStepKind
  /** kind 是 review：审哪一步 */
  target?: string | null
  settings?: FlowStepSettings | null
  /** 开始后对应的任务卡 */
  taskId: string | null
  /** asking：问了别的成员、在等回答；gated：交付了，等你确认（第 12 项） */
  status: 'pending' | 'running' | 'asking' | 'gated' | 'delivered' | 'failed' | 'stopped'
  /** 被审查打回过几次 */
  rejects: number
  result?: FlowResult | null
  /** 交付后先等你确认，再开始依赖它的步骤（第 12 项） */
  gate?: boolean
  /** 这一步用的 Git 副本（第 11 项，并行时才建）；分支名给汇合步骤合并用 */
  copy?: { id: string; branch: string; path: string } | null
  /** 汇合步骤：要合并的分支里，两步以上都改了的文件（steps 是步骤 id），最多 20 个 */
  overlap?: { path: string; steps: string[] }[]
  /** 这一步跑过的轮次（`会话 id:轮次 id`，§10.1），按它从用量记录里算这一步的 token 和花费；流程只有本机成员，不带机器前缀 */
  turns?: string[]
  /** 这一步的用量（主进程按 turns 算好缓存，用量记录变了再刷新） */
  usage?: FlowUsage | null
  /** 这一步用 user_ask 问你、还没回答的问题（status 是 asking） */
  question?: { text: string; at: number } | null
}

/** 一步（或几步加起来）的用量（docs/ui/channels-pipeline.md §10.1）：字段和用量页的 UsageTotals 同名 */
export interface FlowUsage {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 有费用的记录的费用合计（是下限：costKnown 小于 records 时显示「≥」） */
  costUsd: number
  costKnown: number
  /** 其中平台实扣的记录条数 */
  costActual?: number
  records: number
  /** 记下的轮次数；其中一条用量记录都没找到的（还没结束、中断了没记） */
  turns: number
  unrecorded: number
  /** 没有费用的记录各是什么原因 */
  why: Partial<Record<CostState, number>>
}

/** 流程停下的原因：失败、做完没交付、打回到上限、等回答超时、到护栏上限（第 13 项）、汇合前主目录有没提交的改动（第 11 项） */
export type FlowPause = 'failed' | 'no-delivery' | 'reject-limit' | 'ask-timeout' | 'limit' | 'dirty'

/** 流程的护栏（第 13 项）：null 不限 */
export interface FlowLimits {
  rounds: number | null
  minutes: number | null
  /** 已知花费上限（美元，§10.2）；只按有价格的部分算；没写 / null 不限 */
  costUsd?: number | null
}

/** 每天定时运行的流程（docs/ui/channels-pipeline.md §10.3） */
export interface FlowSchedule {
  id: string
  title: string
  /** 每天几点（本地时间，0–23） */
  hour: number
  /** 建定时那一刻的步骤快照 */
  steps: FlowStepInput[]
  /** 无人看着时三项都必须设 */
  limits: { rounds: number; minutes: number; costUsd: number }
  isolate?: boolean
  enabled: boolean
  /** 上次到点处理的时间（跳过、失败也算） */
  lastRunAt: number
  lastFlowMessageId: string | null
  /** 上次没开成的原因；成功时清空 */
  lastError?: string | null
}

/** 存定时时界面传来的（运行时的字段由主进程按 id 保留） */
export type FlowScheduleInput = Pick<FlowSchedule, 'title' | 'hour' | 'steps' | 'limits' | 'enabled'> &
  Partial<Pick<FlowSchedule, 'id' | 'isolate'>>

/** 分工提案的要点：聊出来定下的（by 是谁说的：成员 id 或 SELF_ID）和开工前还要人定的（required 没定完不能开工） */
export interface FlowBrief {
  goal: string
  /** suggested：拟计划的 AI 替你定的（界面标「建议」），by 是它 */
  facts: { k: string; v: string; by: string; suggested?: boolean }[]
  open: { q: string; required: boolean }[]
}

/** 流程（docs/ui/channels-pipeline.md §4）：挂在一条文字消息上 */
export interface ChannelFlow {
  title: string
  /** planning：成员在拆；draft：等你确认 */
  status: 'planning' | 'draft' | 'running' | 'paused' | 'done' | 'stopped'
  /** limit：超的是哪一项 */
  paused?: { reason: FlowPause; stepId: string; limit?: 'rounds' | 'time' | 'cost' } | null
  steps: FlowStep[]
  /** 审查最多打回几次，超了停下 */
  maxRejects: number
  /** 发起这个流程的那条消息带的附件（消息 id）：每一步开工时都带上 */
  attach?: string[]
  /** 拆流程的成员和要求（status 是 planning 时）；auto：牵头成员按你不带 @ 的消息自动拆的（§8.3） */
  planner?: {
    memberId: string
    request: string
    taskId: string | null
    auto?: boolean
    /** 你 @ 它派的活：先出计划（planFirst） */
    mention?: boolean
    /** 牵头自动处理的那条消息（只拆出一步时按它直接派活） */
    sourceId?: string
    /** 拟计划这一轮用的模型、推理强度（在流程卡上换的）；不写跟随成员 */
    settings?: FlowStepSettings | null
    /** 拟计划期间你接着补充的原话（换人拟计划时交给新成员） */
    notes?: { from: string; text: string }[]
  } | null
  /** 拟计划的成员开工前一次问完的问题；answer 是你的回答（都答了才接着出计划） */
  questions?: { q: string; options: string[]; answer?: string }[] | null
  /** 你回答这些问题时在频道里发的那条消息（「1. …」）：界面把之后的计划排在它后面 */
  answersId?: string | null
  /** 成员之间问过的问题（算进接力规则） */
  asks?: { from: string; to: string; at: number }[]
  /** 护栏（第 13 项）；没写 = 不限（第二批之前的流程） */
  limits?: FlowLimits | null
  /** 护栏的计数起点：开始运行或上次继续时的时间和已用轮次 */
  since?: { at: number; rounds: number; cost?: number } | null
  /** 并行步骤用独立的 Git 副本（第 11 项）；没写 = 开 */
  isolate?: boolean
  /** 牵头 / 拆流程的成员交回的要点；草稿期间在频道里接着说会更新 */
  brief?: FlowBrief | null
  /** 提案第几版（拆流程的成员每交回一次加一） */
  rev?: number
}

/** 建 / 改流程草稿时的一步（channels:flow） */
export type FlowStepInput = Pick<FlowStep, 'id' | 'title' | 'memberId' | 'deps' | 'kind'> &
  Partial<Pick<FlowStep, 'target' | 'settings' | 'gate'>>

/** 建 / 改草稿时一起改的流程设置 */
export interface FlowOptions {
  limits?: FlowLimits | null
  isolate?: boolean
}

/** 流程卡上的操作（channels:flow） */
export type FlowAction =
  | ({
      type: 'create'
      title: string
      steps?: FlowStepInput[]
      planner?: { memberId: string; request: string }
    } & FlowOptions)
  | ({ type: 'update'; messageId: string; title?: string; steps?: FlowStepInput[]; brief?: FlowBrief } & FlowOptions)
  | { type: 'start' | 'pause' | 'resume' | 'stop' | 'discard'; messageId: string }
  /** 人工关卡：通过，或打回（note 必填：要改什么） */
  | { type: 'gate'; messageId: string; stepId: string; decision: 'approve' | 'reject'; note?: string }
  /** 回答拟计划的成员一次问完的问题（按顺序，每个都要答） */
  | { type: 'answers'; messageId: string; answers: string[] }
  /** 换拟计划的成员、模型、推理强度：由它重新出计划（开工前） */
  | { type: 'replan'; messageId: string; memberId: string; settings?: FlowStepSettings | null }
  /** 回答一步用 user_ask 问你的问题 */
  | { type: 'answer'; messageId: string; stepId: string; text: string }

/** 系统消息（主动提醒、每日简报）的作者 */
export const SYSTEM_AUTHOR = 'system'

/** 主动提醒的规则（§6）：可能删掉别人的改动、等你回答太久、很久没进展、@ 了没人接、每日简报 */
export type ChannelAlertRule = 'conflict' | 'waiting' | 'stalled' | 'unclaimed' | 'digest'

/** 一条主动提醒：open 还等你处理，done 处理过了（点了按钮或情况已经变了） */
export interface ChannelAlert {
  rule: ChannelAlertRule
  state: 'open' | 'done'
  taskId?: string | null
  /** conflict：被先暂停的那项活 */
  heldTaskId?: string | null
  /** 同一件事只提醒一次：规则 + 任务 + 这个（审批请求 id、轮次等） */
  sig?: string
}

/** 提议的派活：给谁、做什么；open 等你决定，sent 已派出（taskId 是派出的卡），dismissed 不要了 */
export interface ChannelProposal {
  assigneeId: string
  request: string
  state: 'open' | 'sent' | 'dismissed'
  taskId?: string | null
  /** 提议的成员手上那项活带的附件（消息 id）：派出去时一起带上 */
  attach?: string[]
}

/** 消息带的附件说明（本机频道；团队频道不支持） */
export interface ChannelAttachedMeta {
  images: Omit<ImageAttachment, 'dataBase64'>[]
  files: Omit<FileAttachment, 'text' | 'tail'>[]
}

/** 消息带的附件全文 */
export interface ChannelAttachments {
  images: ImageAttachment[]
  files: FileAttachment[]
}

/** 派给 AI 成员的一项活；状态变化时原地更新，不追加新消息 */
export interface ChannelTask extends ChannelMessageBase {
  kind: 'task'
  /** 这项活还带着哪些消息的附件：交活的成员手上的、追加要求带的（run.attach 只管当前这一轮发什么） */
  attach?: string[]
  /** 聊天里派的（消息通道）：要确认的事和结果回到聊天 */
  chat?: ChannelChatOrigin
  authorId: string
  assigneeId: string
  title: string
  status: ChannelTaskStatus
  sessionId?: string | null
  summary?: string | null
  diff?: { added: number; removed: number } | null
  // 以下只有真实数据才有
  /** 派活的那条消息 */
  sourceMessageId?: string
  /** 第几轮，从 1 开始；追加要求、重试时加 1 */
  round?: number
  /** 失败原因（第一行） */
  error?: string | null
  /** stopped 的补充：cancelled = 还没开始就取消了；rejected = 主人没同意；expired = 排队太久过期（Phase C） */
  note?: 'cancelled' | 'rejected' | 'expired' | null
  /** 回复里「需要你决定：」那一行 */
  decision?: string | null
  /** 等你确认的请求（waiting 时）；同时有几项时是第一项 */
  request?: ApprovalRequest | null
  /** 同时等你确认的项数（AI 一次并行调用几个要审批的工具，docs/ui/approval-stack.md） */
  waitingCount?: number
  /** 进行中这一轮的计划进度 */
  progress?: { done: number; total: number } | null
  /** 进行中这一轮「正在做什么」：最近几步和 AI 最近说的一句（只在内存里，不写盘） */
  activity?: ChannelActivity | null
  /** 排队中：同一个成员前面还有几项活 */
  ahead?: number
  /** 机器断开了，重连后继续跟踪 */
  disconnected?: boolean
  /** 这一轮结束的时间 */
  /** 真正开始做的时间（不含排队，§8.2）；旧卡片没有 */
  startedAt?: number | null
  endedAt?: number | null
  /** Phase C：AI 成员的主人（owner key）；只有主人能同意、回答、打开会话 */
  ownerId?: string
  /** Phase C：派活的人或主人点了取消 / 停止 / 重试，等主人那台电脑执行 */
  pendingAction?: Exclude<ChannelTaskAction, 'continue' | 'unlimit' | 'fix' | 'reassign'> | null
  /** Phase C：主人的电脑不在线（queued 时显示「上线后开始」） */
  ownerOffline?: boolean
  /** 牵头按职责分派的（docs/ui/channels-auto-route.md）：谁分的、一句为什么；moved：你改派过 */
  routedBy?: { memberId: string; note: string; moved?: boolean } | null
  /** AI 成员互相派活的一跳（authorId 是交活的成员）；held：超了防刷规则，停下等你点「继续」 */
  relay?: ChannelRelay | null
  /** 做完后的产出检查（docs/ui/channels-collab-v2.md §8）：running 时还在跑；项目关了频道检查时没有 */
  checks?: CheckRun | null
  /** 从任务看板的事项派出来的（docs/ui/channels-collab-v2.md §9）：卡片上显示「事项：标题」，状态写回事项 */
  issue?: { id: string; title: string } | null
  /** 流程里的一步（docs/ui/channels-pipeline.md §4）：流程卡消息 id、步骤 id；拆流程的活 stepId 是空串 */
  flow?: { messageId: string; stepId: string } | null
}

/** 把事项交给频道成员（channels:dispatchIssue） */
export interface IssueDispatch {
  /** 事项 id（远端机器上的带机器前缀） */
  id: string
  title: string
  note: string
  memberId: string
  acceptance: string[]
}

/**
 * AI 互相派活（docs/ui/import-collab.md 第 5 项①）：chain 是这条接力最早那张卡的 id，hop 从 1 数；
 * held = hops：这条链从你上次发言 / 点「继续」以来接满了规定的跳数；pair：同一对成员规定时间内互派满了次数；
 * duration：这条链从开始（或上次放行）以来运行满了规定时间。limit 是停下时的那个上限（跳数 / 次数 / 分钟），界面照着写
 */
export interface ChannelRelay {
  chain: string
  hop: number
  /** chat：这条链是聊天里派的，接手的成员不是询问模式（不会回聊天里问你），放行只能在电脑上 */
  held?: 'hops' | 'pair' | 'duration' | 'chat' | null
  limit?: number
}

/**
 * 频道的接力规则（docs/ui/relay-limits-mockup.html）：到哪个上限就停下等你。null 是不限。
 * hops：一条接力最多几跳；pair：同一对成员 windowMinutes 分钟内最多互派几次；maxMinutes：一条接力最长运行几分钟；
 * notify：停下时 @你（按频道的提醒设置发系统通知）
 */
export interface RelayRules {
  hops: number | null
  pair: number | null
  windowMinutes: number
  maxMinutes: number | null
  notify: boolean
}

export type RelayPreset = 'careful' | 'standard' | 'long'

/** 谨慎是原来写死的规则；新建和原来的频道都按「标准」；长期任务不限次数、最长 4 小时 */
export const RELAY_PRESETS: Readonly<Record<RelayPreset, RelayRules>> = {
  careful: { hops: 6, pair: 4, windowMinutes: 10, maxMinutes: null, notify: true },
  standard: { hops: 20, pair: 6, windowMinutes: 10, maxMinutes: null, notify: true },
  long: { hops: null, pair: null, windowMinutes: 10, maxMinutes: 240, notify: true },
}
export const DEFAULT_RELAY_RULES: RelayRules = RELAY_PRESETS.standard
/** 可选的互派计数时间窗口、最长运行（分钟） */
export const RELAY_WINDOWS = [10, 30, 60] as const
export const RELAY_DURATIONS = [30, 60, 240, 480, 1440] as const
export const RELAY_HOPS_MAX = 200
export const RELAY_PAIR_MAX = 100

/** 频道生效的接力规则 */
export function relayRulesOf(channel: { relayRules?: RelayRules | null }): RelayRules {
  return channel.relayRules ?? DEFAULT_RELAY_RULES
}

/** 规则正好是哪个预设（不看 notify）；都不是为 null（自定义） */
export function relayPresetOf(rules: RelayRules): RelayPreset | null {
  const same = (a: RelayRules, b: RelayRules) =>
    a.hops === b.hops &&
    a.pair === b.pair &&
    a.maxMinutes === b.maxMinutes &&
    (a.pair === null || a.windowMinutes === b.windowMinutes)
  return (Object.keys(RELAY_PRESETS) as RelayPreset[]).find(p => same(rules, RELAY_PRESETS[p])) ?? null
}

/** 检查并整理界面 / IPC 传来的规则；不对时抛中文错误 */
export function cleanRelayRules(raw: unknown): RelayRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const count = (v: unknown, max: number, label: string): number | null => {
    if (v === null) return null
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max)
      throw new Error(`${label}要在 1～${max} 之间`)
    return v
  }
  const windowMinutes = r.windowMinutes
  if (!RELAY_WINDOWS.includes(windowMinutes as never)) throw new Error('互派次数的时间窗口不对')
  const maxMinutes = r.maxMinutes
  if (maxMinutes !== null && !RELAY_DURATIONS.includes(maxMinutes as never)) throw new Error('最长运行时间不对')
  if (typeof r.notify !== 'boolean') throw new Error('到上限时的提醒设置不对')
  return {
    hops: count(r.hops, RELAY_HOPS_MAX, '跳数'),
    pair: count(r.pair, RELAY_PAIR_MAX, '互派次数'),
    windowMinutes: windowMinutes as number,
    maxMinutes: maxMinutes as number | null,
    notify: r.notify,
  }
}

export interface ChannelEvent extends ChannelMessageBase {
  kind: 'event'
  event:
    | 'joined'
    | 'added'
    | 'removed'
    | 'renamed'
    | 'topic'
    | 'left'
    | 'agentAdded'
    | 'agentRemoved'
    | 'archived'
    | 'restored'
  actorId: string
  targetId?: string | null
  value?: string | null
}

export type ChannelMessage = ChannelTextMessage | ChannelTask | ChannelEvent

/** 频道消息搜索的一条结果（docs/ui/channels-local-ai.md §3.1 #8）：本机频道的文字消息和任务卡标题 */
export interface ChannelSearchHit {
  channelId: string
  messageId: string
  kind: 'message' | 'task'
  /** 发消息的人；任务卡是接活的成员 */
  authorId: string
  at: number
  snippet: SearchFragment[]
}

export interface ChannelSearchResult {
  /** 新的在前 */
  hits: ChannelSearchHit[]
  /** 命中的比 hits 多（只给最近的这些） */
  truncated: boolean
}

/** 主进程推给渲染层的频道状态（channels:state / channels:changed） */
export interface ChannelsSnapshot {
  self: HumanMember
  channels: Channel[]
  /** 自己 + 所有 AI 成员（包括不在任何频道里的） */
  members: ChannelMember[]
  /** 频道开出来的会话 → 频道名（侧栏、看板上显示 `# 频道名`） */
  sessionChannels: Record<string, string>
  /**
   * 本机频道开出来的会话 → 最近一张任务卡（docs/ui/channels-local-ai.md §3.1 #12）：
   * 这些会话的系统提醒按频道的说法写，点开回到频道定位到卡片
   */
  sessionTasks?: Record<string, { channelId: string; taskId: string; memberId: string }>
  /** 加入了频道的会话（docs/ui/import-collab.md 第 5 项②）→ 在哪些频道里、是哪个成员（会话菜单「退出频道」、标题旁的 # 频道） */
  sessionBindings?: Record<string, { channelId: string; memberId: string }[]>
  /** 「需要你」（docs/ui/channels-collab-v2.md §2）：本机频道里等你处理的事，新的在前 */
  needs?: ChannelNeed[]
  /** 标为已处理、状态还没变的（「已处理 N 件」里能恢复），新的在前 */
  needsDone?: ChannelNeed[]
  /** 「需要你 › 跟进中」：还在排队或运行的活，新的在前 */
  following?: ChannelFollow[]
  // ── Phase C ──
  teams: TeamInfo[]
  invites: PendingInvite[]
  teamsConnection: TeamsConnection
  /** 上次和云端同步成功的时间 */
  teamsSyncedAt: number | null
}

/**
 * 等你处理的一件事（docs/ui/channels-collab-v2.md §2）。key 认这件事（稍后处理按它记），sig 是它现在的状态：
 * 状态变了（新的审批请求、又失败了一次）稍后处理就不算数，马上重新出现
 */
export interface ChannelNeed {
  key: string
  kind: 'approval' | 'proposal' | 'held' | 'decision' | 'checks' | 'failed' | 'alert' | 'flow'
  /** kind 是 flow 时：草稿等你确认（null）、停下的原因，gate（一步交付了等你确认，第 12 项），或 ask（一步在问你） */
  pause?: FlowPause | 'gate' | 'ask' | null
  /** kind 是 flow、pause 是 gate 时：等你确认的那一步 */
  stepId?: string | null
  /** pause 是 limit 时：超的是哪一项 */
  limit?: 'rounds' | 'time' | 'cost' | null
  /** kind 是 alert 时：哪条规则（决定有哪些按钮） */
  rule?: ChannelAlertRule
  sig: string
  channelId: string
  at: number
  /** 哪个 AI 成员（提议是提议给谁） */
  memberId: string | null
  taskId?: string | null
  messageId?: string | null
  sessionId?: string | null
  /** 一句话：任务标题、提议的要求、提醒的内容 */
  text: string
  /** 补充：要你决定的事、失败原因、停下的原因、检查没过的项 */
  detail?: string | null
  /** 等你确认的请求（能就地允许 / 拒绝的直接处理） */
  request?: ApprovalRequest | null
  /** kind 是 checks 时：文本检查发现了几处 */
  findings?: number
  /** 找不到目标（§2.1）：会话不在了、成员删了、提醒对应的任务卡不在了；这类折叠成一组，不算侧栏数字 */
  gone?: NeedGone | null
}

export type NeedGone = 'session' | 'member' | 'task'

/** 标为已处理 / 恢复的一件事（channels:markNeeds） */
export interface NeedMark {
  channelId: string
  key: string
  sig: string
}

/** 跟进中的一项活 */
export interface ChannelFollow {
  channelId: string
  taskId: string
  memberId: string
  title: string
  status: ChannelTaskStatus
  at: number
  sessionId: string | null
}

/** channels:message 推送：新消息或任务卡更新 */
export interface ChannelMessagePush {
  channelId: string
  message: ChannelMessage
}

export interface ChannelInput {
  name: string
  topic?: string | null
  projectId?: string | null
  /** 新建时加进来的已有 AI 成员 */
  memberIds?: string[]
  /** Phase C：建在哪个团队里；不写是本机频道 */
  teamId?: string | null
}

/** 把已有的会话加入频道（docs/ui/import-collab.md 第 5 项②）：channelId 不写时新建一个叫 channelName 的频道 */
export interface JoinSessionInput {
  sessionId: string
  channelId?: string | null
  channelName?: string
  /** 成员名字（频道里 @ 它用） */
  name: string
  /** 职责说明，派活时带上 */
  instructions?: string
}

/** machineId 由主进程按 projectId 推出来 */
export type AgentInput = Omit<AgentConfig, 'id' | 'createdAt' | 'sharedSessionId' | 'machineId'> & { id?: string }

export interface PostInput {
  text: string
  replyToId?: string | null
  /** 发在这张任务卡 / 这条消息的讨论串里：串里 @ 同一个成员 = 追加要求，不 @ 只是留言 */
  threadId?: string | null
  /** 防止重复发送 */
  clientId: string
  /** 图片和文本文件（只有本机频道支持） */
  attachments?: ImageAttachment[]
  files?: FileAttachment[]
}

/** continue：放行被防刷规则拦下的那一跳 */
/** continue：放行被拦下的接力（计数重新算）；unlimit：放行并且这条接力以后不再拦；fix：把产出检查没过的部分发回去让它修 */
/** reassign：改派给另一个成员（第三个参数是成员 id），只有本机频道 */
export type ChannelTaskAction = 'cancel' | 'stop' | 'retry' | 'continue' | 'unlimit' | 'fix' | 'reassign'

/** 成员面板排队控制（docs/ui/channels-local-ai.md #5）：上移 / 下移 / 先做这个 */
export type ChannelQueueAction = 'up' | 'down' | 'first'

// 协作频道的数据类型（docs/ui/channels.md §9，Phase B 的改动见 docs/ui/channels-phase-b.md §10.1）。
// 主进程（main/core/channels/）和渲染层共用；演示数据（mock/channels.ts）只填界面要用的字段。
import type {
  ApprovalRequest,
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

/**
 * 任务卡上「正在做什么」的一步（docs/ui/channels-local-ai.md §3.1 #2）：只留显示要用的字段（和对话里工具行的说法一样），
 * at 是主进程第一次看到这一步的时间（条目本身不带时间）
 */
export type ChannelStep = { id: string; at: number; running: boolean } & (
  | Pick<Extract<Item, { kind: 'command' }>, 'kind' | 'command' | 'description'>
  | { kind: 'file_change'; changes: Array<Pick<FileChange, 'kind' | 'path'>> }
  | Pick<Extract<Item, { kind: 'tool' }>, 'kind' | 'tool' | 'name' | 'title'>
)

/** 进行中的任务在做什么：最近几步（先后顺序）、AI 最近说的一句 */
export interface ChannelActivity {
  steps: ChannelStep[]
  say: { text: string; at: number } | null
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
 * 都不写是自有账号；platform 是像素星空平台（分组 + 账号），provider 是自定义接口，两个不能同时有
 */
export type AgentSettings = Partial<
  Pick<SessionSettings, 'model' | 'effort' | 'permissionMode' | 'platform' | 'provider'>
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
  createdAt: number
}

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

export interface ChannelTextMessage extends ChannelMessageBase {
  kind: 'message'
  authorId: string
  text: string
  format: 'plain' | 'markdown'
  replyToId?: string | null
  mentions?: string[]
  /** AI 成员发回的任务结果：对应的任务卡 */
  taskId?: string | null
  /** 带的图片和文件：消息里只有说明，图片数据和文件全文另存，按需用 channels:attachments 读 */
  attached?: ChannelAttachedMeta
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
  endedAt?: number | null
  /** Phase C：AI 成员的主人（owner key）；只有主人能同意、回答、打开会话 */
  ownerId?: string
  /** Phase C：派活的人或主人点了取消 / 停止 / 重试，等主人那台电脑执行 */
  pendingAction?: ChannelTaskAction | null
  /** Phase C：主人的电脑不在线（queued 时显示「上线后开始」） */
  ownerOffline?: boolean
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
  // ── Phase C ──
  teams: TeamInfo[]
  invites: PendingInvite[]
  teamsConnection: TeamsConnection
  /** 上次和云端同步成功的时间 */
  teamsSyncedAt: number | null
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

/** machineId 由主进程按 projectId 推出来 */
export type AgentInput = Omit<AgentConfig, 'id' | 'createdAt' | 'sharedSessionId' | 'machineId'> & { id?: string }

export interface PostInput {
  text: string
  replyToId?: string | null
  /** 防止重复发送 */
  clientId: string
  /** 图片和文本文件（只有本机频道支持） */
  attachments?: ImageAttachment[]
  files?: FileAttachment[]
}

export type ChannelTaskAction = 'cancel' | 'stop' | 'retry'

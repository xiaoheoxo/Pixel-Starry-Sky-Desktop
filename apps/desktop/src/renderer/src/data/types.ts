// 界面数据的类型。组件只依赖这里的类型和 data/index.ts 导出的值。
import type {
  Channel,
  ChannelMember,
  ChannelMessage,
  PendingInvite,
  TeamInboxItem,
  TeamInfo,
  TeamsConnection,
} from '../../../shared/types/channels'

export type SessionStatus = 'idle' | 'running' | 'unread'

export interface Session {
  bottomedAt?: number | null
  /** 置顶：显示在侧栏最上面的「置顶」分组，不再列在项目下面 */
  pinnedAt?: number | null
  archivedAt?: number | null
  id: string
  title: string
  status: SessionStatus
  /** 右侧时间，例如「刚刚」「3天」 */
  time?: string
  /** 开分支开出的会话（docs/ui/branch-merge.md §4）：挂在上级下面第几层、标签 */
  branch?: { depth: number; tag: 'copy' | 'shared' | 'merged' }
}

export interface Project {
  id: string
  name: string
  /** 主文件夹（演示数据没有） */
  path?: string
  /** 多文件夹项目的附加文件夹（docs/ui/multi-root-projects.md §3） */
  folders?: { path: string; name?: string }[]
  branch?: string
  running?: boolean
  expanded?: boolean
  sessions: Session[]
  archived?: Session[]
}

export interface PinnedItem {
  id: string
  /** 置顶的会话来自会话记录（useSidebarData 的 pinned），这里只剩任务看板这类固定入口 */
  kind: 'board' | 'session'
  title: string
  /** 标题后面的灰色说明，例如「7 项进行中」 */
  meta?: string
  /** 右侧文字，例如「3 等你」 */
  trailing?: string
  unread?: boolean
}

export interface RecentItem {
  bottomedAt?: number | null
  pinnedAt?: number | null
  id: string
  title: string
  project?: string
  /** 所属项目；判断最近任务是否跨项目用（演示数据没有时按项目名） */
  projectId?: string
  time: string
  /** 右侧绿色 PR 图标 */
  hasPr?: boolean
}

export type ToolCall =
  | { kind: 'edit'; path: string; added: number; removed: number }
  | { kind: 'run'; command: string; ok: boolean; duration: string }

export interface ChangedFile {
  dir: string
  name: string
  added: number
  removed: number
  newText?: string
  /** 这一轮新建的文件（第一次改动是新建）：撤回就是删掉它 */
  created?: boolean
  /** 这一轮对这个文件的各次 diff（按顺序，空的不收）；没有时点文件直接打开编辑器（docs/ui/changes-inline-diff.md） */
  diffs?: string[]
}

export interface ChangedFiles {
  added: number
  removed: number
  files: ChangedFile[]
  /** 有子智能体改的文件时按来源分组（主智能体在前），合计和 files 按路径合并（docs/ui/subagent-changes.md §2.2） */
  groups?: ChangedFileGroup[]
}

export interface ChangedFileGroup {
  key: string
  /** 子智能体的名字；主智能体为 null */
  label: string | null
  added: number
  removed: number
  files: ChangedFile[]
}

export interface AssistantReply {
  intro: string
  bullets: Array<{ text: string; bold?: string; after?: string }>
  outro: string
}

export interface Attachment {
  id: string
  kind: 'browser' | 'screenshot' | 'file' | 'mode'
  label: string
}

/** 一整套界面数据。empty.ts 是新用户的空界面，demo.ts 是照参考图写的演示数据 */
export interface AppData {
  pinned: PinnedItem[]
  projects: Project[]
  recent: RecentItem[]
  /** 默认选中的会话，null 表示新会话（显示欢迎页） */
  defaultSessionId: string | null
  /** 会话顶部的改动统计，null 时不显示 */
  sessionDiff: { added: number; removed: number } | null
  toolCalls: ToolCall[]
  assistantReply: AssistantReply | null
  changedFiles: ChangedFiles | null
  /** 演示对话这一轮的用量（回复下方统计行，docs/ui/usage.md §4）；null 时不显示 */
  turnUsage: import('@pixelsky/protocol').TurnUsage | null
  attachments: Attachment[]
  composer: { placeholder: string; engine: { short: string; name: string }; effort: string }
  /** 输入框下方状态栏；branch / contextPercent 为 null 时不显示对应项 */
  composerStatus: { machine: string; branch: string | null; contextPercent: number | null }
  /** 启动时右侧面板是否打开 */
  defaultPanelOpen: boolean
  /** 协作频道（docs/ui/channels.md §9）；空界面没有频道 */
  channels: Channel[]
  channelMembers: ChannelMember[]
  /** 频道 id → 按时间排列的消息 */
  channelMessages: Record<string, ChannelMessage[]>
  /** 团队（Phase C，docs/ui/channels-phase-c.md §9.3）：空界面没有团队，也不显示团队入口 */
  channelTeams: {
    teams: TeamInfo[]
    invites: PendingInvite[]
    connection: TeamsConnection
    /** 收件箱（docs/multica-learn.md §11.5）；没有时不显示「通知」标签 */
    inbox?: TeamInboxItem[]
  }
}

// 协作频道（docs/ui/channels.md §9）：类型和主进程共用
export type {
  AgentMember,
  Channel,
  ChannelAgentStatus,
  ChannelEvent,
  ChannelMember,
  ChannelMessage,
  ChannelTask,
  ChannelTaskStatus,
  ChannelTextMessage,
  HumanMember,
} from '../../../shared/types/channels'

/** 设置 › 本机引擎用到的引擎信息（真实数据是 EngineInfo，演示数据只填这些） */
export type EngineLite = Pick<
  import('@pixelsky/protocol').EngineInfo,
  | 'id'
  | 'name'
  | 'status'
  | 'version'
  | 'message'
  | 'path'
  | 'launch'
  | 'launchError'
  | 'latestVersion'
  | 'installable'
  | 'account'
  | 'auth'
  | 'configWarnings'
> & {
  caps: Pick<
    import('@pixelsky/protocol').EngineCaps,
    | 'permissionModes'
    | 'efforts'
    | 'ultracode'
    | 'fast'
    | 'thinkingSummaries'
    | 'selfUpdate'
    | 'launchSettings'
    | 'pluginCommands'
    | 'platformSwitch'
  >
}

/** 演示模式下对会话的改动（归档、删除、停止、改名、置底、置顶），只在内存里 */
export interface DemoSessionChange {
  archivedAt: number | null
  deleted: boolean
  stopped: boolean
  title?: string
  bottomedAt?: number | null
  pinnedAt?: number | null
}

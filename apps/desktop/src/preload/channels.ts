import type {
  AgentInput,
  ChannelAttachments,
  ChannelInput,
  ChannelNotify,
  ChannelMessage,
  ChannelMessagePush,
  ChannelsSnapshot,
  ChannelSearchResult,
  AgentPolicy,
  JoinSessionInput,
  ChannelTaskAction,
  ChannelQueueAction,
  NeedMark,
  FlowAction,
  ChannelTextMessage,
  PostInput,
  RelayRules,
  ChannelAlertRule,
  TeamRole,
} from '../shared/types/channels'
import type { ChannelAlertAction } from '../shared/channels/alerts'
import type { FlowScheduleInput, IssueDispatch } from '../shared/types/channels'

/** 协作频道 Phase B（docs/ui/channels-phase-b.md §11） */
export interface ChannelsBridge {
  state(): Promise<ChannelsSnapshot>
  /** 一页消息（最多 200 条）；before 是毫秒时间戳，取这之前的 */
  /** before / beforeId：界面里最早那条消息的时间和 id，取它前面的一页（按 id 定位，同一毫秒跨页不漏） */
  messages(
    channelId: string,
    before?: number | null,
    beforeId?: string | null,
  ): Promise<{ messages: ChannelMessage[]; more: boolean }>
  create(input: ChannelInput): Promise<string>
  update(
    id: string,
    patch: {
      name?: string
      topic?: string | null
      notes?: string | null
      notify?: ChannelNotify
      projectId?: string | null
      /** 归档 / 恢复（docs/ui/channels-local-ai.md §3.1 #11） */
      archived?: boolean
      /** 允许 AI 成员互相派活（docs/ui/import-collab.md 第 5 项①） */
      relay?: boolean
      /** 互相派活的停下规则（docs/ui/relay-limits-mockup.html） */
      relayRules?: RelayRules
      /** 牵头成员（docs/ui/channels-pipeline.md §8.3）：null 不启用 */
      lead?: string | null
      /** @ 一个 AI 派新活时先出计划 */
      planFirst?: boolean
      /** 每天定时运行的流程（docs/ui/channels-pipeline.md §10.3）：整个列表一起存 */
      schedules?: FlowScheduleInput[]
      /** 主动提醒的规则开关、每日简报几点发（docs/ui/channels-collab-v2.md §6） */
      alerts?: Partial<Record<ChannelAlertRule, boolean>>
      digestHour?: number
      /** 审查打回上限、多久没进展提醒（docs/ui/channels-local-rest.md §3.3 d） */
      maxRejects?: number
      stalledMinutes?: number
    },
  ): Promise<void>
  /** 置顶 / 取消置顶一条文字消息（docs/ui/channels-local-ai.md §3.1 #9） */
  pin(channelId: string, messageId: string, pinned: boolean): Promise<void>
  /** AI 成员提议的派活：派出去（返回任务卡 id）或不要（docs/ui/channels-collab-v2.md §1） */
  proposal(channelId: string, messageId: string, accept: boolean): Promise<string | null>
  /** 主动提醒上的按钮（docs/ui/channels-collab-v2.md §6）；换人时返回要放进输入框的草稿 */
  alert(channelId: string, messageId: string, action: ChannelAlertAction): Promise<{ draft?: string }>
  /** 「需要你」里标为已处理（done）/ 恢复（docs/ui/channels-collab-v2.md §2.1） */
  markNeeds(items: NeedMark[], done: boolean): Promise<void>
  /** 流程卡：建草稿 / 改草稿 / 开始 / 暂停 / 继续 / 停止 / 丢弃（docs/ui/channels-pipeline.md §4）；建的时候返回流程卡消息 id */
  flow(channelId: string, action: FlowAction): Promise<{ messageId: string }>
  /** 把任务看板的事项交给频道成员（docs/ui/channels-collab-v2.md §9）：返回派出的任务卡 id */
  dispatchIssue(channelId: string, issue: IssueDispatch): Promise<{ taskId: string }>
  /** 搜频道消息（§3.1 #8）：新的在前；projectId 只搜默认项目是它的频道 */
  search(text: string, opts?: { limit?: number; projectId?: string | null }): Promise<ChannelSearchResult>
  delete(id: string): Promise<void>
  post(channelId: string, input: PostInput): Promise<{ message: ChannelTextMessage; tasks: string[] }>
  /** 一条消息带的图片和文件全文；没有时两个空数组 */
  attachments(channelId: string, messageId: string): Promise<ChannelAttachments>
  markRead(channelId: string): Promise<void>
  /** 新建或编辑 AI 成员；带 channelId 时顺便加进这个频道。返回成员 id */
  saveMember(channelId: string | null, input: AgentInput): Promise<string>
  addMember(channelId: string, memberId: string): Promise<void>
  removeMember(channelId: string, memberId: string): Promise<void>
  deleteMember(memberId: string): Promise<void>
  /** 把已有会话加入频道（docs/ui/import-collab.md 第 5 项②）；不写 channelId 时新建频道 */
  joinSession(input: JoinSessionInput): Promise<{ channelId: string; memberId: string }>
  /** 会话退出频道（绑着它的成员不在任何频道里了就删掉，会话不动） */
  leaveSession(sessionId: string, channelId: string): Promise<void>
  /** memberId：reassign 时改派给谁 */
  task(taskId: string, action: ChannelTaskAction, memberId?: string): Promise<void>
  /** 排队控制（docs/ui/channels-local-ai.md #5）：上移 / 下移 / 先做这个 */
  queueControl(taskId: string, action: ChannelQueueAction): Promise<void>
  // ── Phase C：多人团队（docs/ui/channels-phase-c.md §9.2） ──
  /** 等主人同意的活（approval）：同意 / 拒绝 */
  approveTask(taskId: string, approve: boolean): Promise<void>
  /** 团队频道里我的 AI 成员：别人 @ 它要不要我同意 */
  setAgentPolicy(channelId: string, memberId: string, policy: AgentPolicy): Promise<void>
  /** 新建团队，返回团队 id */
  createTeam(name: string): Promise<string>
  updateTeam(teamId: string, patch: { name: string }): Promise<void>
  deleteTeam(teamId: string): Promise<void>
  /** 改我在这个团队的显示名 */
  setDisplayName(teamId: string, name: string): Promise<void>
  invite(teamId: string, email: string, role: Exclude<TeamRole, 'owner'>): Promise<void>
  revokeInvite(teamId: string, inviteId: string): Promise<void>
  /** 接受 / 拒绝别人给我的邀请 */
  respondInvite(inviteId: string, accept: boolean): Promise<void>
  setRole(teamId: string, userId: string, role: Exclude<TeamRole, 'owner'>): Promise<void>
  /** 移出成员；userId 是自己就是退出团队 */
  removeTeamMember(teamId: string, userId: string): Promise<void>
  /** 马上重连、重拉团队数据 */
  refreshTeams(): Promise<void>
  onChange(callback: (state: ChannelsSnapshot) => void): () => void
  onMessage(callback: (push: ChannelMessagePush) => void): () => void
}

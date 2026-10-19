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
  ChannelTaskAction,
  ChannelTextMessage,
  PostInput,
  TeamRole,
} from '../shared/types/channels'

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
    },
  ): Promise<void>
  /** 置顶 / 取消置顶一条文字消息（docs/ui/channels-local-ai.md §3.1 #9） */
  pin(channelId: string, messageId: string, pinned: boolean): Promise<void>
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
  task(taskId: string, action: ChannelTaskAction): Promise<void>
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

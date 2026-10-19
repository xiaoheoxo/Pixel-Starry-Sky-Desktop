// 协作频道的界面状态（docs/ui/channels.md §1.1；Phase B 见 docs/ui/channels-phase-b.md §11）。
// 演示模式：内存数据，来自 mock/channels.ts，AI 成员不会回复。
// 正式模式：数据都在主进程（main/core/channels/），这里订阅 channels:changed / channels:message，
// 进入频道时按页读消息，发消息、建频道、加成员都走 window.pixelsky.channels。
import { useSyncExternalStore } from 'react'
import { channelMembers, channelMessages, channels, channelTeams, isDemo } from '@/data'
import type { Channel, ChannelMember, ChannelMessage, ChannelTask, ChannelTextMessage } from '@/data/types'
import type {
  AgentInput,
  AgentPolicy,
  ChannelAttachments,
  ChannelInput,
  ChannelNotify,
  ChannelsSnapshot,
  ChannelTaskAction,
  PendingInvite,
  TeamInfo,
  TeamRole,
  TeamsConnection,
} from '../../../../shared/types/channels'
import { getPage, subscribePage } from '@/features/layout/page'
import { appendMessage, createMessage, firstUnreadAt, markRead, unreadTotal } from './model'

/** 正式模式的桥接；演示模式和没有 preload 时为 undefined */
export const channelsBridge = isDemo ? undefined : window.pixelsky?.channels
export const channelsLive = !!channelsBridge
/** 演示模式发的消息带的附件 */
const demoAttachments = new Map<string, ChannelAttachments>()

export interface ChannelsState {
  /** 正式模式已经从主进程拿到频道列表 */
  ready: boolean
  channels: Channel[]
  members: ChannelMember[]
  messages: Record<string, ChannelMessage[]>
  /** 频道 id → 前面还有更早的消息（正式模式分页） */
  more: Record<string, boolean>
  /** 当前频道；null 时取第一个 */
  selectedId: string | null
  /** 频道 id → 正在回复的消息 id */
  replyTo: Record<string, string | null>
  /** 频道 id → 进入时「新消息」分隔线的位置 */
  newFrom: Record<string, number | null>
  /** 频道开出来的会话 → 频道名 */
  sessionChannels: Record<string, string>
  /** 本机频道开出来的会话 → 最近一张任务卡（系统提醒按频道的说法写） */
  sessionTasks: NonNullable<ChannelsSnapshot['sessionTasks']>
  // ── Phase C：多人团队（docs/ui/channels-phase-c.md） ──
  teams: TeamInfo[]
  /** 别人邀请我（频道列表最上面的邀请卡） */
  invites: PendingInvite[]
  /** unavailable = 云端没有团队接口，不显示任何团队入口 */
  teamsConnection: TeamsConnection
  teamsSyncedAt: number | null
  /** 要时间线跳到并高亮的消息（置顶列表、提醒点进来）；时间线处理完清掉 */
  focus: { channelId: string; messageId: string } | null
}

let state: ChannelsState = {
  ready: !channelsLive,
  channels: channelsLive ? [] : channels,
  members: channelsLive ? [] : channelMembers,
  messages: channelsLive ? {} : channelMessages,
  more: {},
  selectedId: null,
  replyTo: {},
  newFrom: {},
  sessionChannels: {},
  sessionTasks: {},
  teams: channelsLive ? [] : channelTeams.teams,
  invites: channelsLive ? [] : channelTeams.invites,
  teamsConnection: channelsLive ? 'unavailable' : channelTeams.connection,
  teamsSyncedAt: channelsLive ? null : Date.now(),
  focus: null,
}
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function set(next: Partial<ChannelsState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}
export const getChannels = (): ChannelsState => state

/** selector 必须返回 state 里已有的引用（或原始值），派生数据在组件里用 useMemo 算 */
export function useChannels<T>(selector: (s: ChannelsState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state))
}

export function useChannelUnreadTotal(): number {
  return useSyncExternalStore(subscribe, () => unreadTotal(state.channels))
}

/** 会话是哪个频道开出来的（侧栏、看板显示 `# 频道名`） */
export function useSessionChannel(sessionId: string): string | null {
  return useSyncExternalStore(subscribe, () => state.sessionChannels[sessionId] ?? null)
}

/** 当前频道：选中的不存在时退回第一个 */
export function selectedChannel(s: ChannelsState): Channel | null {
  return s.channels.find(c => c.id === s.selectedId) ?? s.channels.find(c => !c.archivedAt) ?? s.channels[0] ?? null
}

export const selfMember = (s: ChannelsState): ChannelMember | null =>
  s.members.find(m => m.kind === 'human' && m.you) ?? null

/** 我在这个频道 / 团队里的成员 id：团队里是账号的 owner key（u:… / e:…），本机频道里是 you（演示数据两边相同） */
export const selfIdIn = (s: ChannelsState, ids: readonly string[] | null | undefined): string | null =>
  s.members.find(m => m.kind === 'human' && m.you && !!ids?.includes(m.id))?.id ?? selfMember(s)?.id ?? null

// ---------------------------------------------------------------------------
// 正式模式：和主进程同步
// ---------------------------------------------------------------------------

/** 按时间插入或替换一条消息 */
export function upsertMessage(list: readonly ChannelMessage[], message: ChannelMessage): ChannelMessage[] {
  const i = list.findIndex(m => m.id === message.id)
  if (i >= 0) {
    const next = list.slice()
    next[i] = message
    return next
  }
  if (!list.length || list[list.length - 1].at <= message.at) return [...list, message]
  const at = list.findIndex(m => m.at > message.at)
  return [...list.slice(0, at), message, ...list.slice(at)]
}

function applySnapshot(s: ChannelsSnapshot): void {
  const visible = getPage() === 'channels' ? (selectedChannel({ ...state, channels: s.channels })?.id ?? null) : null
  set({
    ready: true,
    channels: visible ? markRead(s.channels, visible) : s.channels,
    members: s.members,
    sessionChannels: s.sessionChannels,
    sessionTasks: s.sessionTasks ?? {},
    teams: s.teams ?? [],
    invites: s.invites ?? [],
    teamsConnection: s.teamsConnection ?? 'unavailable',
    teamsSyncedAt: s.teamsSyncedAt ?? null,
  })
  if (visible && s.channels.some(c => c.id === visible && (c.unread > 0 || c.mentioned))) readLater(visible)
}

let readTimer: ReturnType<typeof setTimeout> | null = null
/** 正在看的频道来了新消息：稍后标为已读（连续来很多条时只发一次） */
function readLater(id: string): void {
  if (readTimer) clearTimeout(readTimer)
  readTimer = setTimeout(() => {
    readTimer = null
    void channelsBridge?.markRead(id).catch(() => {})
  }, 300)
}

/** 频道 id → 正在读的那一页：同一个频道同时只读一页，这时再要求的等它读完 */
const loading = new Map<string, Promise<void>>()
/** 读一页消息；第一次进频道时顺便定「新消息」分隔线（unread：进入前的未读数），和消息一起更新，时间线只滚一次 */
function loadMessages(id: string, older = false, unread = 0): Promise<void> {
  if (!channelsBridge) return Promise.resolve()
  const running = loading.get(id)
  if (running) return running
  const job = readPage(channelsBridge, id, older, unread).finally(() => loading.delete(id))
  loading.set(id, job)
  return job
}

async function readPage(
  bridge: NonNullable<typeof channelsBridge>,
  id: string,
  older: boolean,
  unread: number,
): Promise<void> {
  // 更早的一页按最早那条消息的 id 定位（只用时间的话，同一毫秒的几条跨在两页之间会漏掉）
  const oldest = older ? state.messages[id]?.[0] : undefined
  const page = await bridge.messages(id, oldest?.at ?? null, oldest?.id ?? null)
  const current = older ? (state.messages[id] ?? []) : []
  let list = [...page.messages, ...current]
  // 读的同时推过来的消息不能丢
  if (!older) for (const m of state.messages[id] ?? []) list = upsertMessage(list, m)
  const self = selfIdIn(state, state.channels.find(c => c.id === id)?.memberIds)
  const newFrom = unread > 0 ? { ...state.newFrom, [id]: firstUnreadAt(list, unread, self) } : state.newFrom
  set({ messages: { ...state.messages, [id]: list }, more: { ...state.more, [id]: page.more }, newFrom })
}

/** 搜索结果点进来，消息太早还没读进来时，最多往前再读这么多页 */
const FOCUS_PAGES = 25

if (channelsBridge) {
  channelsBridge.onChange(applySnapshot)
  channelsBridge.onMessage(({ channelId, message }) => {
    const list = state.messages[channelId]
    // 还没读过这个频道的消息：等进入时一起读
    if (!list) return
    set({ messages: { ...state.messages, [channelId]: upsertMessage(list, message) } })
  })
  void channelsBridge.state().then(applySnapshot, () => set({ ready: true }))
  // 回到频道页：正在看的频道标为已读
  subscribePage(() => {
    const c = selectedChannel(state)
    if (getPage() === 'channels' && c && (c.unread > 0 || c.mentioned)) channelActions.select(c.id)
  })
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export const channelActions = {
  /** 进入频道：记下「新消息」位置并标为已读 */
  select(id: string): void {
    const channel = state.channels.find(c => c.id === id)
    if (!channel) return
    const loaded = !!state.messages[id]
    if (state.selectedId === id && channel.unread === 0 && !channel.mentioned && (loaded || !channelsLive)) return
    const self = selfIdIn(state, channel.memberIds)
    const newFrom = channel.unread > 0 && loaded ? firstUnreadAt(state.messages[id] ?? [], channel.unread, self) : null
    set({ selectedId: id, channels: markRead(state.channels, id), newFrom: { ...state.newFrom, [id]: newFrom } })
    if (channelsBridge) {
      if (channel.unread > 0 || channel.mentioned) void channelsBridge.markRead(id).catch(() => {})
      if (!loaded) void loadMessages(id, false, channel.unread)
    }
  },
  loadOlder(id: string): Promise<void> {
    return loadMessages(id, true)
  },
  setReplyTo(channelId: string, messageId: string | null): void {
    if ((state.replyTo[channelId] ?? null) === messageId) return
    set({ replyTo: { ...state.replyTo, [channelId]: messageId } })
  },
  /**
   * 以「你」的身份发一条消息。正式模式交给主进程（解析 @、派活），失败时抛出原因；
   * 演示模式只追加到内存，AI 成员不会回复。
   */
  async send(channelId: string, text: string, extra: ChannelAttachments = { images: [], files: [] }): Promise<void> {
    const body = text.trim()
    const replyToId = state.replyTo[channelId] ?? null
    const attached = extra.images.length > 0 || extra.files.length > 0
    if (!body && !attached) return
    if (channelsBridge) {
      const { message } = await channelsBridge.post(channelId, {
        text: body,
        replyToId,
        clientId: crypto.randomUUID(),
        ...(extra.images.length ? { attachments: extra.images } : {}),
        ...(extra.files.length ? { files: extra.files } : {}),
      })
      const list = state.messages[channelId] ?? []
      set({
        messages: { ...state.messages, [channelId]: upsertMessage(list, message) },
        replyTo: { ...state.replyTo, [channelId]: null },
      })
      return
    }
    const self = selfMember(state)
    const channel = state.channels.find(c => c.id === channelId)
    if (!self || !channel) return
    const members = state.members.filter(m => channel.memberIds.includes(m.id))
    const message: ChannelTextMessage = createMessage({
      id: `local-${crypto.randomUUID()}`,
      channelId,
      authorId: self.id,
      text: body,
      replyToId,
      members,
      now: Date.now(),
    })
    if (attached) {
      demoAttachments.set(message.id, extra)
      message.attached = {
        images: extra.images.map(({ dataBase64: _d, ...meta }) => meta),
        files: extra.files.map(({ text: _t, tail: _l, ...meta }) => meta),
      }
    }
    set({ messages: appendMessage(state.messages, message), replyTo: { ...state.replyTo, [channelId]: null } })
  },
  /** 一条消息带的图片和文件全文（演示模式只在本次运行的内存里） */
  attachments(channelId: string, messageId: string): Promise<ChannelAttachments> {
    if (channelsBridge) return channelsBridge.attachments(channelId, messageId)
    return Promise.resolve(demoAttachments.get(messageId) ?? { images: [], files: [] })
  },
  async createChannel(input: ChannelInput): Promise<string> {
    if (!channelsBridge) return demo.createChannel(input)
    const id = await channelsBridge.create(input)
    const snapshot = await channelsBridge.state()
    applySnapshot(snapshot)
    set({ selectedId: id, messages: { ...state.messages, [id]: state.messages[id] ?? [] } })
    void loadMessages(id)
    return id
  },
  updateChannel(
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
  ): Promise<void> {
    if (channelsBridge) return channelsBridge.update(id, patch)
    const { archived, ...rest } = patch
    set({
      channels: state.channels.map(c => {
        if (c.id !== id) return c
        const next = { ...c, ...rest, projectId: c.projectId }
        if (archived !== undefined) next.archivedAt = archived ? Date.now() : null
        return archived ? { ...next, unread: 0, mentioned: false } : next
      }),
    })
    return Promise.resolve()
  },
  /** 置顶 / 取消置顶一条文字消息（docs/ui/channels-local-ai.md §3.1 #9）；演示模式只改内存 */
  async pin(channelId: string, messageId: string, pinned: boolean): Promise<void> {
    if (channelsBridge) return channelsBridge.pin(channelId, messageId, pinned)
    set({
      channels: state.channels.map(c => {
        if (c.id !== channelId) return c
        const rest = (c.pinned ?? []).filter(id => id !== messageId)
        return { ...c, pinned: pinned ? [...rest, messageId] : rest }
      }),
    })
  },
  /**
   * 切到这个频道，时间线跳到这条消息并高亮一下。
   * at（搜索结果带的消息时间）：消息太早、还没读进来时，先往前一页页读到它，再让时间线跳
   */
  async focusMessage(channelId: string, messageId: string, at?: number): Promise<void> {
    if (at != null && channelsBridge) {
      set({ selectedId: channelId })
      for (let page = 0; page < FOCUS_PAGES; page++) {
        const list = state.messages[channelId]
        // 最早那条比目标还早（严格小于）才说明目标已经不在了；同一毫秒的还要接着往前读
        if (list && (list.some(m => m.id === messageId) || !state.more[channelId] || (list[0]?.at ?? 0) < at)) break
        await loadMessages(channelId, !!list).catch(() => undefined)
      }
    }
    set({ selectedId: channelId, focus: { channelId, messageId } })
  },
  /** 时间线跳过去了（或这条消息不在已读进来的消息里） */
  focusDone(): void {
    if (state.focus) set({ focus: null })
  },
  async deleteChannel(id: string): Promise<void> {
    await channelsBridge!.delete(id)
    const { [id]: _messages, ...messages } = state.messages
    set({ messages, selectedId: state.selectedId === id ? null : state.selectedId })
  },
  saveMember(channelId: string | null, input: AgentInput): Promise<string> {
    return channelsBridge!.saveMember(channelId, input)
  },
  addMember(channelId: string, memberId: string): Promise<void> {
    return channelsBridge ? channelsBridge.addMember(channelId, memberId) : demo.addMember(channelId, memberId)
  },
  removeMember(channelId: string, memberId: string): Promise<void> {
    return channelsBridge ? channelsBridge.removeMember(channelId, memberId) : demo.removeMember(channelId, memberId)
  },
  deleteMember(memberId: string): Promise<void> {
    return channelsBridge!.deleteMember(memberId)
  },
  task(taskId: string, action: ChannelTaskAction): Promise<void> {
    return channelsBridge ? channelsBridge.task(taskId, action) : demo.task(taskId, action)
  },
  // ── Phase C：团队。正式模式走主进程（返回后再拉一次快照，不等推送）；演示模式只改内存 ──
  /** 等 AI 成员的主人同意的活：同意 / 拒绝 */
  async approveTask(taskId: string, approve: boolean): Promise<void> {
    if (channelsBridge) await channelsBridge.approveTask(taskId, approve)
    else demo.approveTask(taskId, approve)
  },
  /** 我的 AI 成员在这个团队频道里：别人 @ 它要不要我同意 */
  async setAgentPolicy(channelId: string, memberId: string, policy: AgentPolicy): Promise<void> {
    if (channelsBridge) await channelsBridge.setAgentPolicy(channelId, memberId, policy)
    else demo.setAgentPolicy(memberId, policy)
  },
  async createTeam(name: string): Promise<string> {
    if (!channelsBridge) return demo.createTeam(name)
    const id = await channelsBridge.createTeam(name)
    await resync()
    return id
  },
  async updateTeam(teamId: string, name: string): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.updateTeam(teamId, { name })
      await resync()
    } else demo.patchTeam(teamId, t => ({ ...t, name }))
  },
  async deleteTeam(teamId: string): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.deleteTeam(teamId)
      await resync()
    } else demo.removeTeam(teamId)
  },
  async setDisplayName(teamId: string, name: string): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.setDisplayName(teamId, name)
      await resync()
    } else demo.setDisplayName(name)
  },
  async invite(teamId: string, email: string, role: Exclude<TeamRole, 'owner'>): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.invite(teamId, email, role)
      await resync()
    } else demo.invite(teamId, email, role)
  },
  async revokeInvite(teamId: string, inviteId: string): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.revokeInvite(teamId, inviteId)
      await resync()
    } else demo.patchTeam(teamId, t => ({ ...t, invites: t.invites.filter(i => i.id !== inviteId) }))
  },
  async respondInvite(inviteId: string, accept: boolean): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.respondInvite(inviteId, accept)
      await resync()
    } else demo.respondInvite(inviteId, accept)
  },
  async setRole(teamId: string, userId: string, role: Exclude<TeamRole, 'owner'>): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.setRole(teamId, userId, role)
      await resync()
    } else demo.patchTeam(teamId, t => ({ ...t, members: t.members.map(m => (m.id === userId ? { ...m, role } : m)) }))
  },
  /** 移出成员；userId 是自己就是退出团队 */
  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.removeTeamMember(teamId, userId)
      await resync()
    } else demo.removeTeamMember(teamId, userId)
  },
  /** 连不上云端时手动重试 */
  async refreshTeams(): Promise<void> {
    await channelsBridge?.refreshTeams()
  },
}

/** 正式模式：团队操作做完后马上拉一次快照 */
async function resync(): Promise<void> {
  if (channelsBridge) applySnapshot(await channelsBridge.state())
}

// ---------------------------------------------------------------------------
// 演示模式：团队操作只改内存（docs/ui/channels-phase-c.md §9.3），不联网
// ---------------------------------------------------------------------------

const demoId = (prefix: string): string => prefix + '-' + crypto.randomUUID().slice(0, 8)
const DAY = 86_400_000

const demo = {
  patchTeam(teamId: string, change: (team: TeamInfo) => TeamInfo): void {
    set({ teams: state.teams.map(t => (t.id === teamId ? change(t) : t)) })
  },
  /** 解散或退出：团队和它的频道、消息一起从界面上消失 */
  removeTeam(teamId: string): void {
    const gone = new Set(state.channels.filter(c => c.teamId === teamId).map(c => c.id))
    const messages = Object.fromEntries(Object.entries(state.messages).filter(([id]) => !gone.has(id)))
    set({
      teams: state.teams.filter(t => t.id !== teamId),
      channels: state.channels.filter(c => !gone.has(c.id)),
      messages,
      selectedId: state.selectedId && gone.has(state.selectedId) ? null : state.selectedId,
    })
  },
  removeTeamMember(teamId: string, userId: string): void {
    if (userId === selfMember(state)?.id) return demo.removeTeam(teamId)
    demo.patchTeam(teamId, t => ({ ...t, members: t.members.filter(m => m.id !== userId) }))
    // 他的 AI 成员也从这个团队的频道里移出
    const owned = new Set(state.members.filter(m => m.kind === 'agent' && m.ownerId === userId).map(m => m.id))
    set({
      channels: state.channels.map(c =>
        c.teamId === teamId ? { ...c, memberIds: c.memberIds.filter(id => id !== userId && !owned.has(id)) } : c,
      ),
    })
  },
  createTeam(name: string): string {
    const self = selfMember(state)
    const id = demoId('tm')
    const team: TeamInfo = {
      id,
      name: name.trim(),
      role: 'owner',
      members: self ? [{ id: self.id, role: 'owner', online: true, lastSeenAt: Date.now() }] : [],
      invites: [],
    }
    set({ teams: [...state.teams, team] })
    return id
  },
  setDisplayName(name: string): void {
    set({ members: state.members.map(m => (m.kind === 'human' && m.you ? { ...m, name: name.trim() } : m)) })
  },
  invite(teamId: string, email: string, role: Exclude<TeamRole, 'owner'>): void {
    const address = email.trim().toLowerCase()
    demo.patchTeam(teamId, t => ({
      ...t,
      invites: [
        ...t.invites.filter(i => i.email !== address),
        { id: demoId('iv'), email: address, role, expiresAt: Date.now() + 14 * DAY },
      ],
    }))
  },
  respondInvite(inviteId: string, accept: boolean): void {
    const invite = state.invites.find(i => i.id === inviteId)
    const self = selfMember(state)
    if (!invite) return
    set({ invites: state.invites.filter(i => i.id !== inviteId) })
    if (!accept || !self) return
    // 邀请人当所有者，自己按邀请的角色加入
    const inviterId = demoId('m')
    set({
      members: [...state.members, { id: inviterId, kind: 'human', name: invite.inviter, role: 'owner', online: true }],
      teams: [
        ...state.teams,
        {
          id: invite.teamId,
          name: invite.teamName,
          role: invite.role,
          members: [
            { id: inviterId, role: 'owner', online: true, lastSeenAt: Date.now() },
            { id: self.id, role: invite.role, online: true, lastSeenAt: Date.now() },
          ],
          invites: [],
        },
      ],
    })
  },
  createChannel(input: ChannelInput): string {
    const team = state.teams.find(t => t.id === input.teamId)
    const id = demoId('c')
    const humans = team?.members.map(m => m.id) ?? [selfMember(state)?.id ?? '']
    const channel: Channel = {
      id,
      name: input.name.trim(),
      topic: input.topic ?? null,
      scope: team ? 'team' : 'local',
      ...(team ? { teamId: team.id } : {}),
      memberIds: [...humans, ...(input.memberIds ?? [])],
      unread: 0,
      createdAt: Date.now(),
    }
    set({ channels: [...state.channels, channel], messages: { ...state.messages, [id]: [] }, selectedId: id })
    return id
  },
  addMember(channelId: string, memberId: string): Promise<void> {
    const self = selfMember(state)
    set({
      channels: state.channels.map(c =>
        c.id === channelId && !c.memberIds.includes(memberId) ? { ...c, memberIds: [...c.memberIds, memberId] } : c,
      ),
      // 团队频道里的 AI 成员：登记成我的，规则默认「要我同意」
      members: state.members.map(m =>
        m.id === memberId && m.kind === 'agent' && self
          ? { ...m, mine: true, ownerId: self.id, ownerName: self.name, policy: m.policy ?? 'approve' }
          : m,
      ),
    })
    return Promise.resolve()
  },
  removeMember(channelId: string, memberId: string): Promise<void> {
    set({
      channels: state.channels.map(c =>
        c.id === channelId ? { ...c, memberIds: c.memberIds.filter(id => id !== memberId) } : c,
      ),
    })
    return Promise.resolve()
  },
  setAgentPolicy(memberId: string, policy: AgentPolicy): void {
    set({ members: state.members.map(m => (m.id === memberId && m.kind === 'agent' ? { ...m, policy } : m)) })
  },
  /** 找到任务卡并改它 */
  patchTask(taskId: string, change: (task: ChannelTask) => ChannelTask): void {
    const messages: Record<string, ChannelMessage[]> = {}
    for (const [id, list] of Object.entries(state.messages))
      messages[id] = list.map(m => (m.kind === 'task' && m.id === taskId ? change(m) : m))
    set({ messages })
  },
  approveTask(taskId: string, approve: boolean): void {
    demo.patchTask(taskId, t =>
      t.status !== 'approval'
        ? t
        : approve
          ? { ...t, status: 'queued' }
          : { ...t, status: 'stopped', note: 'rejected', endedAt: Date.now() },
    )
  },
  task(taskId: string, action: ChannelTaskAction): Promise<void> {
    if (action === 'cancel')
      demo.patchTask(taskId, t =>
        t.status === 'queued' || t.status === 'approval'
          ? { ...t, status: 'stopped', note: 'cancelled', endedAt: Date.now() }
          : t,
      )
    return Promise.resolve()
  },
}

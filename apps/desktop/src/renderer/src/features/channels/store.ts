// 协作频道的界面状态（docs/ui/channels.md §1.1；Phase B 见 docs/ui/channels-phase-b.md §11）。
// 演示模式：内存数据，来自 mock/channels.ts，AI 成员不会回复。
// 正式模式：数据都在主进程（main/core/channels/），这里订阅 channels:changed / channels:message，
// 进入频道时按页读消息，发消息、建频道、加成员都走 window.pixelsky.channels。
import { useSyncExternalStore } from 'react'
import { tr } from '../../i18n/core'
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
  ChannelQueueAction,
  ChannelFlow,
  FlowStep,
  FlowAction,
  IssueDispatch,
  JoinSessionInput,
  NeedMark,
  PendingInvite,
  RelayRules,
  ChannelAlertRule,
  FlowScheduleInput,
  TeamInfo,
  TeamRole,
  TeamsConnection,
} from '../../../../shared/types/channels'
import { getPage, subscribePage } from '@/features/layout/page'
import { appendMessage, createMessage, firstUnreadAt, markRead, unreadTotal } from './model'
import { channelDraftKey } from './draftKey'
import { appendComposerDraft } from '@/features/engine/drafts'
import { OPEN_SESSION_EVENT } from '@/features/engine/openRequests'
import type { ChannelAlertAction } from '../../../../shared/channels/alerts'
import { threadRootOf } from '../../../../shared/channels/threads'

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
  /** 频道 id → 右侧打开的讨论串（任务卡或消息 id；docs/ui/channels-collab-v2.md §3） */
  thread: Record<string, string | null>
  /** 频道 id → 进入时「新消息」分隔线的位置 */
  newFrom: Record<string, number | null>
  /** 频道开出来的会话 → 频道名 */
  sessionChannels: Record<string, string>
  /** 本机频道开出来的会话 → 最近一张任务卡（系统提醒按频道的说法写） */
  sessionTasks: NonNullable<ChannelsSnapshot['sessionTasks']>
  /** 加入了频道的会话 → 在哪些频道里、是哪个成员（docs/ui/import-collab.md 第 5 项②） */
  sessionBindings: NonNullable<ChannelsSnapshot['sessionBindings']>
  /** 正在把这个会话加入频道（加入频道对话框） */
  joining: { sessionId: string; title: string } | null
  // ── Phase C：多人团队（docs/ui/channels-phase-c.md） ──
  teams: TeamInfo[]
  /** 别人邀请我（频道列表最上面的邀请卡） */
  invites: PendingInvite[]
  /** unavailable = 云端没有团队接口，不显示任何团队入口 */
  teamsConnection: TeamsConnection
  teamsSyncedAt: number | null
  /** 「需要你」（docs/ui/channels-collab-v2.md §2）：主进程算好推过来；演示模式在 needs.ts 里现算 */
  needs: NonNullable<ChannelsSnapshot['needs']>
  /** 标为已处理、状态还没变的（§2.1） */
  needsDone: NonNullable<ChannelsSnapshot['needsDone']>
  following: NonNullable<ChannelsSnapshot['following']>
  /** 演示模式标为已处理的：频道 id → key → sig（正式模式记在主进程） */
  demoMarks: Record<string, Record<string, string>>
  /** 频道页正在看「需要你」（代替时间线） */
  needsOpen: boolean
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
  thread: {},
  newFrom: {},
  sessionChannels: {},
  sessionTasks: {},
  sessionBindings: {},
  joining: null,
  teams: channelsLive ? [] : channelTeams.teams,
  invites: channelsLive ? [] : channelTeams.invites,
  teamsConnection: channelsLive ? 'unavailable' : channelTeams.connection,
  teamsSyncedAt: channelsLive ? null : Date.now(),
  needs: [],
  needsDone: [],
  following: [],
  demoMarks: {},
  needsOpen: false,
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

const NO_BINDINGS: NonNullable<ChannelsSnapshot['sessionBindings']>[string] = []
/** 会话加入了哪些频道、在里面是哪个成员（docs/ui/import-collab.md 第 5 项②） */
export function useSessionBindings(sessionId: string): NonNullable<ChannelsSnapshot['sessionBindings']>[string] {
  return useSyncExternalStore(subscribe, () => state.sessionBindings[sessionId] ?? NO_BINDINGS)
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
  // 开着「需要你」时时间线没显示，选中的频道不算正在看
  const visible =
    getPage() === 'channels' && !state.needsOpen
      ? (selectedChannel({ ...state, channels: s.channels })?.id ?? null)
      : null
  set({
    ready: true,
    channels: visible ? markRead(s.channels, visible) : s.channels,
    members: s.members,
    sessionChannels: s.sessionChannels,
    sessionTasks: s.sessionTasks ?? {},
    sessionBindings: s.sessionBindings ?? {},
    needs: s.needs ?? [],
    needsDone: s.needsDone ?? [],
    following: s.following ?? [],
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
/** 频道 id → 第一次读消息期间推过来的（这时 state.messages 里还没有这个频道），读完一起并进去 */
const pushedWhileLoading = new Map<string, ChannelMessage[]>()
/** 读一页消息；第一次进频道时顺便定「新消息」分隔线（unread：进入前的未读数），和消息一起更新，时间线只滚一次 */
function loadMessages(id: string, older = false, unread = 0): Promise<void> {
  if (!channelsBridge) return Promise.resolve()
  const running = loading.get(id)
  if (running) return running
  const job = readPage(channelsBridge, id, older, unread).finally(() => {
    loading.delete(id)
    pushedWhileLoading.delete(id)
  })
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
  if (!older) {
    const pushed = [...(state.messages[id] ?? []), ...(pushedWhileLoading.get(id) ?? [])]
    for (const m of pushed) list = upsertMessage(list, m)
  }
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
    // 还没读过这个频道的消息：等进入时一起读；正在第一次读的先记下，读完并进去
    if (!list) {
      if (loading.has(channelId))
        pushedWhileLoading.set(channelId, upsertMessage(pushedWhileLoading.get(channelId) ?? [], message))
      return
    }
    set({ messages: { ...state.messages, [channelId]: upsertMessage(list, message) } })
  })
  void channelsBridge.state().then(applySnapshot, () => set({ ready: true }))
  // 回到频道页：正在看的频道标为已读
  subscribePage(() => {
    const c = selectedChannel(state)
    if (getPage() === 'channels' && !state.needsOpen && c && (c.unread > 0 || c.mentioned)) channelActions.select(c.id)
  })
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

export const channelActions = {
  /**
   * 主动提醒上的按钮（docs/ui/channels-collab-v2.md §6）。open 打开会话（不改提醒）；换人时把「@ 标题」放进频道输入框。
   * 演示模式只把提醒标为处理过
   */
  async alert(channelId: string, messageId: string, action: ChannelAlertAction): Promise<void> {
    if (action === 'open') {
      const m = state.messages[channelId]?.find(x => x.id === messageId)
      const taskId = m?.kind === 'message' ? m.alert?.taskId : null
      const task = taskId ? state.messages[channelId]?.find(x => x.id === taskId) : null
      const need = state.needs.find(n => n.messageId === messageId)
      const sessionId = (task?.kind === 'task' ? task.sessionId : null) ?? need?.sessionId
      if (sessionId) window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }))
      return
    }
    if (channelsBridge) {
      const { draft } = await channelsBridge.alert(channelId, messageId, action)
      if (draft) appendComposerDraft(channelDraftKey(channelId), draft)
      return
    }
    const list = state.messages[channelId] ?? []
    set({
      messages: {
        ...state.messages,
        [channelId]: list.map(m =>
          m.kind === 'message' && m.id === messageId && m.alert ? { ...m, alert: { ...m.alert, state: 'done' } } : m,
        ),
      },
    })
  },
  /** 「需要你」里标为已处理（done）/ 恢复（docs/ui/channels-collab-v2.md §2.1）；演示模式只记在内存 */
  async markNeeds(items: NeedMark[], done: boolean): Promise<void> {
    if (!items.length) return
    if (channelsBridge) return channelsBridge.markNeeds(items, done)
    const marks = { ...state.demoMarks }
    for (const item of items) {
      const channel = { ...marks[item.channelId] }
      if (done) channel[item.key] = item.sig
      else delete channel[item.key]
      marks[item.channelId] = channel
    }
    set({ demoMarks: marks })
  },
  /** 打开 / 关掉「需要你」 */
  openNeeds(open: boolean): void {
    if (state.needsOpen !== open) set({ needsOpen: open })
  },
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
  /** 打开 / 关掉右侧的讨论串 */
  openThread(channelId: string, id: string | null): void {
    // 在结果上开串 = 打开任务卡的串；串里的消息 = 它所在的串
    const rootId = id && threadRootOf(state.messages[channelId] ?? [], id)
    if ((state.thread[channelId] ?? null) === rootId) return
    set({ thread: { ...state.thread, [channelId]: rootId } })
  },
  /** AI 成员提议的派活：派出去或不要（演示模式只改内存里的状态） */
  async proposal(channelId: string, messageId: string, accept: boolean): Promise<void> {
    if (channelsBridge) {
      await channelsBridge.proposal(channelId, messageId, accept)
      return
    }
    const list = state.messages[channelId] ?? []
    set({
      messages: {
        ...state.messages,
        [channelId]: list.map(m =>
          m.kind === 'message' && m.id === messageId && m.proposal
            ? { ...m, proposal: { ...m.proposal, state: accept ? 'sent' : 'dismissed' } }
            : m,
        ),
      },
    })
  },
  /**
   * 以「你」的身份发一条消息。正式模式交给主进程（解析 @、派活），失败时抛出原因；
   * 演示模式只追加到内存，AI 成员不会回复。threadId：发在这个讨论串里（不用引用）
   */
  async send(
    channelId: string,
    text: string,
    extra: ChannelAttachments = { images: [], files: [] },
    threadId: string | null = null,
  ): Promise<void> {
    const body = text.trim()
    const replyToId = threadId ? null : (state.replyTo[channelId] ?? null)
    const keepReply = threadId ? { replyTo: state.replyTo } : { replyTo: { ...state.replyTo, [channelId]: null } }
    const attached = extra.images.length > 0 || extra.files.length > 0
    if (!body && !attached) return
    if (channelsBridge) {
      const { message } = await channelsBridge.post(channelId, {
        text: body,
        replyToId,
        ...(threadId ? { threadId } : {}),
        clientId: crypto.randomUUID(),
        ...(extra.images.length ? { attachments: extra.images } : {}),
        ...(extra.files.length ? { files: extra.files } : {}),
      })
      const list = state.messages[channelId] ?? []
      // 按发完时的 state 清引用条：发送期间别的频道点了「回复」、这个频道换了引用对象，都不能用发送前的拷贝盖掉
      const replied = !threadId && (state.replyTo[channelId] ?? null) === replyToId
      set({
        messages: { ...state.messages, [channelId]: upsertMessage(list, message) },
        ...(replied ? { replyTo: { ...state.replyTo, [channelId]: null } } : {}),
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
    if (threadId) message.threadId = threadId
    if (attached) {
      demoAttachments.set(message.id, extra)
      message.attached = {
        images: extra.images.map(({ dataBase64: _d, ...meta }) => meta),
        files: extra.files.map(({ text: _t, tail: _l, ...meta }) => meta),
      }
    }
    set({ messages: appendMessage(state.messages, message), ...keepReply })
  },
  /** 从频道页以外发一条消息（会话评论交给成员、事项派活）：不动输入框的引用回复 */
  async postText(channelId: string, text: string, threadId: string | null = null): Promise<ChannelTextMessage | null> {
    const body = text.trim()
    if (!body) return null
    if (channelsBridge) {
      const { message } = await channelsBridge.post(channelId, {
        text: body,
        clientId: crypto.randomUUID(),
        ...(threadId ? { threadId } : {}),
      })
      const list = state.messages[channelId]
      if (list) set({ messages: { ...state.messages, [channelId]: upsertMessage(list, message) } })
      return message
    }
    const self = selfMember(state)
    const channel = state.channels.find(c => c.id === channelId)
    if (!self || !channel) return null
    const message = createMessage({
      id: `local-${crypto.randomUUID()}`,
      channelId,
      authorId: self.id,
      text: body,
      replyToId: null,
      members: state.members.filter(m => channel.memberIds.includes(m.id)),
      now: Date.now(),
    })
    if (threadId) message.threadId = threadId
    set({ messages: appendMessage(state.messages, message) })
    return message
  },
  /** 把任务看板的事项交给频道成员（docs/ui/channels-collab-v2.md §9）：返回派出的任务卡 id；演示模式只发消息 */
  async dispatchIssue(channelId: string, issue: IssueDispatch): Promise<string | null> {
    if (channelsBridge) return (await channelsBridge.dispatchIssue(channelId, issue)).taskId
    const member = state.members.find(m => m.id === issue.memberId)
    const lines = [`@${member?.name ?? ''} ${tr('board.issue.chip', { title: issue.title })}`]
    if (issue.note) lines.push(issue.note)
    await channelActions.postText(channelId, lines.join('\n\n'))
    return null
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
      /** 允许 AI 成员互相派活（docs/ui/import-collab.md 第 5 项①） */
      relay?: boolean
      /** 互相派活的停下规则（docs/ui/relay-limits-mockup.html） */
      relayRules?: RelayRules
      /** 主动提醒的规则开关、每日简报几点发（docs/ui/channels-collab-v2.md §6） */
      alerts?: Partial<Record<ChannelAlertRule, boolean>>
      digestHour?: number
      /** 牵头成员（docs/ui/channels-pipeline.md §8.3）；null 是不启用 */
      lead?: string | null
      /** @ 一个 AI 派新活时先出计划 */
      planFirst?: boolean
      /** 不带 @ 的简单活由牵头直接派（docs/ui/channels-auto-route.md） */
      leadRoute?: boolean
      /** 每天定时运行的流程（§10.3）：整份列表，主进程按 id 保留运行时字段 */
      schedules?: FlowScheduleInput[]
    },
  ): Promise<void> {
    if (channelsBridge) return channelsBridge.update(id, patch)
    const { archived, schedules, ...rest } = patch
    // 演示：按 id 保留已有定时的运行字段，新的补上
    const old = state.channels.find(c => c.id === id)?.schedules ?? []
    const nextSchedules = schedules?.map(x => ({
      lastRunAt: 0,
      lastFlowMessageId: null,
      ...old.find(o => o.id === x.id),
      ...x,
      id: x.id ?? crypto.randomUUID(),
    }))
    set({
      channels: state.channels.map(c => {
        if (c.id !== id) return c
        const next = { ...c, ...rest, projectId: c.projectId, ...(nextSchedules ? { schedules: nextSchedules } : {}) }
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
    set({ selectedId: channelId, focus: { channelId, messageId }, needsOpen: false })
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
  /** 打开「加入频道」对话框（会话右键菜单；只有正式模式有） */
  openJoin(sessionId: string, title: string): void {
    set({ joining: { sessionId, title } })
  },
  closeJoin(): void {
    if (state.joining) set({ joining: null })
  },
  /** 把已有会话加入频道（docs/ui/import-collab.md 第 5 项②）；不写 channelId 时新建频道 */
  joinSession(input: JoinSessionInput): Promise<{ channelId: string; memberId: string }> {
    if (!channelsBridge) return Promise.reject(new Error(tr('channels.join.demo')))
    return channelsBridge.joinSession(input)
  },
  leaveSession(sessionId: string, channelId: string): Promise<void> {
    if (!channelsBridge) return Promise.resolve()
    return channelsBridge.leaveSession(sessionId, channelId)
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
  /** 流程卡上的操作（docs/ui/channels-pipeline.md §4.5）；返回流程消息 id。演示模式只改内存，AI 成员不会真的做 */
  async flow(channelId: string, action: FlowAction): Promise<string> {
    if (channelsBridge) return (await channelsBridge.flow(channelId, action)).messageId
    return demo.flow(channelId, action)
  },
  task(taskId: string, action: ChannelTaskAction, memberId?: string): Promise<void> {
    return channelsBridge ? channelsBridge.task(taskId, action, memberId) : demo.task(taskId, action)
  },
  queueControl(taskId: string, action: ChannelQueueAction): Promise<void> {
    return channelsBridge ? channelsBridge.queueControl(taskId, action) : demo.queueControl(taskId, action)
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

/** 依赖都交付了的等待中步骤开始运行 */
const startable = (steps: FlowStep[]): FlowStep[] => {
  const done = new Set(steps.filter(x => x.status === 'delivered').map(x => x.id))
  return steps.map(x =>
    x.status === 'pending' && x.deps.every(d => done.has(d)) ? { ...x, status: 'running' as const } : x,
  )
}

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
  flow(channelId: string, action: FlowAction): string {
    const list = state.messages[channelId] ?? []
    if (action.type === 'create') {
      const author = selfIdIn(state, state.channels.find(c => c.id === channelId)?.memberIds) ?? ''
      const planner = action.planner
      const id = demoId('flow')
      const flow: ChannelFlow = {
        title: action.title,
        status: planner ? 'planning' : 'draft',
        steps: (action.steps ?? []).map(x => ({ ...x, taskId: null, status: 'pending', rejects: 0 })),
        maxRejects: 3,
        planner: planner ? { ...planner, taskId: null } : null,
        ...(action.limits !== undefined ? { limits: action.limits } : {}),
        ...(action.isolate !== undefined ? { isolate: action.isolate } : {}),
      }
      const message = createMessage({
        id,
        channelId,
        authorId: author,
        text: action.title,
        members: [],
        now: Date.now(),
      })
      set({ messages: appendMessage(state.messages, { ...message, flow }) })
      return id
    }
    const patch = (change: (f: ChannelFlow) => ChannelFlow | null): void => {
      set({
        messages: {
          ...state.messages,
          [channelId]: list.flatMap(m =>
            m.kind === 'message' && m.id === action.messageId && m.flow
              ? ((f): ChannelTextMessage[] => (f ? [{ ...m, flow: f }] : []))(change(m.flow))
              : [m],
          ),
        },
      })
    }
    const stepStatus = (f: ChannelFlow, status: ChannelFlow['status']): ChannelFlow => ({ ...f, status, paused: null })
    switch (action.type) {
      case 'update':
        patch(f => ({
          ...f,
          title: action.title ?? f.title,
          ...(action.limits !== undefined ? { limits: action.limits } : {}),
          ...(action.isolate !== undefined ? { isolate: action.isolate } : {}),
          steps: action.steps
            ? action.steps.map(x => ({ ...x, taskId: null, status: 'pending', rejects: 0 }))
            : f.steps,
        }))
        break
      case 'start':
      case 'resume':
        patch(f => ({
          ...stepStatus(f, 'running'),
          steps: startable(f.steps),
          // 开始时补默认护栏；继续 = 再给一整份
          limits: f.limits === undefined ? { rounds: Math.max(12, f.steps.length * 4), minutes: 120 } : f.limits,
          since: { at: Date.now(), rounds: 0 },
        }))
        break
      case 'gate':
        patch(f => ({
          ...f,
          steps: startable(
            f.steps.map(x =>
              x.id === action.stepId && x.status === 'gated'
                ? { ...x, status: action.decision === 'approve' ? ('delivered' as const) : ('running' as const) }
                : x,
            ),
          ),
        }))
        break
      case 'pause':
        patch(f => stepStatus(f, 'paused'))
        break
      case 'stop':
        patch(f => ({
          ...stepStatus(f, 'stopped'),
          steps: f.steps.map(x => (x.status === 'running' || x.status === 'asking' ? { ...x, status: 'stopped' } : x)),
        }))
        break
      case 'discard':
        // 和正式数据一样：丢弃 = 标成已停止（消息记录只追加，不删）
        patch(f => stepStatus(f, 'stopped'))
        break
    }
    return action.messageId
  },
  queueControl(taskId: string, action: ChannelQueueAction): Promise<void> {
    const task = Object.values(state.messages)
      .flat()
      .find((m): m is ChannelTask => m.kind === 'task' && m.id === taskId)
    if (!task || task.status !== 'queued' || task.relay?.held) return Promise.resolve()
    const list = state.messages[task.channelId] ?? []
    const queued = list.filter(
      (m): m is ChannelTask =>
        m.kind === 'task' && m.assigneeId === task.assigneeId && m.status === 'queued' && !m.relay?.held,
    )
    const i = queued.findIndex(t => t.id === taskId)
    if (i < 0) return Promise.resolve()
    let order = queued.slice()
    if (action === 'up') {
      if (i === 0) return Promise.resolve()
      ;[order[i - 1], order[i]] = [order[i], order[i - 1]]
    } else if (action === 'down') {
      if (i >= order.length - 1) return Promise.resolve()
      ;[order[i], order[i + 1]] = [order[i + 1], order[i]]
    } else if (action === 'first') {
      if (i === 0) return Promise.resolve()
      order = [queued[i], ...queued.filter((_, k) => k !== i)]
    } else return Promise.resolve()
    const busy = state.members.some(
      m => m.kind === 'agent' && m.id === task.assigneeId && (!!m.task || m.status === 'running'),
    )
    order.forEach((t, idx) => demo.patchTask(t.id, x => ({ ...x, ahead: idx + (busy ? 1 : 0) })))
    return Promise.resolve()
  },
  task(taskId: string, action: ChannelTaskAction): Promise<void> {
    if (action === 'cancel')
      demo.patchTask(taskId, t =>
        t.status === 'queued' || t.status === 'approval'
          ? { ...t, status: 'stopped', note: 'cancelled', endedAt: Date.now() }
          : t,
      )
    // 演示：放行被拦下的接力（AI 成员不会真的做）
    if (action === 'continue' || action === 'unlimit')
      demo.patchTask(taskId, t => (t.relay?.held ? { ...t, relay: { ...t.relay, held: null } } : t))
    return Promise.resolve()
  },
}

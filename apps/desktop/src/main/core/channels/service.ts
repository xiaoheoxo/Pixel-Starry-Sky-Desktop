// 协作频道 Phase B（docs/ui/channels-phase-b.md）：建频道、加 AI 成员、发消息、@成员派活、跟踪状态、发回结果。
// 不依赖 Electron：引擎调用、推送、机器 / 项目 / 会话列表都由 main/channels/ipc.ts 注入，
// 引擎调用和窗口走同一层路由（含 SSH 机器），所以派到远程会话的活和本机一样。
import { randomUUID } from 'node:crypto'
import {
  ENGINES as ENGINE_INFO,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_TOTAL,
  PROVIDER_ID,
  containsTerms,
  searchSnippet,
  searchTerms,
  validateFiles,
  validateImages,
  type HostEvent,
  type MessageInput,
  type OpenedSession,
  type ProjectRecord,
  type SessionRecord,
  type SessionSummary,
} from '@pixelsky/protocol'
import type { Locale } from '../../../shared/i18n/messages'
import type {
  AgentConfig,
  AgentInput,
  AgentMember,
  Channel,
  ChannelInput,
  ChannelNotify,
  ChannelMember,
  ChannelMessage,
  ChannelsSnapshot,
  ChannelSearchResult,
  ChannelTask,
  ChannelTaskAction,
  ChannelTextMessage,
  HumanMember,
  PostInput,
  AgentPolicy,
  ChannelAttachments,
  TeamRole,
} from '../../../shared/types/channels'
import { isReservedMentionName, mentionsAll, parseMentions, type Mentionable } from '../../../shared/channels/mentions'
import { ChannelStore, type StoredChannel } from './store'
import {
  attachedNote,
  clipResult,
  continuePrompt,
  decisionOf,
  dispatchPrompt,
  droppedNote,
  followUpPrompt,
  historyLines,
  summaryOf,
  taskTitle,
} from './prompt'
import {
  clientMessageId,
  diffTotal,
  reconcileRun,
  trackEvent,
  type Finish,
  type TaskRun,
  type TeamRunRef,
  type Tracked,
} from './tracker'
import type { TeamSync } from './team/sync'
import { TeamExecutor } from './team/executor'
import type { AgentRegistration, TeamMessage } from './team/api'

export const SELF_ID = 'you'
const NAME_MAX = 40
const INSTRUCTIONS_MAX = 2000
const TOPIC_MAX = 200
/** 频道说明最多这么长；置顶最多这么多条（docs/ui/channels-local-ai.md §3.1 #9） */
export const NOTES_MAX = 2000
export const PIN_MAX = 10
const PAGE = 200
/** 频道消息搜索最多返回这么多条；搜索词最多这么长（和全局搜索一样） */
const SEARCH_LIMIT = 50
const SEARCH_TEXT_MAX = 200
const DAY = 86_400_000
/** 结束了的运行信息留这么久（重试、追加要求用） */
const KEEP_ENDED = 30 * DAY
const ENGINES = new Set(['claude', 'codex', 'pixel'])

export interface MachineLite {
  id: string
  name: string
  connected: boolean
}

export interface ChannelsDeps {
  store: ChannelStore
  /** 引擎操作表（和窗口同一层路由） */
  call: (channel: string, args: unknown[]) => Promise<unknown>
  emit: (channel: 'channels:changed' | 'channels:message', value: unknown) => void
  machines: () => MachineLite[]
  projects: () => ProjectRecord[]
  sessions: () => SessionSummary[]
  /** 资源 id（项目、会话）属于哪台机器 */
  machineOf: (id: string) => string
  selfName: () => string
  locale: () => Locale
  now?: () => number
  log?: (message: string, error?: unknown) => void
  /** Phase C：团队同步（没登录 / 没接团队时不传） */
  team?: TeamSync
  /** Phase C：这台电脑的设备 id（认领团队任务用） */
  deviceId?: string
  /** Phase C：登记 AI 成员时给别人看的机器名 */
  machineName?: () => string
  /** 测试里调小团队写回的节流 / 上报间隔 */
  teamTiming?: { progressMs?: number; statusMs?: number }
}

const terminal = (status: ChannelTask['status']): boolean =>
  status === 'done' || status === 'failed' || status === 'stopped'
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function cleanName(value: unknown, what: string): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (!name) throw new Error(`${what}不能为空`)
  if (name.length > NAME_MAX) throw new Error(`${what}最多 ${NAME_MAX} 个字`)
  return name
}

/**
 * 成员的额度来源（docs/ui/channels-local-ai.md §3.1 #1）：只留形状对的 platform（分组 + 账号）或 provider（接口 id），
 * 两个都给时报错；都没有就是自有账号。分组还在不在、账号对不对，由开会话 / 发消息时的引擎判断（失败写在任务卡上）
 */
function creditOf(raw: AgentInput['settings']): Pick<AgentConfig['settings'], 'platform' | 'provider'> {
  const p = raw?.platform
  const v = raw?.provider
  const platform =
    p && typeof p.groupId === 'string' && p.groupId && typeof p.account === 'string' && p.account
      ? { groupId: p.groupId.slice(0, 200), account: p.account.slice(0, 320) }
      : null
  const provider = v && typeof v.id === 'string' && PROVIDER_ID.test(v.id) ? { id: v.id } : null
  if ((p && !platform) || (v && !provider)) throw new Error('额度来源无效')
  if (platform && provider) throw new Error('额度来源无效')
  return platform ? { platform } : provider ? { provider } : {}
}

export class Channels {
  private readonly store: ChannelStore
  private readonly now: () => number
  /** clientId → 消息 id：同一条消息重复提交时不重复派活 */
  private readonly posted = new Map<string, string>()
  /** 断开的机器：重连后对账 */
  private offline = new Set<string>()
  private changedTimer: ReturnType<typeof setTimeout> | null = null
  private runsTimer: ReturnType<typeof setTimeout> | null = null
  /** Phase C：团队同步和执行端 */
  private readonly team: TeamSync | null
  private readonly exec: TeamExecutor | null
  /** 团队活只在本机有的显示信息（排队前面还有几项、机器断开） */
  private readonly teamLocal = new Map<string, { ahead?: number; disconnected?: boolean }>()

  constructor(private readonly deps: ChannelsDeps) {
    this.store = deps.store
    this.now = deps.now ?? Date.now
    this.team = deps.team ?? null
    this.exec = null
    if (this.team) {
      const team = this.team
      this.exec = new TeamExecutor({
        sync: team,
        deviceId: deps.deviceId ?? 'device',
        now: this.now,
        log: deps.log,
        ...deps.teamTiming,
        host: {
          member: id => this.member(id),
          run: id => this.store.runs.get(id),
          runs: () => [...this.store.runs.values()],
          enqueue: run => {
            this.store.runs.set(run.taskId, run)
            this.saveRuns()
            void this.pump(run.memberId)
          },
          nextRound: (card, run, prompt, fresh, ref, memberId) =>
            this.nextRound(card, run, prompt, fresh, ref, memberId),
          addFollowUp: (taskId, text, ref) => this.addTeamFollowUp(taskId, text, ref),
          action: (taskId, action) => this.runAction(taskId, action),
          setFinal: (taskId, final) => {
            const run = this.store.runs.get(taskId)
            if (!run?.team) return
            this.store.runs.set(taskId, { ...run, team: { ...run.team, final } })
            this.saveRuns()
          },
          agentStatus: id => this.teamAgentStatus(id),
          locale: () => this.deps.locale(),
        },
      })
      team.bindLocal(localId => this.teamAgentView(localId))
      team.subscribe({
        changed: () => this.changed(),
        message: push => this.pushMessage(this.decorate(push.message)),
      })
    }
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  self(): HumanMember {
    return { id: SELF_ID, kind: 'human', name: this.deps.selfName(), you: true, role: 'owner' }
  }

  private member(id: string): AgentConfig | undefined {
    return this.store.members.find(m => m.id === id)
  }

  private nameOf = (id: string): string => (id === SELF_ID ? this.deps.selfName() : (this.member(id)?.name ?? '?'))

  private machineOnline(machineId: string): boolean {
    return machineId === 'local' || !!this.deps.machines().find(m => m.id === machineId)?.connected
  }

  private agentView(config: AgentConfig, projects: Map<string, ProjectRecord>, machines: MachineLite[]): AgentMember {
    const now = this.now()
    const runs = [...this.store.runs.values()].filter(r => r.memberId === config.id)
    const tasks = runs.map(r => this.taskOf(r)).filter((t): t is ChannelTask => !!t)
    const active =
      tasks.find(t => t.status === 'waiting') ??
      tasks.find(t => !terminal(t.status) && this.store.runs.get(t.id)?.phase === 'sent')
    const online = this.machineOnline(config.machineId)
    const status = !online
      ? 'offline'
      : tasks.some(t => t.status === 'waiting')
        ? 'waiting'
        : active
          ? 'running'
          : 'idle'
    let total = 0,
      done = 0,
      failed = 0
    let last: AgentMember['last'] = null
    for (const list of this.store.messages.values())
      for (const m of list) {
        if (m.kind !== 'task' || m.assigneeId !== config.id) continue
        if (m.at > now - 30 * DAY) {
          total++
          if (m.status === 'done') done++
          if (m.status === 'failed') failed++
        }
        if (terminal(m.status) && (!last || (m.endedAt ?? m.at) > last.at))
          last = { status: m.status, at: m.endedAt ?? m.at }
      }
    const project = projects.get(config.projectId)
    const shares = this.store.members
      .filter(
        o =>
          o.id !== config.id &&
          o.machineId === config.machineId &&
          o.projectId === config.projectId &&
          o.copyId === config.copyId,
      )
      .map(o => o.name)
    return {
      id: config.id,
      kind: 'agent',
      name: config.name,
      engine: config.engine,
      model: config.settings.model ?? null,
      machineId: config.machineId,
      machine:
        config.machineId === 'local' ? '' : (machines.find(m => m.id === config.machineId)?.name ?? config.machineId),
      project: project?.name ?? null,
      status,
      task: active?.title ?? null,
      sessionId: active?.sessionId ?? null,
      config,
      queued: runs.filter(r => r.phase === 'waiting').length,
      warning: project ? null : '项目不存在',
      last,
      stats: { total, done, failed },
      sharesDirWith: shares,
    }
  }

  private unreadOf(channel: StoredChannel): { unread: number; mentioned: boolean; lastAt: number } {
    let unread = 0,
      mentioned = false,
      lastAt = channel.createdAt
    for (const m of this.store.messages.get(channel.id) ?? []) {
      lastAt = Math.max(lastAt, m.at)
      if (m.kind === 'event' || m.authorId === SELF_ID || m.at <= channel.readAt) continue
      unread++
      if (m.kind === 'message' && m.mentions?.includes(SELF_ID)) mentioned = true
    }
    return { unread, mentioned, lastAt }
  }

  state(): ChannelsSnapshot {
    const projects = new Map(this.deps.projects().map(p => [p.id, p]))
    const machines = this.deps.machines()
    const channels: Channel[] = [...this.store.channels.values()]
      .map(c => ({
        id: c.id,
        name: c.name,
        topic: c.topic,
        notes: c.notes ?? null,
        pinned: c.pinned ?? [],
        notify: c.notify ?? 'all',
        archivedAt: c.archivedAt ?? null,
        project: c.projectId ? (projects.get(c.projectId)?.name ?? null) : null,
        projectId: c.projectId,
        scope: 'local' as const,
        memberIds: c.memberIds,
        createdAt: c.createdAt,
        ...this.unreadOf(c),
      }))
      .sort((a, b) => b.lastAt - a.lastAt)
    const sessionChannels: Record<string, string> = {}
    const sessionTasks: NonNullable<ChannelsSnapshot['sessionTasks']> = {}
    for (const [channelId, list] of this.store.messages) {
      const name = this.store.channels.get(channelId)?.name
      if (name)
        for (const m of list)
          if (m.kind === 'task' && m.sessionId) {
            sessionChannels[m.sessionId] = name
            // 消息按时间排：同一个会话（共用会话的成员）留最后一张卡
            sessionTasks[m.sessionId] = { channelId, taskId: m.id, memberId: m.assigneeId }
          }
    }
    const members: ChannelMember[] = [
      this.self(),
      ...this.store.members.map(m => this.agentView(m, projects, machines)),
    ]
    const team = this.team?.snapshot()
    if (this.team && team) {
      channels.push(...this.team.channels())
      members.push(...this.team.members())
      for (const run of this.store.runs.values()) {
        const name = run.team && run.sessionId ? this.team.channelInfo(run.channelId)?.name : null
        if (name && run.sessionId) sessionChannels[run.sessionId] = name
      }
    }
    return {
      self: this.self(),
      channels,
      members,
      sessionChannels,
      sessionTasks,
      teams: team?.teams ?? [],
      invites: team?.invites ?? [],
      // 没有团队同步（团队功能关着，见 main/channels/ipc.ts 的 teamsEnabled）：报不可用，界面藏起所有团队入口
      teamsConnection: this.team ? (team?.connection ?? 'signed-out') : 'unavailable',
      teamsSyncedAt: team?.syncedAt ?? null,
    }
  }

  /**
   * 一页本机频道的消息（最多 PAGE 条）。beforeId 是界面里最早那条消息：取它前面的，按位置不按时间，
   * 同一毫秒的几条消息跨在两页之间时不会漏掉；这条消息不在了（删了）才退回按时间 before 取
   */
  messages(
    channelId: string,
    before?: number | null,
    beforeId?: string | null,
  ): { messages: ChannelMessage[]; more: boolean } {
    const list = this.store.messages.get(channelId)
    if (!list) throw new Error('频道不存在')
    const at = beforeId ? list.findIndex(m => m.id === beforeId) : -1
    const end = at >= 0 ? at : before == null ? list.length : list.findIndex(m => m.at >= before)
    const stop = end < 0 ? list.length : end
    const start = Math.max(0, stop - PAGE)
    return { messages: list.slice(start, stop), more: start > 0 }
  }

  /**
   * 搜频道消息（docs/ui/channels-local-ai.md §3.1 #8）：本机频道（含归档的）的文字消息和任务卡标题，
   * 每个词都要出现，新的在前，最多 limit 条。projectId：只搜默认项目是它的频道
   */
  search(text: string, opts: { limit?: number; projectId?: string | null } = {}): ChannelSearchResult {
    const terms = searchTerms(text.slice(0, SEARCH_TEXT_MAX))
    if (!terms.length) return { hits: [], truncated: false }
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? SEARCH_LIMIT)), SEARCH_LIMIT)
    const found: { m: Extract<ChannelMessage, { kind: 'message' | 'task' }>; body: string }[] = []
    for (const c of this.store.channels.values()) {
      if (opts.projectId && c.projectId !== opts.projectId) continue
      for (const m of this.store.messages.get(c.id) ?? []) {
        const body = m.kind === 'message' ? m.text : m.kind === 'task' ? m.title : ''
        if (m.kind !== 'event' && body && containsTerms(body, terms)) found.push({ m, body })
      }
    }
    found.sort((a, b) => b.m.at - a.m.at)
    return {
      hits: found.slice(0, limit).map(({ m, body }) => ({
        channelId: m.channelId,
        messageId: m.id,
        kind: m.kind,
        authorId: m.kind === 'task' ? m.assigneeId : m.authorId,
        at: m.at,
        snippet: searchSnippet(body, terms),
      })),
      truncated: found.length > limit,
    }
  }

  /** 频道是团队频道吗 */
  private isTeam(channelId: string): boolean {
    return !!this.team?.hasChannel(channelId)
  }

  /** 一页消息：本机频道同步返回，团队频道从云端缓存取（IPC 用这个） */
  page(
    channelId: string,
    before?: number | null,
    beforeId?: string | null,
  ): { messages: ChannelMessage[]; more: boolean } | Promise<{ messages: ChannelMessage[]; more: boolean }> {
    if (!this.isTeam(channelId)) return this.messages(channelId, before, beforeId)
    return this.team!.page(channelId, before, beforeId).then(page => ({
      messages: page.messages.map(m => this.decorate(m)),
      more: page.more,
    }))
  }

  private changed(): void {
    this.exec?.statusChanged()
    if (this.changedTimer) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      this.deps.emit('channels:changed', this.state())
    }, 30)
  }

  private pushMessage(m: ChannelMessage): void {
    this.deps.emit('channels:message', { channelId: m.channelId, message: m })
  }

  /** 运行信息里的回复、改动随事件频繁变化，攒一下再写 */
  private saveRuns(soon = false): void {
    if (soon) {
      if (this.runsTimer) return
      this.runsTimer = setTimeout(() => {
        this.runsTimer = null
        void this.store.saveRuns().catch(e => this.deps.log?.('保存频道任务失败', e))
      }, 2000)
      return
    }
    if (this.runsTimer) clearTimeout(this.runsTimer)
    this.runsTimer = null
    void this.store.saveRuns().catch(e => this.deps.log?.('保存频道任务失败', e))
  }

  /** 退出前：把攒着的运行信息写盘，等写完 */
  async dispose(): Promise<void> {
    if (this.changedTimer) clearTimeout(this.changedTimer)
    this.changedTimer = null
    if (this.runsTimer) this.saveRuns()
    await this.store.flush()
  }

  // -------------------------------------------------------------------------
  // 频道
  // -------------------------------------------------------------------------

  private channel(id: string): StoredChannel {
    const c = this.store.channels.get(id)
    if (!c) throw new Error('频道不存在')
    return c
  }

  /** 要改动的频道：归档了只读（§3.1 #11），恢复后才能发消息、派活、改设置 */
  private writable(id: string): StoredChannel {
    const c = this.channel(id)
    if (c.archivedAt) throw new Error('频道已归档，恢复后才能操作')
    return c
  }

  private uniqueChannelName(name: string, except?: string): void {
    for (const c of this.store.channels.values())
      if (c.id !== except && c.name.toLowerCase() === name.toLowerCase()) throw new Error('已经有同名的频道')
  }

  private event(
    channelId: string,
    event: Extract<ChannelMessage, { kind: 'event' }>['event'],
    extra: { targetId?: string; value?: string } = {},
  ): void {
    const m: ChannelMessage = {
      kind: 'event',
      id: randomUUID(),
      channelId,
      at: this.now(),
      event,
      actorId: SELF_ID,
      ...extra,
    }
    void this.store.append(m).catch(e => this.deps.log?.('保存频道消息失败', e))
    this.pushMessage(m)
  }

  async create(raw: ChannelInput): Promise<string> {
    const name = cleanName(raw?.name, '频道名')
    if (typeof raw.teamId === 'string' && raw.teamId)
      return this.createTeamChannel(raw.teamId, name, raw.topic, raw.memberIds)
    this.uniqueChannelName(name)
    const agents = (Array.isArray(raw.memberIds) ? raw.memberIds : []).filter(id => this.member(id))
    const now = this.now()
    const channel: StoredChannel = {
      id: randomUUID(),
      name,
      topic: typeof raw.topic === 'string' && raw.topic.trim() ? raw.topic.trim().slice(0, TOPIC_MAX) : null,
      projectId: typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null,
      memberIds: [SELF_ID, ...new Set(agents)],
      createdAt: now,
      readAt: now,
    }
    await this.store.saveChannel(channel)
    for (const id of new Set(agents)) this.event(channel.id, 'added', { targetId: id })
    this.changed()
    return channel.id
  }

  async update(
    id: string,
    patch: {
      name?: string
      topic?: string | null
      notes?: string | null
      notify?: ChannelNotify
      projectId?: string | null
      /** 归档 / 恢复（只有本机频道） */
      archived?: boolean
    },
  ): Promise<void> {
    const info = this.team?.channelInfo(id)
    if (info) {
      const wire: { name?: string; topic?: string | null } = {}
      if (patch.name !== undefined) wire.name = cleanName(patch.name, '频道名')
      if (patch.topic !== undefined)
        wire.topic =
          typeof patch.topic === 'string' && patch.topic.trim() ? patch.topic.trim().slice(0, TOPIC_MAX) : null
      await this.team!.updateChannel(info.teamId, id, wire)
      return
    }
    const c = { ...this.channel(id) }
    const restoring = patch.archived === false && !!c.archivedAt
    const archiving = patch.archived === true && !c.archivedAt
    // 归档了只读：只能恢复（同一次也可以顺带改别的）
    if (c.archivedAt && !restoring && Object.entries(patch).some(([k, v]) => k !== 'archived' && v !== undefined))
      throw new Error('频道已归档，恢复后才能操作')
    if (archiving && [...this.store.runs.values()].some(r => r.channelId === id && r.phase !== 'ended'))
      throw new Error('频道里还有没做完的活，做完或停掉后再归档')
    if (restoring) {
      c.archivedAt = null
      this.event(id, 'restored')
    }
    if (patch.name !== undefined) {
      const name = cleanName(patch.name, '频道名')
      if (name !== c.name) {
        this.uniqueChannelName(name, id)
        c.name = name
        this.event(id, 'renamed', { value: name })
      }
    }
    if (patch.topic !== undefined) {
      const topic =
        typeof patch.topic === 'string' && patch.topic.trim() ? patch.topic.trim().slice(0, TOPIC_MAX) : null
      if (topic !== c.topic) {
        c.topic = topic
        this.event(id, 'topic', { value: topic ?? '' })
      }
    }
    if (patch.projectId !== undefined)
      c.projectId = typeof patch.projectId === 'string' && patch.projectId ? patch.projectId : null
    if (patch.notify !== undefined) {
      if (patch.notify !== 'all' && patch.notify !== 'important' && patch.notify !== 'mute')
        throw new Error('提醒设置无效')
      c.notify = patch.notify
    }
    if (patch.notes !== undefined)
      c.notes = typeof patch.notes === 'string' && patch.notes.trim() ? patch.notes.trim().slice(0, NOTES_MAX) : null
    // 归档时一并标为已读：收起来的频道不再算未读
    if (archiving) {
      c.archivedAt = this.now()
      c.readAt = c.archivedAt
      this.event(id, 'archived')
    }
    await this.store.saveChannel(c)
    this.changed()
  }

  /** 删除频道：消息没了，开出来的会话保留；进行中的活照常做完，不再跟踪 */
  async delete(id: string): Promise<void> {
    const info = this.team?.channelInfo(id)
    if (info) {
      await this.team!.deleteChannel(info.teamId, id)
      return
    }
    this.channel(id)
    const members = new Set([...this.store.runs.values()].filter(r => r.channelId === id).map(r => r.memberId))
    await this.store.deleteChannel(id)
    this.saveRuns()
    for (const m of members) void this.pump(m)
    this.changed()
  }

  markRead(id: string): void {
    if (this.team?.hasChannel(id)) {
      this.team.markRead(id)
      return
    }
    const c = this.store.channels.get(id)
    if (!c) return
    const last = (this.store.messages.get(id) ?? []).reduce((max, m) => Math.max(max, m.at), 0)
    if (c.readAt >= last) return
    void this.store
      .saveChannel({ ...c, readAt: Math.max(this.now(), last) })
      .catch(e => this.deps.log?.('保存频道失败', e))
    this.changed()
  }

  // -------------------------------------------------------------------------
  // 成员
  // -------------------------------------------------------------------------

  /** 新建或编辑 AI 成员；带 channelId 时顺便加进这个频道 */
  async saveMember(channelId: string | null, raw: AgentInput): Promise<string> {
    const name = cleanName(raw?.name, '成员名')
    if (!ENGINES.has(raw.engine)) throw new Error('不支持的引擎')
    if (typeof raw.projectId !== 'string' || !raw.projectId) throw new Error('请选择工作目录')
    if (this.store.members.some(m => m.id !== raw.id && m.name.toLowerCase() === name.toLowerCase()))
      throw new Error('已经有同名的 AI 成员')
    const project = this.deps.projects().find(p => p.id === raw.projectId)
    if (!project) throw new Error('项目不存在')
    const existing = raw.id ? this.member(raw.id) : undefined
    if (raw.id && !existing) throw new Error('成员不存在')
    // 归档的频道不能加人（已经在里面的成员照常能改）
    const into = channelId ? this.store.channels.get(channelId) : undefined
    if (into && !(existing && into.memberIds.includes(existing.id))) this.writable(into.id)
    // 老数据里已经叫「全体」的成员不改名也能保存
    if (isReservedMentionName(name) && existing?.name.toLowerCase() !== name.toLowerCase())
      throw new Error('「全体」「all」留给 @全体，换个名字吧')
    const settings: AgentConfig['settings'] = {}
    if (raw.settings?.model !== undefined) settings.model = raw.settings.model
    if (raw.settings?.effort !== undefined) settings.effort = raw.settings.effort
    if (raw.settings?.permissionMode !== undefined) settings.permissionMode = raw.settings.permissionMode
    Object.assign(settings, creditOf(raw.settings))
    const machineId = this.deps.machineOf(raw.projectId)
    const credit = (x: AgentConfig['settings']) => JSON.stringify([x.platform ?? null, x.provider ?? null])
    const moved =
      existing &&
      (existing.engine !== raw.engine ||
        existing.projectId !== raw.projectId ||
        existing.copyId !== (raw.copyId ?? null) ||
        credit(existing.settings) !== credit(settings))
    const config: AgentConfig = {
      id: existing?.id ?? randomUUID(),
      name,
      engine: raw.engine,
      machineId,
      projectId: raw.projectId,
      copyId: raw.copyId ?? null,
      settings,
      instructions: (typeof raw.instructions === 'string' ? raw.instructions : '').slice(0, INSTRUCTIONS_MAX),
      mode: raw.mode === 'shared' ? 'shared' : 'per-task',
      // 换了引擎、目录或额度来源（会话开出来就定了），原来的共用会话不能再用
      sharedSessionId: moved ? null : (existing?.sharedSessionId ?? null),
      createdAt: existing?.createdAt ?? this.now(),
    }
    this.store.members = existing
      ? this.store.members.map(m => (m.id === config.id ? config : m))
      : [...this.store.members, config]
    await this.store.saveMembers()
    if (channelId) await this.addMember(channelId, config.id)
    this.changed()
    return config.id
  }

  async addMember(channelId: string, memberId: string): Promise<void> {
    const info = this.team?.channelInfo(channelId)
    if (info) {
      if (this.team!.agentsOfLocal(memberId).some(a => a.channelId === channelId)) return
      return this.registerAgent(info, channelId, memberId, 'approve')
    }
    const c = this.channel(channelId)
    if (!this.member(memberId)) throw new Error('成员不存在')
    if (c.memberIds.includes(memberId)) return
    this.writable(channelId)
    await this.store.saveChannel({ ...c, memberIds: [...c.memberIds, memberId] })
    this.event(channelId, 'added', { targetId: memberId })
    this.changed()
  }

  /** 从频道移除：已经发出去的活照常做完、结果照常发回；还在排队的取消 */
  async removeMember(channelId: string, memberId: string): Promise<void> {
    const info = this.team?.channelInfo(channelId)
    if (info) {
      const agent = this.team!.agentById(memberId)
      if (!agent || agent.channelId !== channelId) return
      await this.team!.deleteAgent(info.teamId, memberId)
      // 还在排队的活取消；已经发出去的照常做完
      for (const run of [...this.store.runs.values()])
        if (run.team?.agentId === memberId && run.phase === 'waiting')
          this.finish(run, { status: 'stopped', note: 'cancelled' })
      return
    }
    const c = this.writable(channelId)
    if (!c.memberIds.includes(memberId) || memberId === SELF_ID) return
    await this.store.saveChannel({ ...c, memberIds: c.memberIds.filter(id => id !== memberId) })
    for (const run of [...this.store.runs.values()])
      if (run.channelId === channelId && run.memberId === memberId && run.phase === 'waiting')
        this.finish(run, { status: 'stopped', note: 'cancelled' })
    this.event(channelId, 'removed', { targetId: memberId })
    this.changed()
  }

  /** 全局删除成员：有没做完的活时不让删 */
  async deleteMember(memberId: string): Promise<void> {
    if (!this.member(memberId)) return
    if ([...this.store.runs.values()].some(r => r.memberId === memberId && r.phase !== 'ended'))
      throw new Error('这个成员还有没做完的活')
    // 团队频道里登记的同名成员一起撤下（云端不通也不挡本机删除）
    for (const a of this.team?.agentsOfLocal(memberId) ?? [])
      await this.team!.deleteAgent(a.teamId, a.id).catch(e => this.deps.log?.('撤下团队 AI 成员失败', e))
    this.store.members = this.store.members.filter(m => m.id !== memberId)
    await this.store.saveMembers()
    for (const c of this.store.channels.values())
      if (c.memberIds.includes(memberId))
        await this.store.saveChannel({ ...c, memberIds: c.memberIds.filter(id => id !== memberId) })
    for (const [id, run] of this.store.runs) if (run.memberId === memberId) this.store.runs.delete(id)
    this.saveRuns()
    this.changed()
  }

  // -------------------------------------------------------------------------
  // 发消息、派活
  // -------------------------------------------------------------------------

  private channelMembers(c: StoredChannel): Mentionable[] {
    return c.memberIds.map(id => ({ id, name: this.nameOf(id), kind: this.member(id) ? 'agent' : 'human' }))
  }

  /** 引用的是任务卡或任务结果：对应的任务卡 */
  private replyTask(channelId: string, replyToId: string | null | undefined): ChannelTask | null {
    if (!replyToId) return null
    const target = this.store.messages.get(channelId)?.find(m => m.id === replyToId)
    if (target?.kind === 'task') return target
    if (target?.kind === 'message' && target.taskId) {
      const task = this.store.task(target.taskId)
      return task?.channelId === channelId ? task : null
    }
    return null
  }

  async post(channelId: string, input: PostInput): Promise<{ message: ChannelTextMessage; tasks: string[] }> {
    if (this.isTeam(channelId)) return this.postTeam(channelId, input)
    const c = this.writable(channelId)
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    const images = validateImages(input?.attachments),
      files = validateFiles(input?.files)
    if (!text && !images.length && !files.length) throw new Error('消息不能为空')
    const clientId = typeof input.clientId === 'string' ? input.clientId : randomUUID()
    const known = this.posted.get(clientId)
    if (known) {
      const m = this.store.messages.get(channelId)?.find(x => x.id === known)
      if (m?.kind === 'message') return { message: m, tasks: [] }
    }
    const members = this.channelMembers(c)
    const replyToId =
      input.replyToId && this.store.messages.get(channelId)?.some(m => m.id === input.replyToId)
        ? input.replyToId
        : null
    const now = this.now()
    const message: ChannelTextMessage = {
      kind: 'message',
      id: randomUUID(),
      channelId,
      at: now,
      authorId: SELF_ID,
      text,
      format: 'plain',
      replyToId,
      mentions: parseMentions(text, members).filter(id => id !== SELF_ID),
    }
    if (images.length || files.length) {
      // 全文先写好再追加消息：消息出现时附件一定读得到
      await this.store.saveAttachments(channelId, message.id, { images, files })
      message.attached = {
        images: images.map(({ dataBase64: _d, ...meta }) => meta),
        files: files.map(({ text: _t, tail: _l, ...meta }) => meta),
      }
    }
    this.posted.set(clientId, message.id)
    await this.store.append(message)
    // 发消息就算看过了
    await this.store.saveChannel({ ...c, readAt: now })
    this.pushMessage(message)
    const agents = (message.mentions ?? []).filter(id => this.member(id))
    const target = this.replyTask(channelId, replyToId)
    const tasks: string[] = []
    if (target && agents.every(id => id === target.assigneeId)) {
      this.followUp(c, target, message)
      tasks.push(target.id)
    } else for (const id of agents) tasks.push(this.newTask(c, message, id, replyToId))
    this.changed()
    return { message, tasks }
  }

  /** 一条消息带的图片和文件全文（团队频道没有附件） */
  async attachments(channelId: string, messageId: string): Promise<ChannelAttachments> {
    if (this.isTeam(channelId)) return { images: [], files: [] }
    this.channel(channelId)
    return this.store.readAttachments(channelId, messageId)
  }

  /** 这一轮要带上的附件：几条消息的合在一起，超过一条消息的上限时后面的图片不带；引擎不收图片时只带文件 */
  private async attachmentsFor(
    run: TaskRun,
    member: AgentConfig,
  ): Promise<{ input: Pick<MessageInput, 'attachments' | 'files'>; dropped: { images: number; files: number } }> {
    const dropped = { images: 0, files: 0 }
    if (!run.attach?.length) return { input: {}, dropped }
    const images: ChannelAttachments['images'] = [],
      files: ChannelAttachments['files'] = []
    let total = 0
    for (const id of run.attach) {
      const data = await this.store.readAttachments(run.channelId, id)
      for (const image of data.images)
        if (images.length < MAX_IMAGE_COUNT && total + image.bytes <= MAX_IMAGE_TOTAL) {
          images.push(image)
          total += image.bytes
        } else dropped.images++
      files.push(...data.files)
    }
    const takesImages = ENGINE_INFO[member.engine]?.caps.imageInput === true
    if (!takesImages) dropped.images += images.length
    const kept = { attachments: takesImages ? images : [], files: files.slice(0, 10) }
    // 文件全文合计超了就一个个往回减，直到能发
    while (kept.files.length) {
      try {
        validateFiles(kept.files)
        break
      } catch {
        kept.files = kept.files.slice(0, -1)
      }
    }
    dropped.files = files.length - kept.files.length
    return {
      input: {
        ...(kept.attachments.length ? { attachments: kept.attachments } : {}),
        ...(kept.files.length ? { files: kept.files } : {}),
      },
      dropped,
    }
  }

  /** 第一次派给成员的提示词：带最近的讨论和被引用的消息 */
  private freshPrompt(
    c: StoredChannel,
    source: ChannelTextMessage,
    member: AgentConfig,
    replyToId: string | null,
    shared: boolean,
  ): string {
    const list = this.store.messages.get(c.id) ?? []
    const locale = this.deps.locale()
    // 一直用同一个会话：只补上次派给它之后的消息
    let since: number | null = null
    if (shared && member.sharedSessionId)
      for (const m of list)
        if (
          m.kind === 'task' &&
          m.assigneeId === member.id &&
          m.at < source.at &&
          m.sessionId === member.sharedSessionId
        )
          since = m.at
    const quoted = replyToId ? list.find(m => m.id === replyToId) : undefined
    const quotedText =
      quoted?.kind === 'message'
        ? `${this.nameOf(quoted.authorId)}${locale === 'en-US' ? ': ' : '：'}${quoted.text}`
        : quoted?.kind === 'task'
          ? quoted.title
          : null
    return dispatchPrompt({
      locale,
      channel: { name: c.name, topic: c.topic },
      notes: c.notes ?? null,
      pinned: this.pinnedLines(c),
      author: this.nameOf(SELF_ID),
      instructions: member.instructions,
      history: historyLines(list, { beforeId: source.id, since, skip: replyToId, nameOf: this.nameOf, locale }),
      quoted: quotedText,
      request: source.text,
      attached: source.attached ? { images: source.attached.images.length, files: source.attached.files.length } : null,
      together: this.together(c, source, member.id),
    })
  }

  /** 置顶的消息（还在的、是文字消息的）：「名字：原文」，派活时作为资料带上 */
  private pinnedLines(c: StoredChannel): string[] {
    const list = this.store.messages.get(c.id) ?? []
    const sep = this.deps.locale() === 'en-US' ? ': ' : '：'
    return (c.pinned ?? []).flatMap(id => {
      const m = list.find(x => x.id === id)
      return m?.kind === 'message' && m.text.trim() ? [`${this.nameOf(m.authorId)}${sep}${m.text.trim()}`] : []
    })
  }

  /** 置顶 / 取消置顶一条文字消息（本机频道） */
  async pin(channelId: string, messageId: string, pinned: boolean): Promise<void> {
    const c = { ...this.writable(channelId) }
    const message = (this.store.messages.get(channelId) ?? []).find(m => m.id === messageId)
    if (message?.kind !== 'message') throw new Error('只能置顶文字消息')
    const list = (c.pinned ?? []).filter(id => id !== messageId)
    if (pinned) {
      if (list.length >= PIN_MAX) throw new Error(`最多置顶 ${PIN_MAX} 条`)
      list.push(messageId)
    }
    c.pinned = list
    await this.store.saveChannel(c)
    this.changed()
  }

  /** 源消息 @全体 时，同时收到这项活的其他 AI 成员的名字 */
  private together(c: StoredChannel, source: ChannelTextMessage, memberId: string): string[] {
    if (!mentionsAll(source.text, this.channelMembers(c))) return []
    return (source.mentions ?? []).filter(id => id !== memberId && this.member(id)).map(this.nameOf)
  }

  private newTask(c: StoredChannel, source: ChannelTextMessage, memberId: string, replyToId: string | null): string {
    const member = this.member(memberId)!
    const now = this.now()
    const task: ChannelTask = {
      kind: 'task',
      id: randomUUID(),
      channelId: c.id,
      at: now,
      authorId: SELF_ID,
      assigneeId: memberId,
      title:
        taskTitle(source.text, this.channelMembers(c)) ||
        // 只 @ 了人、没写字：用附件的文件名
        [...(source.attached?.images ?? []), ...(source.attached?.files ?? [])]
          .map(a => a.name)
          .join('、')
          .slice(0, 60) ||
        source.text.slice(0, 60),
      status: 'queued',
      sessionId: null,
      sourceMessageId: source.id,
      round: 1,
    }
    void this.store.append(task).catch(e => this.deps.log?.('保存频道消息失败', e))
    this.pushMessage(task)
    const prompt = this.freshPrompt(c, source, member, replyToId, member.mode === 'shared')
    const run: TaskRun = {
      taskId: task.id,
      channelId: c.id,
      memberId,
      phase: 'waiting',
      queuedAt: now,
      round: 1,
      sessionId: null,
      clientMessageId: null,
      prompt,
      // 共用会话被删了、要新开时，带完整的讨论
      freshPrompt: member.mode === 'shared' ? this.freshPrompt(c, source, member, replyToId, false) : prompt,
      started: false,
      turnId: null,
      requests: [],
      diff: {},
      reply: null,
      progress: null,
      followUps: [],
      notice: null,
      ...(source.attached ? { attach: [source.id] } : {}),
    }
    this.store.runs.set(task.id, run)
    this.saveRuns()
    void this.pump(memberId)
    return task.id
  }

  /** 回复任务卡 = 追加要求（§7.1）：还在做时等这一轮做完再发 */
  private followUp(c: StoredChannel, task: ChannelTask, source: ChannelTextMessage): void {
    const member = this.member(task.assigneeId)
    if (!member) return
    const locale = this.deps.locale()
    const note = source.attached
      ? attachedNote(source.attached.images.length, source.attached.files.length, locale)
      : ''
    const text = followUpPrompt({
      locale,
      channel: c.name,
      author: this.nameOf(SELF_ID),
      text: [source.text, note].filter(Boolean).join('\n'),
    })
    const run = this.store.runs.get(task.id)
    const attach = source.attached ? [source.id] : []
    if (run && run.phase !== 'ended') {
      this.store.runs.set(task.id, {
        ...run,
        followUps: [...run.followUps, text],
        ...(attach.length ? { followUpAttach: [...(run.followUpAttach ?? []), ...attach] } : {}),
      })
      this.saveRuns()
      return
    }
    this.nextRound(
      task,
      run ?? null,
      text,
      this.freshPrompt(c, source, member, task.id, false),
      undefined,
      undefined,
      attach,
    )
  }

  /** 开始下一轮（追加要求、重试）：排进成员的队列 */
  private nextRound(
    task: ChannelTask,
    run: TaskRun | null,
    prompt: string,
    fresh: string,
    team?: TeamRunRef,
    memberId?: string,
    /** 这一轮要带上哪些消息的附件 */
    attach?: string[],
  ): void {
    // 团队活：云端任务卡的轮次可能已经被追加要求加过了
    const round = team ? Math.max((run?.round ?? task.round ?? 1) + 1, task.round ?? 0) : (task.round ?? 1) + 1
    const next: TaskRun = {
      taskId: task.id,
      channelId: task.channelId,
      memberId: memberId ?? task.assigneeId,
      phase: 'waiting',
      queuedAt: this.now(),
      round,
      sessionId: run?.sessionId ?? task.sessionId ?? null,
      clientMessageId: null,
      prompt,
      freshPrompt: fresh,
      started: false,
      turnId: null,
      requests: [],
      diff: {},
      reply: null,
      progress: null,
      followUps: [],
      notice: null,
      ...(attach?.length ? { attach } : {}),
      ...(team ? { team: { ...team, final: undefined } } : {}),
    }
    this.store.runs.set(task.id, next)
    this.patch(task.channelId, task.id, {
      status: 'queued',
      round,
      error: null,
      note: null,
      decision: null,
      request: null,
      progress: null,
      endedAt: null,
    })
    this.saveRuns()
    void this.pump(next.memberId)
  }

  private patch(channelId: string, taskId: string, patch: Partial<ChannelTask>): ChannelTask | null {
    const run = this.store.runs.get(taskId)
    if (run?.team) return this.patchTeam(run, patch)
    const task = this.store.patchTask(channelId, taskId, patch)
    if (task) this.pushMessage(task)
    return task
  }

  /** 成员空出来了就开始它最早排队的那项活；还在忙就更新排队的「前面还有 N 项」 */
  private async pump(memberId: string): Promise<void> {
    const runs = [...this.store.runs.values()].filter(r => r.memberId === memberId)
    const busy = runs.some(r => r.phase === 'sent')
    const waiting = runs.filter(r => r.phase === 'waiting').sort((a, b) => a.queuedAt - b.queuedAt)
    waiting.forEach((r, i) => {
      const ahead = i + (busy ? 1 : 0)
      if (this.taskOf(r)?.ahead !== ahead) this.patch(r.channelId, r.taskId, { ahead })
    })
    this.changed()
    if (busy || !waiting.length) return
    await this.start(waiting[0])
  }

  private sessionExists(id: string | null | undefined): boolean {
    return !!id && this.deps.sessions().some(s => s.record.id === id)
  }

  private async start(run: TaskRun): Promise<void> {
    const member = this.member(run.memberId)
    const task = this.taskOf(run)
    if (!member || !task || (!run.team && !this.store.channels.has(run.channelId))) {
      this.store.runs.delete(run.taskId)
      this.saveRuns()
      return
    }
    // 先占住成员，免得同时开始两项
    const cmid = clientMessageId(task.id, run.round)
    let current: TaskRun = { ...run, phase: 'sent', clientMessageId: cmid }
    this.store.runs.set(run.taskId, current)
    this.patch(run.channelId, run.taskId, { ahead: 0, disconnected: false })
    try {
      if (!this.machineOnline(member.machineId)) {
        const name = this.deps.machines().find(m => m.id === member.machineId)?.name ?? member.machineId
        throw new Error(`机器「${name}」未连接`)
      }
      let sessionId = current.sessionId
      let text = current.prompt
      if (!this.sessionExists(sessionId)) {
        sessionId =
          member.mode === 'shared' && this.sessionExists(member.sharedSessionId) ? member.sharedSessionId : null
        if (!sessionId) {
          sessionId = await this.createSession(member, task.title)
          text = current.freshPrompt
        } else if (current.round > 1) text = current.freshPrompt
      }
      current = { ...current, sessionId }
      this.store.runs.set(run.taskId, current)
      this.patch(run.channelId, run.taskId, { sessionId, status: 'queued' })
      this.saveRuns()
      const extra = await this.attachmentsFor(current, member)
      // 几条消息的附件合在一起超过一条消息的上限、带不上的，告诉 AI 一声
      const lost = droppedNote(extra.dropped.images, extra.dropped.files, this.deps.locale())
      await this.deps.call('engine:send', [
        sessionId,
        { text: lost ? `${text}\n\n${lost}` : text, clientMessageId: cmid, ...extra.input },
      ])
    } catch (error) {
      const latest = this.store.runs.get(run.taskId)
      if (latest && latest.phase === 'sent' && !latest.started)
        this.finish(latest, { status: 'failed', error: message(error) })
    }
  }

  private async createSession(member: AgentConfig, title: string): Promise<string> {
    const record = (await this.deps.call('engine:createSession', [
      {
        projectId: member.projectId,
        engine: member.engine,
        ...member.settings,
        ...(member.copyId ? { copyId: member.copyId } : {}),
      },
    ])) as SessionRecord
    const shared = member.mode === 'shared'
    // 侧栏里认得出来：会话标题用任务标题（共用会话用成员名）
    await this.deps
      .call('engine:renameSession', [record.id, shared ? member.name : title])
      .catch(e => this.deps.log?.('频道会话改名失败', e))
    if (shared) {
      this.store.members = this.store.members.map(m => (m.id === member.id ? { ...m, sharedSessionId: record.id } : m))
      await this.store.saveMembers()
    }
    return record.id
  }

  /** 这一轮结束：更新任务卡，做完了就把回复发回频道，再开始成员的下一项活 */
  private finish(run: TaskRun, finish: Finish): void {
    const task = this.taskOf(run)
    const ended: TaskRun = { ...run, phase: 'ended', requests: [], progress: null, activity: null }
    this.store.runs.set(run.taskId, ended)
    if (task) {
      const now = this.now()
      let teamResult: { text: string; mentions: string[] } | undefined
      const patch: Partial<ChannelTask> = {
        status: finish.status,
        error: finish.status === 'failed' ? (finish.error ?? null) : null,
        note: finish.note ?? null,
        request: null,
        progress: null,
        activity: null,
        ahead: 0,
        disconnected: false,
        endedAt: now,
      }
      if (finish.status === 'done' || run.reply) {
        const diff = diffTotal(run)
        if (diff) patch.diff = diff
      }
      if (finish.status === 'done') {
        const reply = run.reply?.trim() ?? ''
        const locale = this.deps.locale()
        patch.summary = reply ? summaryOf(reply) : locale === 'en-US' ? 'No reply text' : '没有回复文字'
        patch.decision = reply ? decisionOf(reply) : null
        if (reply && run.team) {
          // 团队活：结果由执行端以 AI 成员的身份发到云端频道（随任务卡的收尾一起，没发成功会补发）
          const decide = patch.decision && run.team.author ? [run.team.author] : []
          teamResult = { text: clipResult(reply, locale), mentions: decide }
        } else if (reply) {
          const result: ChannelTextMessage = {
            kind: 'message',
            id: randomUUID(),
            channelId: run.channelId,
            at: now,
            authorId: run.memberId,
            text: clipResult(reply, locale),
            format: 'markdown',
            replyToId: task.id,
            taskId: task.id,
            mentions: patch.decision ? [SELF_ID] : [],
          }
          if (this.store.channels.has(run.channelId)) {
            void this.store.append(result).catch(e => this.deps.log?.('保存频道消息失败', e))
            this.pushMessage(result)
          }
        }
      }
      if (run.team) this.patchTeam(ended, patch, teamResult)
      else this.patch(run.channelId, run.taskId, patch)
      // 做的时候追加的要求：接着发
      if (run.followUps.length && finish.note !== 'cancelled') {
        const text = run.followUps.join('\n\n')
        this.nextRound(
          { ...task, ...patch } as ChannelTask,
          ended,
          text,
          text,
          run.team,
          run.memberId,
          run.followUpAttach,
        )
        return
      }
    }
    this.saveRuns()
    this.prune()
    void this.pump(run.memberId)
  }

  /** 去掉很久以前结束的运行信息 */
  private prune(): void {
    const cutoff = this.now() - KEEP_ENDED
    for (const [id, run] of this.store.runs) {
      if (run.phase !== 'ended') continue
      if (run.team) {
        // 团队活：卡片在云端；收尾没写回去之前不能丢
        if (run.queuedAt < cutoff && !run.team.final) {
          this.store.runs.delete(id)
          this.teamLocal.delete(id)
        }
        continue
      }
      const task = this.store.task(id)
      if (!task || (task.endedAt ?? task.at) < cutoff) this.store.runs.delete(id)
    }
  }

  private apply(run: TaskRun, tracked: Tracked): void {
    if (tracked.run !== run) {
      this.store.runs.set(run.taskId, tracked.run)
      this.saveRuns(!tracked.finish && tracked.run.started === run.started)
    }
    if (tracked.patch) this.patch(run.channelId, run.taskId, tracked.patch)
    if (tracked.finish) this.finish(tracked.run, tracked.finish)
    else if (tracked.patch?.status) this.changed()
  }

  // -------------------------------------------------------------------------
  // 卡片上的操作
  // -------------------------------------------------------------------------

  async taskAction(taskId: string, action: ChannelTaskAction): Promise<void> {
    // 团队卡：请求记在云端卡片上，由主人的电脑执行
    if (this.team?.card(taskId)) {
      await this.team.taskCall(taskId, teamId => this.team!.api.action(teamId, taskId, action))
      return
    }
    return this.runAction(taskId, action)
  }

  /** 本机执行 Phase B 的取消 / 停止 / 重试（本机频道直接调，团队卡由执行端收到请求后调） */
  private async runAction(taskId: string, action: ChannelTaskAction): Promise<void> {
    const run = this.store.runs.get(taskId)
    const task = run?.team ? this.taskOf(run) : this.store.task(taskId)
    if (!task) throw new Error('任务不存在')
    if (action === 'retry') {
      if (!terminal(task.status)) return
      if (!this.member(task.assigneeId)) throw new Error('成员不存在')
      const c = this.writable(task.channelId)
      const source = this.store.messages.get(c.id)?.find(m => m.id === task.sourceMessageId)
      const fresh =
        source?.kind === 'message'
          ? this.freshPrompt(c, source, this.member(task.assigneeId)!, source.replyToId ?? null, false)
          : (run?.freshPrompt ?? task.title)
      // 还没开始就失败：原样再发一次；做到一半：发「继续」
      const prompt = run?.started ? continuePrompt(this.deps.locale()) : (run?.prompt ?? fresh)
      // 还没开始就失败的，附件原样再带；做到一半的会话里已经有了
      const attach = run?.started
        ? undefined
        : (run?.attach ?? (source?.kind === 'message' && source.attached ? [source.id] : undefined))
      this.nextRound(task, run ?? null, prompt, fresh, undefined, undefined, attach)
      return
    }
    if (!run || run.phase === 'ended') return
    if (run.phase === 'waiting') {
      this.finish(run, { status: 'stopped', note: 'cancelled' })
      return
    }
    if (action === 'stop' && run.started && run.sessionId && run.turnId) {
      await this.deps.call('engine:interruptTurn', [run.sessionId, run.turnId])
      return
    }
    if (!run.started && run.sessionId && run.clientMessageId) {
      await this.deps.call('engine:cancelQueued', [run.sessionId, run.clientMessageId]).catch(() => undefined)
      const latest = this.store.runs.get(taskId)
      if (latest?.phase === 'sent' && !latest.started) this.finish(latest, { status: 'stopped', note: 'cancelled' })
    }
  }

  // -------------------------------------------------------------------------
  // 会话事件、对账
  // -------------------------------------------------------------------------

  hostEvent(event: HostEvent): void {
    if (event.kind === 'session') {
      for (const run of [...this.store.runs.values()])
        if (run.phase === 'sent' && run.sessionId === event.sessionId)
          this.apply(run, trackEvent(run, event.event, this.now()))
    } else if (event.kind === 'sessions') this.sessionsChanged(event.sessions)
    else if (event.kind === 'projects') this.changed()
  }

  /** 会话被删了：进行中的活算失败（只看连着的机器，断开的机器会话列表不可信） */
  private sessionsChanged(sessions: SessionSummary[]): void {
    const ids = new Set(sessions.map(s => s.record.id))
    for (const run of [...this.store.runs.values()]) {
      if (run.phase !== 'sent' || !run.sessionId || ids.has(run.sessionId)) continue
      const member = this.member(run.memberId)
      if (member && this.machineOnline(member.machineId)) this.finish(run, { status: 'failed', error: '会话已删除' })
    }
  }

  /** 机器连上 / 断开（machines:changed） */
  machinesChanged(): void {
    const machines = this.deps.machines()
    const down = new Set(machines.filter(m => m.id !== 'local' && !m.connected).map(m => m.id))
    const up = [...this.offline].filter(id => !down.has(id))
    this.offline = down
    for (const run of this.store.runs.values()) {
      if (run.phase !== 'sent') continue
      const member = this.member(run.memberId)
      if (member && down.has(member.machineId) && !this.taskOf(run)?.disconnected)
        this.patch(run.channelId, run.taskId, { disconnected: true })
    }
    if (up.length) void this.reconcile(id => up.includes(id))
    this.changed()
  }

  /** 按会话快照对账（启动时全部，重连时那台机器的） */
  async reconcile(machine: (id: string) => boolean = () => true): Promise<void> {
    for (const run of [...this.store.runs.values()]) {
      const member = this.member(run.memberId)
      if (!member || !machine(member.machineId)) continue
      if (run.phase === 'waiting') continue
      if (run.phase !== 'sent' || !run.sessionId) continue
      if (!this.machineOnline(member.machineId)) {
        this.patch(run.channelId, run.taskId, { disconnected: true })
        continue
      }
      let snapshot: OpenedSession['snapshot'] | null = null
      try {
        snapshot = ((await this.deps.call('engine:openSession', [run.sessionId])) as OpenedSession).snapshot
      } catch (error) {
        if (!/不存在|not found/i.test(message(error))) {
          this.deps.log?.('频道任务对账失败', error)
          continue
        }
      }
      const latest = this.store.runs.get(run.taskId)
      if (!latest || latest.phase !== 'sent') continue
      this.patch(run.channelId, run.taskId, { disconnected: false })
      this.apply(latest, reconcileRun(latest, snapshot, this.now()))
    }
    for (const m of new Set([...this.store.runs.values()].filter(r => r.phase === 'waiting').map(r => r.memberId)))
      void this.pump(m)
  }

  // -------------------------------------------------------------------------
  // Phase C：团队频道（docs/ui/channels-phase-c.md）
  // -------------------------------------------------------------------------

  /** 一项活现在的任务卡：本机频道从存储取，团队活从云端缓存取并补上只在本机有的信息 */
  private taskOf(run: TaskRun): ChannelTask | null {
    if (!run.team) return this.store.task(run.taskId)
    const card = this.team?.taskOf(run.taskId)
    if (card) return this.decorate(card) as ChannelTask
    // 云端卡片还没拉到（刚启动、没连上）：按运行信息凑一张
    const status: ChannelTask['status'] =
      run.phase === 'ended'
        ? 'done'
        : run.requests.length
          ? 'waiting'
          : run.phase === 'sent' && run.started
            ? 'running'
            : 'queued'
    return this.decorate({
      kind: 'task',
      id: run.taskId,
      channelId: run.channelId,
      at: run.queuedAt,
      authorId: run.team.author ?? '',
      assigneeId: run.team.agentId ?? run.memberId,
      title: run.team.title ?? '',
      status,
      sessionId: null,
      round: run.round,
      ownerId: this.team?.getMe()?.id,
    }) as ChannelTask
  }

  /** 我自己的活：补上会话、待确认请求、排队、断开这些只在本机有的信息 */
  private decorate(m: ChannelMessage): ChannelMessage {
    if (m.kind !== 'task') return m
    const run = this.store.runs.get(m.id)
    if (!run?.team) return m
    const local = this.teamLocal.get(m.id)
    return {
      ...m,
      sessionId: run.sessionId ?? m.sessionId ?? null,
      request: m.status === 'waiting' ? (run.requests[0] ?? null) : null,
      ...(local?.ahead !== undefined ? { ahead: local.ahead } : {}),
      ...(local?.disconnected !== undefined ? { disconnected: local.disconnected } : {}),
    }
  }

  /** 团队活的任务卡变化：本机才有的信息留在内存，其余交给执行端写回云端 */
  private patchTeam(
    run: TaskRun,
    patch: Partial<ChannelTask>,
    result?: { text: string; mentions: string[] },
  ): ChannelTask | null {
    if (patch.ahead !== undefined || patch.disconnected !== undefined) {
      const local = { ...this.teamLocal.get(run.taskId) }
      if (patch.ahead !== undefined) local.ahead = patch.ahead
      if (patch.disconnected !== undefined) local.disconnected = patch.disconnected
      this.teamLocal.set(run.taskId, local)
    }
    // 「正在做什么」只给本机任务卡（团队卡上写云端会多一大堆更新）
    const { activity: _activity, ...wire } = patch
    if (Object.keys(wire).length || result) this.exec?.send(run, wire, result)
    const task = this.taskOf(run)
    if (task) this.pushMessage(task)
    return task
  }

  /** 这一轮还没做完时又有人追加要求：攒着，做完接着发；云端卡片已回到排队，把现在的状态写回去 */
  private addTeamFollowUp(taskId: string, text: string, team: TeamRunRef): void {
    const run = this.store.runs.get(taskId)
    if (!run) return
    const next: TaskRun = {
      ...run,
      followUps: [...run.followUps, text],
      team: { ...(run.team ?? team), follow: team.follow },
    }
    this.store.runs.set(taskId, next)
    this.saveRuns()
    this.patchTeam(next, { status: run.requests.length ? 'waiting' : run.started ? 'running' : 'queued' })
  }

  /** 上报给云端的成员状态 */
  private teamAgentStatus(localId: string): {
    status: 'idle' | 'running' | 'waiting' | 'offline'
    task: string | null
  } {
    const config = this.member(localId)
    if (!config) return { status: 'offline', task: null }
    const runs = [...this.store.runs.values()].filter(r => r.memberId === localId)
    const tasks = runs.map(r => this.taskOf(r)).filter((t): t is ChannelTask => !!t)
    const active =
      tasks.find(t => t.status === 'waiting') ??
      tasks.find(t => !terminal(t.status) && this.store.runs.get(t.id)?.phase === 'sent')
    if (!this.machineOnline(config.machineId)) return { status: 'offline', task: null }
    return {
      status: tasks.some(t => t.status === 'waiting') ? 'waiting' : active ? 'running' : 'idle',
      task: active?.title ?? null,
    }
  }

  /** 我的 AI 成员在本机的情况（团队频道的成员行用） */
  private teamAgentView(localId: string): AgentMember | undefined {
    const config = this.member(localId)
    if (!config) return undefined
    const projects = new Map(this.deps.projects().map(p => [p.id, p]))
    return this.agentView(config, projects, this.deps.machines())
  }

  private requireTeam(): TeamSync {
    if (!this.team) throw new Error('团队功能暂不可用')
    return this.team
  }

  private async createTeamChannel(
    teamId: string,
    name: string,
    topic: string | null | undefined,
    memberIds: string[] | undefined,
  ): Promise<string> {
    const team = this.requireTeam()
    const role = team.roleIn(teamId)
    if (!role) throw new Error('团队不存在')
    if (role === 'observer') throw new Error('观察者不能建频道')
    const id = await team.createChannel(teamId, {
      name,
      topic: typeof topic === 'string' && topic.trim() ? topic.trim().slice(0, TOPIC_MAX) : null,
    })
    for (const memberId of new Set(Array.isArray(memberIds) ? memberIds.filter(m => this.member(m)) : []))
      await this.registerAgent({ teamId, role }, id, memberId, 'approve').catch(e =>
        this.deps.log?.('登记团队 AI 成员失败', e),
      )
    return id
  }

  /** 把自己的 AI 成员登记到团队频道（已登记的更新派活规则）。云端只存名字、引擎、模型、机器名、项目名和规则 */
  private async registerAgent(
    info: { teamId: string; role: TeamRole },
    channelId: string,
    localId: string,
    policy: AgentPolicy,
  ): Promise<void> {
    if (info.role === 'observer') throw new Error('观察者不能添加 AI 成员')
    const config = this.member(localId)
    if (!config) throw new Error('成员不存在')
    const project = this.deps.projects().find(p => p.id === config.projectId)
    const machine =
      config.machineId === 'local'
        ? (this.deps.machineName?.() ?? '这台电脑')
        : (this.deps.machines().find(m => m.id === config.machineId)?.name ?? config.machineId)
    const reg: AgentRegistration = {
      name: config.name,
      engine: config.engine,
      model: config.settings.model ?? '',
      machine,
      project: project?.name ?? '',
      policy,
    }
    await this.requireTeam().putAgent(info.teamId, channelId, config.id, reg)
  }

  /** 团队频道里我的 AI 成员：别人 @ 它要不要我同意 */
  async setAgentPolicy(channelId: string, memberId: string, policy: AgentPolicy): Promise<void> {
    if (policy !== 'approve' && policy !== 'team') throw new Error('不支持的派活规则')
    const team = this.requireTeam()
    const info = team.channelInfo(channelId)
    if (!info) throw new Error('频道不存在')
    const agent = team.agentById(memberId)
    if (!agent || agent.channelId !== channelId || agent.owner !== team.getMe()?.id)
      throw new Error('只能设置自己的 AI 成员')
    await this.registerAgent(info, channelId, agent.localId, policy)
  }

  /** 等主人同意的活：同意 / 拒绝 */
  async approveTask(taskId: string, approve: boolean): Promise<void> {
    const team = this.requireTeam()
    await team.taskCall(taskId, teamId => team.api.approve(teamId, taskId, !!approve))
  }

  private async postTeam(
    channelId: string,
    input: PostInput,
  ): Promise<{ message: ChannelTextMessage; tasks: string[] }> {
    const team = this.requireTeam()
    const info = team.channelInfo(channelId)
    if (!info) throw new Error('频道不存在')
    const text = typeof input?.text === 'string' ? input.text.trim() : ''
    if (input?.attachments?.length || input?.files?.length) throw new Error('团队频道暂不支持附件')
    if (!text) throw new Error('消息不能为空')
    const me = team.getMe()?.id
    // 观察者不能派活：@ AI 成员只当文字
    const mentions = parseMentions(text, team.mentionables(channelId)).filter(
      id => id !== me && (info.role !== 'observer' || !team.agentById(id)),
    )
    const res = await team.post(channelId, {
      clientId: typeof input.clientId === 'string' ? input.clientId : randomUUID(),
      text,
      replyTo: input.replyToId ?? null,
      mentions,
    })
    if (res.message?.kind !== 'message') throw new Error('云端返回的数据异常')
    // 发消息就算看过了
    team.markRead(channelId)
    return { message: res.message, tasks: res.tasks }
  }

  async createTeam(name: string): Promise<string> {
    return this.requireTeam().createTeam(cleanName(name, '团队名'))
  }
  async updateTeam(teamId: string, patch: { name: string }): Promise<void> {
    return this.requireTeam().updateTeam(teamId, { name: cleanName(patch?.name, '团队名') })
  }
  deleteTeam(teamId: string): Promise<void> {
    return this.requireTeam().deleteTeam(teamId)
  }
  async renameSelf(teamId: string, name: string): Promise<void> {
    const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
    if (!clean || clean.length > 32) throw new Error('显示名要 1–32 个字')
    return this.requireTeam().rename(teamId, clean)
  }
  async invite(teamId: string, email: string, role: Exclude<TeamRole, 'owner'>): Promise<void> {
    const mail = typeof email === 'string' ? email.trim().toLowerCase() : ''
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('邮箱格式不对')
    if (role !== 'member' && role !== 'observer') throw new Error('角色不对')
    return this.requireTeam().invite(teamId, mail, role)
  }
  revokeInvite(teamId: string, inviteId: string): Promise<void> {
    return this.requireTeam().revokeInvite(teamId, inviteId)
  }
  respondInvite(inviteId: string, accept: boolean): Promise<void> {
    return this.requireTeam().respondInvite(inviteId, !!accept)
  }
  async setRole(teamId: string, userId: string, role: Exclude<TeamRole, 'owner'>): Promise<void> {
    if (role !== 'member' && role !== 'observer') throw new Error('角色不对')
    return this.requireTeam().setRole(teamId, userId, role)
  }
  removeTeamMember(teamId: string, userId: string): Promise<void> {
    return this.requireTeam().removeMember(teamId, userId)
  }
  async refreshTeams(): Promise<void> {
    await this.team?.refresh()
  }

  /** 窗口获得焦点 */
  focus(): void {
    this.team?.focus()
  }
}

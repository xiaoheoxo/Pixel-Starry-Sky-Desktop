// 团队数据的同步与缓存（docs/ui/channels-phase-c.md §5.2、§9.1）：总览、每个已打开频道的消息缓存、
// seq 补齐、在线状态、已读；把团队数据转成 Channel / ChannelMember / ChannelMessage。只缓存在内存里，不落盘。
import type {
  AgentMember,
  AgentPolicy,
  Channel,
  ChannelEvent,
  ChannelMember,
  ChannelMessage,
  ChannelTask,
  HumanMember,
  PendingInvite,
  TeamInfo,
  TeamRole,
  TeamsConnection,
} from '../../../../shared/types/channels'
import {
  TeamError,
  type AgentRegistration,
  type Overview,
  type TaskPatch,
  type TeamAgentData,
  type TeamApi,
  type TeamChannelData,
  type TeamData,
  type TeamMessage,
  type TeamTaskData,
} from './api'
import type { RealtimeStatus, TeamFrame } from './realtime'
import type { Mentionable } from '../../../../shared/channels/mentions'
import { titleWithoutAll } from '../prompt'

/** 每个频道最多缓存最近这么多条，往上翻再拉 */
export const CACHE_MAX = 500
const FIRST_PAGE = 100
const PAGE = 200
const FOCUS_MIN_MS = 15_000
const RELOAD_RETRY_MIN = 3000
const RELOAD_RETRY_MAX = 60_000

export interface RealtimeLike {
  start(): void
  stop(): void
  restart(): void
}

export type ReadyReason = 'start' | 'connected' | 'focus' | 'manual'

export interface TeamSyncListener {
  /** 总览、未读、在线状态、连接状态变了：重发频道快照 */
  changed?(): void
  /** 新消息或任务卡更新（已转成频道消息） */
  message?(push: { channelId: string; message: ChannelMessage }): void
  /** 有任务卡进来或变了（执行端用） */
  card?(teamId: string, channelId: string, message: TeamMessage): void
  /** 连上云端并拉完总览（执行端补拉待办） */
  ready?(reason: ReadyReason): void
}

export interface TeamSyncDeps {
  api: TeamApi
  /** 创建实时通道；帧和状态交给 TeamSync 处理 */
  realtime: (handlers: { onFrame(frame: TeamFrame): void; onStatus(status: RealtimeStatus): void }) => RealtimeLike
  now?: () => number
  log?: (message: string, error?: unknown) => void
  /** 我自己的 AI 成员在本机的情况（状态、配置、会话）；没有就只用云端登记的信息 */
  localAgent?: (localId: string) => Partial<AgentMember> | undefined
}

interface Cache {
  teamId: string
  /** 按 n 升序 */
  list: TeamMessage[]
  /** 比最老的一条更早的还有 */
  hasMore: boolean
  /** 补齐到这个 seq 为止都在缓存里了 */
  syncedSeq: number
}

interface Meta {
  teamId: string
  data: TeamChannelData
  unread: number
  mentioned: boolean
  lastN: number
  lastAt: number
  readN: number
}

/** 云端事件类型 → 事件行（不认识的不显示） */
function eventKind(type: string): ChannelEvent['event'] | null {
  switch (type.replace(/[_\-\s]/g, '').toLowerCase()) {
    case 'joined':
      return 'joined'
    case 'left':
      return 'left'
    case 'added':
      return 'added'
    case 'removed':
      return 'removed'
    case 'renamed':
      return 'renamed'
    case 'topic':
      return 'topic'
    case 'agentadded':
      return 'agentAdded'
    case 'agentremoved':
      return 'agentRemoved'
    default:
      return null
  }
}

export class TeamSync {
  readonly api: TeamApi
  private readonly now: () => number
  private readonly realtime: RealtimeLike
  private readonly listeners = new Set<TeamSyncListener>()
  private localAgent: TeamSyncDeps['localAgent']

  private stopped = true
  private epoch = 0
  private unavailable = false
  private ws: RealtimeStatus = 'connecting'
  private restOk = false
  private restFailed = false
  private syncedAt: number | null = null
  private lastLoadAt = 0

  private me: Overview['me'] | null = null
  private teams = new Map<string, TeamData>()
  private invites: Overview['invites'] = []
  private readonly meta = new Map<string, Meta>()
  private readonly caches = new Map<string, Cache>()
  /** 任务卡消息（执行端和卡片更新用，不限于已打开的频道） */
  private readonly cards = new Map<string, { teamId: string; tm: TeamMessage }>()
  private online = new Map<string, Set<string>>()
  /** 频道 → 已经（或正在）告诉云端读到哪条 */
  private readonly readSent = new Map<string, number>()
  /** 其他人最后在线时间的本地更新（presence 离线帧） */
  private seen = new Map<string, number>()

  private loading: Promise<void> | null = null
  private again: ReadyReason | 'plain' | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RELOAD_RETRY_MIN
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private warned = false

  constructor(private readonly deps: TeamSyncDeps) {
    this.api = deps.api
    this.now = deps.now ?? Date.now
    this.localAgent = deps.localAgent
    this.realtime = deps.realtime({
      onFrame: frame => this.frame(frame),
      onStatus: status => this.linkStatus(status),
    })
  }

  subscribe(listener: TeamSyncListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 绑定本机 AI 成员信息（Channels 创建后调用） */
  bindLocal(localAgent: NonNullable<TeamSyncDeps['localAgent']>): void {
    this.localAgent = localAgent
  }

  private emitChanged(): void {
    for (const l of this.listeners) l.changed?.()
  }

  // -------------------------------------------------------------------------
  // 启停、连接状态
  // -------------------------------------------------------------------------

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.epoch++
    this.unavailable = false
    this.restOk = false
    this.restFailed = false
    this.ws = 'connecting'
    this.warned = false
    this.emitChanged()
    this.realtime.start()
    void this.reload('start')
  }

  /** 退出登录 / 换账号：清掉所有团队数据 */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.epoch++
    this.realtime.stop()
    for (const t of [this.retryTimer, this.reloadTimer]) if (t) clearTimeout(t)
    this.retryTimer = this.reloadTimer = null
    this.retryDelay = RELOAD_RETRY_MIN
    this.again = null
    this.clear()
    this.emitChanged()
  }

  private clear(): void {
    this.me = null
    this.teams = new Map()
    this.invites = []
    this.meta.clear()
    this.caches.clear()
    this.cards.clear()
    this.online = new Map()
    this.readSent.clear()
    this.seen = new Map()
    this.syncedAt = null
    this.restOk = false
    this.restFailed = false
  }

  connection(): TeamsConnection {
    if (this.stopped) return 'signed-out'
    if (this.unavailable) return 'unavailable'
    if (this.restFailed || this.ws === 'offline') return 'offline'
    if (this.ws === 'online' && this.restOk) return 'online'
    return 'connecting'
  }

  private linkStatus(status: RealtimeStatus): void {
    if (this.stopped) return
    const was = this.ws
    this.ws = status
    if (status === 'online' && was !== 'online') void this.reload('connected')
    this.emitChanged()
  }

  /** 窗口获得焦点：离上次同步超过 15 秒就补一次 */
  focus(): void {
    if (this.stopped || this.unavailable) return
    if (this.now() - this.lastLoadAt < FOCUS_MIN_MS) return
    void this.reload('focus')
  }

  /** 手动重试：重连、重拉（云端之前没部署的也再试一次） */
  async refresh(): Promise<void> {
    if (this.stopped) return
    this.unavailable = false
    this.realtime.restart()
    await this.reload('manual')
  }

  // -------------------------------------------------------------------------
  // 拉总览
  // -------------------------------------------------------------------------

  /** 合并同时到来的请求：正在拉时只记一笔「拉完再拉一次」 */
  reload(reason: ReadyReason | 'plain'): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.loading) {
      if (!this.again || this.again === 'plain') this.again = reason
      return this.loading
    }
    const loading = this.doReload(reason).finally(() => {
      if (this.loading === loading) this.loading = null
      const next = this.again
      this.again = null
      if (next && !this.stopped) void this.reload(next)
    })
    this.loading = loading
    return loading
  }

  /** 稍后重拉（一连串推送合成一次） */
  private reloadSoon(): void {
    if (this.stopped || this.reloadTimer) return
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      void this.reload('plain')
    }, 300)
  }

  private async doReload(reason: ReadyReason | 'plain'): Promise<void> {
    const epoch = this.epoch
    let ov: Overview
    try {
      ov = await this.api.overview()
    } catch (error) {
      if (epoch !== this.epoch) return
      if (error instanceof TeamError && error.code === 'NOT_DEPLOYED') {
        this.unavailable = true
        this.realtime.stop()
        this.clearData()
        this.emitChanged()
        return
      }
      this.restFailed = true
      if (!this.warned) {
        this.warned = true
        this.deps.log?.('拉取团队总览失败', error)
      }
      this.scheduleRetry()
      this.emitChanged()
      return
    }
    if (epoch !== this.epoch) return
    this.warned = false
    this.retryDelay = RELOAD_RETRY_MIN
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.unavailable = false
    this.restOk = true
    this.restFailed = false
    this.apply(ov)
    this.syncedAt = this.lastLoadAt = this.now()
    try {
      await this.catchUp()
    } catch (error) {
      this.deps.log?.('补齐团队消息失败', error)
    }
    if (epoch !== this.epoch) return
    this.emitChanged()
    if (reason !== 'plain') for (const l of this.listeners) l.ready?.(reason)
  }

  private clearData(): void {
    this.me = null
    this.teams = new Map()
    this.invites = []
    this.meta.clear()
    this.caches.clear()
    this.cards.clear()
    this.online = new Map()
    this.syncedAt = null
    this.restOk = false
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return
    const wait = this.retryDelay
    this.retryDelay = Math.min(RELOAD_RETRY_MAX, this.retryDelay * 2)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.reload('plain')
    }, wait)
  }

  private apply(ov: Overview): void {
    this.me = ov.me
    this.teams = new Map(ov.teams.map(t => [t.id, t]))
    this.invites = ov.invites
    this.online = new Map(ov.teams.map(t => [t.id, new Set(t.members.filter(m => m.online).map(m => m.id))]))
    const alive = new Set<string>()
    for (const team of ov.teams)
      for (const ch of team.channels) {
        alive.add(ch.id)
        // 本机已经读过（云端的已读还没追上）的不再算未读
        const sent = this.readSent.get(ch.id) ?? 0
        const read = sent >= ch.lastN
        this.meta.set(ch.id, {
          teamId: team.id,
          data: ch,
          unread: read ? 0 : ch.unread,
          mentioned: read ? false : ch.mentioned,
          lastN: ch.lastN,
          lastAt: ch.lastAt,
          readN: Math.max(ch.readN, sent),
        })
      }
    for (const id of [...this.meta.keys()])
      if (!alive.has(id)) {
        this.meta.delete(id)
        this.caches.delete(id)
        this.readSent.delete(id)
      }
    for (const [id, c] of this.cards) if (!this.teams.has(c.teamId)) this.cards.delete(id)
  }

  /** 已经打开过的频道：云端的 seq 比缓存新就按 after 补齐 */
  private async catchUp(): Promise<void> {
    for (const [cid, cache] of this.caches) {
      const meta = this.meta.get(cid)
      if (!meta || meta.data.seq <= cache.syncedSeq) continue
      await this.fetchAfter(cid, cache, meta.data.seq).catch(e => this.deps.log?.('补齐频道消息失败', e))
    }
  }

  private async fetchAfter(cid: string, cache: Cache, target: number): Promise<void> {
    let after = cache.syncedSeq
    for (let i = 0; i < 20; i++) {
      const page = await this.api.messages(cache.teamId, cid, { after })
      for (const tm of page.messages) this.ingest(cache.teamId, cid, tm)
      const top = page.messages.reduce((max, m) => Math.max(max, m.seq), after)
      if (!page.hasMore || top <= after) {
        cache.syncedSeq = Math.max(cache.syncedSeq, top, target)
        return
      }
      after = top
      cache.syncedSeq = top
    }
  }

  // -------------------------------------------------------------------------
  // 实时帧
  // -------------------------------------------------------------------------

  private frame(frame: TeamFrame): void {
    if (this.stopped) return
    switch (frame.type) {
      case 'hello':
        this.online = new Map(Object.entries(frame.online).map(([tid, users]) => [tid, new Set(users)]))
        this.emitChanged()
        return
      case 'message': {
        if (!this.meta.has(frame.channel)) {
          // 新频道还没在总览里：先收下，再重拉总览
          this.reloadSoon()
          return
        }
        this.ingest(frame.team, frame.channel, frame.message)
        return
      }
      case 'team':
      case 'invites':
        this.reloadSoon()
        return
      case 'removed':
        this.dropTeam(frame.team)
        this.reloadSoon()
        return
      case 'presence': {
        const set = this.online.get(frame.team) ?? new Set<string>()
        if (frame.online) set.add(frame.user)
        else {
          set.delete(frame.user)
          this.seen.set(`${frame.team}/${frame.user}`, this.now())
        }
        this.online.set(frame.team, set)
        this.emitChanged()
      }
    }
  }

  private dropTeam(tid: string): void {
    this.teams.delete(tid)
    for (const [cid, m] of this.meta)
      if (m.teamId === tid) {
        this.meta.delete(cid)
        this.caches.delete(cid)
        this.readSent.delete(cid)
      }
    for (const [id, c] of this.cards) if (c.teamId === tid) this.cards.delete(id)
    this.emitChanged()
  }

  // -------------------------------------------------------------------------
  // 消息进来
  // -------------------------------------------------------------------------

  /** 一条消息进来（推送、发送 / 写回的响应、补齐）：更新缓存、未读，通知界面和执行端 */
  ingest(teamId: string, channelId: string, tm: TeamMessage): void {
    let changed = false
    let newer = false
    if (tm.kind === 'task' && tm.task) {
      const old = this.cards.get(tm.id)
      if (!old || tm.seq > old.tm.seq || (tm.seq === old.tm.seq && tm.updatedAt > old.tm.updatedAt)) {
        this.cards.set(tm.id, { teamId, tm })
        changed = true
      }
    }
    const cache = this.caches.get(channelId)
    if (cache) changed = this.upsert(cache, tm) || changed
    const meta = this.meta.get(channelId)
    if (meta && tm.n > meta.lastN) {
      meta.lastN = tm.n
      meta.lastAt = Math.max(meta.lastAt, tm.createdAt)
      if (tm.kind === 'message' && !this.isMine(tm.author)) {
        meta.unread++
        if (this.me && tm.mentions.includes(this.me.id)) meta.mentioned = true
      }
      newer = true
    }
    if (!changed && !newer) return
    const mapped = this.toMessage(teamId, tm)
    if (mapped) for (const l of this.listeners) l.message?.({ channelId, message: mapped })
    if (newer) this.emitChanged()
    if (tm.kind === 'task') for (const l of this.listeners) l.card?.(teamId, channelId, tm)
  }

  private isMine(author: string): boolean {
    if (!this.me) return false
    return author === this.me.id || this.agentById(author)?.owner === this.me.id
  }

  /** 缓存里放一条（同 id 的按 seq 取新的）；返回有没有变化 */
  private upsert(cache: Cache, tm: TeamMessage): boolean {
    const i = cache.list.findIndex(m => m.id === tm.id)
    if (i >= 0) {
      const old = cache.list[i]
      if (tm.seq < old.seq || (tm.seq === old.seq && tm.updatedAt <= old.updatedAt)) return false
      cache.list[i] = tm
      return true
    }
    // 按 n 插入（通常是最后）
    let at = cache.list.length
    while (at > 0 && cache.list[at - 1].n > tm.n) at--
    cache.list.splice(at, 0, tm)
    if (cache.list.length > CACHE_MAX && at === cache.list.length - 1) {
      cache.list.splice(0, cache.list.length - CACHE_MAX)
      cache.hasMore = true
    }
    return true
  }

  /** 乐观地改缓存里的任务卡（执行端写回云端之前先让界面动起来） */
  patchCard(id: string, patch: Partial<TeamTaskData>): void {
    const card = this.cards.get(id)
    if (!card?.tm.task) return
    const next: TeamMessage = { ...card.tm, task: { ...card.tm.task, ...patch } }
    this.cards.set(id, { teamId: card.teamId, tm: next })
    const cache = this.caches.get(next.channelId)
    const i = cache?.list.findIndex(m => m.id === id) ?? -1
    if (cache && i >= 0) cache.list[i] = next
  }

  // -------------------------------------------------------------------------
  // 读：一页消息、已读
  // -------------------------------------------------------------------------

  /**
   * 一页消息（最多 200 条）；beforeId 是界面里最早那条消息，取它前面的（按位置，同一毫秒跨页不漏）；
   * 这条不在缓存里时退回按毫秒时间戳 before 取。第一次打开频道时从云端拉最近 100 条
   */
  async page(
    channelId: string,
    before?: number | null,
    beforeId?: string | null,
  ): Promise<{ messages: ChannelMessage[]; more: boolean }> {
    const meta = this.meta.get(channelId)
    if (!meta) throw new Error('频道不存在')
    let cache = this.caches.get(channelId)
    if (!cache) {
      const first = await this.api.messages(meta.teamId, channelId, { limit: FIRST_PAGE })
      cache = this.caches.get(channelId)
      if (!cache) {
        cache = { teamId: meta.teamId, list: [], hasMore: first.hasMore, syncedSeq: meta.data.seq }
        this.caches.set(channelId, cache)
      }
      for (const tm of first.messages) {
        this.upsert(cache, tm)
        if (tm.kind === 'task' && tm.task) this.rememberCard(meta.teamId, tm)
      }
      cache.hasMore = first.hasMore
    }
    const older = before != null || !!beforeId
    const have = (): TeamMessage[] => {
      const at = beforeId ? cache!.list.findIndex(m => m.id === beforeId) : -1
      if (at >= 0) return cache!.list.slice(0, at)
      return before == null ? cache!.list : cache!.list.filter(m => m.createdAt < before)
    }
    if (older && have().length < PAGE && cache.hasMore && cache.list.length) {
      const oldest = cache.list[0].n
      const earlier = await this.api.messages(meta.teamId, channelId, { before: oldest, limit: PAGE })
      for (const tm of earlier.messages) {
        this.upsert(cache, tm)
        if (tm.kind === 'task' && tm.task) this.rememberCard(meta.teamId, tm)
      }
      cache.hasMore = earlier.hasMore
    }
    const list = have()
    const start = Math.max(0, list.length - PAGE)
    const messages = list.slice(start).flatMap(tm => this.toMessage(meta.teamId, tm) ?? [])
    return { messages, more: start > 0 || cache.hasMore }
  }

  private rememberCard(teamId: string, tm: TeamMessage): void {
    const old = this.cards.get(tm.id)
    if (!old || tm.seq > old.tm.seq) this.cards.set(tm.id, { teamId, tm })
  }

  /** 看完这个频道：已读位置往前走（只在有新内容时才通知云端） */
  markRead(channelId: string): void {
    const meta = this.meta.get(channelId)
    if (!meta) return
    const n = meta.lastN
    if (meta.unread || meta.mentioned) {
      meta.unread = 0
      meta.mentioned = false
      this.emitChanged()
    }
    if (n <= (this.readSent.get(channelId) ?? meta.readN)) return
    this.readSent.set(channelId, n)
    meta.readN = n
    void this.api.markRead(meta.teamId, channelId, n).catch(error => {
      // 没发成功：下次再标
      if (this.readSent.get(channelId) === n) this.readSent.delete(channelId)
      this.deps.log?.('同步已读位置失败', error)
    })
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  hasChannel(channelId: string): boolean {
    return this.meta.has(channelId)
  }

  channelInfo(
    channelId: string,
  ): { teamId: string; name: string; topic: string | null; role: TeamRole; createdBy: string } | null {
    const meta = this.meta.get(channelId)
    if (!meta) return null
    return {
      teamId: meta.teamId,
      name: meta.data.name,
      topic: meta.data.topic,
      role: this.teams.get(meta.teamId)?.role ?? 'member',
      createdBy: meta.data.createdBy,
    }
  }

  getMe(): Overview['me'] | null {
    return this.me
  }

  roleIn(teamId: string): TeamRole | null {
    return this.teams.get(teamId)?.role ?? null
  }

  teamIds(): string[] {
    return [...this.teams.keys()]
  }

  /** 我在某个团队的显示名 */
  nameOf(teamId: string, id: string): string {
    const team = this.teams.get(teamId)
    const agent = team?.agents.find(a => a.id === id)
    if (agent) return agent.name
    const member = team?.members.find(m => m.id === id)
    if (member) return member.name || member.email.split('@')[0] || id
    return id === this.me?.id ? this.me.name : '?'
  }

  agentById(id: string): (TeamAgentData & { teamId: string }) | undefined {
    for (const team of this.teams.values()) {
      const a = team.agents.find(x => x.id === id)
      if (a) return { ...a, teamId: team.id }
    }
    return undefined
  }

  /** 这个团队里登记在我名下的 AI 成员 */
  myAgents(teamId: string): TeamAgentData[] {
    const me = this.me?.id
    return me ? (this.teams.get(teamId)?.agents.filter(a => a.owner === me) ?? []) : []
  }

  /** 本机 AI 成员登记过的所有团队频道 AI 成员 */
  agentsOfLocal(localId: string): (TeamAgentData & { teamId: string })[] {
    const me = this.me?.id
    const out: (TeamAgentData & { teamId: string })[] = []
    for (const team of this.teams.values())
      for (const a of team.agents) if (a.owner === me && a.localId === localId) out.push({ ...a, teamId: team.id })
    return out
  }

  /** 频道里能 @ 的：团队所有真人和本频道的 AI 成员 */
  mentionables(channelId: string): Mentionable[] {
    const meta = this.meta.get(channelId)
    const team = meta && this.teams.get(meta.teamId)
    if (!team) return []
    return [
      ...team.members.map(m => ({ id: m.id, name: this.nameOf(team.id, m.id), kind: 'human' as const })),
      ...team.agents
        .filter(a => a.channelId === channelId)
        .map(a => ({ id: a.id, name: a.name, kind: 'agent' as const })),
    ]
  }

  card(id: string): { teamId: string; tm: TeamMessage } | undefined {
    return this.cards.get(id)
  }

  /** 任务卡（映射成频道里的任务消息） */
  taskOf(id: string): ChannelTask | null {
    const card = this.cards.get(id)
    const m = card && this.toMessage(card.teamId, card.tm)
    return m?.kind === 'task' ? m : null
  }

  isOnline(teamId: string, userId: string): boolean {
    return userId === this.me?.id || (this.online.get(teamId)?.has(userId) ?? false)
  }

  // -------------------------------------------------------------------------
  // 映射
  // -------------------------------------------------------------------------

  toMessage(teamId: string, tm: TeamMessage): ChannelMessage | null {
    if (tm.kind === 'event') {
      const e = tm.event
      const kind = e && eventKind(e.type)
      if (!e || !kind) return null
      return {
        kind: 'event',
        id: tm.id,
        channelId: tm.channelId,
        at: tm.createdAt,
        event: kind,
        actorId: e.actor,
        targetId: e.target,
        value: e.value,
      }
    }
    if (tm.kind === 'task') {
      const t = tm.task
      if (!t) return null
      return {
        kind: 'task',
        id: tm.id,
        channelId: tm.channelId,
        at: tm.createdAt,
        authorId: tm.author,
        assigneeId: t.assignee,
        title: titleWithoutAll(t.title, this.mentionables(tm.channelId)),
        status: t.status,
        sessionId: null,
        summary: t.summary,
        diff: t.diff,
        sourceMessageId: t.sourceMessage ?? undefined,
        round: t.round,
        error: t.error,
        note: t.note,
        decision: t.decision,
        request: null,
        progress: t.progress,
        endedAt: t.endedAt,
        ownerId: t.owner,
        pendingAction: t.pendingAction,
        ownerOffline: t.status === 'queued' && t.owner !== this.me?.id && !this.isOnline(teamId, t.owner),
      }
    }
    return {
      kind: 'message',
      id: tm.id,
      channelId: tm.channelId,
      at: tm.createdAt,
      authorId: tm.author,
      text: tm.text,
      format: tm.format,
      replyToId: tm.replyTo,
      mentions: tm.mentions,
      taskId: tm.taskId,
    }
  }

  snapshot(): { teams: TeamInfo[]; invites: PendingInvite[]; connection: TeamsConnection; syncedAt: number | null } {
    const teams: TeamInfo[] = [...this.teams.values()].map(t => ({
      id: t.id,
      name: t.name,
      role: t.role,
      members: t.members.map(m => ({
        id: m.id,
        role: m.role,
        online: this.isOnline(t.id, m.id),
        lastSeenAt: this.seen.get(`${t.id}/${m.id}`) ?? m.lastSeenAt,
        email: m.email || undefined,
      })),
      invites: t.role === 'owner' ? t.invites : [],
    }))
    return { teams, invites: this.invites, connection: this.connection(), syncedAt: this.syncedAt }
  }

  /** 团队频道，按最后一条消息的时间从新到旧 */
  channels(): Channel[] {
    const out: Channel[] = []
    for (const team of this.teams.values())
      for (const ch of team.channels) {
        const meta = this.meta.get(ch.id)
        out.push({
          id: ch.id,
          name: ch.name,
          topic: ch.topic,
          project: null,
          projectId: null,
          scope: 'team',
          teamId: team.id,
          memberIds: [...team.members.map(m => m.id), ...team.agents.filter(a => a.channelId === ch.id).map(a => a.id)],
          unread: meta?.unread ?? 0,
          mentioned: meta?.mentioned ?? false,
          createdAt: ch.createdAt,
          lastAt: meta?.lastAt ?? ch.lastAt,
        })
      }
    return out.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
  }

  /** 团队里的真人和 AI 成员（真人按 id 去重，多个团队里同一个人只列一次） */
  members(): ChannelMember[] {
    const me = this.me
    const out: ChannelMember[] = []
    const humans = new Map<string, HumanMember>()
    for (const team of this.teams.values())
      for (const m of team.members) {
        const online = this.isOnline(team.id, m.id)
        const old = humans.get(m.id)
        if (old) {
          old.online = old.online || online
          continue
        }
        humans.set(m.id, {
          id: m.id,
          kind: 'human',
          name: this.nameOf(team.id, m.id),
          ...(m.id === me?.id ? { you: true } : {}),
          role: m.role,
          userId: m.id,
          online,
          lastSeenAt: this.seen.get(`${team.id}/${m.id}`) ?? m.lastSeenAt,
        })
      }
    out.push(...humans.values())
    for (const team of this.teams.values()) for (const a of team.agents) out.push(this.agentMember(team, a))
    return out
  }

  private agentMember(team: TeamData, a: TeamAgentData): AgentMember {
    const mine = a.owner === this.me?.id
    const ownerOnline = mine || this.isOnline(team.id, a.owner)
    const base: AgentMember = {
      id: a.id,
      kind: 'agent',
      name: a.name,
      engine: a.engine as AgentMember['engine'],
      model: a.model || null,
      machineId: mine ? 'local' : 'team',
      machine: a.machine,
      project: a.project || null,
      status: ownerOnline ? a.status : 'offline',
      task: a.task,
      ownerId: a.owner,
      teamAgentId: a.id,
      ownerName: this.nameOf(team.id, a.owner),
      mine,
      policy: a.policy as AgentPolicy,
    }
    if (!mine) return base
    const local = this.localAgent?.(a.localId)
    if (!local) return { ...base, status: 'offline', warning: '这个 AI 成员已被删除' }
    return {
      ...base,
      ...local,
      id: a.id,
      kind: 'agent',
      ownerId: a.owner,
      teamAgentId: a.id,
      ownerName: base.ownerName,
      mine: true,
      policy: base.policy,
    }
  }

  // -------------------------------------------------------------------------
  // 操作（调云端，再重拉总览）
  // -------------------------------------------------------------------------

  private async done<T>(value: Promise<T>): Promise<T> {
    const result = await value
    await this.reload('plain')
    return result
  }

  createTeam(name: string): Promise<string> {
    return this.done(this.api.createTeam(name))
  }
  updateTeam(teamId: string, patch: { name: string }): Promise<void> {
    return this.done(this.api.updateTeam(teamId, patch))
  }
  deleteTeam(teamId: string): Promise<void> {
    return this.done(this.api.deleteTeam(teamId))
  }
  rename(teamId: string, name: string): Promise<void> {
    return this.done(this.api.rename(teamId, name))
  }
  invite(teamId: string, email: string, role: Exclude<TeamRole, 'owner'>): Promise<void> {
    return this.done(this.api.invite(teamId, email, role))
  }
  revokeInvite(teamId: string, inviteId: string): Promise<void> {
    return this.done(this.api.revokeInvite(teamId, inviteId))
  }
  respondInvite(inviteId: string, accept: boolean): Promise<void> {
    return this.done(this.api.respondInvite(inviteId, accept))
  }
  setRole(teamId: string, userId: string, role: Exclude<TeamRole, 'owner'>): Promise<void> {
    return this.done(this.api.setRole(teamId, userId, role))
  }
  removeMember(teamId: string, userId: string): Promise<void> {
    return this.done(this.api.removeMember(teamId, userId))
  }
  createChannel(teamId: string, input: { name: string; topic: string | null }): Promise<string> {
    return this.done(this.api.createChannel(teamId, input))
  }
  updateChannel(teamId: string, channelId: string, patch: { name?: string; topic?: string | null }): Promise<void> {
    return this.done(this.api.updateChannel(teamId, channelId, patch))
  }
  deleteChannel(teamId: string, channelId: string): Promise<void> {
    return this.done(this.api.deleteChannel(teamId, channelId))
  }
  putAgent(teamId: string, channelId: string, localId: string, reg: AgentRegistration): Promise<void> {
    return this.done(this.api.putAgent(teamId, channelId, localId, reg))
  }
  deleteAgent(teamId: string, agentId: string): Promise<void> {
    return this.done(this.api.deleteAgent(teamId, agentId))
  }

  /** 发消息：响应里的消息和任务卡马上进缓存 */
  async post(
    channelId: string,
    input: { clientId: string; text: string; replyTo?: string | null; mentions: string[] },
  ): Promise<{ message: ChannelMessage | null; tasks: string[] }> {
    const meta = this.meta.get(channelId)
    if (!meta) throw new Error('频道不存在')
    const res = await this.api.postMessage(meta.teamId, channelId, input)
    this.ingest(meta.teamId, channelId, res.message)
    for (const t of res.tasks) this.ingest(meta.teamId, channelId, t)
    return { message: this.toMessage(meta.teamId, res.message), tasks: res.tasks.map(t => t.id) }
  }

  /** 任务卡上的操作（同意 / 拒绝、取消 / 停止 / 重试）：响应里的卡片马上进缓存 */
  async taskCall(id: string, call: (teamId: string) => Promise<TeamMessage>): Promise<void> {
    const card = this.cards.get(id)
    if (!card) throw new Error('任务不存在')
    const tm = await call(card.teamId)
    this.ingest(card.teamId, tm.channelId || card.tm.channelId, tm)
  }

  /** 写回任务卡（执行端）：响应里的卡片进缓存 */
  async writeTask(teamId: string, channelId: string, id: string, patch: TaskPatch): Promise<void> {
    const tm = await this.api.patchTask(teamId, id, patch)
    this.ingest(teamId, tm.channelId || channelId, tm)
  }

  /** 距离上次成功同步过了多久（毫秒） */
  sinceSync(): number {
    return this.lastLoadAt ? this.now() - this.lastLoadAt : Infinity
  }
}

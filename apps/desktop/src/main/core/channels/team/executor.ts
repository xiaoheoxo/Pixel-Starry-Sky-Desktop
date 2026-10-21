// 团队频道的执行端（docs/ui/channels-phase-c.md §4）：任务卡归「AI 成员主人的像素星空」执行。
// 收到分配给自己 AI 成员的任务卡后认领、按 Phase B 的流程在本机开会话派活（排队、发送、跟踪都复用 service.ts），
// 状态变化写回云端任务卡，做完以 AI 成员的身份把结果发成频道消息，并处理别人点的取消 / 停止 / 重试。
// 本文件只管和云端的往来和「接不接这项活」的判断；本机怎么跑由宿主（Channels）实现。
import type { Locale } from '../../../../shared/i18n/messages'
import type { AgentConfig, ChannelMessage, ChannelTask } from '../../../../shared/types/channels'
import { mentionsAll } from '../../../../shared/channels/mentions'
import { continuePrompt, dispatchPrompt, followUpPrompt, historyLines } from '../prompt'
import { newTaskRun, type TaskRun, type TeamRunRef } from '../tracker'
import { TeamError, type TaskPatch, type TeamMessage, type TeamTaskData } from './api'
import type { TeamSync } from './sync'

/** 进度更新最快每秒写回一次 */
export const PROGRESS_THROTTLE_MS = 1000
const RETRY_MS = 5000
const MAX_ATTEMPTS = 6
const STATUS_DELAY_MS = 1000
const NOT_DEPLOYED_ERROR = '这个 AI 成员已被删除'
const LOST_ERROR = '这台电脑上没有这项活的记录，请重新派活'

export interface ExecutorHost {
  /** 本机 AI 成员 */
  member(localId: string): AgentConfig | undefined
  run(taskId: string): TaskRun | undefined
  runs(): TaskRun[]
  /** 新活：登记运行信息，排进成员的队列 */
  enqueue(run: TaskRun): void
  /** 开下一轮（追加要求、重试） */
  nextRound(
    card: ChannelTask,
    run: TaskRun | null,
    prompt: string,
    fresh: string,
    team: TeamRunRef,
    memberId: string,
  ): void
  /** 这一轮还没做完时追加的要求 */
  addFollowUp(taskId: string, text: string, team: TeamRunRef): void
  /** Phase B 的取消 / 停止 */
  action(taskId: string, action: 'cancel' | 'stop'): Promise<void>
  /** 记下 / 清掉「这一轮的收尾还没写回云端」 */
  setFinal(taskId: string, final: TeamRunRef['final'] | undefined): void
  /** 成员现在的状态和当前任务标题 */
  agentStatus(localId: string): { status: 'idle' | 'running' | 'waiting' | 'offline'; task: string | null }
  locale(): Locale
}

export interface ExecutorDeps {
  sync: TeamSync
  host: ExecutorHost
  /** 这台电脑的设备 id（认领用） */
  deviceId: string
  now?: () => number
  /** 进度更新写回的最小间隔 / 上报成员状态的等待时间（测试里调小） */
  progressMs?: number
  statusMs?: number
  log?: (message: string, error?: unknown) => void
}

interface Outbox {
  team: TeamRunRef
  body: TaskPatch
  /** round：产生这个结果的那一轮（结果消息的 clientId 用它，不能等发送时再读——那时可能已经开了下一轮） */
  result?: { text: string; mentions: string[]; round?: number }
  final: boolean
  attempts: number
}

const terminal = (status: string): boolean => status === 'done' || status === 'failed' || status === 'stopped'
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export class TeamExecutor {
  private readonly sync: TeamSync
  private readonly host: ExecutorHost
  private readonly device: string
  private readonly now: () => number
  /** 正在处理的任务卡（同一张卡同时只处理一次，期间有新变化就再看一遍） */
  private readonly busy = new Map<string, string>()
  private readonly dirty = new Set<string>()
  private readonly acting = new Set<string>()
  private readonly outbox = new Map<string, Outbox>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastSent = new Map<string, number>()
  private readonly reported = new Map<string, string>()
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  /** 上次看到的连接是不是 online（从别的状态恢复 online 时补发 outbox） */
  private wasOnline = false
  private readonly progressMs: number
  private readonly statusMs: number

  constructor(private readonly deps: ExecutorDeps) {
    this.sync = deps.sync
    this.host = deps.host
    this.device = deps.deviceId
    this.now = deps.now ?? Date.now
    this.progressMs = deps.progressMs ?? PROGRESS_THROTTLE_MS
    this.statusMs = deps.statusMs ?? STATUS_DELAY_MS
    this.sync.subscribe({
      changed: () => this.onConnection(),
      card: (_t, _c, tm) => this.onCard(tm.id),
      ready: () => void this.onReady().catch(e => this.deps.log?.('团队待办同步失败', e)),
    })
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.statusTimer = null
  }

  // -------------------------------------------------------------------------
  // 收到任务卡
  // -------------------------------------------------------------------------

  private onCard(id: string): void {
    const me = this.sync.getMe()
    const card = this.sync.card(id)
    if (!me || card?.tm.task?.owner !== me.id) return
    if (this.busy.has(id)) {
      this.dirty.add(id)
      return
    }
    const version = this.versionOf(id)
    this.busy.set(id, version)
    void this.consider(id)
      .catch(error => this.deps.log?.('处理团队任务卡失败', error))
      .finally(() => {
        this.busy.delete(id)
        // 处理期间卡片又变了才再看一遍
        if (this.dirty.delete(id) && this.versionOf(id) !== version) this.onCard(id)
      })
  }

  private versionOf(id: string): string {
    const tm = this.sync.card(id)?.tm
    return tm ? `${tm.seq}/${tm.updatedAt}` : ''
  }

  private async consider(id: string): Promise<void> {
    const card = this.sync.card(id)
    const tm = card?.tm
    const t = tm?.task
    if (!card || !tm || !t) return
    const run = this.host.run(id)
    if (t.pendingAction) return this.perform(card.teamId, tm, run)
    if (t.status !== 'queued') return
    if (t.claimedBy && t.claimedBy !== this.device) return
    if (!run) return this.accept(card.teamId, tm)
    if (t.round <= run.round) return
    if (t.followupMessage && t.followupMessage === run.team?.follow) return
    return this.followUp(card.teamId, tm, run)
  }

  /** 认领；已经被别的设备认领（409）返回 null */
  private async claim(teamId: string, tm: TeamMessage): Promise<TeamMessage | null> {
    if (tm.task?.claimedBy === this.device) return tm
    try {
      const claimed = await this.deps.sync.api.claim(teamId, tm.id, this.device)
      this.sync.ingest(teamId, claimed.channelId || tm.channelId, claimed)
      return claimed
    } catch (error) {
      if (!(error instanceof TeamError && error.code === 'CONFLICT')) this.deps.log?.('认领团队任务失败', error)
      return null
    }
  }

  private async fail(teamId: string, tm: TeamMessage, error: string): Promise<void> {
    await this.sync
      .writeTask(teamId, tm.channelId, tm.id, { status: 'failed', error })
      .catch(e => this.deps.log?.('写回团队任务失败', e))
  }

  /** 新活：认领 → 本机成员还在就排队开工，不在了就标失败 */
  private async accept(teamId: string, tm: TeamMessage): Promise<void> {
    const lost = tm.task?.claimedBy === this.device
    const claimed = await this.claim(teamId, tm)
    if (!claimed?.task) return
    const t = claimed.task
    const agent = this.sync.agentById(t.assignee)
    const member = agent && agent.owner === this.sync.getMe()?.id ? this.host.member(agent.localId) : undefined
    if (!member) return this.fail(teamId, claimed, NOT_DEPLOYED_ERROR)
    // 认领过却没有本机记录（runs.json 丢了）：没法接着做
    if (lost) return this.fail(teamId, claimed, LOST_ERROR)
    const follow = t.round > 1 ? t.followupMessage : null
    const prompt = await this.fresh(teamId, claimed, member, follow)
    const team: TeamRunRef = {
      teamId,
      channelId: claimed.channelId,
      messageId: claimed.id,
      agentId: t.assignee,
      author: claimed.author,
      title: t.title,
      follow,
    }
    this.host.enqueue(
      newTaskRun({
        taskId: claimed.id,
        channelId: claimed.channelId,
        memberId: member.id,
        queuedAt: this.now(),
        round: t.round,
        prompt,
        freshPrompt: prompt,
        team,
      }),
    )
  }

  /** 追加要求（卡片回到 queued，round 比本机的大） */
  private async followUp(teamId: string, tm: TeamMessage, run: TaskRun): Promise<void> {
    const claimed = await this.claim(teamId, tm)
    if (!claimed?.task) return
    const t = claimed.task
    const follow = t.followupMessage
    const locale = this.host.locale()
    const info = this.sync.channelInfo(claimed.channelId)
    const msg = follow ? await this.find(teamId, claimed.channelId, follow) : null
    const text = msg
      ? followUpPrompt({
          locale,
          channel: info?.name ?? '',
          author: this.sync.nameOf(teamId, msg.author),
          text: msg.text,
        })
      : continuePrompt(locale)
    const team: TeamRunRef = { ...(run.team ?? this.refOf(teamId, claimed)), follow }
    if (run.phase !== 'ended') {
      this.host.addFollowUp(run.taskId, text, team)
      return
    }
    const member = this.host.member(run.memberId)
    const fresh = member ? await this.fresh(teamId, claimed, member, follow) : text
    const card = this.sync.taskOf(claimed.id)
    if (card) this.host.nextRound(card, run, text, fresh, team, run.memberId)
  }

  private refOf(teamId: string, tm: TeamMessage): TeamRunRef {
    return {
      teamId,
      channelId: tm.channelId,
      messageId: tm.id,
      agentId: tm.task?.assignee,
      author: tm.author,
      title: tm.task?.title,
    }
  }

  // -------------------------------------------------------------------------
  // 提示词：最近的讨论从云端拉
  // -------------------------------------------------------------------------

  /** 在频道最近的消息里找一条 */
  private async find(teamId: string, channelId: string, id: string): Promise<TeamMessage | null> {
    try {
      const page = await this.sync.api.messages(teamId, channelId, { limit: 60 })
      return page.messages.find(m => m.id === id) ?? null
    } catch (error) {
      this.deps.log?.('拉取团队消息失败', error)
      return null
    }
  }

  /** 第一次派给成员的提示词（Phase B §4.2）：带最近的讨论和被引用的消息；follow 是追加要求那条消息 */
  private async fresh(teamId: string, tm: TeamMessage, member: AgentConfig, follow: string | null): Promise<string> {
    const t = tm.task!
    const locale = this.host.locale()
    const nameOf = (id: string): string => this.sync.nameOf(teamId, id)
    const info = this.sync.channelInfo(tm.channelId)
    let list: TeamMessage[] = []
    try {
      const page = await this.sync.api.messages(
        teamId,
        tm.channelId,
        follow ? { limit: 60 } : { before: tm.n, limit: 40 },
      )
      list = page.messages
    } catch (error) {
      this.deps.log?.('拉取团队讨论失败', error)
    }
    const requestId = follow ?? t.sourceMessage
    const source = list.find(m => m.id === requestId)
    const mapped = list.flatMap(m => this.sync.toMessage(teamId, m) ?? ([] as ChannelMessage[]))
    const quoted = follow
      ? t.title
      : source?.replyTo
        ? (() => {
            const q = list.find(m => m.id === source.replyTo)
            if (!q) return null
            if (q.kind === 'task') return q.task?.title ?? null
            return `${nameOf(q.author)}${locale === 'en-US' ? ': ' : '：'}${q.text}`
          })()
        : null
    return dispatchPrompt({
      locale,
      channel: { name: info?.name ?? '', topic: info?.topic ?? null },
      author: nameOf(source?.author ?? tm.author),
      instructions: member.instructions,
      history: requestId
        ? historyLines(mapped, {
            beforeId: requestId,
            since: null,
            skip: follow ? t.sourceMessage : source?.replyTo,
            nameOf,
            locale,
          })
        : [],
      quoted,
      request: source?.text ?? t.title,
      together: source && !follow ? this.together(tm.channelId, source, t.assignee) : [],
    })
  }

  /** 源消息 @全体 时，同时收到这项活的其他 AI 成员的名字 */
  private together(channelId: string, source: TeamMessage, assignee: string): string[] {
    const members = this.sync.mentionables(channelId)
    if (!mentionsAll(source.text, members)) return []
    const agents = new Map(members.filter(m => m.kind === 'agent').map(m => [m.id, m.name]))
    return source.mentions.filter(id => id !== assignee && agents.has(id)).map(id => agents.get(id)!)
  }

  // -------------------------------------------------------------------------
  // 取消 / 停止 / 重试
  // -------------------------------------------------------------------------

  /** 别人（或自己在别的设备上）点了取消 / 停止 / 重试：照 Phase B 执行，再清掉卡片上的请求 */
  private async perform(teamId: string, tm: TeamMessage, run: TaskRun | undefined): Promise<void> {
    const t = tm.task!
    if (this.acting.has(tm.id)) return
    if (t.claimedBy && t.claimedBy !== this.device) return
    this.acting.add(tm.id)
    try {
      const action = t.pendingAction!
      const patch: TaskPatch = { clearAction: true }
      if (action === 'retry') {
        if (terminal(t.status)) await this.retry(teamId, tm, run)
      } else if (run && run.phase !== 'ended') await this.host.action(tm.id, action)
      else if (!terminal(t.status)) {
        // 本机没有在做这项活（还没认领、或排着队没被接走）：直接停掉
        patch.status = 'stopped'
        if (action === 'cancel') patch.note = 'cancelled'
      }
      await this.sync.writeTask(teamId, tm.channelId, tm.id, patch)
    } catch (error) {
      this.deps.log?.('执行团队任务操作失败', error)
    } finally {
      this.acting.delete(tm.id)
    }
  }

  private async retry(teamId: string, tm: TeamMessage, run: TaskRun | undefined): Promise<void> {
    const locale = this.host.locale()
    const card = this.sync.taskOf(tm.id)
    if (!card) return
    if (run) {
      // 还没开始就失败：原样再发一次；做到一半：发「继续」
      const team = run.team ?? this.refOf(teamId, tm)
      this.host.nextRound(
        card,
        run,
        run.started ? continuePrompt(locale) : run.prompt,
        run.freshPrompt,
        team,
        run.memberId,
      )
      return
    }
    const claimed = await this.claim(teamId, tm)
    if (!claimed?.task) return
    const agent = this.sync.agentById(claimed.task.assignee)
    const member = agent && agent.owner === this.sync.getMe()?.id ? this.host.member(agent.localId) : undefined
    if (!member) return this.fail(teamId, claimed, NOT_DEPLOYED_ERROR)
    const prompt = await this.fresh(teamId, claimed, member, null)
    this.host.nextRound(card, null, prompt, prompt, this.refOf(teamId, claimed), member.id)
  }

  // -------------------------------------------------------------------------
  // 状态写回
  // -------------------------------------------------------------------------

  /**
   * 本机的任务卡变化 → 云端任务卡。只写和云端不一样的字段；进度更新节流，其余马上写。
   * result 不为空是这一轮的收尾：先发结果消息，再写任务卡，没写成功之前留在运行信息里，重连后补发。
   */
  send(run: TaskRun, patch: Partial<ChannelTask>, result?: { text: string; mentions: string[] }): void {
    const team = run.team
    if (!team) return
    const card = this.sync.card(team.messageId)?.tm.task
    const body: TaskPatch = {}
    const local: Partial<TeamTaskData> = {}
    const put = <K extends 'status' | 'round' | 'error' | 'note' | 'decision' | 'summary' | 'diff' | 'progress'>(
      key: K,
      value: ChannelTask[K] | undefined,
    ): void => {
      if (value === undefined || same(value, card?.[key])) return
      // 云端不接受把 diff / progress 清成 null：只在本机缓存里清
      if (!((key === 'diff' || key === 'progress') && value === null)) (body as Record<string, unknown>)[key] = value
      ;(local as Record<string, unknown>)[key] = value
    }
    put('status', patch.status)
    put('round', patch.round)
    put('error', patch.error)
    put('note', patch.note)
    put('decision', patch.decision)
    put('summary', patch.summary)
    put('diff', patch.diff)
    put('progress', patch.progress)
    if (patch.endedAt !== undefined) local.endedAt = patch.endedAt
    if (!Object.keys(body).length && !result) return
    this.sync.patchCard(team.messageId, local)
    this.enqueue(team, body, result && { ...result, round: run.round })
  }

  private enqueue(team: TeamRunRef, body: TaskPatch, result?: Outbox['result']): void {
    const id = team.messageId
    const entry: Outbox = this.outbox.get(id) ?? { team, body: {}, final: false, attempts: 0 }
    entry.team = team
    entry.body = { ...entry.body, ...body }
    if (result) {
      entry.result = result
      entry.final = true
    }
    if (entry.final) this.host.setFinal(id, { patch: { ...entry.body }, result: entry.result })
    this.outbox.set(id, entry)
    const progressOnly = !entry.final && Object.keys(entry.body).every(k => k === 'progress')
    const wait = progressOnly ? Math.max(0, (this.lastSent.get(id) ?? 0) + this.progressMs - this.now()) : 0
    this.schedule(id, wait)
  }

  private schedule(id: string, wait: number): void {
    const old = this.timers.get(id)
    if (old) {
      if (wait > 0) return
      clearTimeout(old)
    }
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        const next = (this.chains.get(id) ?? Promise.resolve()).then(() => this.flush(id))
        this.chains.set(id, next)
        void next.finally(() => {
          if (this.chains.get(id) === next) this.chains.delete(id)
        })
      }, wait),
    )
  }

  private async flush(id: string): Promise<void> {
    const entry = this.outbox.get(id)
    if (!entry) return
    // 没连上云端：留着，连上后统一补发
    if (this.sync.connection() !== 'online') return
    this.outbox.delete(id)
    const { team } = entry
    try {
      if (entry.result) {
        const round = entry.result.round ?? this.host.run(id)?.round ?? 0
        const res = await this.sync.api.postMessage(team.teamId, team.channelId, {
          clientId: `res-${id}-${round}`,
          text: entry.result.text,
          replyTo: id,
          mentions: entry.result.mentions,
          agentId: team.agentId,
          taskId: id,
        })
        this.sync.ingest(team.teamId, team.channelId, res.message)
      }
      if (Object.keys(entry.body).length) await this.sync.writeTask(team.teamId, team.channelId, id, entry.body)
      this.lastSent.set(id, this.now())
      if (entry.final) this.host.setFinal(id, undefined)
    } catch (error) {
      const code = error instanceof TeamError ? error.code : null
      const fatal = code === 'CONFLICT' || code === 'FORBIDDEN' || code === 'NOT_FOUND' || code === 'INVALID'
      if (!fatal && ++entry.attempts < MAX_ATTEMPTS) {
        const newer = this.outbox.get(id)
        this.outbox.set(id, {
          ...entry,
          body: { ...entry.body, ...newer?.body },
          result: newer?.result ?? entry.result,
          final: entry.final || !!newer?.final,
        })
        this.schedule(id, RETRY_MS * entry.attempts)
        return
      }
      this.deps.log?.('写回团队任务失败', error)
      // 云端不认了（任务没了、已经结束）：不再重发
      if (fatal && entry.final) this.host.setFinal(id, undefined)
    }
  }

  // -------------------------------------------------------------------------
  // 连上云端：补拉待办、补发收尾、上报成员状态
  // -------------------------------------------------------------------------

  /**
   * 连接恢复 online：把 outbox 里留着的补发。实时通道没断、只是一次 REST 失败被标 offline 时，
   * 之后的重拉成功不会触发 ready，只靠 ready 补发的话收尾会一直留在本机
   */
  private onConnection(): void {
    const online = this.sync.connection() === 'online'
    if (online && !this.wasOnline) for (const id of [...this.outbox.keys()]) this.schedule(id, 0)
    this.wasOnline = online
  }

  private async onReady(): Promise<void> {
    this.reported.clear()
    // 上次没写回去的收尾
    for (const run of this.host.runs())
      if (run.team?.final && run.phase === 'ended' && !this.outbox.has(run.taskId)) {
        const { patch, result } = run.team.final
        this.outbox.set(run.taskId, {
          team: run.team,
          body: patch as TaskPatch,
          result,
          final: true,
          attempts: 0,
        })
      }
    for (const id of [...this.outbox.keys()]) this.schedule(id, 0)
    for (const mine of await this.sync.api.tasksMine()) {
      this.sync.ingest(mine.teamId, mine.channelId, mine.message)
      this.onCard(mine.message.id)
    }
    this.statusChanged()
  }

  /** 成员的状态或当前任务变了：稍后上报给云端 */
  statusChanged(): void {
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      void this.report().catch(e => this.deps.log?.('上报成员状态失败', e))
    }, this.statusMs)
  }

  private async report(): Promise<void> {
    if (this.sync.connection() !== 'online') return
    for (const teamId of this.sync.teamIds()) {
      const agents = this.sync.myAgents(teamId).map(a => {
        const s = this.host.agentStatus(a.localId)
        return { id: a.id, status: s.status === 'offline' ? ('idle' as const) : s.status, task: s.task }
      })
      if (!agents.length) continue
      const key = JSON.stringify(agents)
      if (this.reported.get(teamId) === key) continue
      this.reported.set(teamId, key)
      await this.sync.api.agentStatus(teamId, agents).catch(error => {
        this.reported.delete(teamId)
        this.deps.log?.('上报成员状态失败', error)
      })
    }
  }
}

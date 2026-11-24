// 团队频道的执行端（docs/ui/channels-phase-c.md §4）：任务卡归「AI 成员主人的像素星空」执行。
// 收到分配给自己 AI 成员的任务卡后认领、按 Phase B 的流程在本机开会话派活（排队、发送、跟踪都复用 service.ts），
// 状态变化写回云端任务卡，做完以 AI 成员的身份把结果发成频道消息，并处理别人点的取消 / 停止 / 重试。
// 本文件只管和云端的往来和「接不接这项活」的判断；本机怎么跑由宿主（Channels）实现。
import type { Locale } from '../../../../shared/i18n/messages'
import type { AgentConfig, ChannelMessage, ChannelTask, ChannelWakeupTag } from '../../../../shared/types/channels'
import { mentionsAll } from '../../../../shared/channels/mentions'
import { MAX_RUNS, runReasonOf } from '../../../../shared/channels/runReason'
import { continuePrompt, dispatchPrompt, followUpPrompt, historyLines, wakeupRequest } from '../prompt'
import { newTaskRun, type TaskRun, type TeamRunRef } from '../tracker'
import { TeamError, isRunnerId, type TaskPatch, type TeamMessage, type TeamTaskData } from './api'
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
  /** 开下一轮（追加要求、重试）；wakeup：这一轮是事项唤醒开的（云端卡上带 wake，回 [silent] 静默结束） */
  nextRound(
    card: ChannelTask,
    run: TaskRun | null,
    prompt: string,
    fresh: string,
    team: TeamRunRef,
    memberId: string,
    wakeup?: ChannelWakeupTag,
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

/**
 * 云端登记的「由谁接」（docs/multica-learn.md §11.7）归不归 self 这个执行端：登记了的只认那一个；
 * 没登记的（旧数据）主人的哪台桌面都接，执行机不接
 */
export function executes(executor: string | null | undefined, self: string): boolean {
  return executor ? executor === self : !isRunnerId(self)
}

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

  /** 这个成员的活归不归这台（云端没有这个成员时按旧数据算：认领后判「已被删除」） */
  private mine(assignee: string): boolean {
    return executes(this.sync.agentById(assignee)?.executor, this.device)
  }

  /**
   * 能不能接这张卡（认领、开新一轮、重试）：要归这台；别人认领着的只有成员登记的就是这台时才接手
   * （改了由谁接之后，云端放行合格的一方重新认领）
   */
  private takes(t: TeamTaskData): boolean {
    if (!this.mine(t.assignee)) return false
    return !t.claimedBy || t.claimedBy === this.device || this.sync.agentById(t.assignee)?.executor === this.device
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
    // 不归这台的（另一台桌面、执行机接的成员）不去认领：认领了也没有这个成员，只会把卡判成「已被删除」
    if (!this.takes(t)) return
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

  /**
   * 开工前核对（docs/multica-learn.md §4、§11.3）：本机排队轮到这项活、开会话之前调。云端说不能开工（回到等同意、停下、
   * 卡已经不是这台的或已经取消）时返回 ok = false，卡的新状态已经进了同步；通过时带这一轮的凭证（旧云端没有）。
   * 连不上云端时照常开工、不带凭证：认领时已经核对过一次，不为一次网络问题让活失败
   */
  async preflight(run: TaskRun): Promise<{ ok: boolean; token: string | null }> {
    const team = run.team
    if (!team) return { ok: true, token: null }
    try {
      // 先把这张卡排着的写回发出去（重试、追加要求时卡要先回到排队，云端才认）
      await this.drain(team.messageId)
      const res = await this.sync.api.start(team.teamId, team.messageId, this.device)
      if (res.message) this.sync.ingest(team.teamId, res.message.channelId || team.channelId, res.message)
      return { ok: res.outcome === 'ok', token: res.runToken }
    } catch (error) {
      const code = error instanceof TeamError ? error.code : null
      if (code === 'CONFLICT' || code === 'FORBIDDEN' || code === 'NOT_FOUND') return { ok: false, token: null }
      this.deps.log?.('开工前核对失败，照常开工', error)
      return { ok: true, token: null }
    }
  }

  /** 有这一轮的运行凭证就用它写，凭证被拒（过期、云端换过版本）退回登录令牌，保证收尾写得回去 */
  private async withRun<T>(
    team: TeamRunRef,
    viaRun: (token: string) => Promise<T>,
    viaLogin: () => Promise<T>,
  ): Promise<T> {
    const token = team.runToken
    if (token)
      try {
        return await viaRun(token)
      } catch (error) {
        if (!(error instanceof TeamError && error.code === 'RUN_TOKEN')) throw error
      }
    return viaLogin()
  }

  private async fail(teamId: string, tm: TeamMessage, error: string): Promise<void> {
    await this.sync
      .writeTask(teamId, tm.channelId, tm.id, { status: 'failed', error, reason: runReasonOf('failed', error) })
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
        // 事项唤醒派来的唤醒卡（docs/multica-learn.md §11.6）：回 [silent] 不发结果、不覆盖摘要
        ...(t.wake ? { wakeup: t.wake } : {}),
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
    const list = follow || t.wake ? await this.recent(teamId, claimed.channelId) : []
    const msg = follow ? (list.find(m => m.id === follow) ?? null) : null
    // 事项唤醒以后几次（§11.6）：追加要求那条是挂规则的人发的指令，换成唤醒的要求（带盯着的卡、[silent] 那句）；
    // 这一轮还没做完（并进去）的照常回复，不带 [silent] 那句
    const ended = run.phase === 'ended'
    const wake = t.wake ? this.wakeRequest(teamId, claimed, list, msg?.text ?? '', !ended) : null
    const text =
      wake !== null && wake.startsWith('/')
        ? wake
        : msg || wake !== null
          ? followUpPrompt({
              locale,
              channel: info?.name ?? '',
              author: this.sync.nameOf(teamId, msg?.author ?? t.requestedBy ?? claimed.author),
              text: wake ?? msg!.text,
            })
          : continuePrompt(locale)
    const team: TeamRunRef = { ...(run.team ?? this.refOf(teamId, claimed)), follow }
    if (!ended) {
      this.host.addFollowUp(run.taskId, text, team)
      return
    }
    const member = this.host.member(run.memberId)
    const fresh = member ? await this.fresh(teamId, claimed, member, follow) : text
    const card = this.sync.taskOf(claimed.id)
    if (card) this.host.nextRound(card, run, text, fresh, team, run.memberId, t.wake ?? undefined)
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

  /** 频道最近的消息（追加要求那条、盯着的卡最后的结果从这里找）；拉不到是空的 */
  private async recent(teamId: string, channelId: string): Promise<TeamMessage[]> {
    try {
      return (await this.sync.api.messages(teamId, channelId, { limit: 60 })).messages
    } catch (error) {
      this.deps.log?.('拉取团队消息失败', error)
      return []
    }
  }

  /**
   * 事项唤醒开的这一轮（云端卡上带 wake，docs/multica-learn.md §11.6）的要求：唤醒指令、盯着的卡现在的样子，
   * 没什么要说的回 [silent]（和本机唤醒同一套 wakeupRequest）。被盯的卡先找缓存，没有（重启后频道还没打开）再到 list
   * 里找带着这条规则的卡；都找不到时用 fallback（那条消息的正文）当指令、不写盯着的卡。
   * merged：并进还没做完的一轮，不带 [silent] 那句
   */
  private wakeRequest(teamId: string, tm: TeamMessage, list: TeamMessage[], fallback: string, merged = false): string {
    const t = tm.task!
    const wake = t.wake!
    const watched =
      this.sync.wakeupRule(wake.ruleId)?.tm ??
      list.find(m => m.kind === 'task' && m.task?.wakeups?.some(r => r.id === wake.ruleId))
    const w = watched?.task
    let result: string | null = null
    for (let i = list.length - 1; i >= 0 && result === null && watched; i--)
      if (list[i].kind === 'message' && list[i].taskId === watched.id) result = list[i].text
    return wakeupRequest({
      locale: this.host.locale(),
      kind: wake.kind,
      text: w?.wakeups?.find(r => r.id === wake.ruleId)?.text || fallback || t.title,
      target: w
        ? {
            kind: 'task',
            title: w.title,
            status: w.status,
            owner: this.sync.nameOf(teamId, w.assignee),
            summary: w.summary,
            decision: w.decision,
            result,
          }
        : null,
      merged,
    })
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
    // 置顶的消息作为资料带上（和只有我的频道一样）；读不到不挡派活
    let pinned: string[] = []
    if (info?.pinned.length)
      try {
        const sep = locale === 'en-US' ? ': ' : '：'
        pinned = (await this.sync.api.pins(teamId, tm.channelId))
          .filter(m => m.kind === 'message' && m.text.trim())
          .map(m => `${nameOf(m.author)}${sep}${m.text.trim()}`)
      } catch (error) {
        this.deps.log?.('拉取团队频道的置顶失败', error)
      }
    const requestId = follow ?? t.sourceMessage
    const source = list.find(m => m.id === requestId)
    // 事项唤醒开的一轮：要求换成唤醒的要求；斜杠命令原样发，前后不拼东西（AGENTS.md「往用户消息前拼内容」）
    const wake = t.wake ? this.wakeRequest(teamId, tm, list, source?.text ?? '') : null
    if (wake?.startsWith('/')) return wake
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
      pinned,
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
      request: wake ?? source?.text ?? t.title,
      together: source && !follow && !wake ? this.together(tm.channelId, source, t.assignee) : [],
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
    // 重试归现在接这个成员的一方（改了由谁接之后由新的一方接手）；取消、停止归认领着的一方（它手上可能还在跑）
    if (t.pendingAction === 'retry' ? !this.takes(t) : t.claimedBy && t.claimedBy !== this.device) return
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
    let card = this.sync.taskOf(tm.id)
    if (!card) return
    // 重试唤醒的一轮还算唤醒轮（§11.6，同本机）：云端的 wake 标记只在有人追加要求时清掉
    const wake = tm.task?.wake ?? undefined
    if (run) {
      // 卡被别的执行端认领过（成员改绑过又改回来）：先接手，不然开工前核对过不去
      const by = tm.task?.claimedBy
      if (by && by !== this.device) {
        if (!(await this.claim(teamId, tm))) return
        // await 期间运行信息、卡可能被停掉或删掉：重新读最新的
        card = this.sync.taskOf(tm.id)
        run = this.host.run(tm.id)
        if (!card || !run) return
      }
      // 还没开始就失败：原样再发一次；做到一半：发「继续」
      const team = run.team ?? this.refOf(teamId, tm)
      this.host.nextRound(
        card,
        run,
        run.started ? continuePrompt(locale) : run.prompt,
        run.freshPrompt,
        team,
        run.memberId,
        wake,
      )
      return
    }
    const claimed = await this.claim(teamId, tm)
    if (!claimed?.task) return
    const agent = this.sync.agentById(claimed.task.assignee)
    const member = agent && agent.owner === this.sync.getMe()?.id ? this.host.member(agent.localId) : undefined
    if (!member) return this.fail(teamId, claimed, NOT_DEPLOYED_ERROR)
    const prompt = await this.fresh(teamId, claimed, member, null)
    this.host.nextRound(card, null, prompt, prompt, this.refOf(teamId, claimed), member.id, wake)
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
    const put = <
      K extends 'status' | 'round' | 'error' | 'note' | 'decision' | 'summary' | 'diff' | 'progress' | 'reason',
    >(
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
    put('reason', patch.reason)
    // 运行记录只追加云端还没有的（docs/multica-learn.md §11.1）
    if (patch.runs) {
      const known = card?.runs ?? []
      const fresh = patch.runs
        .filter(r => !known.some(k => k.n === r.n && k.endedAt === r.endedAt))
        .map(({ sessionId: _sessionId, ...r }) => r)
      if (fresh.length) {
        body.addRuns = fresh.slice(-MAX_RUNS)
        local.runs = [...known, ...fresh].slice(-MAX_RUNS)
      }
    }
    if (patch.endedAt !== undefined) local.endedAt = patch.endedAt
    if (!Object.keys(body).length && !result) return
    this.sync.patchCard(team.messageId, local)
    this.enqueue(team, body, result && { ...result, round: run.round })
  }

  private enqueue(team: TeamRunRef, body: TaskPatch, result?: Outbox['result']): void {
    const id = team.messageId
    const entry: Outbox = this.outbox.get(id) ?? { team, body: {}, final: false, attempts: 0 }
    entry.team = team
    // 没连上时几轮的运行记录接在一起，不互相覆盖
    // 云端一次最多收 MAX_RUNS 条，多了整条写回会被拒（连状态一起丢）
    const addRuns = [...(entry.body.addRuns ?? []), ...(body.addRuns ?? [])].slice(-MAX_RUNS)
    entry.body = { ...entry.body, ...body, ...(addRuns.length ? { addRuns } : {}) }
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
        void this.kick(id)
      }, wait),
    )
  }

  /** 接在这张卡上一次写回后面发一次 */
  private kick(id: string): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(() => this.flush(id))
    this.chains.set(id, next)
    void next.finally(() => {
      if (this.chains.get(id) === next) this.chains.delete(id)
    })
    return next
  }

  /** 马上把这张卡排着的写回发完（不等节流）；发不出去也不抛，留在 outbox 里照旧补发 */
  private async drain(id: string): Promise<void> {
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    await (this.outbox.has(id) ? this.kick(id) : this.chains.get(id))?.catch(() => undefined)
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
        const input = { clientId: `res-${id}-${round}`, text: entry.result.text, mentions: entry.result.mentions }
        const message = await this.withRun(
          team,
          token => this.sync.api.postRunResult(team.teamId, id, token, input),
          async () =>
            (
              await this.sync.api.postMessage(team.teamId, team.channelId, {
                ...input,
                replyTo: id,
                agentId: team.agentId,
                taskId: id,
              })
            ).message,
        )
        this.sync.ingest(team.teamId, team.channelId, message)
      }
      if (Object.keys(entry.body).length) {
        const body = entry.body
        const tm = await this.withRun(
          team,
          token => this.sync.api.patchRun(team.teamId, id, token, body),
          () => this.sync.api.patchTask(team.teamId, id, body),
        )
        this.sync.ingest(team.teamId, tm.channelId || team.channelId, tm)
      }
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
      // 只报归这台接的成员：别的桌面的成员这台没有，报上去会把那边的「进行中」盖成空闲
      const agents = this.sync
        .myAgents(teamId)
        .filter(a => executes(a.executor, this.device))
        .map(a => {
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

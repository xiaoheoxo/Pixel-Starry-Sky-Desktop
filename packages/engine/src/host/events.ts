// 事件：apply 是唯一写快照的入口（先落盘再广播，seq 递增）；适配器发来的事件在这里推导运行状态
import { randomUUID } from 'node:crypto'
import {
  AUTO_REVIEW_TEXT,
  cutItem,
  reduce,
  replyPreview,
  type EngineEvent,
  type Item,
  type SessionRecord,
} from '@pixelsky/protocol'
import type { HostContext, Runtime } from './context'
import { reconnectedCount } from './queue'
import { providerOfEngine } from './quota'
import { limitKind } from '../retry'
import { logger } from '../log'

const log = logger('engine.host')

type DeltaEvent = Extract<EngineEvent, { type: 'item_delta' }>

/** 原地接着终端里的 Codex 会话的对话：空闲这么久就关进程、放开线程的写入锁 */
const CODEX_IMPORTED_IDLE_MS = 2 * 60_000

/**
 * 最近一轮最后一条 assistant 回复的预览（SessionRecord.lastReply）：从末尾往前找，遇到普通用户消息（这一轮的起点）就停；
 * 中途插入的引导消息（guidance）不算起点。这一轮没有回复、或回复是空的 / 全是记号，返回 undefined（调用方保留旧值）
 */
export function lastTurnReply(items: readonly Item[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'user' && item.mode !== 'guidance') return undefined
    if (item.kind !== 'assistant') continue
    const preview = replyPreview(item.text)
    if (preview) return preview
  }
  return undefined
}

/** 引擎在干活的条目：看到它们说明引擎收到了这一轮的消息（用户消息、提示不算） */
const WORK_KINDS: ReadonlySet<Item['kind']> = new Set(['assistant', 'reasoning', 'tool', 'command'])

export class HostEvents {
  /** 每个会话一条还没应用的文字增量（同一条目同一字段的连续增量合并在这里） */
  private readonly pendingDelta = new Map<string, DeltaEvent>()

  /** 各引擎上次处理「自己的订阅登录失效」的时间：同一个引擎 60 秒内只处理一次 */
  private readonly loginFailedAt = new Map<string, number>()

  constructor(private readonly ctx: HostContext) {}

  /**
   * 用自己订阅的对话报登录失效（docs/ui/claude-login-recovery.md §1）：记一笔带凭据到期时间的日志（分清自然过期还是被作废），
   * 重新检测引擎（界面上的通道状态跟着变成「要授权」），再把额度按当前账号清掉重读
   */
  private ownLoginFailed(id: string, rt: Runtime): void {
    const engine = (rt.execution ?? rt.snapshot.record).engine
    const provider = providerOfEngine(engine)
    if (!provider) return
    const now = Date.now()
    if (now - (this.loginFailedAt.get(engine) ?? 0) < 60_000) return
    this.loginFailedAt.set(engine, now)
    const adapter = this.ctx.adapters[engine]
    log.warn('自己的订阅登录失效', {
      engine,
      sessionId: id,
      account: rt.sessionAccount ?? null,
      ...(adapter?.loginTimes?.() ?? {}),
    })
    const { m } = this.ctx
    void m.settings
      .engines(true)
      .then(() => m.quota.reset(provider))
      .catch(() => undefined)
  }

  /** 把合并好的增量应用出去；先删再应用，apply 里再调用也不会递归 */
  private flushDelta(id: string): void {
    const pending = this.pendingDelta.get(id)
    if (!pending) return
    this.pendingDelta.delete(id)
    this.apply(id, pending)
  }

  /** 应用一个事件：更新快照、保存、广播 */
  apply(id: string, event: EngineEvent): void {
    const { ctx } = this
    // 其他事件不能越过还没应用的文字，先把它应用掉
    if (event.type !== 'item_delta') this.flushDelta(id)
    const rt = ctx.runtimes.get(id)
    if (!rt) return
    const before = rt.snapshot.items
    // 开始时也写一次：重开会话时条目按开始的先后排（和实时一致），没等到完成的也不会丢（读出时标成已中断）
    if (event.type === 'item_completed' || event.type === 'item_started') ctx.store.appendItem(id, event.item)
    // 磁盘上写完整的，快照里留截过的（图片数据、长输出）（docs/session-memory.md）；还在跑的不截。广播的仍是完整事件
    rt.snapshot = reduce(
      rt.snapshot,
      event.type === 'item_completed' || event.type === 'item_started'
        ? { ...event, item: cutItem(event.item) }
        : event.type === 'items_reset'
          ? { ...event, items: event.items.map(cutItem) }
          : event,
    )
    // 清单写 reduce 记下每一步起点之后的那一份（stepMarks，docs/ui/auto-fold.md §3），不然重开就没了
    if ((event.type === 'item_completed' || event.type === 'item_started') && event.item.kind === 'todo') {
      const stored = rt.snapshot.items.findLast(item => item.id === event.item.id)
      if (stored) ctx.store.appendItem(id, stored)
    }
    rt.seq++
    // 一轮结束时收尾的条目（还在跑的标成完成 / 中断 / 失败）也要落盘，不然重开后状态不一致；落盘后再截
    if (event.type === 'turn_completed' && rt.snapshot.items !== before) {
      const old = new Map(before.map(item => [item.id, item]))
      const items = rt.snapshot.items.map(item => {
        if (old.get(item.id) === item) return item
        ctx.store.appendItem(id, item)
        return cutItem(item)
      })
      rt.snapshot = { ...rt.snapshot, items }
    }
    // 新的一轮开始：回退不能再撤销了，放掉撤销记录和回退前的条目文件
    if (event.type === 'turn_started') ctx.m.branch.forget(id)
    if (event.type === 'record') {
      ctx.records.set(id, event.record)
      ctx.store.saveRecord(event.record)
    }
    ctx.opts.emit({ kind: 'session', sessionId: id, seq: rt.seq, event })
    if (event.type === 'status' || event.type === 'record') this.broadcastSessions()
    else if (event.type === 'background' && rt.snapshot.state === 'idle') this.broadcastSessions()
  }

  patchRecord(id: string, patch: Partial<SessionRecord>): SessionRecord {
    const { ctx } = this
    const rt = ctx.runtimes.get(id)
    if (
      patch.model !== undefined ||
      patch.platform !== undefined ||
      patch.provider !== undefined ||
      patch.engine !== undefined
    ) {
      ctx.m.cache.reset(id)
      if (rt?.snapshot.context)
        this.apply(id, { type: 'context', context: { ...rt.snapshot.context, stale: true, diagnosticStale: true } })
    }
    if (!rt) {
      // 没载入的会话只改记录：不为改一个字段把整份对话读进内存（docs/session-memory.md 第 1 期）；没人持有它的快照，不发会话事件
      const base = ctx.records.get(id)
      if (!base) throw new Error('会话不存在')
      const record = { ...base, ...patch }
      ctx.records.set(id, record)
      ctx.store.saveRecord(record)
      this.broadcastSessions()
      return record
    }
    const record = { ...rt.snapshot.record, ...patch }
    this.apply(id, { type: 'record', record })
    return record
  }

  broadcastSessions(): void {
    this.ctx.opts.emit({ kind: 'sessions', sessions: this.ctx.m.sessions.sessions() })
  }

  /**
   * 按当前这一轮（rt.turn）记下引擎收到消息了没有、有没有进展（断线重连用，queue.ts reconnect）：
   * 引擎确认收到（input_ack）、有输出、或者自己在重试，都算收到；有输出才算有进展。
   * 第一次确认收到、且这一轮不是「继续」时，把队列项标成 delivered。
   * engineRetried：引擎重试之后又有输出，说明重试成功接上了，之后再断要由宿主重连，所以清掉。
   * 已知限制：这里只按「当前这一轮」的 turnId 和 rt.snapshot.turnId 对上来记；旧一轮迟到的输出
   * 如果赶在新一轮 turn_started 之后到达，会被当成新一轮的输出（把新一轮误判成已送达），目前没有办法区分，先不处理。
   */
  private trackTurn(id: string, rt: Runtime, event: EngineEvent): void {
    const t = rt.turn
    if (!t || rt.snapshot.turnId !== t.turnId) return
    // 已经有输出、引擎也没在重试：条目和增量不用再查（每个文字增量都过这里），只剩引擎重试要留意
    if (t.progressed && !t.engineRetried && event.type !== 'request_retry') return
    let delivered = false
    switch (event.type) {
      case 'input_ack':
        delivered = event.state === 'consumed' && event.id === t.userItemId
        break
      case 'item_started':
      case 'item_completed':
        if (WORK_KINDS.has(event.item.kind)) {
          delivered = true
          t.progressed = true
          t.engineRetried = false
        }
        break
      case 'item_delta': {
        const kind = rt.snapshot.items.find(i => i.id === event.itemId)?.kind
        if (kind && WORK_KINDS.has(kind)) {
          delivered = true
          t.progressed = true
          t.engineRetried = false
        }
        break
      }
      case 'request_retry':
        if (event.retry && event.retry.turnId === t.turnId) {
          delivered = true
          t.engineRetried = true
        }
        break
    }
    if (!delivered || t.delivered) return
    t.delivered = true
    if (!t.resume) this.ctx.m.queue.changeQueue(id, t.queueId, { delivered: true })
  }

  /** 适配器发来的事件：在这里推导运行状态 */
  onEngineEvent(id: string, event: EngineEvent): void {
    const { ctx } = this
    const m = ctx.m
    const rt = ctx.runtimes.get(id)
    if (!rt) return
    this.trackTurn(id, rt, event)
    // 额度用完的报错（Codex usageLimitExceeded）：这一轮失败时看要不要自动换订阅账号（accounts.ts autoSwitch）
    if (
      event.type === 'item_completed' &&
      event.item.kind === 'notice' &&
      event.item.error?.code === 'usageLimitExceeded' &&
      rt.turn
    )
      rt.turn.usageLimited = true
    if (
      event.type === 'item_completed' &&
      event.item.kind === 'notice' &&
      event.item.error?.kind === 'auth' &&
      rt.sessionSource === null
    )
      this.ownLoginFailed(id, rt)
    // 已结束轮次的迟到 result 不能清理正在执行的新轮和审批。
    if (event.type === 'turn_completed' && event.turnId !== rt.snapshot.turnId) return
    if (event.type === 'request_cache_reset') {
      m.cache.reset(id)
      return
    }
    if (event.type === 'request_usage') {
      const r = event.request
      if (rt.snapshot.turnId !== r.turnId || rt.snapshot.state === 'idle' || rt.stopping) return
      m.cache.check(id, rt, r)
      return
    }
    if (event.type === 'item_delta') {
      // 同一块 stdout 的事件是同步处理的，微任务会在任何别的宏任务（如 IPC 取快照）之前应用，快照和广播保持一致；
      // 输出快时一块里几百个增量合成一条，慢时仍然逐个到达
      const pending = this.pendingDelta.get(id)
      if (pending && pending.itemId === event.itemId && pending.field === event.field) {
        pending.delta += event.delta
        return
      }
      this.flushDelta(id)
      this.pendingDelta.set(id, { ...event })
      queueMicrotask(() => this.flushDelta(id))
      return
    }
    if ((event.type === 'item_started' || event.type === 'item_completed') && event.item.kind === 'compaction') {
      const withSummary = m.compaction.withSummary(id, event)
      this.apply(id, withSummary)
      m.compaction.itemApplied(id, withSummary.item)
      return
    }
    this.apply(id, event)
    switch (event.type) {
      case 'goal':
        // 续轮间隙仍在执行目标，不能被空闲回收打断；暂停/清除后恢复正常回收。
        if (event.goal?.status === 'active' && rt.idleTimer) {
          clearTimeout(rt.idleTimer)
          rt.idleTimer = null
        } else if (event.goal?.status !== 'active' && rt.snapshot.state === 'idle') this.armIdle(id)
        break
      case 'turn_started':
        // 适配器自己开的一轮（后台任务通知后引擎接着干活，没有用户消息）：和普通的一轮一样算运行中，
        // 空闲定时器不能在这时关掉进程
        if (rt.idleTimer) {
          clearTimeout(rt.idleTimer)
          rt.idleTimer = null
        }
        this.apply(id, { type: 'status', state: 'running' })
        break
      case 'approval_request':
        this.apply(id, { type: 'status', state: 'waiting' })
        break
      case 'approval_resolved':
        if (rt.snapshot.turnId && rt.snapshot.pending.length === 0) this.apply(id, { type: 'status', state: 'running' })
        // 状态没变时也要广播：会话列表里的 pending 是第一个待批准的，处理掉一个就换成下一个
        else this.broadcastSessions()
        break
      case 'turn_completed': {
        if (event.usage || m.usage.hasPlatformRequests(id, event.turnId))
          m.usage.recordUsage(id, event.turnId, event.outcome, event.usage ?? { models: {}, durationMs: 0 })
        // 这一轮结束：执行它的引擎看到了对话到现在为止的全部（没带交接的斜杠命令除外，交接留给下一条普通消息；
        // 失败的一轮不确定引擎收没收到，游标不动，重试时再带一次交接）。旧记录从这里开始有 engineSessions
        const done = rt.snapshot.record
        const engine = rt.execution?.engine ?? done.engine
        const entry = done.engineSessions?.[engine]
        // 连续被自动审核拦下的一轮引擎收到了（同下面队列的处理），游标照常前进
        const held =
          rt.holdCursor === event.turnId ||
          (event.outcome === 'failed' && event.error !== AUTO_REVIEW_TEXT.tooMany && !!done.engineSessions)
        rt.holdCursor = undefined
        const reply = lastTurnReply(rt.snapshot.items)
        this.patchRecord(id, {
          engineSessions: {
            ...done.engineSessions,
            [engine]: {
              ...entry,
              id: done.engineSessionId,
              seen: held ? (entry?.seen ?? null) : (rt.snapshot.items.at(-1)?.id ?? null),
            },
          },
          lastOutcome: event.outcome,
          lastError: event.outcome === 'failed' ? (event.error ?? '').slice(0, 500) || null : null,
          // 这一轮没有回复（只有用户消息、或只有工具调用）时不写，保留上一次的预览
          ...(reply === undefined ? {} : { lastReply: reply }),
          updatedAt: Date.now(),
        })
        // 对话检查点记在哪条消息上（下面可能把队列项删掉，先取）：「继续」那一轮接着原消息，
        // 队列项的 messageUuid 就是原消息 id（重试过的是重试那条，不是第一次发的）
        const turn = rt.turn
        const checkpointId = turn
          ? turn.resume
            ? (rt.snapshot.queue.find(q => q.id === turn.queueId)?.messageUuid ?? turn.queueId)
            : turn.userItemId
          : null
        // 连接问题断开的：这条留在队首，等一会儿自动接着做，队列不暂停（queue.ts reconnect）
        let reconnecting = false
        if (rt.activeId) {
          const item = rt.snapshot.queue.find(q => q.id === rt.activeId)
          // 连续被自动审核拦下：消息模型收到了也做了，不留成「发送失败」（否则接着发消息时原消息被标成未送达）
          if (item && event.outcome === 'failed' && event.error !== AUTO_REVIEW_TEXT.tooMany) {
            // 额度用完、开了自动换账号：换到下一个账号，这条马上重新派发（下一条消息前按新账号换进程）
            const switched = rt.turn?.usageLimited ? m.accounts.autoSwitch(id, item.id) : null
            // 没换成账号（订阅账号都用完了）、开了「订阅额度都用完时改用平台」：这条先在队首等着，挑好平台线路再重发
            // （docs/ui/engine-accounts.md §5.2）
            const fallback = rt.turn?.usageLimited && !switched ? m.accounts.platformFallback(id, item.id) : null
            // 提示条：界面按 account 字段拼文字、给「换回去」「关闭自动切换」（docs/ui/engine-accounts-claude.md §3）
            if (switched && m.accounts.noticeOn(switched.engine))
              this.apply(id, {
                type: 'item_completed',
                item: {
                  kind: 'notice',
                  id: `account-switch-${randomUUID()}`,
                  level: 'info',
                  text: `${switched.fromName} 的额度用完了，已自动换到 ${switched.toName} 并重新发送这条消息`,
                  account: switched,
                },
              })
            reconnecting =
              switched || fallback
                ? m.queue.reconnect(id, item.id, event.error ?? null, undefined, { account: true })
                : m.queue.reconnect(id, item.id, event.error ?? null)
            if (fallback && reconnecting) void m.accounts.fallbackToPlatform(id, item.id, fallback, event.error ?? null)
            // 限流 / 额度用完又没有别的账号可换：留在队首，等到恢复时间再发「继续」（docs/ui/rate-limit-resume.md）
            if (!reconnecting && !switched && !fallback) {
              const kind = limitKind(event.error, rt.turn?.usageLimited)
              if (kind)
                reconnecting = m.queue.limitWait(id, item.id, event.error ?? null, {
                  kind,
                  ...m.accounts.limitReading(id, kind),
                })
            }
            if (!reconnecting)
              m.queue.changeQueue(id, item.id, {
                status: 'failed',
                error: event.error ?? '任务执行失败',
                reconnect: undefined,
                ...(item.reconnect ? { reconnected: reconnectedCount(item.reconnect, true) } : {}),
              })
          } else if (item) m.queue.removeQueue(id, item.id, 'accepted')
          rt.activeId = null
        }
        // 对话检查点：这一轮结束时再拍一次
        if (checkpointId) m.checkpoints.afterTurn(id, checkpointId)
        rt.turn = undefined
        const turnEngine = (rt.execution ?? rt.snapshot.record).engine
        const awaitingGuidance = rt.snapshot.queue.some(q => q.status === 'delivering')
        if (!awaitingGuidance) rt.execution = null
        if (event.outcome !== 'completed' && !reconnecting) rt.snapshot = { ...rt.snapshot, queuePaused: true }
        m.queue.publishQueue(id)
        this.apply(id, { type: 'status', state: awaitingGuidance ? 'starting' : 'idle' })
        // 必须等适配器旧轮的 turnEnded / 审批清理回调返回，再派发下一条。
        queueMicrotask(() => {
          void m.turn.pump(id)
        })
        if (rt.snapshot.queuePaused || rt.snapshot.queue.length === 0) this.armIdle(id)
        // 账号额度：有人看过、超过 5 分钟没取，借这个会话还活着的进程补取一次（分模型 / 额外用量 / 点数）
        m.quota.afterTurn(id)
        // 自动换过订阅账号、改用过平台：订阅额度恢复了就换回去（从下一条消息起）
        m.accounts.afterTurn(turnEngine, id)
        break
      }
      case 'background':
        // 后台子智能体还在跑时不关进程（关了它们就一起没了）；都结束了、会话也空着，再开始计时
        if (event.count > 0) {
          if (rt.idleTimer) {
            clearTimeout(rt.idleTimer)
            rt.idleTimer = null
          }
        } else if (
          rt.snapshot.state === 'idle' &&
          !rt.idleTimer &&
          (rt.snapshot.queuePaused || rt.snapshot.queue.length === 0)
        )
          this.armIdle(id)
        break
      case 'input_ack': {
        const input = rt.snapshot.queue.find(q => q.id === event.id && q.mode === 'guidance')
        if (input) {
          if (event.state === 'consumed') {
            this.apply(id, {
              type: 'item_completed',
              item: {
                kind: 'user',
                id: input.id,
                text: input.text,
                attachments: input.attachments,
                ...(input.files ? { files: input.files } : {}),
                createdAt: Date.now(),
                mode: event.mode ?? 'guidance',
                turnId: rt.snapshot.turnId ?? undefined,
                engine: rt.execution?.engine ?? rt.snapshot.record.engine,
              },
            })
            m.queue.removeQueue(id, input.id, 'accepted')
          } else if (event.state === 'cancelled')
            m.queue.changeQueue(id, input.id, { status: 'queued', mode: 'normal', error: null })
          else {
            rt.snapshot = { ...rt.snapshot, queuePaused: true }
            m.queue.changeQueue(id, input.id, { status: 'uncertain', error: '引擎退出前未确认是否采纳，请核对后重试' })
          }
          // 上一轮结束时还在等这条引导被采纳（状态停在「启动中」）：没被采纳、也没别的在等，回到空闲接着派发
          if (
            event.state !== 'consumed' &&
            !rt.turn &&
            !rt.pumping &&
            !rt.activeId &&
            rt.snapshot.state === 'starting' &&
            !rt.snapshot.queue.some(q => q.status === 'delivering')
          ) {
            rt.execution = null
            this.apply(id, { type: 'status', state: 'idle' })
            queueMicrotask(() => {
              void m.turn.pump(id)
            })
            if (rt.snapshot.queuePaused || rt.snapshot.queue.length === 0) this.armIdle(id)
          }
        }
        break
      }
    }
  }

  armIdle(id: string): void {
    const rt = this.ctx.runtimes.get(id)
    if (!rt || rt.snapshot.background) return
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer)
      rt.idleTimer = null
    }
    if (rt.snapshot.goal?.status === 'active') return
    // 原地接着终端里的 Codex 会话：进程一直拿着线程的写入锁，终端里 `codex resume` 会报被占用，所以 2 分钟空闲就放开
    // （docs/ui/codex-resume.md §4.6）；下一条消息再 thread/resume
    // 只在当前执行者还是 Codex、并且还接着原线程时才缩短：换到别的引擎、或回退后换了新线程，进程没拿着原线程的锁
    const record = rt.snapshot.record
    const imported = record.imported
    const idleMs =
      imported?.engine === 'codex' &&
      !imported.forked &&
      record.engine === 'codex' &&
      record.engineSessionId === imported.sessionId
        ? Math.min(this.ctx.idleMs, CODEX_IMPORTED_IDLE_MS)
        : this.ctx.idleMs
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = null
      if (
        rt.snapshot.state !== 'idle' ||
        rt.snapshot.background ||
        rt.snapshot.goal?.status === 'active' ||
        !rt.session
      )
        return
      const s = rt.session
      rt.session = null
      void s.close()
    }, idleMs)
    rt.idleTimer.unref?.()
  }
}

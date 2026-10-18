// 消息队列：发送、排队、撤回、关掉、调序、继续、插队、引导、断线自动重连（docs/ui/message-queue.md）
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { MessageInput, QueuedMessage, QueueMove, QueueSummary, SendReceipt } from '@pixelsky/protocol'
import { codedError, messageWithFiles } from '@pixelsky/protocol'
import { messageInput, queueSettings, sameQueueSettings } from '../queue'
import { ENGINES } from '../registry'
import { connectionKind, reconnectDelay, reconnectLimit } from '../retry'
import type { HostContext, Runtime } from './context'

/** 派发一条队列项前要发什么（reconnectPlan） */
export type ReconnectPlan =
  /** 不是自动重连：照旧发 */
  | { kind: 'normal' }
  /** 引擎收到过原消息、原条目还在对话里：只发一句「继续」 */
  | { kind: 'resume' }
  /** 引擎没收到：原样重发，沿用原条目 id 和时间，不多出一条消息 */
  | { kind: 'resend'; userItemId: string; createdAt?: number }
  /** 不能发了，标发送失败：原消息已经不在对话里（回退等，发不了「继续」也没法原样重发）；或等待期间重连次数改小了 */
  | { kind: 'fail'; error: string }

export const RECONNECT_LOST = '原消息已不在对话里，请重试或撤回'

/** 还在等着自动重连的项（等待中，或正在派发） */
const waitingReconnect = (q: QueuedMessage): boolean =>
  !!q.reconnect && (q.status === 'queued' || q.status === 'dispatching')

/** 累计自动重连的上限是当前 max 的几倍（每次有输出 attempt 都从 1 重算，没有总上限会无限「继续」烧额度） */
export const RECONNECT_TOTAL_FACTOR = 3

/** 这条已经累计自动重连了几次（旧数据没有 total，按 attempt 算） */
export const reconnectTotal = (r: { attempt: number; total?: number }): number => r.total ?? r.attempt

/**
 * 界面写「已自动重连 n 次」用的次数：这一次已经发出去过（sent）就算上，没发出去（等待中被停止、派发前失败）不算
 */
export const reconnectedCount = (r: { attempt: number; total?: number }, sent: boolean): number =>
  Math.max(0, reconnectTotal(r) - (sent ? 0 : 1))

/** 自动重连停下来：这些项（except 除外）转成发送失败，记下自动重连了几次 */
const settleReconnects = (queue: QueuedMessage[], except?: string): QueuedMessage[] =>
  queue.map(q =>
    q.reconnect && q.id !== except && waitingReconnect(q)
      ? {
          ...q,
          status: 'failed' as const,
          error: q.reconnect.reason || '连接中断',
          reconnect: undefined,
          reconnected: reconnectedCount(q.reconnect, false),
        }
      : q,
  )

export class HostQueue {
  /** 没打开过的会话读一次已保存的队列（之后由运行时接管），任务 › 待处理用（docs/ui/tasks-inbox.md §4） */
  private readonly queueHints = new Map<string, QueueSummary | null>()
  /** 上次广播时的队列状态：只在「有排队且暂停」或排队数变化时重新广播会话列表 */
  private readonly queueKeys = new Map<string, string>()

  constructor(private readonly ctx: HostContext) {}

  queueSummary(id: string): QueueSummary | null {
    const rt = this.ctx.runtimes.get(id)
    if (rt) {
      // queued 只数还在等的：正在执行、正在交付的那条不算（手机任务列表的「排队 n」，docs/mobile-remote.md §17）
      const queue = rt.snapshot.queue
      const queued = queue.filter(q => q.status === 'queued').length
      const failed = queue.filter(q => q.status === 'failed' || q.status === 'uncertain').length
      if (!queued && !failed) return null
      return { queued, failed, paused: rt.snapshot.queuePaused }
    }
    if (!this.queueHints.has(id)) this.queueHints.set(id, this.ctx.store.peekQueue(id))
    return this.queueHints.get(id) ?? null
  }

  /** 会话删除后清掉缓存的队列状态 */
  forget(id: string): void {
    this.queueHints.delete(id)
    this.queueKeys.delete(id)
  }

  async send(id: string, input: string | MessageInput): Promise<SendReceipt> {
    const { ctx } = this
    const m = ctx.m
    if (ctx.closing) throw new Error('应用正在退出')
    if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const rt = m.sessions.runtime(id)
    if (m.guard.isLocked(rt.snapshot.record.cwd)) throw new Error('工作目录正在维护，请稍后重试')
    if (!statSync(rt.snapshot.record.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('项目目录不存在')
    const v = messageInput(input, rt.snapshot.record, randomUUID)
    if (v.attachments?.length && !ENGINES[rt.snapshot.record.engine].caps.imageInput)
      throw new Error('当前引擎不支持图片输入')
    const duplicate = rt.receipts.find(r => r.queueId === v.clientMessageId)
    if (duplicate) return duplicate
    if (rt.snapshot.queue.some(q => q.id === v.clientMessageId)) return { queueId: v.clientMessageId, status: 'queued' }
    const item: QueuedMessage = {
      id: v.clientMessageId,
      text: v.text,
      attachments: v.attachments,
      ...(v.files ? { files: v.files } : {}),
      settings: v.settings,
      createdAt: Date.now(),
      status: 'queued',
      error: null,
      mode: 'normal',
    }
    // 没有对话在运行：用户这次发送就是「现在执行」。之前暂停的排队项单独保持暂停，
    // 失败 / 待核对项留给用户处理，都不会挡住这条，也不会被它顺带执行。
    const idle = rt.snapshot.state === 'idle' && !rt.pumping && !rt.stopping && !rt.activeId
    const held = idle && rt.snapshot.queuePaused
    // 暂停着的自动重连（重启后恢复的，或停止时的残留）不能当普通排队项一起 held：先结算成发送失败，再算 held
    const settled = held ? settleReconnects(rt.snapshot.queue) : rt.snapshot.queue
    // 引擎其实收到过的（delivered）：结算后关掉时对话里那条不标「未送达」
    const received = new Set(
      held ? rt.snapshot.queue.filter(q => waitingReconnect(q) && q.delivered).map(q => q.id) : [],
    )
    const queue = settled.map(q => (held && q.status === 'queued' ? { ...q, held: true } : q))
    // 前面没有会先执行的排队项时，这条就是「现在执行」，界面不把它当排队显示。
    if (idle && !queue.some(q => q.status === 'queued' && !q.held)) item.direct = true
    const next = { ...rt.snapshot, queue: [...queue, item], queuePaused: idle ? false : rt.snapshot.queuePaused }
    // 先落盘，再承诺接收；磁盘失败时保持原快照，输入框原文不会被清空。
    ctx.store.saveQueue(id, { items: next.queue, paused: next.queuePaused, receipts: rt.receipts })
    rt.snapshot = next
    if (rt.snapshot.record.archivedAt) m.events.patchRecord(id, { archivedAt: null })
    if (rt.snapshot.suggestion) m.events.apply(id, { type: 'suggestion', text: null })
    this.publishQueue(id)
    // 有发送失败的消息时直接说了新的：失败那条算关掉（对话里标「未送达」，想带上可以点「重发」）
    if (idle)
      for (const q of rt.snapshot.queue)
        if (q.status === 'failed' && rt.snapshot.items.some(i => i.id === q.messageUuid))
          this.dismissQueued(id, q.id, !received.has(q.id))
    queueMicrotask(() => {
      void m.turn.pump(id)
    })
    return { queueId: item.id, status: 'queued' }
  }

  publishQueue(id: string): void {
    const { ctx } = this
    const rt = ctx.m.sessions.runtime(id)
    ctx.store.saveQueue(id, { items: rt.snapshot.queue, paused: rt.snapshot.queuePaused, receipts: rt.receipts })
    ctx.m.events.apply(id, { type: 'queue', items: rt.snapshot.queue, paused: rt.snapshot.queuePaused })
    const key = rt.snapshot.queuePaused && rt.snapshot.queue.length ? `p${rt.snapshot.queue.length}` : ''
    if ((this.queueKeys.get(id) ?? '') !== key) {
      this.queueKeys.set(id, key)
      ctx.m.events.broadcastSessions()
    }
  }

  changeQueue(id: string, queueId: string, patch: Partial<QueuedMessage>): void {
    const rt = this.ctx.m.sessions.runtime(id)
    rt.snapshot = { ...rt.snapshot, queue: rt.snapshot.queue.map(q => (q.id === queueId ? { ...q, ...patch } : q)) }
    this.publishQueue(id)
  }

  removeQueue(id: string, queueId: string, status: SendReceipt['status']): void {
    const rt = this.ctx.m.sessions.runtime(id)
    rt.receipts = [...rt.receipts.filter(r => r.queueId !== queueId), { queueId, status }].slice(-256)
    rt.snapshot = { ...rt.snapshot, queue: rt.snapshot.queue.filter(q => q.id !== queueId) }
    this.publishQueue(id)
  }

  cancelQueued(id: string, queueId: string): string {
    const item = this.ctx.m.sessions.runtime(id).snapshot.queue.find(q => q.id === queueId)
    if (!item) throw new Error('这条消息已开始处理或已经撤回')
    if (['running', 'dispatching', 'delivering'].includes(item.status)) throw new Error('这条消息已开始交付，无法撤回')
    this.removeQueue(id, queueId, 'cancelled')
    return item.text
  }

  /**
   * 发送失败的消息不重发也不撤回：从队列里拿掉，对话里的那条变淡、标「未送达」，错误卡片照旧，接着说什么由用户定。
   * 还没进对话的（引擎没启动起来）关掉就找不回来了：只能重试或撤回。
   * markUndelivered 为 false 时只从队列拿掉，对话里那条不标「未送达」（引擎其实收到了）
   */
  dismissQueued(id: string, queueId: string, markUndelivered = true): void {
    const rt = this.ctx.m.sessions.runtime(id)
    const item = rt.snapshot.queue.find(q => q.id === queueId)
    if (!item) throw new Error('这条消息已开始处理或已经撤回')
    if (item.status !== 'failed' && item.status !== 'uncertain') throw new Error('只有失败或待核对的消息可以关掉')
    const user = item.messageUuid ? rt.snapshot.items.find(i => i.id === item.messageUuid) : undefined
    if (user?.kind !== 'user') throw new Error('这条消息还没发出去，请重试或撤回')
    this.removeQueue(id, queueId, 'accepted')
    if (rt.snapshot.queue.length === 0 && rt.snapshot.queuePaused) {
      rt.snapshot = { ...rt.snapshot, queuePaused: false }
      this.publishQueue(id)
    }
    if (markUndelivered) this.ctx.m.events.apply(id, { type: 'item_completed', item: { ...user, dismissed: true } })
  }

  /**
   * 一轮因为连接问题失败（retry.ts connectionKind）：先不标失败，这条留在队首按退避等一会儿再派发
   * （Codex 的 Reconnecting n/m）。这是自动重连唯一的调度入口，发什么由派发时的 reconnectPlan 按 delivered 定。
   * 不满足下面任何一条、或次数用完时返回 false，调用方照常标失败：
   * - 应用没在退出、队列没暂停、没在停止（用户点了停止之后才报的连接错误不重连），传了 generation 时还是同一次派发；
   * - 普通消息，不是斜杠命令（/compact 等重发会重复执行）；
   * - 网络类错误；或引擎意外退出、且引擎确认收到过这条（没收到就退出：不知道发没发出去，交给用户重试）；
   * - 引擎自己没重试过（request_retry），不叠加一层；
   * - 次数按当前设置算（0 是关闭）；这一轮有过输出就从头算，否则接着上次累加；
   *   累计（total）超过当前 max 的 3 倍也不再重连，上游每次出几个字就断的话不能一直「继续」。
   */
  reconnect(id: string, queueId: string, error: string | null, generation?: number): boolean {
    const { ctx } = this
    const rt = ctx.runtimes.get(id)
    if (!rt || ctx.closing || rt.snapshot.queuePaused || rt.stopping) return false
    if (generation !== undefined && generation !== rt.generation) return false
    const item = rt.snapshot.queue.find(q => q.id === queueId)
    if (!item || item.mode !== 'normal' || item.text.trimStart().startsWith('/')) return false
    const kind = connectionKind(error)
    if (kind === null || (kind === 'exit' && !item.delivered)) return false
    if (rt.turn?.engineRetried) return false
    const max = reconnectLimit(ctx.m.settings.file.maxRetries)
    const attempt = rt.turn?.progressed ? 1 : (item.reconnect?.attempt ?? 0) + 1
    const total = (item.reconnect ? reconnectTotal(item.reconnect) : 0) + 1
    if (max <= 0 || attempt > max || total > max * RECONNECT_TOTAL_FACTOR) return false
    const now = Date.now()
    const delay = ctx.opts.reconnectDelays?.[attempt - 1] ?? reconnectDelay(attempt)
    const next: QueuedMessage = {
      ...item,
      status: 'queued',
      error: null,
      held: false,
      direct: true,
      reconnect: {
        attempt,
        max,
        total,
        since: now,
        at: now + delay,
        reason: (error ?? '').split('\n')[0].slice(0, 300),
        ...(item.delivered ? {} : { resend: true }),
      },
    }
    rt.snapshot = { ...rt.snapshot, queue: [next, ...rt.snapshot.queue.filter(q => q.id !== queueId)] }
    this.publishQueue(id)
    if (!this.armReconnect(id)) queueMicrotask(() => void ctx.m.turn.pump(id))
    return true
  }

  /**
   * 派发一条队列项前校验：自动重连的项发什么（turn.ts 派发时调用，唯一的判断处）。
   * 引擎收到过原消息（delivered）且它还在对话里：只发「继续」；收到过但已经不在对话里：不发，让调用方标失败；
   * 没收到过：原样重发，沿用原条目（messageUuid ?? id），时间也沿用。
   * 等待期间把重连次数改小（0 是关闭）、这次已经超过了：到点不再重连，按上次断开的原因标失败（max 每次按当前设置算）
   */
  reconnectPlan(id: string, item: QueuedMessage): ReconnectPlan {
    if (!item.reconnect) return { kind: 'normal' }
    const max = reconnectLimit(this.ctx.m.settings.file.maxRetries)
    if (item.reconnect.attempt > max || reconnectTotal(item.reconnect) > max * RECONNECT_TOTAL_FACTOR)
      return { kind: 'fail', error: item.reconnect.reason || '连接中断' }
    const original = item.messageUuid
      ? this.ctx.m.sessions.runtime(id).snapshot.items.find(i => i.id === item.messageUuid && i.kind === 'user')
      : undefined
    if (item.delivered) return original ? { kind: 'resume' } : { kind: 'fail', error: RECONNECT_LOST }
    return {
      kind: 'resend',
      userItemId: item.messageUuid ?? item.id,
      ...(original?.kind === 'user' ? { createdAt: original.createdAt } : {}),
    }
  }

  /**
   * 停止就是结算：正在等的和正在派发的自动重连直接算发送失败（记下已自动重连几次），队列暂停。
   * 用户点停止（EngineHost.interrupt）、归档会话都先调它；runQueuedNow 里那次内部中断不调（它用事先存的项重建）
   */
  stopReconnect(id: string): void {
    const rt = this.ctx.runtimes.get(id)
    if (!rt || !rt.snapshot.queue.some(waitingReconnect)) return
    if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer)
    rt.reconnectTimer = null
    rt.snapshot = { ...rt.snapshot, queuePaused: true, queue: settleReconnects(rt.snapshot.queue) }
    this.publishQueue(id)
  }

  /** 队首是还没到时间的自动重连：到时间再派发一次（重复调用只留最新的一个定时器） */
  armReconnect(id: string): boolean {
    const rt = this.ctx.runtimes.get(id)
    if (!rt) return false
    const head = rt.snapshot.queue.find(q => q.status === 'queued' && !q.held)
    if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer)
    rt.reconnectTimer = null
    const wait = head?.reconnect ? head.reconnect.at - Date.now() : 0
    if (wait <= 0) return false
    this.scheduleReconnect(id, rt, wait)
    return true
  }

  private scheduleReconnect(id: string, rt: Runtime, wait: number): void {
    if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer)
    rt.reconnectTimer = setTimeout(() => {
      rt.reconnectTimer = null
      if (this.ctx.runtimes.get(id) !== rt) return
      void this.ctx.m.turn
        .pump(id)
        .catch(() => {})
        .then(() => this.rearmIfDue(id, rt))
    }, wait)
    rt.reconnectTimer.unref?.()
  }

  /** 到点了 pump 却没派发出去（会话正忙、工作目录加锁、正在整理上下文等 pump 直接返回的情况）：1 秒后再试，不能就此没人管 */
  private rearmIfDue(id: string, rt: Runtime): void {
    if (this.ctx.closing || this.ctx.runtimes.get(id) !== rt || rt.reconnectTimer || rt.snapshot.queuePaused) return
    const head = rt.snapshot.queue.find(q => q.status === 'queued' && !q.held)
    if (head?.reconnect && head.reconnect.at <= Date.now()) this.scheduleReconnect(id, rt, 1000)
  }

  /**
   * 调序。{ before } 按消息 id 定位（null = 排到最后）：被挪的消息或锚点已不在队里（队首刚好发完被移走）、
   * 或者已经开始交付，整条拒绝（queue.changed），顺序不动，界面提示「队列已变化，排序未保存」。
   * 数字是旧版手机发来的「挪到第几位」，只夹进范围，保持老行为
   */
  moveQueued(id: string, queueId: string, to: QueueMove): void {
    const rt = this.ctx.m.sessions.runtime(id)
    const source = rt.snapshot.queue.findIndex(q => q.id === queueId)
    const byId = typeof to === 'object' && to !== null
    if (source < 0 || rt.snapshot.queue[source].status !== 'queued') {
      if (byId) throw codedError('queue.changed')
      throw new Error('只有排队中的消息可以调序')
    }
    const items = [...rt.snapshot.queue]
    const item = items.splice(source, 1)[0]
    let index: number
    if (byId) {
      if (to.before === null) index = items.length
      else {
        const anchor = to.before
        index = items.findIndex(q => q.id === anchor)
        // 锚点没了，或锚点已经在交付：排到它前面会插到正在发的消息前面
        if (anchor === queueId || index < 0 || ['dispatching', 'running', 'delivering'].includes(items[index].status))
          throw codedError('queue.changed')
      }
    } else index = Math.max(0, Math.min(items.length, Math.trunc(to)))
    // 排完位置没变：不用重新发布队列
    if (index === source) return
    items.splice(index, 0, item)
    rt.snapshot = { ...rt.snapshot, queue: items }
    this.publishQueue(id)
  }

  resumeQueue(id: string): void {
    const { ctx } = this
    const m = ctx.m
    if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const rt = m.sessions.runtime(id)
    if (rt.stopping) throw new Error('正在停止当前任务，请稍后继续')
    // 失败 / 待核对项留给用户处理，继续时只派发排队中的消息。
    if (rt.snapshot.record.archivedAt) m.events.patchRecord(id, { archivedAt: null })
    rt.snapshot = {
      ...rt.snapshot,
      queuePaused: false,
      queue: rt.snapshot.queue.map(q => (q.held ? { ...q, held: false } : q)),
    }
    this.publishQueue(id)
    queueMicrotask(() => {
      void m.turn.pump(id)
    })
  }

  async runQueuedNow(id: string, queueId: string): Promise<void> {
    const { ctx } = this
    const m = ctx.m
    if (ctx.changingSessions.has(id)) throw new Error('正在处理这个会话，请稍后重试')
    const rt = m.sessions.runtime(id)
    if (rt.stopping) throw new Error('正在停止当前任务，请稍后重试')
    const item = rt.snapshot.queue.find(q => q.id === queueId)
    if (!item || ['dispatching', 'running', 'delivering'].includes(item.status)) throw new Error('这条消息已经开始交付')
    // 插队执行别的消息：等着的 / 派发中的自动重连（选中的这条除外）先结算成发送失败，
    // 不然它们会在插队的消息跑完后自己发「继续」，或者在派发中被改回排队、卡片还挂在那里
    if (rt.snapshot.queue.some(q => q.id !== queueId && waitingReconnect(q))) {
      if (rt.reconnectTimer) clearTimeout(rt.reconnectTimer)
      rt.reconnectTimer = null
      rt.snapshot = { ...rt.snapshot, queue: settleReconnects(rt.snapshot.queue, queueId) }
      this.publishQueue(id)
    }
    await m.turn.interrupt(id)
    await rt.pumpFinished
    if (ctx.runtimes.get(id) !== rt || ctx.closing) throw new Error('会话已关闭')
    // 中断可能与完成事件竞争，仍使用稳定 ID 领取选中的任务。
    if (!rt.snapshot.queue.some(q => q.id === queueId)) throw new Error('这条消息已经开始处理')
    if (rt.snapshot.state !== 'idle' || rt.pumping) throw new Error('当前任务还没有停止，请稍后重试')
    if (rt.snapshot.record.archivedAt) m.events.patchRecord(id, { archivedAt: null })
    // 还在等的自动重连：现在就连，次数照算；失败了再重试的：从头算，又能自动重连满次数
    const reconnect = item.reconnect && item.status === 'queued' ? { ...item.reconnect, at: Date.now() } : undefined
    // 重试出过错的（执行失败、发送失败、交付待核对）：用会话现在的模型、强度和额度来源，不用入队时存的那份——
    // 出错后多半是换了渠道再重试（docs/ui/message-queue.md「可重试、撤回或检查设置」）。没出过错的排队项照旧用固定设置
    const retried = item.error || item.status === 'failed' || item.status === 'uncertain' || item.reconnect
    const settings = retried ? queueSettings(rt.snapshot.record) : item.settings
    rt.snapshot = {
      ...rt.snapshot,
      queue: [
        {
          ...item,
          settings,
          status: 'queued',
          mode: 'normal',
          error: null,
          held: false,
          direct: true,
          reconnect,
          reconnected: undefined,
          // 重试 / 重发是整条重新发：不再是上一次的送达状态（自动重连的项保留，派发时按它决定发「继续」还是原样重发）
          delivered: reconnect ? item.delivered : false,
        },
        ...rt.snapshot.queue.filter(q => q.id !== queueId),
      ],
      queuePaused: false,
    }
    this.publishQueue(id)
    await m.turn.pump(id)
  }

  async steerQueued(id: string, queueId: string, expectedTurnId: string): Promise<void> {
    const rt = this.ctx.m.sessions.runtime(id)
    if (rt.snapshot.state !== 'running' || rt.snapshot.turnId !== expectedTurnId || rt.stopping)
      throw new Error('当前一轮已结束或正在等待审批')
    if (!rt.snapshot.flags.steerAvailable || !rt.session?.steer)
      throw new Error('当前引擎尚未通过运行中引导验证，可等待或插队')
    const item = rt.snapshot.queue.find(q => q.id === queueId && q.status === 'queued')
    if (!item) throw new Error('这条消息已经开始交付')
    if (!sameQueueSettings(item.settings, queueSettings(rt.execution ?? rt.snapshot.record)))
      throw new Error('设置与当前任务不同，可等待或插队')
    this.changeQueue(id, queueId, { status: 'delivering', mode: 'guidance' })
    try {
      await rt.session.steer(messageWithFiles(item.text, item.files), item.id, item.attachments)
    } catch (err) {
      this.changeQueue(id, queueId, { status: 'uncertain', error: `引导交付结果待核对：${(err as Error).message}` })
      rt.snapshot = { ...rt.snapshot, queuePaused: true }
      this.publishQueue(id)
      throw err
    }
  }
}

// 消息通道的核心（docs/ui/one-click-connectors.md「QQ、微信第一版规划」）：配对、只认绑定的人、审批编号、固定询问模式、
// 回复窗口用完时的待发队列。不碰 electron 和具体平台，收发见 qq.ts、wechat.ts，接线见 ipc.ts
import { randomInt } from 'node:crypto'
import type { ApprovalDecision, ApprovalRequest, EngineEvent, SessionRecord } from '@pixelsky/protocol'
import type { TranslationKey } from '../../shared/i18n/translate'

export const PAIR_TTL = 5 * 60_000
const PAIR_ATTEMPTS = 5
const OUTBOX_MAX = 30
const SEEN_MAX = 200
/** 一段回复最多发几条：回复额度有限（QQ 每条用户消息 4 次），还要留给后面的审批 */
const MAX_CHUNKS = 2
const DETAIL_MAX = 500
const USER_TEXT_MAX = 20_000

export interface ImInbound {
  /** 平台的消息 id：同一条可能推送多次，靠它去重 */
  id: string
  from: string
  text: string
  /** 回复时要带上的东西（QQ 的 msg_id、微信的 context_token） */
  reply: string
}

/** window：这条现在发不了（回复窗口过了、额度用完），等用户下一条消息；网络问题抛错 */
export type SendResult = 'sent' | 'window'

export interface ImSender {
  readonly maxChars: number
  send(to: string, text: string, reply: string | null): Promise<SendResult>
}

export interface BridgeEngine {
  create(projectId: string): SessionRecord
  /** 没有或已归档返回 null */
  record(id: string): SessionRecord | null
  send(id: string, text: string): Promise<unknown>
  answer(id: string, requestId: string, decision: ApprovalDecision): Promise<unknown> | unknown
  interrupt(id: string): Promise<unknown>
  /** 断线后还会自动重连接着做：这时的失败不算结束 */
  reconnecting(id: string): boolean
}

/** 要存盘的部分（整份加密，见 ipc.ts） */
export interface BridgeMemory {
  bound: string | null
  sessionId: string | null
  reply: string | null
  outbox: string[]
  nextApproval: number
}

export const emptyMemory = (): BridgeMemory => ({
  bound: null,
  sessionId: null,
  reply: null,
  outbox: [],
  nextApproval: 1,
})

export interface BridgeDeps {
  sender: ImSender
  engine: BridgeEngine
  projectId(): string | null
  memory(): BridgeMemory
  save(patch: Partial<BridgeMemory>): void
  say(key: TranslationKey, values?: Record<string, string | number>): string
  /** 配对状态、绑定变了（设置页刷新） */
  changed(): void
  warn(message: string): void
  now?(): number
}

interface Pending {
  sessionId: string
  request: ApprovalRequest
}

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) + '…' : text)

/** 切成不超过 maxChars 的几段，优先在换行处切；放不下的丢掉，结尾写上 note（完整内容在电脑上） */
export function splitReply(text: string, maxChars: number, note: string): string[] {
  const chunks: string[] = []
  let rest = text.trim()
  while (rest && chunks.length < MAX_CHUNKS) {
    const last = chunks.length === MAX_CHUNKS - 1
    if (rest.length <= maxChars) {
      chunks.push(rest)
      return chunks
    }
    const room = last ? maxChars - note.length - 1 : maxChars
    const newline = rest.lastIndexOf('\n', room)
    let end = newline > room / 2 ? newline : room
    // 不把 emoji 这类代理对切成两半
    const code = rest.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end--
    chunks.push(last ? `${rest.slice(0, end).trimEnd()}\n${note}` : rest.slice(0, end).trimEnd())
    rest = rest.slice(end).trimStart()
  }
  return chunks
}

/** 平台明确不收这一条（内容审核、不让发网址）：重发也没用。网络问题抛普通 Error，内容留着等恢复 */
export class ImRejected extends Error {}

export class ImBridge {
  private readonly pending = new Map<number, Pending>()
  private readonly seen = new Set<string>()
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null
  /** 所有收发排成一队：同时来两条消息时不会建出两个对话，回复也按顺序发 */
  private chain: Promise<void> = Promise.resolve()
  /** 这一轮最后一段回复，一轮结束才发 */
  private lastText = ''
  private turnActive = false
  private lastError: string | null = null
  /** 说过的失败队列项：失败的那条会一直留在队列里，后面每个 queue 事件都带着它 */
  private readonly reportedQueue = new Set<string>()
  /** 没绑定的人发来、被丢掉的消息数（设置页显示） */
  ignored = 0

  constructor(private readonly d: BridgeDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  private run(task: () => Promise<void> | void): Promise<void> {
    this.chain = this.chain.then(task).catch(e => this.d.warn(String((e as Error)?.message ?? e)))
    return this.chain
  }

  // ---- 配对 ----

  startPairing(): void {
    this.pairing = {
      code: `PX-${String(randomInt(0, 1_000_000)).padStart(6, '0')}`,
      expiresAt: this.now() + PAIR_TTL,
      attempts: 0,
    }
    this.d.changed()
    // 到期时让界面收起配对码，不然用户发一个过期的码什么反应都没有
    setTimeout(() => this.d.changed(), PAIR_TTL + 500).unref?.()
  }

  cancelPairing(): void {
    this.pairing = null
    this.d.changed()
  }

  pairingState(): { code: string; expiresAt: number } | null {
    if (this.pairing && this.pairing.expiresAt <= this.now()) this.pairing = null
    return this.pairing && { code: this.pairing.code, expiresAt: this.pairing.expiresAt }
  }

  /** 解除绑定：对话留在电脑上，待发的内容丢掉（不能发给下一个绑定的人） */
  unbind(): void {
    this.pending.clear()
    this.endTurn()
    this.ignored = 0
    this.d.save({ bound: null, sessionId: null, reply: null, outbox: [] })
    this.d.changed()
  }

  /** 不再跟着当前这一轮了（换对话、解绑）：它后面的事件不会再过来，turnActive 不清就一直是真的 */
  private endTurn(): void {
    this.lastText = ''
    this.turnActive = false
  }

  private tryPair(m: ImInbound, text: string): Promise<void> | void {
    const pairing = this.pairingState()
    if (!pairing || !this.pairing) {
      this.ignored++
      this.d.changed()
      return
    }
    if (text.toUpperCase() !== pairing.code) {
      this.ignored++
      if (++this.pairing.attempts >= PAIR_ATTEMPTS) this.pairing = null
      this.d.changed()
      return
    }
    this.pairing = null
    this.d.save({ bound: m.from, reply: m.reply, outbox: [], sessionId: null })
    this.d.changed()
    return this.enqueue(this.d.say('im.chat.paired'))
  }

  // ---- 收消息 ----

  receive(m: ImInbound): Promise<void> {
    return this.run(() => this.handle(m))
  }

  private async handle(m: ImInbound): Promise<void> {
    if (this.seen.has(m.id)) return
    this.seen.add(m.id)
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string)

    const text = m.text.trim()
    const { bound } = this.d.memory()
    if (!bound) return this.tryPair(m, text)
    if (m.from !== bound) {
      this.ignored++
      this.d.changed()
      return
    }
    this.lastError = null
    this.d.save({ reply: m.reply })
    // 新消息带来新的回复窗口：先补发之前没发出去的
    await this.flush()
    if (this.d.memory().bound !== bound) return

    if (!text) return this.enqueue(this.d.say('im.chat.textOnly'))
    if (/^\/(新对话|new)$/i.test(text)) {
      this.d.save({ sessionId: null })
      this.endTurn()
      return this.enqueue(this.d.say('im.chat.newSession'))
    }
    if (/^\/(停止|stop)$/i.test(text)) return this.stop()
    if (/^\/(状态|status)$/i.test(text)) return this.status()
    const decide = /^(同意|拒绝|allow|deny)\s*#?(\d+)$/i.exec(text)
    if (decide) return this.decide(Number(decide[2]), /^(同意|allow)$/i.test(decide[1]))
    const answer = /^(?:回答|answer)\s*#?(\d+)\s+(.+)$/is.exec(text)
    if (answer) return this.answer(Number(answer[1]), answer[2])
    return this.forward(text)
  }

  private async stop(): Promise<void> {
    const { sessionId } = this.d.memory()
    if (!sessionId) return this.enqueue(this.d.say('im.chat.noSession'))
    await this.d.engine.interrupt(sessionId)
    if (!this.turnActive) return this.enqueue(this.d.say('im.chat.stopped'))
  }

  private status(): Promise<void> {
    const { sessionId } = this.d.memory()
    const record = sessionId ? this.d.engine.record(sessionId) : null
    return this.enqueue(
      record
        ? this.d.say('im.chat.status', { title: record.title || record.id, pending: this.pending.size })
        : this.d.say('im.chat.noSession'),
    )
  }

  /** 发给 AI：固定询问模式，电脑上改成别的模式就不接着发 */
  private async forward(text: string): Promise<void> {
    let { sessionId } = this.d.memory()
    let record = sessionId ? this.d.engine.record(sessionId) : null
    if (!record) {
      const projectId = this.d.projectId()
      if (!projectId) return this.enqueue(this.d.say('im.chat.noProject'))
      try {
        record = this.d.engine.create(projectId)
      } catch (e) {
        return this.enqueue(this.d.say('im.chat.failed', { error: cut(String((e as Error).message), DETAIL_MAX) }))
      }
      sessionId = record.id
      this.d.save({ sessionId })
    }
    if (record.permissionMode !== 'ask' && record.permissionMode !== 'plan')
      return this.enqueue(this.d.say('im.chat.modeChanged'))
    try {
      await this.d.engine.send(record.id, text.slice(0, USER_TEXT_MAX))
    } catch (e) {
      return this.enqueue(this.d.say('im.chat.failed', { error: cut(String((e as Error).message), DETAIL_MAX) }))
    }
  }

  // ---- 审批 ----

  /** 只给 allow / deny：allow_all、allow_always 不能从聊天里给，和手机网页版同一条 */
  private async decide(n: number, allow: boolean): Promise<void> {
    const p = this.pending.get(n)
    if (!p) return this.enqueue(this.d.say('im.chat.expired', { n }))
    const { request } = p
    if (request.kind === 'question') return this.enqueue(this.d.say('im.chat.useAnswer', { n }))
    if (allow ? request.canAllow === false : request.canDeny === false)
      return this.enqueue(this.d.say('im.chat.onDesktop'))
    this.pending.delete(n)
    await this.settle(p, n, allow ? { type: 'allow' } : { type: 'deny' })
  }

  /** 「回答 3 2 1」：每个问题一个选项序号 */
  private async answer(n: number, raw: string): Promise<void> {
    const p = this.pending.get(n)
    if (!p) return this.enqueue(this.d.say('im.chat.expired', { n }))
    const questions = p.request.questions ?? []
    const picks = raw.trim().split(/[\s,，]+/)
    if (p.request.kind !== 'question' || picks.length !== questions.length)
      return this.enqueue(this.d.say('im.chat.badAnswer', { n }))
    const answers: Record<string, string> = {}
    for (const [i, q] of questions.entries()) {
      const option = /^\d+$/.test(picks[i]) ? q.options[Number(picks[i]) - 1] : undefined
      if (!option) return this.enqueue(this.d.say('im.chat.badAnswer', { n }))
      answers[q.question] = option.label
    }
    this.pending.delete(n)
    await this.settle(p, n, { type: 'answer', answers })
  }

  private async settle(p: Pending, n: number, decision: ApprovalDecision): Promise<void> {
    try {
      await this.d.engine.answer(p.sessionId, p.request.requestId, decision)
    } catch {
      await this.enqueue(this.d.say('im.chat.expired', { n }))
    }
  }

  private approvalText(n: number, r: ApprovalRequest): string {
    const detail =
      r.kind === 'plan'
        ? r.plan
        : r.command
          ? r.command
          : r.changes?.length
            ? r.changes.map(c => c.path).join('\n')
            : r.input !== undefined
              ? JSON.stringify(r.input)
              : r.description
    const head = this.d.say('im.chat.approvalHead', { n, title: r.title })
    return [head, detail && cut(detail, DETAIL_MAX), this.d.say('im.chat.approvalHow', { n })]
      .filter(Boolean)
      .join('\n')
  }

  private questionText(n: number, r: ApprovalRequest): string {
    const lines = (r.questions ?? []).flatMap(q => [q.question, ...q.options.map((o, i) => `${i + 1}. ${o.label}`)])
    return [this.d.say('im.chat.questionHead', { n }), ...lines, this.d.say('im.chat.questionHow', { n })].join('\n')
  }

  private onApproval(sessionId: string, r: ApprovalRequest): Promise<void> {
    // 表单、要填密码的问题不能经聊天软件传
    const desktopOnly = r.formSchema !== undefined || r.questions?.some(q => q.secret || !q.options.length)
    if (desktopOnly) return this.enqueue(this.d.say('im.chat.onDesktop'))
    const n = this.d.memory().nextApproval
    this.d.save({ nextApproval: n + 1 })
    this.pending.set(n, { sessionId, request: r })
    return this.enqueue(r.kind === 'question' ? this.questionText(n, r) : this.approvalText(n, r))
  }

  // ---- 引擎事件 ----

  onEvent(sessionId: string, event: EngineEvent): Promise<void> | void {
    const relevant =
      event.type === 'approval_request' ||
      event.type === 'approval_resolved' ||
      event.type === 'item_completed' ||
      event.type === 'turn_started' ||
      event.type === 'turn_completed' ||
      event.type === 'queue'
    if (!relevant) return
    return this.run(() => this.handleEvent(sessionId, event))
  }

  private async handleEvent(sessionId: string, event: EngineEvent): Promise<void> {
    if (event.type === 'approval_resolved') {
      for (const [n, p] of this.pending) if (p.request.requestId === event.requestId) this.pending.delete(n)
      return
    }
    if (event.type === 'turn_completed')
      for (const [n, p] of this.pending) if (p.sessionId === sessionId) this.pending.delete(n)
    const { bound, sessionId: current } = this.d.memory()
    if (!bound || sessionId !== current) return
    switch (event.type) {
      case 'approval_request':
        return this.onApproval(sessionId, event.request)
      case 'item_completed':
        if (event.item.kind === 'assistant' && event.item.text.trim()) this.lastText = event.item.text
        return
      case 'turn_started':
        this.turnActive = true
        return
      case 'turn_completed': {
        this.turnActive = false
        // 断线自动重连：还会接着做，不算结束，也不算新的一轮
        if (event.outcome === 'failed' && this.d.engine.reconnecting(sessionId)) return
        const text = this.lastText
        this.lastText = ''
        if (event.outcome === 'failed') return this.reportFailure(event.error)
        if (event.outcome === 'interrupted') return this.enqueue(this.d.say('im.chat.stopped'))
        const background = event.background ? `\n${this.d.say('im.chat.background', { n: event.background })}` : ''
        return this.enqueue((text || this.d.say('im.chat.done')) + background)
      }
      case 'queue': {
        // 引擎没启动起来时没有 turn_completed，只有队列里这条失败；轮里失败的由 turn_completed 说，这里只记下
        const failed = event.items.filter(
          q => q.status === 'failed' && q.error && !q.reconnect && !this.reportedQueue.has(q.id),
        )
        for (const q of failed) this.reportedQueue.add(q.id)
        if (this.turnActive || !failed.length) return
        return this.reportFailure(failed[0].error ?? null)
      }
    }
  }

  private reportFailure(error: string | null): Promise<void> {
    if (error && error === this.lastError) return Promise.resolve()
    this.lastError = error
    return this.enqueue(this.d.say('im.chat.failed', { error: cut(error ?? '', DETAIL_MAX) }))
  }

  // ---- 发消息 ----

  private async enqueue(text: string): Promise<void> {
    const note = this.d.say('im.chat.truncated')
    const chunks = splitReply(text, this.d.sender.maxChars, note)
    const outbox = [...this.d.memory().outbox, ...chunks].slice(-OUTBOX_MAX)
    this.d.save({ outbox })
    await this.flush()
  }

  /** 发到发不出去为止；剩下的留着，用户下一条消息带来新窗口时再发。每次重读，期间解绑了就停 */
  private async flush(): Promise<void> {
    for (;;) {
      const { bound, reply, outbox } = this.d.memory()
      if (!bound || !outbox.length) return
      let result: SendResult
      try {
        result = await this.d.sender.send(bound, outbox[0], reply)
      } catch (e) {
        this.d.warn(`send failed: ${(e as Error).message}`)
        if (!(e instanceof ImRejected)) return
        // 不能让它堵住后面的；也不能悄悄没了（可能是 AI 的回复或审批），换成一句提示，提示也不收才丢
        const latest = this.d.memory()
        if (latest.bound !== bound) return
        const notice = this.d.say('im.chat.rejected')
        const rest = latest.outbox.slice(1)
        this.d.save({ outbox: latest.outbox[0] === notice ? rest : [notice, ...rest] })
        continue
      }
      if (result === 'window') return
      const latest = this.d.memory()
      if (latest.bound !== bound) return
      this.d.save({ outbox: latest.outbox.slice(1) })
    }
  }

  /** 连接恢复时补发 */
  retry(): Promise<void> {
    return this.run(() => this.flush())
  }
}

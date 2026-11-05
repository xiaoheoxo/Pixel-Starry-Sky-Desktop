// 消息通道配合频道（docs/ui/one-click-connectors.md「配合频道」）：聊天里发的话等于在频道里发言；
// 只把要你决定的事和最后的结果发回聊天。sync 每次按频道里的现状重算，发过的记在 told 里，重启后接着跟
import { createHash } from 'node:crypto'
import type { ApprovalRequest } from '@pixelsky/protocol'
import type { TranslationKey } from '../../shared/i18n/translate'
import type {
  ChannelChatOrigin,
  ChannelFlow,
  ChannelMessage,
  ChannelTask,
  FlowAction,
} from '../../shared/types/channels'

const ROOTS_MAX = 20
const TOLD_MAX = 200
/** 合并结果里每个成员最多带多少字；只有一项活时发完整回复 */
const LINE_MAX = 300
/** 只有一项活时回复超过这么长就可能发不全（一段回复最多发两条） */
const FULL_MAX = 3000
const STATUS_MAX = 15

/** 一条聊天发进来、还没收尾的消息 */
export interface RootMemory {
  channelId: string
  id: string
  /** 已经发过的（审批、计划、拦下…），不重复发 */
  told: string[]
}

/** 流程上要你回的编号（要存盘：草稿重启后还在，审批不用，重启后引擎的请求也没了） */
export interface FlowAsk {
  kind: 'plan' | 'questions' | 'step'
  root: string
  channelId: string
  messageId: string
  stepId?: string
  /** 发出去那份内容的指纹：电脑上改过计划后，旧编号不能开工 */
  sig: string
}

export interface ChatMemberAccess {
  name: string
  allowed: boolean
  local: boolean
}

export interface BridgeChannels {
  info(channelId: string): { name: string; members: ChatMemberAccess[] } | null
  access(memberId: string): ChatMemberAccess
  mentions(channelId: string, text: string): string[]
  /** root：要跟的那条消息；null 是没人接 */
  post(channelId: string, text: string, clientId: string): Promise<{ root: string | null }>
  items(channelId: string): readonly ChannelMessage[]
  stopTask(taskId: string, action: 'cancel' | 'stop'): Promise<unknown>
  flow(channelId: string, action: FlowAction): Promise<unknown>
}

export interface RouteHost {
  channels(): BridgeChannels | null
  memory(): { bound: string | null; roots: RootMemory[]; asks: Record<string, FlowAsk> }
  save(patch: { roots?: RootMemory[]; asks?: Record<string, FlowAsk> }): void
  say(key: TranslationKey, values?: Record<string, string | number>): string
  enqueue(text: string): Promise<void>
  /** 取下一个编号 */
  number(): number
  /** 发一项要确认的操作（编号和回复由桥接处理） */
  approval(sessionId: string, request: ApprovalRequest, who: string): Promise<void>
}

type FlowMessage = ChannelMessage & { kind: 'message'; flow: ChannelFlow }

const finished = (t: ChannelTask): boolean => t.status === 'done' || t.status === 'failed' || t.status === 'stopped'
const isFlow = (m: ChannelMessage): m is FlowMessage => m.kind === 'message' && !!m.flow
const isTask = (m: ChannelMessage): m is ChannelTask => m.kind === 'task'
const rootOf = (m: ChannelMessage): ChannelChatOrigin['root'] | undefined =>
  m.kind === 'task' || m.kind === 'message' ? m.chat?.root : undefined
const fingerprint = (value: unknown): string =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12)
const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) + '…' : text)

const unanswered = (f: ChannelFlow): boolean => !!f.questions?.some(q => !q.answer)
/** 拟计划的成员出错、什么都没交回时流程是空草稿：没有东西可定了 */
const flowSettled = (f: ChannelFlow): boolean =>
  f.status === 'done' || f.status === 'stopped' || (f.status === 'draft' && !f.steps.length && !unanswered(f))

export class ChannelRoute {
  constructor(private readonly h: RouteHost) {}

  // ---- 发进频道 ----

  async send(channelId: string, text: string, clientId: string): Promise<void> {
    const ch = this.h.channels()
    const info = channelId ? ch?.info(channelId) : null
    if (!ch || !info) return this.h.enqueue(this.h.say('im.chat.noChannel'))
    // 一条 @ 了几个人、其中有放宽模式的：整条不发，免得一半派出去一半没有
    const blocked = ch
      .mentions(channelId, text)
      .map(id => ch.access(id))
      .filter(a => !a.allowed)
    if (blocked.length)
      return this.h.enqueue(this.h.say('im.chat.blocked', { names: blocked.map(a => a.name).join('、') }))
    let root: string | null
    try {
      ;({ root } = await ch.post(channelId, text, clientId))
    } catch (e) {
      return this.h.enqueue(this.h.say('im.chat.failed', { error: cut(String((e as Error).message), LINE_MAX) }))
    }
    if (!root) {
      const members = info.members
        .filter(m => m.allowed)
        .map(m => `@${m.name}`)
        .join(' ')
      return this.h.enqueue(
        members
          ? this.h.say('im.chat.unrouted', { channel: info.name, members })
          : this.h.say('im.chat.unroutedNone', { channel: info.name }),
      )
    }
    const { roots } = this.h.memory()
    if (!roots.some(r => r.id === root))
      this.h.save({ roots: [...roots, { channelId, id: root, told: [] }].slice(-ROOTS_MAX) })
  }

  // ---- 跟进 ----

  async sync(): Promise<void> {
    const ch = this.h.channels()
    if (!ch || !this.h.memory().bound) return
    for (const root of this.h.memory().roots) await this.syncRoot(ch, root)
  }

  private itemsOf(ch: BridgeChannels, root: RootMemory): ChannelMessage[] {
    return ch.items(root.channelId).filter(m => rootOf(m) === root.id)
  }

  /** 这件事没发过就记下，返回要不要发 */
  private first(root: RootMemory, key: string): boolean {
    const { roots } = this.h.memory()
    const now = roots.find(r => r.id === root.id)
    if (!now || now.told.includes(key)) return false
    const told = [...now.told, key].slice(-TOLD_MAX)
    this.h.save({ roots: roots.map(r => (r === now ? { ...r, told } : r)) })
    return true
  }

  private async syncRoot(ch: BridgeChannels, root: RootMemory): Promise<void> {
    const items = this.itemsOf(ch, root)
    const tasks = items.filter(isTask)
    const flows = items.filter(isFlow)
    // 还没有卡片：@ 一个成员先拟计划时，流程卡是异步建的
    const settled =
      (tasks.length > 0 || flows.length > 0) && tasks.every(finished) && flows.every(m => flowSettled(m.flow))
    // 还没收尾时失败的先说一句，收尾时合并的结果里还会有。流程的步骤由流程停下那句说；
    // 拟计划的成员改计划失败：排在计划前面，不然看起来像改好了
    if (!settled)
      for (const t of tasks)
        if (t.status === 'failed' && !t.flow?.stepId && this.first(root, `failed:${t.id}:${t.round ?? 1}`))
          await this.h.enqueue(
            this.h.say('im.chat.taskFailed', {
              who: ch.access(t.assigneeId).name,
              title: t.title,
              error: cut(t.error ?? '', LINE_MAX),
            }),
          )
    for (const t of tasks) await this.syncTask(ch, root, t, tasks)
    for (const m of flows) await this.syncFlow(ch, root, m)
    if (settled) return this.finish(ch, root, tasks, flows)
  }

  private async syncTask(ch: BridgeChannels, root: RootMemory, t: ChannelTask, tasks: ChannelTask[]): Promise<void> {
    const who = ch.access(t.assigneeId)
    if (t.status === 'waiting' && t.request && this.first(root, `req:${t.request.requestId}`)) {
      if (who.local && t.sessionId) return this.h.approval(t.sessionId, t.request, who.name)
      return this.h.enqueue(this.h.say('im.chat.memberWaiting', { who: who.name, title: t.request.title }))
    }
    if (t.status !== 'queued' || !t.relay?.held) return
    // 几个成员都交给同一个放宽模式的成员：还停着的这几张只说一次（回复额度有限）；放行后再被拦下要再说
    const same =
      t.relay.held === 'chat'
        ? tasks.filter(x => x.status === 'queued' && x.relay?.held === 'chat' && x.assigneeId === t.assigneeId)
        : [t]
    const fresh = same.map(x => this.first(root, `held:${x.id}:${x.relay!.hop}`))
    if (!fresh.every(Boolean)) return
    return this.h.enqueue(
      t.relay.held === 'chat'
        ? this.h.say('im.chat.heldChat', { who: who.name })
        : this.h.say('im.chat.held', { who: who.name, title: t.title }),
    )
  }

  private planSig(ch: BridgeChannels, root: RootMemory, m: FlowMessage): string {
    const planner = ch.items(root.channelId).find(x => x.id === m.flow.planner?.taskId)
    return fingerprint([
      m.flow.steps.map(s => [s.title, s.memberId]),
      planner?.kind === 'task' ? (planner.round ?? 0) : 0,
    ])
  }

  private addAsk(root: RootMemory, m: FlowMessage, ask: Pick<FlowAsk, 'kind' | 'stepId' | 'sig'>): number {
    const n = this.h.number()
    // 同一张流程卡上同一类的旧编号作废
    const asks = Object.fromEntries(
      Object.entries(this.h.memory().asks).filter(
        ([, a]) => !(a.messageId === m.id && a.kind === ask.kind && a.stepId === ask.stepId),
      ),
    )
    asks[n] = { ...ask, root: root.id, channelId: root.channelId, messageId: m.id }
    this.h.save({ asks })
    return n
  }

  private async syncFlow(ch: BridgeChannels, root: RootMemory, m: FlowMessage): Promise<void> {
    const f = m.flow
    const planner = f.planner ? ch.access(f.planner.memberId).name : ''
    if (f.status === 'draft') {
      if (unanswered(f)) {
        const sig = fingerprint(f.questions)
        if (!this.first(root, `qs:${m.id}:${sig}`)) return
        const n = this.addAsk(root, m, { kind: 'questions', sig })
        return this.h.enqueue(this.questionsText(n, f, planner))
      }
      if (!f.steps.length) return
      const sig = this.planSig(ch, root, m)
      if (!this.first(root, `plan:${m.id}:${sig}`)) return
      const n = this.addAsk(root, m, { kind: 'plan', sig })
      return this.h.enqueue(this.planText(ch, n, f, planner))
    }
    if (f.status !== 'running' && f.status !== 'paused') return
    for (const s of f.steps) {
      const who = ch.access(s.memberId).name
      if (s.question && this.first(root, `q:${s.id}:${s.question.at}`)) {
        const n = this.addAsk(root, m, { kind: 'step', stepId: s.id, sig: String(s.question.at) })
        await this.h.enqueue(
          [
            this.h.say('im.chat.questionHeadWho', { n, who }),
            s.question.text,
            this.h.say('im.chat.freeHow', { n }),
          ].join('\n'),
        )
      }
      const round = ch.items(root.channelId).find(x => x.id === s.taskId)
      if (s.status === 'gated' && this.first(root, `gate:${s.id}:${round?.kind === 'task' ? round.round : 0}`))
        await this.h.enqueue(this.h.say('im.chat.gated', { who, title: s.title }))
    }
    if (f.paused && this.first(root, `paused:${m.id}:${f.paused.reason}:${f.paused.stepId}:${f.since?.at ?? 0}`))
      await this.h.enqueue(
        this.h.say(f.paused.reason === 'limit' ? 'im.chat.flowLimit' : 'im.chat.flowPaused', { title: f.title }),
      )
  }

  private questionsText(n: number, f: ChannelFlow, who: string): string {
    const qs = f.questions ?? []
    const lines = qs.flatMap(q => [q.q, ...q.options.map((o, i) => `${i + 1}. ${o}`)])
    const free = qs.filter(q => !q.options.length).length
    const how = free === 0 ? 'im.chat.questionHow' : qs.length === 1 ? 'im.chat.freeHow' : 'im.chat.mixedHow'
    return [this.h.say('im.chat.questionHeadWho', { n, who }), ...lines, this.h.say(how, { n })].join('\n')
  }

  private blockedIn(ch: BridgeChannels, f: ChannelFlow): string[] {
    return [
      ...new Set(
        f.steps
          .map(s => ch.access(s.memberId))
          .filter(a => !a.allowed)
          .map(a => a.name),
      ),
    ]
  }

  private planText(ch: BridgeChannels, n: number, f: ChannelFlow, who: string): string {
    const blocked = this.blockedIn(ch, f)
    return [
      this.h.say('im.chat.planHead', { n, who }),
      ...f.steps.map((s, i) => `${i + 1}. ${s.title} · ${ch.access(s.memberId).name}`),
      blocked.length
        ? this.h.say('im.chat.planBlockedHow', { n, names: blocked.join('、') })
        : this.h.say('im.chat.planHow', { n }),
    ].join('\n')
  }

  private async finish(
    ch: BridgeChannels,
    root: RootMemory,
    tasks: ChannelTask[],
    flows: FlowMessage[],
  ): Promise<void> {
    const channel = ch.info(root.channelId)?.name ?? '?'
    const { roots, asks } = this.h.memory()
    this.h.save({
      roots: roots.filter(r => r.id !== root.id),
      asks: Object.fromEntries(Object.entries(asks).filter(([, a]) => a.root !== root.id)),
    })
    // 拟计划的那张卡不算活，除非它直接回答了（流程里没有步骤、也没有别的卡）
    const work = tasks.filter(t => !t.flow || t.flow.stepId)
    // 问完问题后直接回答（流程还是没有步骤的草稿）不算放弃，回答照常发
    const planned = flows.find(m => m.flow.steps.length || (m.flow.status === 'stopped' && m.flow.questions?.length))
    if (!work.length && planned)
      return this.h.enqueue(this.h.say('im.chat.planDropped', { channel, title: planned.flow.title }))
    const list = work.length ? work : tasks
    const items = ch.items(root.channelId)
    const reply = (t: ChannelTask): string => {
      if (t.status === 'failed') return this.h.say('im.chat.lineFailed', { error: t.error ?? '' })
      if (t.status === 'stopped') return this.h.say('im.chat.stopped')
      const result = [...items].reverse().find(m => m.kind === 'message' && m.taskId === t.id)
      return (result?.kind === 'message' ? result.text : t.summary) || this.h.say('im.chat.done')
    }
    const decision = (t: ChannelTask): string =>
      t.status === 'done' && t.decision
        ? this.h.say('im.chat.lineDecision', { decision: cut(t.decision, LINE_MAX) })
        : ''
    // 流程中途停了：还没开始的步骤没有卡片，也要算进去
    const unstarted = flows
      .filter(m => m.flow.status === 'stopped')
      .flatMap(m => m.flow.steps)
      .filter(s => !s.taskId).length
    if (list.length === 1 && !unstarted) {
      const text = reply(list[0])
      const head = this.h.say('im.chat.resultOne', { channel, who: ch.access(list[0].assigneeId).name })
      // 长回复发不全，结尾的「需要你决定」提到前面
      const early = text.length > FULL_MAX ? decision(list[0]) : ''
      return this.h.enqueue([head, early, text].filter(Boolean).join('\n'))
    }
    const total = list.length + unstarted
    const done = list.filter(t => t.status === 'done').length
    return this.h.enqueue(
      [
        unstarted
          ? this.h.say('im.chat.resultStopped', { channel, n: total, done })
          : done === total
            ? this.h.say('im.chat.resultAll', { channel, n: done })
            : this.h.say('im.chat.resultSome', { channel, n: total, done }),
        ...list.flatMap(t => {
          const text = cut(reply(t), LINE_MAX)
          const line = `${ch.access(t.assigneeId).name}：${text}`
          // 截掉了结尾的「需要你决定」就单独写一行
          return t.decision && text.includes(t.decision) ? [line] : [line, decision(t)].filter(Boolean)
        }),
        this.h.say('im.chat.resultMore'),
      ].join('\n'),
    )
  }

  // ---- 命令 ----

  /** /状态：聊天派的活，电脑上派的不列 */
  status(): Promise<void> {
    const ch = this.h.channels()
    const lines: string[] = []
    let waiting = 0
    for (const root of ch ? this.h.memory().roots : []) {
      const before = lines.length
      const items = this.itemsOf(ch!, root)
      for (const m of items) {
        if (isTask(m) && !finished(m)) {
          const held = m.status === 'queued' && !!m.relay?.held
          if (m.status === 'waiting') waiting++
          const state = held
            ? 'im.chat.stateHeld'
            : m.status === 'waiting'
              ? 'im.chat.stateWaiting'
              : m.status === 'queued'
                ? 'im.chat.stateQueued'
                : 'im.chat.stateRunning'
          lines.push(`${ch!.access(m.assigneeId).name}：${cut(m.title, 60)}（${this.h.say(state)}）`)
        } else if (isFlow(m) && m.flow.status === 'draft' && !flowSettled(m.flow)) {
          waiting++
          lines.push(this.h.say('im.chat.stateDraft', { title: cut(m.flow.title, 60) }))
        } else if (isFlow(m) && (m.flow.status === 'running' || m.flow.status === 'paused')) {
          for (const s of m.flow.steps)
            if (s.question || s.status === 'gated') {
              waiting++
              const state = s.question ? 'im.chat.stateAsking' : 'im.chat.stateWaiting'
              lines.push(`${ch!.access(s.memberId).name}：${cut(s.title, 60)}（${this.h.say(state)}）`)
            }
          if (m.flow.status === 'paused') {
            waiting++
            lines.push(this.h.say('im.chat.stateFlowPaused', { title: cut(m.flow.title, 60) }))
          }
        }
      }
      // 流程在两步之间、电脑上刚接手的提案在拟计划：没有在做的卡，但还没完
      const open = items.filter(isFlow).find(m => !flowSettled(m.flow))
      if (open && lines.length === before)
        lines.push(this.h.say('im.chat.stateFlowRunning', { title: cut(open.flow.title, 60) }))
    }
    const shown = lines.slice(0, STATUS_MAX)
    return this.h.enqueue(
      [
        shown.length ? this.h.say('im.chat.routeHead') : this.h.say('im.chat.routeIdle'),
        ...shown,
        this.h.say('im.chat.routeWaiting', { n: waiting }),
      ].join('\n'),
    )
  }

  /** /停止：只停聊天派的活 */
  async stop(): Promise<void> {
    const ch = this.h.channels()
    let stopped = 0
    try {
      for (const root of ch ? this.h.memory().roots : []) {
        for (const m of this.itemsOf(ch!, root)) {
          if (isFlow(m) && !flowSettled(m.flow)) {
            stopped++
            await ch!.flow(root.channelId, { type: 'stop', messageId: m.id })
          } else if (isTask(m) && !finished(m) && !m.flow) {
            stopped++
            await ch!.stopTask(m.id, m.status === 'queued' ? 'cancel' : 'stop')
          }
        }
      }
    } catch (e) {
      return this.h.enqueue(this.h.say('im.chat.failed', { error: cut(String((e as Error).message), LINE_MAX) }))
    }
    if (!stopped) return this.h.enqueue(this.h.say('im.chat.noWork'))
  }

  // ---- 回复编号 ----

  private dropAsk(n: number): void {
    const { [n]: _gone, ...asks } = this.h.memory().asks
    this.h.save({ asks })
  }

  /** 编号对应的流程卡现在还是发出去时的样子；不是就作废 */
  private current(ch: BridgeChannels, n: number, ask: FlowAsk): FlowMessage | null {
    const m = ch.items(ask.channelId).find(x => x.id === ask.messageId)
    const root = this.h.memory().roots.find(r => r.id === ask.root)
    if (m && root && isFlow(m)) {
      const f = m.flow
      if (ask.kind === 'plan' && f.status === 'draft' && this.planSig(ch, root, m) === ask.sig) return m
      if (ask.kind === 'questions' && f.status === 'draft' && fingerprint(f.questions) === ask.sig) return m
      if (ask.kind === 'step' && String(f.steps.find(s => s.id === ask.stepId)?.question?.at) === ask.sig) return m
    }
    this.dropAsk(n)
    return null
  }

  private async act(n: number, ask: FlowAsk, ch: BridgeChannels, action: FlowAction): Promise<void> {
    try {
      await ch.flow(ask.channelId, action)
      this.dropAsk(n)
    } catch (e) {
      await this.h.enqueue(this.h.say('im.chat.failed', { error: cut(String((e as Error).message), LINE_MAX) }))
    }
  }

  /** 编号是流程上的就处理，返回 true；不是的交回桥接 */
  async decide(n: number, allow: boolean): Promise<boolean> {
    const ask = this.h.memory().asks[n]
    if (!ask) return false
    const ch = this.h.channels()
    const m = ch && this.current(ch, n, ask)
    if (!ch || !m) await this.h.enqueue(this.h.say('im.chat.expired', { n }))
    else if (ask.kind !== 'plan') await this.h.enqueue(this.h.say('im.chat.useAnswer', { n }))
    else if (!allow) await this.act(n, ask, ch, { type: 'discard', messageId: m.id })
    else {
      const blocked = this.blockedIn(ch, m.flow)
      if (blocked.length) await this.h.enqueue(this.h.say('im.chat.planBlocked', { names: blocked.join('、') }))
      else await this.act(n, ask, ch, { type: 'start', messageId: m.id })
    }
    return true
  }

  async answer(n: number, raw: string): Promise<boolean> {
    const ask = this.h.memory().asks[n]
    if (!ask) return false
    const ch = this.h.channels()
    const m = ch && this.current(ch, n, ask)
    if (!ch || !m) await this.h.enqueue(this.h.say('im.chat.expired', { n }))
    else if (ask.kind === 'plan') await this.h.enqueue(this.h.say('im.chat.planHow', { n }))
    else if (ask.kind === 'step')
      await this.act(n, ask, ch, { type: 'answer', messageId: m.id, stepId: ask.stepId!, text: raw.trim() })
    else {
      const answers = pickAnswers(m.flow.questions ?? [], raw)
      if (answers) await this.act(n, ask, ch, { type: 'answers', messageId: m.id, answers })
      else await this.h.enqueue(this.h.say('im.chat.badMixed', { n }))
    }
    return true
  }
}

/**
 * 一个问题：序号或整句话。几个问题：一行一个；都写在一行时用空格或逗号隔开，多出来的算最后一个问题的答案
 * （最后一个有选项时不算，免得前面哪个答案带了空格、错位了还当答对）
 */
export function pickAnswers(questions: { q: string; options: string[] }[], raw: string): string[] | null {
  const text = raw.trim()
  const pick = (options: string[], value: string): string => {
    const option = /^\d+$/.test(value) ? options[Number(value) - 1] : undefined
    return option ?? value
  }
  if (questions.length === 1) return text ? [pick(questions[0].options, text)] : null
  const lines = text.split(/\s*\n\s*/)
  if (lines.length === questions.length) return questions.map((q, i) => pick(q.options, lines[i]))
  const parts: string[] = []
  let rest = text
  for (let i = 0; i < questions.length - 1; i++) {
    const m = /^([^\s,，]+)[\s,，]+(.*)$/s.exec(rest)
    if (!m) return null
    parts.push(m[1])
    rest = m[2]
  }
  const last = questions[questions.length - 1]
  if (!rest || (last.options.length && /[\s,，]/.test(rest))) return null
  return questions.map((q, i) => pick(q.options, parts[i] ?? rest))
}

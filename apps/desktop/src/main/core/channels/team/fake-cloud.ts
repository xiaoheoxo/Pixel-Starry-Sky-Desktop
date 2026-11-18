// 测试用的假云端（只给 team/*.test.ts 和 service.team.test.ts 用，应用里不会引入）：
// 在内存里实现 docs/ui/channels-phase-c.md §8.2 的接口子集，按 §4.2 的规则建任务卡，变化通过 push 回调推给「实时通道」。
import type { TeamFetch } from './api'
import type { TeamFrame } from './realtime'
import { parseMessage } from './api'

type Json = Record<string, unknown>
const ENDED = ['done', 'failed', 'stopped']

export interface FakeCall {
  method: string
  path: string
  body: Json | undefined
  /** 带的运行凭证（runs 接口） */
  runToken?: string
}

export class FakeCloud {
  me = { id: 'u:1', name: '林夏', email: 'lx@example.com' }
  role: 'owner' | 'member' | 'observer' = 'owner'
  teamId = 'tm_1'
  users: Record<string, { name: string; email: string; role: string; online: boolean }> = {
    'u:1': { name: '林夏', email: 'lx@example.com', role: 'owner', online: true },
    'u:2': { name: '周宁', email: 'zn@example.com', role: 'member', online: true },
    'u:3': { name: '陈一', email: 'cy@example.com', role: 'observer', online: false },
  }
  channels: { id: string; name: string; topic: string | null; createdBy: string }[] = [
    { id: 'tc_1', name: '更新日志', topic: null, createdBy: 'u:1' },
  ]
  agents: Json[] = []
  invites: Json[] = []
  readN: Record<string, number> = {}
  messages = new Map<string, Json[]>()
  calls: FakeCall[] = []
  /** 'METHOD 路径前缀' → 状态码：命中就返回错误 */
  failures: Record<string, number> = {}
  /** 整个云端不通（网络错误） */
  down = false
  deployed = true
  /** 开工前核对（docs/multica-learn.md §11.3）：null 是旧云端（没有这个接口）；否则按这个结果回 */
  startOutcome: 'ok' | 'approval' | 'stopped' | null = 'ok'
  /** 每张卡现在有效的运行凭证 */
  runTokens = new Map<string, string>()
  /** 收件箱（docs/multica-learn.md §11.5）：GET /v1/inbox 返回的行；null 是旧云端（404） */
  inbox: Json[] | null = []
  /** 设了时 GET /v1/inbox 等它放行才回（测拉取期间推来的帧） */
  inboxGate: Promise<void> | null = null
  /** 事项唤醒（docs/multica-learn.md §11.6）：false 是旧云端（卡上没有 wakeups / wake 字段，没有唤醒接口） */
  wakeups = true
  push: (frame: TeamFrame) => void = () => {}
  private seq = 100
  private tick = 0
  private counters: Record<string, number> = {}

  constructor() {
    for (const c of this.channels) this.messages.set(c.id, [])
  }

  private id(prefix: string): string {
    this.counters[prefix] = (this.counters[prefix] ?? 0) + 1
    return `${prefix}_${this.counters[prefix]}`
  }

  private time(): string {
    return new Date(Date.UTC(2026, 9, 14, 6, 0, 0) + ++this.tick * 1000).toISOString()
  }

  fetch: TeamFetch = async (method, path, body, _timeout, runToken) => {
    if (this.down) throw new TypeError('fetch failed')
    this.calls.push({ method, path, body: body as Json | undefined, ...(runToken ? { runToken } : {}) })
    for (const [key, status] of Object.entries(this.failures)) {
      const [m, prefix] = key.split(' ')
      if (m === method && path.startsWith(prefix)) return this.json({ error: '失败' }, status)
    }
    if (!this.deployed) return this.json({ error: 'not found' }, 404)
    if (method === 'GET' && path === '/v1/inbox' && this.inboxGate) {
      // 先把这一刻的数据拍下来（请求「发出」时的样子），放行后才回
      const res = this.route(method, path, {}, runToken)
      await this.inboxGate
      return res
    }
    return this.route(method, path, (body ?? {}) as Json, runToken)
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  // ---- 数据 ----

  agent(id: string): Json | undefined {
    return this.agents.find(a => a.id === id)
  }

  addAgent(owner: string, localId: string, extra: Json = {}, channel = 'tc_1'): Json {
    const a = {
      id: this.id('ta'),
      channel_id: channel,
      owner,
      local_id: localId,
      name: owner === this.me.id ? '前端助手' : '审查员',
      engine: 'claude',
      model: '',
      machine: '这台电脑',
      project: 'pixel-web',
      policy: 'approve',
      status: 'idle',
      task: null,
      updated_at: this.time(),
      ...extra,
    }
    this.agents.push(a)
    return a
  }

  private message(cid: string, kind: string, author: string, extra: Json): Json {
    const list = this.messages.get(cid)!
    const t = this.time()
    const m = {
      id: this.id('tg'),
      channel_id: cid,
      n: list.length ? (list[list.length - 1].n as number) + 1 : 1,
      seq: ++this.seq,
      kind,
      author,
      client_id: '',
      text: '',
      format: 'plain',
      reply_to: null,
      mentions: [],
      task_id: null,
      task: null,
      event: null,
      created_at: t,
      updated_at: t,
      ...extra,
    }
    list.push(m)
    return m
  }

  private frame(cid: string, m: Json): void {
    const parsed = parseMessage(m)
    if (parsed) this.push({ type: 'message', team: this.teamId, channel: cid, seq: parsed.seq, message: parsed })
  }

  private touch(m: Json): void {
    m.seq = ++this.seq
    m.updated_at = this.time()
    this.frame(m.channel_id as string, m)
  }

  /** 某个真人发消息（并按 §4.2 建任务卡 / 追加要求）；返回消息和任务卡 */
  userPost(
    author: string,
    cid: string,
    text: string,
    mentions: string[] = [],
    replyTo: string | null = null,
    clientId = '',
  ): { message: Json; tasks: Json[] } {
    const m = this.message(cid, 'message', author, { text, mentions, reply_to: replyTo, client_id: clientId })
    this.frame(cid, m)
    const tasks: Json[] = []
    const observer = this.users[author]?.role === 'observer'
    const target = replyTo ? this.messages.get(cid)!.find(x => x.id === replyTo && x.kind === 'task') : undefined
    const assignees = mentions.map(id => this.agent(id)).filter((a): a is Json => !!a)
    const status = (a: Json): string | null => this.dispatchStatus(a, author)
    if (!observer && target && (!assignees.length || assignees.every(a => a.id === (target.task as Json).assignee))) {
      const t = target.task as Json
      const a = this.agent(t.assignee as string)!
      if (!status(a)) return { message: m, tasks }
      t.requested_by = author
      t.approved = false
      t.round = (t.round as number) + 1
      t.status = status(a)
      t.followup_message = m.id
      t.error = t.note = t.summary = t.decision = t.progress = t.ended_at = null
      // 有人追加要求：不再是唤醒开的一轮
      if (this.wakeups) t.wake = null
      this.touch(target)
      tasks.push(target)
    } else if (!observer)
      for (const a of assignees) {
        if (!status(a)) continue
        // 和云端 taskTitle 一样：只去掉被派活的 AI 成员名（@全体、@真人 都留着），取第一行
        const title =
          assignees
            .reduce((t, x) => t.split(`@${x.name as string}`).join(''), text)
            .split('\n')
            .map(l => l.replace(/\s+/g, ' ').trim())
            .find(Boolean) ?? text
        const card = this.newCard(cid, author, a, m.id as string, title, status(a)!)
        tasks.push(card)
      }
    return { message: m, tasks }
  }

  /** 同云端 dispatchStatus：主人自己、团队都能派、名单里有他 → queued；只有我 → null（不能派）；其余要同意 */
  private dispatchStatus(a: Json, author: string): string | null {
    return a.owner === author ||
      a.policy === 'team' ||
      (a.policy === 'listed' && ((a.allow as string[] | undefined) ?? []).includes(author))
      ? 'queued'
      : a.policy === 'owner'
        ? null
        : 'approval'
  }

  /** 建一张任务卡并推出去（发消息派活、事项唤醒第一次叫） */
  private newCard(
    cid: string,
    author: string,
    a: Json,
    source: string,
    title: string,
    status: string,
    extra: Json = {},
  ): Json {
    const card = this.message(cid, 'task', author, {
      task: {
        assignee: a.id,
        owner: a.owner,
        title,
        status,
        round: 1,
        summary: null,
        diff: null,
        error: null,
        note: null,
        decision: null,
        progress: null,
        claimed_by: null,
        pending_action: null,
        source_message: source,
        ended_at: null,
        requested_by: author,
        approved: false,
        ...(this.wakeups ? { wakeups: [], wake: null } : {}),
        ...extra,
      },
    })
    this.frame(cid, card)
    return card
  }

  /** 直接在卡上放一条规则（测别人挂的、要我同意的）；返回规则 */
  putWakeup(cardId: string, rule: Json): Json {
    const t = this.task(cardId)
    const w = {
      id: this.id('tw'),
      member: '',
      owner: '',
      by: this.me.id,
      when: { kind: 'at', at: '2026-10-14T07:00:00Z' },
      text: '看看 CI',
      until: null,
      next: '2026-10-14T07:00:00Z',
      fired: 0,
      card: null,
      state: 'active',
      end_note: null,
      approved: false,
      created_at: this.time(),
      last_at: null,
      ...rule,
    }
    ;((t.wakeups as Json[] | undefined) ?? (t.wakeups = [])).push(w)
    this.touch(this.card(cardId))
    return w
  }

  /**
   * 叫一次（同云端 fireRule）：第一次以挂的人的名义发一条回复被盯的卡、@ 成员的消息，派一张带 wake 的唤醒卡；
   * 以后在唤醒卡上发一条追加要求（正文是指令）开下一轮，上一轮的摘要、决定留着
   */
  fireWakeup(cardId: string, ruleId: string): Json {
    const watched = this.card(cardId)
    const w = ((watched.task as Json).wakeups as Json[]).find(x => x.id === ruleId)!
    const a = this.agent(w.member as string)!
    const cid = watched.channel_id as string
    const kind = (w.when as Json).kind as string
    const wake = { rule_id: w.id, kind }
    w.fired = (w.fired as number) + 1
    w.last_at = this.time()
    if (!w.card) {
      const m = this.message(cid, 'message', w.by as string, {
        text: `⏰ 唤醒 @${a.name as string}：${w.text as string}`,
        reply_to: cardId,
        mentions: [a.id],
      })
      this.frame(cid, m)
      const card = this.newCard(cid, w.by as string, a, m.id as string, `唤醒：${w.text as string}`, 'queued', {
        wake,
        approved: w.approved,
      })
      w.card = card.id
      if (kind === 'at') Object.assign(w, { state: 'done', next: null })
      this.touch(watched)
      return card
    }
    const card = this.card(w.card as string)
    const m = this.message(cid, 'message', w.by as string, { text: w.text, reply_to: card.id })
    this.frame(cid, m)
    const t = card.task as Json
    Object.assign(t, {
      round: (t.round as number) + 1,
      status: 'queued',
      requested_by: w.by,
      approved: w.approved,
      followup_message: m.id,
      error: null,
      note: null,
      progress: null,
      ended_at: null,
      wake,
    })
    this.touch(card)
    this.touch(watched)
    return card
  }

  /** 唤醒接口（POST /tasks/{mid}/wakeups、DELETE …/{wid}、POST …/{wid}/approve），同云端 AddWakeup / CancelWakeup / ApproveWakeup */
  private wakeupRoute(card: Json, method: string, seg: string[], body: Json): Response {
    const t = card.task as Json
    const list = t.wakeups as Json[]
    if (seg.length === 6 && method === 'POST') {
      const a = this.agent(body.member as string)
      if (!a || a.channel_id !== card.channel_id || !body.text) return this.json({ error: '提交的内容不对' }, 400)
      const status = this.dispatchStatus(a, this.me.id)
      if (!status || this.role === 'observer') return this.json({ error: '没有权限' }, 403)
      if (t.status === 'stopped') return this.json({ error: '任务现在的状态不能做这个操作' }, 409)
      const when = body.when as Json
      const w = this.putWakeup(card.id as string, {
        member: a.id,
        owner: a.owner,
        by: this.me.id,
        when,
        text: body.text,
        until: body.until ?? null,
        next: when.kind === 'at' ? when.at : '2026-10-15T01:00:00Z',
        state: status === 'queued' ? 'active' : 'pending',
      })
      return this.json({ message: card, wakeup: w }, 201)
    }
    const w = list.find(x => x.id === seg[6])
    if (!w) return this.json({ error: '不存在' }, 404)
    if (method === 'DELETE') {
      if (w.by !== this.me.id && w.owner !== this.me.id) return this.json({ error: '没有权限' }, 403)
      if (w.state === 'active' || w.state === 'pending') Object.assign(w, { state: 'cancelled', next: null })
    } else if (seg[7] === 'approve') {
      if (w.owner !== this.me.id) return this.json({ error: '没有权限' }, 403)
      if (w.state !== 'pending') return this.json({ error: '任务现在的状态不能做这个操作' }, 409)
      Object.assign(
        w,
        body.approve === false
          ? { state: 'cancelled', end_note: 'rejected', next: null }
          : { state: 'active', approved: true },
      )
    }
    this.touch(card)
    return this.json({ message: card })
  }

  card(id: string): Json {
    for (const list of this.messages.values()) {
      const m = list.find(x => x.id === id)
      if (m) return m
    }
    throw new Error(`没有 ${id}`)
  }

  task(id: string): Json {
    return this.card(id).task as Json
  }

  /** 全部任务卡 */
  cards(): Json[] {
    return [...this.messages.values()].flat().filter(m => m.kind === 'task')
  }

  // ---- 路由 ----

  private route(method: string, full: string, body: Json, runToken?: string): Response {
    const [path, query = ''] = full.split('?')
    const q = new URLSearchParams(query)
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
    // seg: v1 teams ...
    if (seg[1] === 'invites') return this.json({})
    if (seg[1] === 'inbox' && method === 'GET') {
      if (!this.inbox) return new Response('404 page not found', { status: 404 })
      return this.json({ items: this.inbox.filter(it => !it.archived) })
    }
    if (seg[3] === 'inbox' && method === 'PATCH') {
      const it = this.inbox?.find(x => x.team_id === seg[2] && x.key === seg[4])
      if (!it) return this.json({ error: '找不到' }, 404)
      for (const k of ['read', 'archived', 'muted', 'snooze_until']) if (k in body) it[k] = body[k]
      if (body.muted === true) it.archived = true
      return this.json({ item: it })
    }
    if (method === 'GET' && seg.length === 2) return this.json(this.overview())
    if (method === 'POST' && seg.length === 2) return this.json({ id: this.id('tm') })
    if (method === 'GET' && seg[2] === 'tasks' && seg[3] === 'mine') {
      const tasks = this.cards()
        .filter(
          m =>
            (m.task as Json).owner === this.me.id &&
            !['done', 'failed', 'stopped'].includes((m.task as Json).status as string),
        )
        .map(m => ({ team_id: this.teamId, channel_id: m.channel_id, message: m }))
      return this.json({ tasks })
    }
    const tid = seg[2]
    if (tid !== this.teamId) return this.json({ error: '不存在' }, 404)
    if (seg[3] === 'channels') {
      if (seg.length === 4 && method === 'POST') {
        const c = {
          id: this.id('tc'),
          name: body.name as string,
          topic: (body.topic as string | null) ?? null,
          createdBy: this.me.id,
        }
        this.channels.push(c)
        this.messages.set(c.id, [])
        return this.json({ id: c.id })
      }
      const cid = seg[4]
      if (!this.messages.has(cid)) return this.json({ error: '不存在' }, 404)
      if (seg[5] === 'messages' && method === 'GET') return this.listMessages(cid, q)
      if (seg[5] === 'messages' && method === 'POST') return this.postMessage(cid, body)
      if (seg[5] === 'read') {
        this.readN[cid] = Math.max(this.readN[cid] ?? 0, body.n as number)
        return this.json({})
      }
      if (seg[5] === 'agents' && method === 'PUT') {
        const old = this.agents.find(a => a.channel_id === cid && a.local_id === seg[6] && a.owner === this.me.id)
        if (old) Object.assign(old, body)
        else this.addAgent(this.me.id, seg[6], body, cid)
        return this.json({})
      }
      if (method === 'PATCH') {
        const c = this.channels.find(x => x.id === cid)!
        if (typeof body.name === 'string') c.name = body.name
        if ('topic' in body) c.topic = body.topic as string | null
        return this.json({})
      }
      if (method === 'DELETE') {
        this.channels = this.channels.filter(x => x.id !== cid)
        this.messages.delete(cid)
        return this.json({})
      }
    }
    if (seg[3] === 'agents' && seg[4] === 'status') {
      for (const s of body.agents as Json[]) {
        const a = this.agent(s.id as string)
        if (a) Object.assign(a, { status: s.status, task: s.task })
      }
      return this.json({})
    }
    if (seg[3] === 'agents' && method === 'DELETE') {
      this.agents = this.agents.filter(a => a.id !== seg[4])
      return this.json({})
    }
    if (seg[3] === 'runs') {
      // 运行凭证写回（同云端 runTask：凭证对、卡没结束）
      const card = this.cards().find(m => m.id === seg[4])
      const t = card?.task as Json | undefined
      if (
        !card ||
        !t ||
        !runToken ||
        this.runTokens.get(card.id as string) !== runToken ||
        ENDED.includes(t.status as string)
      )
        return this.json({ error: '运行凭证无效或已过期' }, 401)
      if (seg[5] === 'result')
        return this.json(
          JSON.parse(
            JSON.stringify(
              this.agentPost(card.channel_id as string, {
                ...body,
                agent_id: t.assignee,
                task_id: card.id,
                reply_to: card.id,
              }),
            ),
          ),
          201,
        )
      this.patchCard(card, body)
      return this.json({ message: card })
    }
    if (seg[3] === 'tasks') {
      const card = this.cards().find(m => m.id === seg[4])
      if (!card) return this.json({ error: '不存在' }, 404)
      const t = card.task as Json
      if (seg[5] === 'wakeups')
        return this.wakeups
          ? this.wakeupRoute(card, method, seg, body)
          : new Response('404 page not found', { status: 404 })
      if (seg[5] === 'start') {
        // 旧云端：没有这个接口（Go 的 404 是纯文字）
        if (!this.startOutcome) return new Response('404 page not found', { status: 404 })
        if (t.claimed_by !== body.device) return this.json({ error: '已被认领' }, 409)
        // 同云端：还在排队、没有别的请求（重试的请求执行端随后清掉）
        if (t.status !== 'queued' || (t.pending_action && t.pending_action !== 'retry'))
          return this.json({ error: '任务现在的状态不能做这个操作' }, 409)
        const outcome = this.startOutcome
        let token: string | null = null
        if (outcome === 'ok') {
          token = `rt_${card.id}_${this.id('run')}`
          this.runTokens.set(card.id as string, token)
        } else if (outcome === 'approval') {
          t.status = 'approval'
          t.claimed_by = null
        } else {
          t.status = 'stopped'
          t.reason = 'not_allowed'
          t.ended_at = this.time()
        }
        if (outcome !== 'ok') this.runTokens.delete(card.id as string)
        this.touch(card)
        return this.json({ message: card, outcome, run_token: token })
      }
      if (seg[5] === 'claim') {
        if (t.claimed_by && t.claimed_by !== body.device) return this.json({ error: '已被认领' }, 409)
        t.claimed_by = body.device
        this.touch(card)
      } else if (seg[5] === 'approve') {
        t.status = body.approve ? 'queued' : 'stopped'
        if (body.approve) t.approved = true
        if (!body.approve) t.note = 'rejected'
        this.touch(card)
      } else if (seg[5] === 'action') {
        t.pending_action = body.action
        this.touch(card)
      } else if (method === 'PATCH') this.patchCard(card, body)
      return this.json({ message: card })
    }
    // 成员、邀请、团队本身：只记调用
    if (['members', 'invites', 'me'].includes(seg[3]) || seg.length === 3) return this.json({})
    return this.json({ error: '不存在' }, 404)
  }

  /** 改任务卡（登录令牌和运行凭证两条路一样） */
  private patchCard(card: Json, body: Json): void {
    const t = card.task as Json
    for (const key of [
      'status',
      'title',
      'summary',
      'diff',
      'error',
      'note',
      'decision',
      'progress',
      'round',
      'reason',
    ])
      if (key in body) t[key] = body[key]
    if (body.clear_action) t.pending_action = null
    // 运行记录只追加，同一轮同一结束时间不重复（同云端 teams.addRuns）
    if (Array.isArray(body.add_runs)) {
      const runs = Array.isArray(t.runs) ? (t.runs as Record<string, unknown>[]) : []
      for (const r of body.add_runs as Record<string, unknown>[])
        if (!runs.some(o => o.n === r.n && o.ended_at === r.ended_at)) runs.push(r)
      t.runs = runs
    }
    if (ENDED.includes(t.status as string)) {
      t.ended_at = this.time()
      this.runTokens.delete(card.id as string)
    }
    this.touch(card)
  }

  private listMessages(cid: string, q: URLSearchParams): Response {
    const all = this.messages.get(cid)!
    const limit = Number(q.get('limit') ?? 100)
    if (q.has('after')) {
      const rest = all.filter(m => (m.seq as number) > Number(q.get('after')))
      return this.json({ messages: rest.slice(0, limit), has_more: rest.length > limit })
    }
    const before = q.has('before') ? Number(q.get('before')) : Infinity
    const older = all.filter(m => (m.n as number) < before)
    return this.json({ messages: older.slice(-limit), has_more: older.length > limit })
  }

  private postMessage(cid: string, body: Json): Response {
    const author = (body.agent_id as string | undefined) ?? this.me.id
    const dup = this.messages
      .get(cid)!
      .find(m => m.author === author && body.client_id && m.client_id === body.client_id)
    if (dup) return this.json({ message: dup, tasks: [] })
    if (body.agent_id) return this.json(this.agentPost(cid, body))
    const { message, tasks } = this.userPost(
      this.me.id,
      cid,
      body.text as string,
      (body.mentions as string[]) ?? [],
      (body.reply_to as string | undefined) ?? null,
      (body.client_id as string) ?? '',
    )
    return this.json({ message, tasks })
  }

  /** AI 成员发结果（登录令牌带 agent_id，或运行凭证接口） */
  private agentPost(cid: string, body: Json): { message: Json; tasks: Json[] } {
    const author = body.agent_id as string
    const dup = this.messages
      .get(cid)!
      .find(m => m.author === author && body.client_id && m.client_id === body.client_id)
    if (dup) return { message: dup, tasks: [] }
    const m = this.message(cid, 'message', author, {
      text: body.text,
      format: 'markdown',
      reply_to: body.reply_to ?? null,
      mentions: body.mentions ?? [],
      task_id: body.task_id ?? null,
      client_id: body.client_id,
    })
    this.frame(cid, m)
    return { message: m, tasks: [] }
  }

  private overview(): Json {
    return {
      me: this.me,
      teams: [
        {
          id: this.teamId,
          name: '像素星空小队',
          role: this.role,
          seq: this.seq,
          members: Object.entries(this.users).map(([id, u]) => ({
            id,
            name: u.name,
            email: u.email,
            role: u.role,
            online: u.online,
            last_seen_at: '2026-10-14T06:00:00Z',
          })),
          invites: this.role === 'owner' ? this.invites : [],
          channels: this.channels.map(c => {
            const list = this.messages.get(c.id)!
            const read = this.readN[c.id] ?? 0
            const unread = list.filter(m => m.kind === 'message' && (m.n as number) > read && m.author !== this.me.id)
            return {
              id: c.id,
              name: c.name,
              topic: c.topic,
              created_by: c.createdBy,
              created_at: '2026-10-14T05:00:00Z',
              last_at: list.length ? (list[list.length - 1].created_at as string) : '2026-10-14T05:00:00Z',
              seq: list.reduce((max, m) => Math.max(max, m.seq as number), 0),
              last_n: list.length ? list[list.length - 1].n : 0,
              read_n: read,
              unread: unread.length,
              mentioned: unread.some(m => (m.mentions as string[]).includes(this.me.id)),
            }
          }),
          agents: this.agents,
        },
      ],
      invites: [],
    }
  }
}

/** 等一个条件成立（测试里等异步步骤走完） */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise(r => setTimeout(r, 4))
  }
}

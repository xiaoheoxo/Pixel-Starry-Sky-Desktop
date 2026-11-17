// 测试用的假云端（只给 team/*.test.ts 和 service.team.test.ts 用，应用里不会引入）：
// 在内存里实现 docs/ui/channels-phase-c.md §8.2 的接口子集，按 §4.2 的规则建任务卡，变化通过 push 回调推给「实时通道」。
import type { TeamFetch } from './api'
import type { TeamFrame } from './realtime'
import { parseMessage } from './api'

type Json = Record<string, unknown>

export interface FakeCall {
  method: string
  path: string
  body: Json | undefined
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

  fetch: TeamFetch = async (method, path, body) => {
    if (this.down) throw new TypeError('fetch failed')
    this.calls.push({ method, path, body: body as Json | undefined })
    for (const [key, status] of Object.entries(this.failures)) {
      const [m, prefix] = key.split(' ')
      if (m === method && path.startsWith(prefix)) return this.json({ error: '失败' }, status)
    }
    if (!this.deployed) return this.json({ error: 'not found' }, 404)
    return this.route(method, path, (body ?? {}) as Json)
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
    const status = (a: Json): string => (a.owner === author || a.policy === 'team' ? 'queued' : 'approval')
    if (!observer && target && (!assignees.length || assignees.every(a => a.id === (target.task as Json).assignee))) {
      const t = target.task as Json
      const a = this.agent(t.assignee as string)!
      t.round = (t.round as number) + 1
      t.status = status(a)
      t.followup_message = m.id
      t.error = t.note = t.summary = t.decision = t.progress = t.ended_at = null
      this.touch(target)
      tasks.push(target)
    } else if (!observer)
      for (const a of assignees) {
        const card = this.message(cid, 'task', author, {
          task: {
            assignee: a.id,
            owner: a.owner,
            // 和云端 taskTitle 一样：只去掉被派活的 AI 成员名（@全体、@真人 都留着），取第一行
            title:
              assignees
                .reduce((t, x) => t.split(`@${x.name as string}`).join(''), text)
                .split('\n')
                .map(l => l.replace(/\s+/g, ' ').trim())
                .find(Boolean) ?? text,
            status: status(a),
            round: 1,
            summary: null,
            diff: null,
            error: null,
            note: null,
            decision: null,
            progress: null,
            claimed_by: null,
            pending_action: null,
            source_message: m.id,
            ended_at: null,
          },
        })
        this.frame(cid, card)
        tasks.push(card)
      }
    return { message: m, tasks }
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

  private route(method: string, full: string, body: Json): Response {
    const [path, query = ''] = full.split('?')
    const q = new URLSearchParams(query)
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent)
    // seg: v1 teams ...
    if (seg[1] === 'invites') return this.json({})
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
    if (seg[3] === 'tasks') {
      const card = this.cards().find(m => m.id === seg[4])
      if (!card) return this.json({ error: '不存在' }, 404)
      const t = card.task as Json
      if (seg[5] === 'claim') {
        if (t.claimed_by && t.claimed_by !== body.device) return this.json({ error: '已被认领' }, 409)
        t.claimed_by = body.device
        this.touch(card)
      } else if (seg[5] === 'approve') {
        t.status = body.approve ? 'queued' : 'stopped'
        if (!body.approve) t.note = 'rejected'
        this.touch(card)
      } else if (seg[5] === 'action') {
        t.pending_action = body.action
        this.touch(card)
      } else if (method === 'PATCH') {
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
        if (['done', 'failed', 'stopped'].includes(t.status as string)) t.ended_at = this.time()
        this.touch(card)
      }
      return this.json({ message: card })
    }
    // 成员、邀请、团队本身：只记调用
    if (['members', 'invites', 'me'].includes(seg[3]) || seg.length === 3) return this.json({})
    return this.json({ error: '不存在' }, 404)
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
    if (body.agent_id) {
      const m = this.message(cid, 'message', author, {
        text: body.text,
        format: 'markdown',
        reply_to: body.reply_to ?? null,
        mentions: body.mentions ?? [],
        task_id: body.task_id ?? null,
        client_id: body.client_id,
      })
      this.frame(cid, m)
      return this.json({ message: m, tasks: [] })
    }
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

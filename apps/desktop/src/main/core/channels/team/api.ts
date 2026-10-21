// 团队云端接口的薄客户端（docs/ui/channels-phase-c.md §8.2）：snake_case → camelCase，时间转毫秒，
// 非 2xx 转成带 code 的错误。请求函数（teamsFetch）由应用层注入，这里不碰 Electron。
import type { AgentPolicy, ChannelTaskStatus, TeamRole } from '../../../../shared/types/channels'

export type TeamErrorCode =
  | 'NOT_DEPLOYED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INVALID'
  | 'UNAVAILABLE'
  | 'AUTH_EXPIRED'

export class TeamError extends Error {
  constructor(
    message: string,
    readonly code: TeamErrorCode,
  ) {
    super(message)
    this.name = 'TeamError'
  }
}

export type TeamFetch = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs?: number,
) => Promise<Response>

// ---------------------------------------------------------------------------
// 类型（解析后的云端数据）
// ---------------------------------------------------------------------------

export interface TeamMe {
  id: string
  name: string
  email: string
}

export interface TeamMemberData {
  id: string
  name: string
  email: string
  role: TeamRole
  online: boolean
  lastSeenAt: number | null
}

export interface TeamInviteData {
  id: string
  email: string
  role: Exclude<TeamRole, 'owner'>
  expiresAt: number
}

export interface TeamChannelData {
  id: string
  name: string
  topic: string | null
  createdBy: string
  createdAt: number
  lastAt: number
  seq: number
  lastN: number
  readN: number
  unread: number
  mentioned: boolean
}

export interface TeamAgentData {
  id: string
  channelId: string
  /** 主人（owner key） */
  owner: string
  /** 主人那边的本机成员 id */
  localId: string
  name: string
  engine: string
  model: string
  machine: string
  project: string
  policy: AgentPolicy
  status: 'idle' | 'running' | 'waiting'
  task: string | null
  updatedAt: number
}

export interface TeamData {
  id: string
  name: string
  role: TeamRole
  seq: number
  members: TeamMemberData[]
  invites: TeamInviteData[]
  channels: TeamChannelData[]
  agents: TeamAgentData[]
}

export interface InviteData {
  id: string
  teamId: string
  teamName: string
  inviter: string
  role: Exclude<TeamRole, 'owner'>
  expiresAt: number
}

export interface Overview {
  me: TeamMe
  teams: TeamData[]
  invites: InviteData[]
}

export interface TeamTaskData {
  assignee: string
  owner: string
  title: string
  status: ChannelTaskStatus
  round: number
  summary: string | null
  diff: { added: number; removed: number } | null
  error: string | null
  note: 'cancelled' | 'rejected' | 'expired' | null
  decision: string | null
  progress: { done: number; total: number } | null
  claimedBy: string | null
  pendingAction: 'cancel' | 'stop' | 'retry' | null
  sourceMessage: string | null
  /** 追加要求那条消息的 id（任务卡被追加要求后云端带上） */
  followupMessage: string | null
  endedAt: number | null
}

export interface TeamEventData {
  type: string
  actor: string
  target: string | null
  value: string | null
}

export interface TeamMessage {
  id: string
  channelId: string
  n: number
  seq: number
  kind: 'message' | 'task' | 'event'
  author: string
  clientId: string
  text: string
  format: 'plain' | 'markdown'
  replyTo: string | null
  mentions: string[]
  taskId: string | null
  task: TeamTaskData | null
  event: TeamEventData | null
  createdAt: number
  updatedAt: number
}

export interface MessageQuery {
  /** 往前翻：n 小于它的 */
  before?: number
  /** 补齐：seq 大于它的 */
  after?: number
  limit?: number
}

export interface MineTask {
  teamId: string
  channelId: string
  message: TeamMessage
}

/** 发给 PATCH /tasks/{mid} 的字段（snake_case 由 patchTask 转） */
export interface TaskPatch {
  status?: ChannelTaskStatus
  title?: string
  summary?: string | null
  diff?: { added: number; removed: number } | null
  error?: string | null
  note?: string | null
  decision?: string | null
  progress?: { done: number; total: number } | null
  round?: number
  clearAction?: boolean
}

export interface AgentRegistration {
  name: string
  engine: string
  model: string
  machine: string
  project: string
  policy: AgentPolicy
}

// ---------------------------------------------------------------------------
// 解析（逐字段防御）
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function time(v: unknown): number {
  if (typeof v !== 'string') return 0
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : 0
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

const ROLES = ['owner', 'member', 'observer'] as const satisfies readonly TeamRole[]
const INVITE_ROLES = ['member', 'observer'] as const
const STATUSES = [
  'queued',
  'approval',
  'running',
  'waiting',
  'done',
  'failed',
  'stopped',
] as const satisfies readonly ChannelTaskStatus[]
const AGENT_STATUS = ['idle', 'running', 'waiting'] as const

const arr = <T>(v: unknown, parse: (x: unknown) => T | null): T[] =>
  (Array.isArray(v) ? v : []).flatMap(x => parse(x) ?? [])

function parseMember(v: unknown): TeamMemberData | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  const seen = time(v.last_seen_at)
  return {
    id: v.id,
    name: str(v.name),
    email: str(v.email),
    role: oneOf(v.role, ROLES, 'member'),
    online: v.online === true,
    lastSeenAt: seen > 0 ? seen : null,
  }
}

function parseTeamInvite(v: unknown): TeamInviteData | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  return {
    id: v.id,
    email: str(v.email),
    role: oneOf(v.role, INVITE_ROLES, 'member'),
    expiresAt: time(v.expires_at),
  }
}

function parseChannel(v: unknown): TeamChannelData | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  const created = time(v.created_at)
  return {
    id: v.id,
    name: str(v.name),
    topic: strOrNull(v.topic),
    createdBy: str(v.created_by),
    createdAt: created,
    lastAt: time(v.last_at) || created,
    seq: int(v.seq),
    lastN: int(v.last_n),
    readN: int(v.read_n),
    unread: Math.max(0, int(v.unread)),
    mentioned: v.mentioned === true,
  }
}

function parseAgent(v: unknown): TeamAgentData | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  return {
    id: v.id,
    channelId: str(v.channel_id),
    owner: str(v.owner),
    localId: str(v.local_id),
    name: str(v.name),
    engine: str(v.engine),
    model: str(v.model),
    machine: str(v.machine),
    project: str(v.project),
    policy: oneOf(v.policy, ['approve', 'team'] as const, 'approve'),
    status: oneOf(v.status, AGENT_STATUS, 'idle'),
    task: strOrNull(v.task),
    updatedAt: time(v.updated_at),
  }
}

function parseTeam(v: unknown): TeamData | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  return {
    id: v.id,
    name: str(v.name),
    role: oneOf(v.role, ROLES, 'member'),
    seq: int(v.seq),
    members: arr(v.members, parseMember),
    invites: arr(v.invites, parseTeamInvite),
    channels: arr(v.channels, parseChannel),
    agents: arr(v.agents, parseAgent),
  }
}

function parsePendingInvite(v: unknown): InviteData | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  return {
    id: v.id,
    teamId: str(v.team_id),
    teamName: str(v.team_name),
    inviter: str(v.inviter),
    role: oneOf(v.role, INVITE_ROLES, 'member'),
    expiresAt: time(v.expires_at),
  }
}

export function parseOverview(body: unknown): Overview {
  const o = isObj(body) ? body : {}
  const me = isObj(o.me) ? o.me : {}
  return {
    me: { id: str(me.id), name: str(me.name), email: str(me.email) },
    teams: arr(o.teams, parseTeam),
    invites: arr(o.invites, parsePendingInvite),
  }
}

function parseTask(v: unknown): TeamTaskData | null {
  if (!isObj(v)) return null
  const diff = isObj(v.diff) ? { added: int(v.diff.added), removed: int(v.diff.removed) } : null
  const progress = isObj(v.progress) ? { done: int(v.progress.done), total: int(v.progress.total) } : null
  // 不认识的请求（云端以后新加的）当作没有：不能回退成取消，否则旧版本会把活停掉
  const action =
    v.pending_action === 'cancel' || v.pending_action === 'stop' || v.pending_action === 'retry'
      ? v.pending_action
      : null
  return {
    assignee: str(v.assignee),
    owner: str(v.owner),
    title: str(v.title),
    status: oneOf(v.status, STATUSES, 'queued'),
    round: Math.max(1, int(v.round)),
    summary: strOrNull(v.summary),
    diff: diff && (diff.added || diff.removed) ? diff : null,
    error: strOrNull(v.error),
    note: v.note === 'cancelled' || v.note === 'rejected' || v.note === 'expired' ? v.note : null,
    decision: strOrNull(v.decision),
    progress: progress && progress.total ? progress : null,
    claimedBy: strOrNull(v.claimed_by),
    pendingAction: action,
    sourceMessage: strOrNull(v.source_message),
    followupMessage: strOrNull(v.followup_message),
    endedAt: time(v.ended_at) || null,
  }
}

export function parseMessage(v: unknown): TeamMessage | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  const kind = oneOf(v.kind, ['message', 'task', 'event'] as const, 'message')
  const created = time(v.created_at)
  const event = isObj(v.event)
    ? {
        type: str(v.event.type),
        actor: str(v.event.actor),
        target: strOrNull(v.event.target),
        value: strOrNull(v.event.value),
      }
    : null
  return {
    id: v.id,
    channelId: str(v.channel_id),
    n: int(v.n),
    seq: int(v.seq),
    kind,
    author: str(v.author),
    clientId: str(v.client_id),
    text: str(v.text),
    format: v.format === 'markdown' ? 'markdown' : 'plain',
    replyTo: strOrNull(v.reply_to),
    mentions: (Array.isArray(v.mentions) ? v.mentions : []).filter((m): m is string => typeof m === 'string'),
    taskId: strOrNull(v.task_id),
    task: kind === 'task' ? parseTask(v.task) : null,
    event: kind === 'event' ? event : null,
    createdAt: created,
    updatedAt: time(v.updated_at) || created,
  }
}

function messageOf(body: unknown): TeamMessage {
  const m = isObj(body) ? parseMessage(body.message ?? body) : null
  if (!m) throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
  return m
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

async function errorOf(res: Response, notDeployed: boolean): Promise<TeamError> {
  let message = ''
  try {
    const body: unknown = await res.json()
    if (isObj(body)) {
      if (typeof body.error === 'string') message = body.error
      else if (isObj(body.error) && typeof body.error.message === 'string') message = body.error.message
    }
  } catch {
    /* 响应体不是 JSON */
  }
  const s = res.status
  if (s === 404 && notDeployed) return new TeamError(message || '云端暂未开放团队功能', 'NOT_DEPLOYED')
  if (s === 404) return new TeamError(message || '团队、频道或消息不存在', 'NOT_FOUND')
  if (s === 403) return new TeamError(message || '没有权限', 'FORBIDDEN')
  if (s === 409) return new TeamError(message || '操作冲突，请刷新后重试', 'CONFLICT')
  if (s === 429) return new TeamError(message || '操作太频繁，请稍后再试', 'RATE_LIMITED')
  if (s === 400 || s === 413) return new TeamError(message || '提交的内容不对', 'INVALID')
  return new TeamError(message || '团队服务暂时不可用，请稍后再试', 'UNAVAILABLE')
}

const seg = (id: string): string => encodeURIComponent(id)

export class TeamApi {
  constructor(private readonly fetcher: TeamFetch) {}

  /** 发请求并检查状态；网络错误、超时变成 UNAVAILABLE，登录过期变成 AUTH_EXPIRED，其余原样抛出 */
  private async request(
    method: Parameters<TeamFetch>[0],
    path: string,
    body?: unknown,
    notDeployed = false,
  ): Promise<Response> {
    let res: Response
    try {
      res = await this.fetcher(method, path, body)
    } catch (e) {
      if (e instanceof TeamError) throw e
      const err = e as { code?: unknown; name?: unknown; message?: unknown }
      if (err?.code === 'AUTH_EXPIRED')
        throw new TeamError(typeof err.message === 'string' ? err.message : '登录已过期', 'AUTH_EXPIRED')
      if (e instanceof Error && !(e.name === 'TimeoutError' || e.name === 'AbortError' || e instanceof TypeError))
        throw e
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new TeamError(timeout ? '请求超时，请稍后再试' : '连不上云端，请检查网络后重试', 'UNAVAILABLE')
    }
    if (res.ok) return res
    throw await errorOf(res, notDeployed)
  }

  private async json(res: Response): Promise<unknown> {
    try {
      return await res.json()
    } catch {
      throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
    }
  }

  private async call(method: Parameters<TeamFetch>[0], path: string, body?: unknown): Promise<void> {
    const res = await this.request(method, path, body)
    await res.body?.cancel().catch(() => undefined)
  }

  async overview(): Promise<Overview> {
    return parseOverview(await this.json(await this.request('GET', '/v1/teams', undefined, true)))
  }

  async createTeam(name: string): Promise<string> {
    const body = await this.json(await this.request('POST', '/v1/teams', { name }))
    const team = isObj(body) && isObj(body.team) ? body.team : body
    const id = isObj(team) ? str(team.id) : ''
    if (!id) throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
    return id
  }

  updateTeam(teamId: string, patch: { name: string }): Promise<void> {
    return this.call('PATCH', `/v1/teams/${seg(teamId)}`, patch)
  }

  deleteTeam(teamId: string): Promise<void> {
    return this.call('DELETE', `/v1/teams/${seg(teamId)}`)
  }

  rename(teamId: string, name: string): Promise<void> {
    return this.call('PATCH', `/v1/teams/${seg(teamId)}/me`, { name })
  }

  invite(teamId: string, email: string, role: Exclude<TeamRole, 'owner'>): Promise<void> {
    return this.call('POST', `/v1/teams/${seg(teamId)}/invites`, { email, role })
  }

  revokeInvite(teamId: string, inviteId: string): Promise<void> {
    return this.call('DELETE', `/v1/teams/${seg(teamId)}/invites/${seg(inviteId)}`)
  }

  respondInvite(inviteId: string, accept: boolean): Promise<void> {
    return this.call('POST', `/v1/invites/${seg(inviteId)}/${accept ? 'accept' : 'decline'}`, {})
  }

  setRole(teamId: string, userId: string, role: Exclude<TeamRole, 'owner'>): Promise<void> {
    return this.call('PATCH', `/v1/teams/${seg(teamId)}/members/${seg(userId)}`, { role })
  }

  removeMember(teamId: string, userId: string): Promise<void> {
    return this.call('DELETE', `/v1/teams/${seg(teamId)}/members/${seg(userId)}`)
  }

  async createChannel(teamId: string, input: { name: string; topic: string | null }): Promise<string> {
    const body = await this.json(await this.request('POST', `/v1/teams/${seg(teamId)}/channels`, input))
    const channel = isObj(body) && isObj(body.channel) ? body.channel : body
    const id = isObj(channel) ? str(channel.id) : ''
    if (!id) throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
    return id
  }

  updateChannel(teamId: string, channelId: string, patch: { name?: string; topic?: string | null }): Promise<void> {
    return this.call('PATCH', `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}`, patch)
  }

  deleteChannel(teamId: string, channelId: string): Promise<void> {
    return this.call('DELETE', `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}`)
  }

  async messages(
    teamId: string,
    channelId: string,
    query: MessageQuery = {},
  ): Promise<{ messages: TeamMessage[]; hasMore: boolean }> {
    const q = new URLSearchParams()
    if (query.before !== undefined) q.set('before', String(query.before))
    if (query.after !== undefined) q.set('after', String(query.after))
    if (query.limit !== undefined) q.set('limit', String(query.limit))
    const qs = q.toString()
    const path = `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}/messages${qs ? `?${qs}` : ''}`
    const body = await this.json(await this.request('GET', path))
    const o = isObj(body) ? body : {}
    return { messages: arr(o.messages, parseMessage), hasMore: o.has_more === true }
  }

  async postMessage(
    teamId: string,
    channelId: string,
    input: {
      clientId: string
      text: string
      replyTo?: string | null
      mentions: string[]
      agentId?: string
      taskId?: string
    },
  ): Promise<{ message: TeamMessage; tasks: TeamMessage[] }> {
    const wire = {
      client_id: input.clientId,
      text: input.text,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      mentions: input.mentions,
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(input.taskId ? { task_id: input.taskId } : {}),
    }
    const body = await this.json(
      await this.request('POST', `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}/messages`, wire),
    )
    const o = isObj(body) ? body : {}
    const message = parseMessage(o.message)
    if (!message) throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
    return { message, tasks: arr(o.tasks, parseMessage) }
  }

  markRead(teamId: string, channelId: string, n: number): Promise<void> {
    return this.call('POST', `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}/read`, { n })
  }

  putAgent(teamId: string, channelId: string, localId: string, reg: AgentRegistration): Promise<void> {
    return this.call('PUT', `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}/agents/${seg(localId)}`, reg)
  }

  deleteAgent(teamId: string, agentId: string): Promise<void> {
    return this.call('DELETE', `/v1/teams/${seg(teamId)}/agents/${seg(agentId)}`)
  }

  agentStatus(
    teamId: string,
    agents: { id: string; status: 'idle' | 'running' | 'waiting'; task: string | null }[],
  ): Promise<void> {
    return this.call('POST', `/v1/teams/${seg(teamId)}/agents/status`, { agents })
  }

  async tasksMine(): Promise<MineTask[]> {
    const body = await this.json(await this.request('GET', '/v1/teams/tasks/mine'))
    const o = isObj(body) ? body : {}
    return arr(o.tasks, v => {
      if (!isObj(v)) return null
      const message = parseMessage(v.message)
      return message ? { teamId: str(v.team_id), channelId: str(v.channel_id) || message.channelId, message } : null
    })
  }

  async claim(teamId: string, messageId: string, device: string): Promise<TeamMessage> {
    return messageOf(
      await this.json(await this.request('POST', `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}/claim`, { device })),
    )
  }

  async patchTask(teamId: string, messageId: string, patch: TaskPatch): Promise<TeamMessage> {
    const { clearAction, ...rest } = patch
    const wire = { ...rest, ...(clearAction ? { clear_action: true } : {}) }
    return messageOf(
      await this.json(await this.request('PATCH', `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}`, wire)),
    )
  }

  async approve(teamId: string, messageId: string, approve: boolean): Promise<TeamMessage> {
    return messageOf(
      await this.json(
        await this.request('POST', `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}/approve`, { approve }),
      ),
    )
  }

  async action(teamId: string, messageId: string, action: 'cancel' | 'stop' | 'retry'): Promise<TeamMessage> {
    return messageOf(
      await this.json(
        await this.request('POST', `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}/action`, { action }),
      ),
    )
  }
}

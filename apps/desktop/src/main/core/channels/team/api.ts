// 团队云端接口的薄客户端（docs/ui/channels-phase-c.md §8.2）：snake_case → camelCase，时间转毫秒，
// 非 2xx 转成带 code 的错误。请求函数（teamsFetch）由应用层注入，这里不碰 Electron。
import type {
  AgentPolicy,
  ChannelRun,
  ChannelTaskStatus,
  ChannelWakeupTag,
  RunReason,
  TeamInboxItem,
  TeamInboxKind,
  TeamInboxPatch,
  TeamRole,
  WakeupFreq,
} from '../../../../shared/types/channels'
import { parseRunReason } from '../../../../shared/channels/runReason'

export type TeamErrorCode =
  | 'NOT_DEPLOYED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INVALID'
  | 'UNAVAILABLE'
  | 'AUTH_EXPIRED'
  /** 运行凭证不对、过期，或卡已经结束（docs/multica-learn.md §11.3） */
  | 'RUN_TOKEN'

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
  /** 用这一轮的运行凭证代替登录令牌（只用于 /v1/teams/{tid}/runs/…，docs/multica-learn.md §11.3） */
  runToken?: string,
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
  /** 置顶的消息 id（先后顺序）。null：云端还是旧版，没有讨论串、置顶、归档（docs/ui/channels-unify.md §7.1） */
  pinned: string[] | null
  archivedAt: number | null
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
  /** 「指定的人直接派」的名单（owner key）；旧云端没有 */
  allow: string[]
  /**
   * 由哪个执行端接（docs/multica-learn.md §11.7）：桌面的设备 id、执行机 id（rn_…）；null 是旧数据（主人的哪台桌面都接、
   * 执行机不接），旧云端没有
   */
  executor: string | null
  /** 绑的执行机（executor 是执行机、还没停用时才有）和它在不在线 */
  runner: TeamRunnerState | null
  status: 'idle' | 'running' | 'waiting'
  task: string | null
  updatedAt: number
}

/** AI 成员绑的执行机：总览里带在线状态，排队的卡「上线后开始」看它 */
export interface TeamRunnerState {
  id: string
  name: string
  online: boolean
  lastSeenAt: number | null
}

/** 我的执行机（GET /v1/teams/runners）：version 是执行机报的版本，没报为 null */
export interface TeamRunnerData {
  id: string
  name: string
  version: string | null
  createdAt: number
  lastSeenAt: number | null
  online: boolean
}

/** 执行机 id 的前缀（和云端 IsRunnerID 一致）；桌面的设备 id 是 dev-… */
export const isRunnerId = (id: string | null | undefined): boolean => !!id && id.startsWith('rn_')

export interface TeamData {
  id: string
  name: string
  role: TeamRole
  seq: number
  /** 排队宽限期（小时）；旧云端没有，为 0 */
  queueGraceHours: number
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
  /** 这一轮的原因代码、跑过的每一轮（docs/multica-learn.md §11.1）；旧云端没有 */
  reason: RunReason | null
  runs: ChannelRun[]
  /** 这一轮是谁要的（docs/multica-learn.md §11.3）；旧云端没有 */
  requestedBy: string | null
  /** 挂在这张卡上的事项唤醒（docs/multica-learn.md §11.6）：活着的和最近结束的；null 是旧云端（没有这个字段，不支持唤醒） */
  wakeups: TeamWakeupData[] | null
  /** 这一轮是事项唤醒开的（哪条规则、什么条件）；有人追加要求时云端清掉 */
  wake: ChannelWakeupTag | null
}

/** 团队卡上的唤醒条件：到某个时间（只一次）、定期检查（按挂规则的人的时区 tz） */
export type TeamWakeWhen =
  | { kind: 'at'; at: number }
  | { kind: 'every'; freq: WakeupFreq; hour: number; minute: number; tz: string }

/** 团队卡上的一条事项唤醒规则（云端字段，时间转成毫秒） */
export interface TeamWakeupData {
  id: string
  /** 叫谁（ta_…） */
  member: string
  /** 这个 AI 成员的主人（等同意时由他同意） */
  owner: string
  /** 谁挂的 */
  by: string
  when: TeamWakeWhen
  text: string
  until: number | null
  next: number | null
  fired: number
  /** 唤醒卡：第一次叫时建 */
  card: string | null
  state: 'pending' | 'active' | 'done' | 'expired' | 'cancelled'
  /** 规则自己结束的原因代码（card_stopped、member_gone、creator_left、not_allowed、rejected）；有人点取消的是 null */
  endNote: string | null
  approved: boolean
  createdAt: number
  lastAt: number | null
}

/** 挂一条唤醒（POST /tasks/{mid}/wakeups）：定期检查必须给截止 */
export interface WakeupInput {
  member: string
  when: TeamWakeWhen
  text: string
  until: number | null
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
  /** 讨论串的根；主时间线上的是 null */
  threadId: string | null
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
  /** 这一轮的原因代码；null 清掉 */
  reason?: RunReason | null
  /** 要追加的运行记录（云端按轮次 + 结束时间去重） */
  addRuns?: ChannelRun[]
}

export interface AgentRegistration {
  name: string
  engine: string
  model: string
  machine: string
  project: string
  policy: AgentPolicy
  /** 「指定的人直接派」的名单；不带就不改 */
  allow?: string[]
  /** 由哪个执行端接（桌面的设备 id、自己的执行机 id）；不带就不改，null 清掉（谁都接） */
  executor?: string | null
}

/** 开工前核对的结果（docs/multica-learn.md §11.3）：ok 时带这一轮的运行凭证；旧云端没有这个接口时 ok、没有凭证 */
export interface StartResult {
  outcome: 'ok' | 'approval' | 'stopped'
  message: TeamMessage | null
  runToken: string | null
}

// ---------------------------------------------------------------------------
// 解析（逐字段防御）
// ---------------------------------------------------------------------------

const AGENT_POLICIES = ['owner', 'approve', 'listed', 'team'] as const
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
    pinned: Array.isArray(v.pinned) ? v.pinned.filter((x): x is string => typeof x === 'string') : null,
    archivedAt: time(v.archived_at) || null,
  }
}

function parseRunnerState(v: unknown): TeamRunnerState | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  return { id: v.id, name: str(v.name), online: v.online === true, lastSeenAt: time(v.last_seen_at) || null }
}

function parseRunner(v: unknown): TeamRunnerData | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  return {
    id: v.id,
    name: str(v.name),
    version: strOrNull(v.version),
    createdAt: time(v.created_at),
    lastSeenAt: time(v.last_seen_at) || null,
    online: v.online === true,
  }
}

export function parseAgent(v: unknown): TeamAgentData | null {
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
    policy: oneOf(v.policy, AGENT_POLICIES, 'approve'),
    allow: Array.isArray(v.allow) ? v.allow.filter((x): x is string => typeof x === 'string' && !!x) : [],
    executor: strOrNull(v.executor),
    runner: parseRunnerState(v.runner),
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
    queueGraceHours: int(v.queue_grace_hours),
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
    reason: parseRunReason(v.reason),
    runs: arr(v.runs, parseRun),
    requestedBy: strOrNull(v.requested_by),
    // 有这个字段（哪怕是空的）就是支持唤醒的云端
    wakeups: Array.isArray(v.wakeups) ? arr(v.wakeups, parseWakeup) : null,
    wake:
      isObj(v.wake) && typeof v.wake.rule_id === 'string' && v.wake.rule_id
        ? { ruleId: v.wake.rule_id, kind: oneOf(v.wake.kind, ['at', 'every', 'ended'] as const, 'at') }
        : null,
  }
}

const WAKE_STATES = ['pending', 'active', 'done', 'expired', 'cancelled'] as const
const WAKE_FREQS = ['hourly', 'daily', 'weekdays'] as const

function parseWakeWhen(v: unknown): TeamWakeWhen | null {
  if (!isObj(v)) return null
  if (v.kind === 'at') {
    const at = time(v.at)
    return at ? { kind: 'at', at } : null
  }
  if (v.kind !== 'every' || !(WAKE_FREQS as readonly unknown[]).includes(v.freq)) return null
  return { kind: 'every', freq: v.freq as WakeupFreq, hour: int(v.hour), minute: int(v.minute), tz: str(v.tz) }
}

/** 一条唤醒规则；不认识的条件、状态（云端以后新加的）丢掉，界面画不出来 */
function parseWakeup(v: unknown): TeamWakeupData | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  const when = parseWakeWhen(v.when)
  if (!when || !(WAKE_STATES as readonly unknown[]).includes(v.state)) return null
  return {
    id: v.id,
    member: str(v.member),
    owner: str(v.owner),
    by: str(v.by),
    when,
    text: str(v.text),
    until: time(v.until) || null,
    next: time(v.next) || null,
    fired: Math.max(0, int(v.fired)),
    card: strOrNull(v.card),
    state: v.state as TeamWakeupData['state'],
    endNote: strOrNull(v.end_note),
    approved: v.approved === true,
    createdAt: time(v.created_at),
    lastAt: time(v.last_at) || null,
  }
}

/** 唤醒条件的线上形状（时间写成 RFC 3339） */
function wakeWhenWire(w: TeamWakeWhen): Record<string, unknown> {
  return w.kind === 'at'
    ? { kind: 'at', at: new Date(w.at).toISOString() }
    : { kind: 'every', freq: w.freq, hour: w.hour, minute: w.minute, tz: w.tz }
}

const RUN_STATUSES = ['done', 'failed', 'stopped'] as const

function parseRun(v: unknown): ChannelRun | null {
  if (!isObj(v)) return null
  const endedAt = time(v.ended_at)
  if (!endedAt || !(RUN_STATUSES as readonly unknown[]).includes(v.status)) return null
  return {
    n: Math.max(1, int(v.n)),
    status: v.status as ChannelRun['status'],
    startedAt: time(v.started_at) || null,
    endedAt,
    reason: parseRunReason(v.reason),
    error: strOrNull(v.error),
    engine: strOrNull(v.engine),
    model: strOrNull(v.model),
    machine: strOrNull(v.machine),
  }
}

/** 运行记录的线上形状（会话 id 只在本机，不上传） */
function runWire(r: ChannelRun): Record<string, unknown> {
  return {
    n: r.n,
    status: r.status,
    started_at: r.startedAt ? new Date(r.startedAt).toISOString() : null,
    ended_at: new Date(r.endedAt).toISOString(),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.engine ? { engine: r.engine } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.machine ? { machine: r.machine } : {}),
  }
}

const INBOX_KINDS: readonly TeamInboxKind[] = [
  'mention',
  'reply',
  'assigned',
  'approval',
  'failed',
  'done',
  'review',
  'rejected',
]

const timeOf = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** 收件箱的一行（docs/multica-learn.md §11.5）；不认识的种类丢掉 */
export function parseInboxItem(v: unknown): TeamInboxItem | null {
  if (!isObj(v) || typeof v.team_id !== 'string' || typeof v.key !== 'string' || typeof v.channel_id !== 'string')
    return null
  const kind = INBOX_KINDS.find(k => k === v.kind)
  const at = timeOf(v.at)
  if (!kind || at === null) return null
  return {
    teamId: v.team_id,
    key: v.key,
    channelId: v.channel_id,
    kind,
    actor: typeof v.actor === 'string' ? v.actor : '',
    text: typeof v.text === 'string' ? v.text : '',
    count: typeof v.count === 'number' && v.count >= 0 ? Math.floor(v.count) : 0,
    at,
    read: v.read === true,
    archived: v.archived === true,
    snoozeUntil: timeOf(v.snooze_until),
    muted: v.muted === true,
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
    threadId: strOrNull(v.thread_id),
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
  if (s === 401) return new TeamError(message || '运行凭证无效或已过期', 'RUN_TOKEN')
  if (s === 403) return new TeamError(message || '没有权限', 'FORBIDDEN')
  if (s === 409) return new TeamError(message || '操作冲突，请刷新后重试', 'CONFLICT')
  if (s === 429) return new TeamError(message || '操作太频繁，请稍后再试', 'RATE_LIMITED')
  if (s === 400 || s === 413) return new TeamError(message || '提交的内容不对', 'INVALID')
  return new TeamError(message || '团队服务暂时不可用，请稍后再试', 'UNAVAILABLE')
}

const seg = (id: string): string => encodeURIComponent(id)

/** 任务卡写回的请求体（登录令牌和运行凭证两条路一样） */
function taskWire(patch: TaskPatch): Record<string, unknown> {
  const { clearAction, addRuns, ...rest } = patch
  return {
    ...rest,
    ...(clearAction ? { clear_action: true } : {}),
    ...(addRuns?.length ? { add_runs: addRuns.map(runWire) } : {}),
  }
}

export class TeamApi {
  constructor(private readonly fetcher: TeamFetch) {}

  /** 发请求并检查状态；网络错误、超时变成 UNAVAILABLE，登录过期变成 AUTH_EXPIRED，其余原样抛出 */
  private async request(
    method: Parameters<TeamFetch>[0],
    path: string,
    body?: unknown,
    notDeployed = false,
    runToken?: string,
  ): Promise<Response> {
    let res: Response
    try {
      res = runToken
        ? await this.fetcher(method, path, body, undefined, runToken)
        : await this.fetcher(method, path, body)
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

  updateTeam(teamId: string, patch: { name?: string; queueGraceHours?: number }): Promise<void> {
    return this.call('PATCH', `/v1/teams/${seg(teamId)}`, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.queueGraceHours !== undefined ? { queue_grace_hours: patch.queueGraceHours } : {}),
    })
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

  updateChannel(
    teamId: string,
    channelId: string,
    patch: { name?: string; topic?: string | null; archived?: boolean },
  ): Promise<void> {
    return this.call('PATCH', `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}`, patch)
  }

  /** 置顶 / 取消置顶一条文字消息 */
  pin(teamId: string, channelId: string, messageId: string, on: boolean): Promise<void> {
    return this.call(
      on ? 'PUT' : 'DELETE',
      `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}/pins/${seg(messageId)}`,
    )
  }

  /** 置顶的消息，按置顶的先后（派活时作为资料带上） */
  async pins(teamId: string, channelId: string): Promise<TeamMessage[]> {
    const body = await this.json(await this.request('GET', `/v1/teams/${seg(teamId)}/channels/${seg(channelId)}/pins`))
    return arr(isObj(body) ? body.messages : null, parseMessage)
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
      threadId?: string | null
      mentions: string[]
      /** 不写时云端按作者定：真人 plain，AI 成员 markdown */
      format?: 'plain' | 'markdown'
      agentId?: string
      taskId?: string
    },
  ): Promise<{ message: TeamMessage; tasks: TeamMessage[] }> {
    const wire = {
      client_id: input.clientId,
      text: input.text,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      ...(input.threadId ? { thread_id: input.threadId } : {}),
      mentions: input.mentions,
      ...(input.format ? { format: input.format } : {}),
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
    return messageOf(
      await this.json(await this.request('PATCH', `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}`, taskWire(patch))),
    )
  }

  /** 开工前核对（docs/multica-learn.md §11.3）。旧云端没有这个接口（404 且不是 JSON 错误）：当作通过、没有凭证 */
  async start(teamId: string, messageId: string, device: string): Promise<StartResult> {
    let res: Response
    try {
      res = await this.request('POST', `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}/start`, { device })
    } catch (e) {
      if (e instanceof TeamError && e.code === 'NOT_FOUND' && e.message === '团队、频道或消息不存在')
        return { outcome: 'ok', message: null, runToken: null }
      throw e
    }
    const body = await this.json(res)
    const o = isObj(body) ? body : {}
    const message = parseMessage(o.message)
    if (!message) throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
    const outcome = oneOf(o.outcome, ['ok', 'approval', 'stopped'] as const, 'ok')
    const token = typeof o.run_token === 'string' && o.run_token.startsWith('rt_') ? o.run_token : null
    return { outcome, message, runToken: outcome === 'ok' ? token : null }
  }

  /** 收件箱（docs/multica-learn.md §11.5）。旧云端没有这个接口（404 且不是 JSON 错误）：null */
  async inbox(): Promise<TeamInboxItem[] | null> {
    let res: Response
    try {
      res = await this.request('GET', '/v1/inbox')
    } catch (e) {
      if (e instanceof TeamError && e.code === 'NOT_FOUND' && e.message === '团队、频道或消息不存在') return null
      throw e
    }
    const body = await this.json(res)
    return arr(isObj(body) ? body.items : null, parseInboxItem)
  }

  /** 改收件箱的一行：已读、归档、延后、取消订阅 */
  async patchInbox(teamId: string, key: string, patch: TeamInboxPatch): Promise<TeamInboxItem> {
    const wire: Record<string, unknown> = {}
    if (patch.read !== undefined) wire.read = patch.read
    if (patch.archived !== undefined) wire.archived = patch.archived
    if (patch.muted !== undefined) wire.muted = patch.muted
    if (patch.snoozeUntil !== undefined)
      wire.snooze_until = patch.snoozeUntil === null ? null : new Date(patch.snoozeUntil).toISOString()
    const body = await this.json(await this.request('PATCH', `/v1/teams/${seg(teamId)}/inbox/${seg(key)}`, wire))
    const item = parseInboxItem(isObj(body) ? body.item : null)
    if (!item) throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
    return item
  }

  /** 用运行凭证写回任务卡（字段和 patchTask 一样） */
  async patchRun(teamId: string, messageId: string, token: string, patch: TaskPatch): Promise<TeamMessage> {
    return messageOf(
      await this.json(
        await this.request('PATCH', `/v1/teams/${seg(teamId)}/runs/${seg(messageId)}`, taskWire(patch), false, token),
      ),
    )
  }

  /** 用运行凭证以这张卡的 AI 成员发结果 */
  async postRunResult(
    teamId: string,
    messageId: string,
    token: string,
    input: { clientId: string; text: string; mentions: string[] },
  ): Promise<TeamMessage> {
    return messageOf(
      await this.json(
        await this.request(
          'POST',
          `/v1/teams/${seg(teamId)}/runs/${seg(messageId)}/result`,
          { client_id: input.clientId, text: input.text, mentions: input.mentions },
          false,
          token,
        ),
      ),
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

  /** 在任务卡上挂一条事项唤醒（docs/multica-learn.md §11.6）：返回改后的卡和新规则（要主人同意的是 pending） */
  async addWakeup(
    teamId: string,
    messageId: string,
    input: WakeupInput,
  ): Promise<{ message: TeamMessage; wakeup: TeamWakeupData | null }> {
    const wire = {
      member: input.member,
      when: wakeWhenWire(input.when),
      text: input.text,
      until: input.until === null ? null : new Date(input.until).toISOString(),
    }
    const body = await this.json(
      await this.request('POST', `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}/wakeups`, wire),
    )
    return { message: messageOf(body), wakeup: isObj(body) ? parseWakeup(body.wakeup) : null }
  }

  /** 取消一条唤醒（挂的人、成员的主人）；已经结束的云端原样返回 */
  async cancelWakeup(teamId: string, messageId: string, wakeupId: string): Promise<TeamMessage> {
    return messageOf(
      await this.json(
        await this.request('DELETE', `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}/wakeups/${seg(wakeupId)}`),
      ),
    )
  }

  /** 成员的主人同意 / 不同意一条等同意的唤醒 */
  async approveWakeup(teamId: string, messageId: string, wakeupId: string, approve: boolean): Promise<TeamMessage> {
    return messageOf(
      await this.json(
        await this.request(
          'POST',
          `/v1/teams/${seg(teamId)}/tasks/${seg(messageId)}/wakeups/${seg(wakeupId)}/approve`,
          { approve },
        ),
      ),
    )
  }

  // ---- 执行机（docs/multica-learn.md §11.7）----

  /** 桌面要一个执行机配对码（5 分钟、只能用一次）；带 runnerId 是给这台重新配对、换令牌。台数到了席位数是 CONFLICT */
  async runnerPairing(name: string, runnerId?: string): Promise<{ code: string; expiresAt: number }> {
    const body = await this.json(
      await this.request('POST', '/v1/teams/runners/pairings', { name, ...(runnerId ? { runner_id: runnerId } : {}) }),
    )
    const o = isObj(body) ? body : {}
    const code = str(o.code)
    if (!code) throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
    return { code, expiresAt: time(o.expires_at) }
  }

  /** 执行机用配对码换令牌（不要登录，请求函数由执行机自己给）。码不对、过期、用过是 NOT_FOUND */
  async pairRunner(code: string, version: string): Promise<{ runnerId: string; name: string; token: string }> {
    const body = await this.json(await this.request('POST', '/v1/teams/runners/pair', { code, version }))
    const o = isObj(body) ? body : {}
    const runnerId = str(o.runner_id)
    const token = str(o.token)
    if (!isRunnerId(runnerId) || !token.startsWith('rn_')) throw new TeamError('云端返回的数据异常', 'UNAVAILABLE')
    return { runnerId, name: str(o.name), token }
  }

  /** 我的执行机（按配对先后）。旧云端没有这个接口（404 且不是 JSON 错误）：null */
  async runners(): Promise<TeamRunnerData[] | null> {
    let res: Response
    try {
      res = await this.request('GET', '/v1/teams/runners')
    } catch (e) {
      if (e instanceof TeamError && e.code === 'NOT_FOUND' && e.message === '团队、频道或消息不存在') return null
      throw e
    }
    const body = await this.json(res)
    return arr(isObj(body) ? body.runners : null, parseRunner)
  }

  /** 停用执行机：令牌作废、断开连接，绑它的 AI 成员改回谁都接 */
  removeRunner(runnerId: string): Promise<void> {
    return this.call('DELETE', `/v1/teams/runners/${seg(runnerId)}`)
  }
}

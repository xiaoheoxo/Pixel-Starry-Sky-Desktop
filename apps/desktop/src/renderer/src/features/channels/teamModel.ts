// 协作频道 Phase C（多人团队）的纯函数（docs/ui/channels-phase-c.md）。不依赖 window，可以直接单测。
import type { Channel, ChannelMember, ChannelMessage, ChannelTask } from '@/data/types'
import type { TeamInfo, TeamMemberInfo, TeamRole } from '../../../../shared/types/channels'

const DAY = 86_400_000

// ---------------------------------------------------------------------------
// 频道列表分段
// ---------------------------------------------------------------------------

/** 频道列表的一段：team 为空是「本机」 */
export interface ChannelSection {
  /** 'local'、'archived' 或团队 id */
  id: string
  team: TeamInfo | null
  channels: Channel[]
}

export const LOCAL_SECTION = 'local'
/** 列表底部「已归档」（docs/ui/channels-local-ai.md §3.1 #11）：有归档的频道才有这一段 */
export const ARCHIVED_SECTION = 'archived'

/**
 * 本机频道在前，然后每个团队一段（按团队列表的顺序），归档的频道在最后一段。
 * 有搜索词时没有匹配频道的段整段隐藏；找不到团队的团队频道（刚被移出）不显示。
 */
export function groupChannels(
  channels: readonly Channel[],
  teams: readonly TeamInfo[],
  opts: { searching?: boolean } = {},
): ChannelSection[] {
  const open = channels.filter(c => !c.archivedAt)
  const sections: ChannelSection[] = [
    { id: LOCAL_SECTION, team: null, channels: open.filter(c => c.scope !== 'team' || !c.teamId) },
    ...teams.map(team => ({ id: team.id, team, channels: open.filter(c => c.teamId === team.id) })),
  ]
  const archived = channels.filter(c => c.archivedAt)
  if (archived.length) sections.push({ id: ARCHIVED_SECTION, team: null, channels: archived })
  return opts.searching ? sections.filter(s => s.channels.length > 0) : sections
}

/** localStorage 里折叠的段 id 列表；格式不对当作没有 */
export function parseCollapsed(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function toggleCollapsed(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter(v => v !== id) : [...list, id]
}

/** 段标题右边的在线头像：最多 limit 个在线的真人（不含自己，自己总是在线） */
export function onlineMembers(
  team: TeamInfo,
  names: ReadonlyMap<string, string>,
  selfId: string | null,
  limit = 3,
): { id: string; name: string }[] {
  return team.members
    .filter(m => m.online && m.id !== selfId)
    .slice(0, limit)
    .map(m => ({ id: m.id, name: names.get(m.id) ?? '?' }))
}

// ---------------------------------------------------------------------------
// 在线状态
// ---------------------------------------------------------------------------

/** 超过这么多天没上线就不写「几天前在线」 */
export const SEEN_MAX_DAYS = 7

export type LastSeen = { unit: 'justNow' } | { unit: 'minutes' | 'hours' | 'days'; count: number }

/** 「N 分钟 / 小时 / 天前在线」；没有记录或超过 7 天返回 null */
export function lastSeen(at: number | null | undefined, now: number): LastSeen | null {
  if (at == null) return null
  const ms = Math.max(0, now - at)
  if (ms > SEEN_MAX_DAYS * DAY) return null
  if (ms < 60_000) return { unit: 'justNow' }
  if (ms < 3_600_000) return { unit: 'minutes', count: Math.floor(ms / 60_000) }
  if (ms < DAY) return { unit: 'hours', count: Math.floor(ms / 3_600_000) }
  return { unit: 'days', count: Math.floor(ms / DAY) }
}

export function onlineCount(humans: readonly { online?: boolean; you?: boolean }[]): number {
  return humans.filter(h => h.online || h.you).length
}

// ---------------------------------------------------------------------------
// 权限（docs/ui/channels-phase-c.md §2.2、§4.2）
// ---------------------------------------------------------------------------

export const myRole = (teams: readonly TeamInfo[], teamId: string | undefined): TeamRole | undefined =>
  teamId ? teams.find(t => t.id === teamId)?.role : undefined

/** 观察者不能派活；本机频道（没有角色）可以 */
export const canDispatch = (role: TeamRole | undefined): boolean => role !== 'observer'
export const canCreateChannel = canDispatch
export const canAddAgent = canDispatch
export const canManageTeam = (role: TeamRole | undefined): boolean => role === 'owner'

/** 任务卡上「同意 / 拒绝」：只有 AI 成员的主人能点 */
export const canApprove = (task: Pick<ChannelTask, 'status' | 'ownerId'>, selfId: string | null): boolean =>
  task.status === 'approval' && !!selfId && task.ownerId === selfId

/** 等同意时派活的人可以取消 */
export const canWithdraw = (task: Pick<ChannelTask, 'status' | 'authorId'>, selfId: string | null): boolean =>
  task.status === 'approval' && !!selfId && task.authorId === selfId

/** 这张卡的 AI 成员是不是我的：本机频道、没有 ownerId 的卡都算我的（会话、确认问题只有主人能处理） */
export const isMyTask = (task: Pick<ChannelTask, 'ownerId'>, selfId: string | null): boolean =>
  !task.ownerId || task.ownerId === selfId

/** 停止 / 取消 / 重试：派活的人和主人都能点（docs/ui/channels-phase-c.md §4.2） */
export const canControlTask = (task: Pick<ChannelTask, 'ownerId' | 'authorId'>, selfId: string | null): boolean =>
  isMyTask(task, selfId) || (!!selfId && task.authorId === selfId)

/** @ 菜单里 AI 成员后面的提示：观察者不能派活；别人的「要我同意」的成员需要主人同意 */
export function mentionNote(member: ChannelMember, role: TeamRole | undefined): 'observer' | 'approval' | null {
  if (member.kind !== 'agent') return null
  if (!canDispatch(role)) return 'observer'
  if (member.mine === false && member.policy !== 'team') return 'approval'
  return null
}

// ---------------------------------------------------------------------------
// 邀请
// ---------------------------------------------------------------------------

/** 邀请还剩几天（向下取整，0 = 今天过期） */
export const inviteDaysLeft = (expiresAt: number, now: number): number =>
  Math.max(0, Math.floor((expiresAt - now) / DAY))

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()
export const isValidEmail = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())

/** 团队里排序：所有者在前，然后在线的，然后按名字 */
export function sortTeamMembers(
  members: readonly TeamMemberInfo[],
  names: ReadonlyMap<string, string>,
): TeamMemberInfo[] {
  const rank = (m: TeamMemberInfo) => (m.role === 'owner' ? 0 : m.online ? 1 : 2)
  return [...members].sort(
    (a, b) => rank(a) - rank(b) || (names.get(a.id) ?? '').localeCompare(names.get(b.id) ?? '', 'zh-Hans-CN'),
  )
}

// ---------------------------------------------------------------------------
// 系统通知（docs/ui/channels-phase-c.md §6.2）
// ---------------------------------------------------------------------------

export type TeamNotice =
  | { kind: 'mention'; messageId: string; channelId: string }
  | { kind: 'approval'; messageId: string; channelId: string }

/** 新来的一条消息要不要提醒：@ 了我，或有我的 AI 成员的新活等我同意；不提醒自己发的 */
export function teamNotice(
  message: ChannelMessage,
  channel: Pick<Channel, 'id' | 'scope'> | undefined,
  selfId: string | null,
): TeamNotice | null {
  if (!selfId || channel?.scope !== 'team') return null
  if (message.kind === 'message') {
    return message.authorId !== selfId && message.mentions?.includes(selfId)
      ? { kind: 'mention', messageId: message.id, channelId: channel.id }
      : null
  }
  if (message.kind === 'task' && message.status === 'approval' && message.ownerId === selfId)
    return { kind: 'approval', messageId: message.id, channelId: channel.id }
  return null
}

/** 点通知跳到频道：通知 id 里带着频道 id */
export const teamNoticeId = (notice: TeamNotice): string =>
  `team:${notice.channelId}:${notice.kind}:${notice.messageId}`
export function channelOfNotice(id: string): string | null {
  const m = /^team:([^:]+):/.exec(id)
  return m ? m[1] : null
}

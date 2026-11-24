// 频道和团队融合（docs/ui/channels-unify.md）的纯函数：任务页分组、「正在做」分格、派活预告。不依赖 window，可以直接单测。
import type { AgentMember, Channel, ChannelMember, ChannelMessage, ChannelTask } from '@/data/types'
import type { ChannelFollow, ChannelNeed, TeamRole } from '../../../../shared/types/channels'
import { canApprove, isMyTask, mentionNote } from './teamModel'

// ---------------------------------------------------------------------------
// 频道的「任务」页
// ---------------------------------------------------------------------------

/** mine 要你处理；running 进行中；queued 排队中；others 等别人同意；ended 做完和停下的 */
export type TaskGroupId = 'mine' | 'running' | 'queued' | 'others' | 'ended'
/** sent 我派的；received 派给我的 AI 成员（团队的频道才有这两个筛选） */
export type TaskFilter = 'all' | 'sent' | 'received'

export const TASK_GROUPS: readonly TaskGroupId[] = ['mine', 'running', 'queued', 'others', 'ended']

/** 这张卡放哪一组：等我同意、等我确认、接力停下等我的是「要你处理」 */
export function taskGroupOf(task: ChannelTask, selfId: string | null): TaskGroupId {
  const mine = isMyTask(task, selfId)
  switch (task.status) {
    case 'approval':
      return canApprove(task, selfId) ? 'mine' : 'others'
    case 'waiting':
      return mine ? 'mine' : 'running'
    case 'queued':
      return task.relay?.held && mine ? 'mine' : 'queued'
    case 'running':
      return 'running'
    default:
      return 'ended'
  }
}

/** 还没结束的活有几件（「任务」标签上的数字） */
export const openTaskCount = (messages: readonly ChannelMessage[]): number =>
  messages.filter(m => m.kind === 'task' && m.status !== 'done' && m.status !== 'failed' && m.status !== 'stopped')
    .length

/** 已读进来的消息里的任务卡，按组分好，组里新的在前；空的组不返回 */
export function groupTasks(
  messages: readonly ChannelMessage[],
  selfId: string | null,
  filter: TaskFilter = 'all',
): { id: TaskGroupId; tasks: ChannelTask[] }[] {
  const tasks = messages
    .filter((m): m is ChannelTask => m.kind === 'task')
    .filter(t =>
      filter === 'sent'
        ? !!selfId && t.authorId === selfId
        : filter === 'received'
          ? !!selfId && t.ownerId === selfId
          : true,
    )
    .sort((a, b) => b.at - a.at)
  return TASK_GROUPS.map(id => ({ id, tasks: tasks.filter(t => taskGroupOf(t, selfId) === id) })).filter(
    g => g.tasks.length > 0,
  )
}

// ---------------------------------------------------------------------------
// 「正在做」
// ---------------------------------------------------------------------------

export interface DoingItem {
  channelId: string
  taskId: string
  title: string
  /** waiting：等我确认（来自「需要你」） */
  status: ChannelFollow['status']
  at: number
  sessionId: string | null
}

export interface DoingBox {
  member: AgentMember
  items: DoingItem[]
  /** 它在哪些没归档的频道里（空闲时写出来） */
  channels: Channel[]
}

/**
 * 每个 AI 成员一格。mine：我自己的本机 AI 成员，手上的活来自「跟进中」和「需要你」里等我确认的，有活的排前面；
 * team：团队的频道里正在做事的 AI 成员（我的和队友的），云端只给状态和当前这一件的标题
 */
export function doingBoxes(
  members: readonly ChannelMember[],
  channels: readonly Channel[],
  following: readonly ChannelFollow[],
  needs: readonly ChannelNeed[],
): { mine: DoingBox[]; team: DoingBox[] } {
  const open = channels.filter(c => !c.archivedAt)
  const agents = members.filter((m): m is AgentMember => m.kind === 'agent')
  const inChannels = (m: AgentMember) => open.filter(c => c.memberIds.includes(m.id))
  const waiting: DoingItem[] = needs
    .filter(n => n.kind === 'approval' && !n.gone && !!n.taskId && !!n.memberId)
    .map(n => ({
      channelId: n.channelId,
      taskId: n.taskId!,
      title: n.text,
      status: 'waiting' as const,
      at: n.at,
      sessionId: n.sessionId ?? null,
    }))
  const waitingOf = new Map(needs.filter(n => n.taskId && n.memberId).map(n => [n.taskId!, n.memberId!]))
  const mine = agents
    .filter(m => m.mine !== false && !m.teamAgentId)
    .map(member => ({
      member,
      channels: inChannels(member),
      items: [
        ...waiting.filter(w => waitingOf.get(w.taskId) === member.id),
        ...following.filter(f => f.memberId === member.id).map(({ memberId: _, ...rest }) => rest),
      ],
    }))
  // 有活的在前，各自保持原来的顺序
  mine.sort((a, b) => Number(b.items.length > 0) - Number(a.items.length > 0))
  const team = agents
    .filter(m => !!m.teamAgentId && (m.status === 'running' || m.status === 'waiting'))
    .map(member => ({ member, channels: inChannels(member), items: [] }))
  return { mine, team }
}

// ---------------------------------------------------------------------------
// 派活预告（输入框下面）
// ---------------------------------------------------------------------------

/** start 马上开始；approval 要主人同意；text 只当文字（别人的「只有我」的成员、观察者） */
export type DispatchKind = 'start' | 'approval' | 'text'

export interface DispatchPreview {
  member: AgentMember
  kind: DispatchKind
}

/** 这些被 @ 到的成员里，AI 成员各自会怎样（顺序照传进来的） */
export function dispatchPreview(
  mentioned: readonly ChannelMember[],
  role: TeamRole | undefined,
  selfId: string | null,
): DispatchPreview[] {
  return mentioned
    .filter((m): m is AgentMember => m.kind === 'agent')
    .map(member => {
      const note = mentionNote(member, role, selfId)
      return { member, kind: note === 'approval' ? 'approval' : note ? 'text' : 'start' }
    })
}

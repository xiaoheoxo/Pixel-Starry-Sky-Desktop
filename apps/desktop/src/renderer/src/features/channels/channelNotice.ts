// 频道派出去的会话的系统提醒（docs/ui/channels-local-ai.md §3.1 #12）：按频道的说法写「#网页版改版 · 前端助手」，
// 点开回到频道并定位到那张任务卡；会话自己的提醒就不再发（同一件事只提醒一次）。纯函数。
import { tr } from '../../i18n/core'
import type { NotificationIntent } from '@/features/notifications/policy'
import type { ChannelsState } from './store'

/**
 * 提醒 id：`chtask|<频道 id>|<任务卡 id>`（id 都是 UUID，不含 |；合计 81 字，主进程限 100 字）。
 * 同一张卡的新提醒顶替旧的（等你确认 → 做完了），通知中心里一张卡只留一条；去重靠会话提醒的 dedupeKey
 */
const PREFIX = 'chtask'

export interface ChannelNotice {
  id: string
  title: string
  body: string
  channelId: string
  taskId: string
  /** 频道的提醒级别不让发（§3.1 #13）：不提醒；只提醒要我处理的时，做完不提醒 */
  muted: boolean
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * 这条会话提醒是频道派出去的活：换成频道的说法；不是（或频道已经删了）返回 null，照会话的提醒发。
 * detail 已经翻译好；sessionTitle 是会话标题（任务卡还没读进来时用它当活的标题，频道开的会话就是用任务标题命名的）
 */
export function channelNotice(
  intent: Pick<NotificationIntent, 'kind' | 'sessionId' | 'dedupeKey'>,
  detail: string,
  s: Pick<ChannelsState, 'sessionTasks' | 'channels' | 'members' | 'messages'>,
  sessionTitle: string | null,
): ChannelNotice | null {
  const ref = s.sessionTasks[intent.sessionId]
  const channel = ref && s.channels.find(c => c.id === ref.channelId)
  if (!ref || !channel) return null
  const member = s.members.find(m => m.id === ref.memberId)
  const task = s.messages[channel.id]?.find(m => m.id === ref.taskId)
  const title = flat((task?.kind === 'task' ? task.title : null) || sessionTitle || '')
  const what = clip(flat(detail) || title, 200)
  const body =
    intent.kind === 'completed'
      ? tr('channels.notify.done', { title: clip(title, 200) })
      : intent.kind === 'failed'
        ? tr('channels.notify.failed', { detail: what })
        : tr('channels.notify.waiting', { detail: what })
  return {
    id: [PREFIX, channel.id, ref.taskId].join('|'),
    title: clip(tr('channels.notify.title', { channel: channel.name, member: member?.name ?? '?' }), 120),
    body: clip(body, 300),
    channelId: channel.id,
    taskId: ref.taskId,
    muted: channel.notify === 'mute' || (channel.notify === 'important' && intent.kind === 'completed'),
  }
}

/** 点了提醒：是频道任务的提醒就给出频道和任务卡 */
export function taskOfNotice(id: string): { channelId: string; taskId: string } | null {
  const [prefix, channelId, taskId] = id.split('|')
  return prefix === PREFIX && channelId && taskId ? { channelId, taskId } : null
}

// 收件箱「通知」页的显示规则（docs/multica-learn.md §7、§11.5）：纯函数，界面和系统通知共用
import type { TeamInboxItem, TeamInboxKind } from '../../../../shared/types/channels'
import type { TranslationKey } from '../../i18n/core'

/** 现在要显示的：没归档、没延后（或延后到点了） */
export function visibleInbox(items: readonly TeamInboxItem[], now: number): TeamInboxItem[] {
  return items.filter(it => !it.archived && (it.snoozeUntil === null || it.snoozeUntil <= now))
}

/** 标签上的数字：显示着的里面没读的 */
export function unreadInbox(items: readonly TeamInboxItem[], now: number): number {
  return visibleInbox(items, now).filter(it => !it.read).length
}

/** 延后的三个时间：1 小时后、明天 9 点、下周一 9 点 */
export function inboxSnoozeTimes(now: number): { hour: number; tomorrow: number; nextWeek: number } {
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const monday = new Date(now)
  // 周一是 1；今天是周一也排到下周一
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7))
  monday.setHours(9, 0, 0, 0)
  return { hour: now + 3_600_000, tomorrow: tomorrow.getTime(), nextWeek: monday.getTime() }
}

export const inboxId = (it: Pick<TeamInboxItem, 'teamId' | 'key'>): string => `${it.teamId}/${it.key}`

/** 系统通知只弹这么久以内的（重连后补来的旧事不弹） */
export const INBOX_RECENT_MS = 10 * 60_000

/**
 * 哪些行要弹系统通知：和上次看到的相比最近时间变新了、没读、现在显示着、10 分钟以内。
 * seen 是上次每行的最近时间；为 null 是第一次拿到收件箱，只记下不弹（不然一打开就弹一串）
 */
export function freshInbox(
  seen: ReadonlyMap<string, number> | null,
  items: readonly TeamInboxItem[],
  now: number,
): { notify: TeamInboxItem[]; seen: Map<string, number> } {
  const next = new Map(items.map(it => [inboxId(it), it.at]))
  if (!seen) return { notify: [], seen: next }
  const notify = visibleInbox(items, now).filter(
    it => !it.read && now - it.at <= INBOX_RECENT_MS && it.at > (seen.get(inboxId(it)) ?? -Infinity),
  )
  return { notify, seen: next }
}

/** 一行的说明：「周宁 @了你」这类，{name} 是触发的人 */
export const INBOX_KIND: Record<TeamInboxKind, TranslationKey> = {
  mention: 'inbox.kind.mention',
  reply: 'inbox.kind.reply',
  assigned: 'inbox.kind.assigned',
  approval: 'inbox.kind.approval',
  failed: 'inbox.kind.failed',
  done: 'inbox.kind.done',
  review: 'inbox.kind.review',
  rejected: 'inbox.kind.rejected',
}

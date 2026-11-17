import { describe, expect, it } from 'vitest'
import type { TeamInboxItem } from '../../../../shared/types/channels'
import { freshInbox, inboxSnoozeTimes, unreadInbox, visibleInbox } from './teamInboxModel'

const NOW = new Date(2026, 10, 18, 15, 30).getTime() // 周三
const item = (key: string, patch: Partial<TeamInboxItem> = {}): TeamInboxItem => ({
  teamId: 'tm',
  key,
  channelId: 'tc',
  kind: 'mention',
  actor: 'u:2',
  text: '看下',
  count: 1,
  at: NOW - 60_000,
  read: false,
  archived: false,
  snoozeUntil: null,
  muted: false,
  ...patch,
})

describe('收件箱显示规则', () => {
  it('归档的、延后还没到点的不显示；未读数只算显示着的', () => {
    const items = [
      item('a'),
      item('b', { read: true }),
      item('c', { archived: true }),
      item('d', { snoozeUntil: NOW + 1000 }),
      item('e', { snoozeUntil: NOW - 1000 }),
    ]
    expect(visibleInbox(items, NOW).map(i => i.key)).toEqual(['a', 'b', 'e'])
    expect(unreadInbox(items, NOW)).toBe(2)
  })

  it('延后：1 小时后、明天 9 点、下周一 9 点（周一也排到下周）', () => {
    const t = inboxSnoozeTimes(NOW)
    expect(t.hour).toBe(NOW + 3_600_000)
    expect(new Date(t.tomorrow)).toEqual(new Date(2026, 10, 19, 9, 0))
    expect(new Date(t.nextWeek)).toEqual(new Date(2026, 10, 23, 9, 0))
    const monday = new Date(2026, 10, 23, 8, 0).getTime()
    expect(new Date(inboxSnoozeTimes(monday).nextWeek)).toEqual(new Date(2026, 10, 30, 9, 0))
  })

  it('系统通知：第一次只记下；之后变新、没读、显示着、10 分钟内的才弹', () => {
    const first = freshInbox(null, [item('a')], NOW)
    expect(first.notify).toEqual([])
    const items = [
      item('a', { at: NOW - 1000 }), // 变新了
      item('b', { at: NOW - 1000 }), // 新来的
      item('c', { at: NOW - 1000, read: true }),
      item('d', { at: NOW - 1000, snoozeUntil: NOW + 60_000 }),
      item('e', { at: NOW - 11 * 60_000 }), // 太旧
    ]
    const seen = new Map([['tm/a', NOW - 60_000]])
    expect(freshInbox(seen, items, NOW).notify.map(i => i.key)).toEqual(['a', 'b'])
    // 没变的不再弹
    const again = freshInbox(freshInbox(seen, items, NOW).seen, items, NOW)
    expect(again.notify).toEqual([])
  })
})

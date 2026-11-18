import { describe, expect, it } from 'vitest'
import { translateMessage } from '@/i18n/core'
import type { ChannelMember, ChannelMessage, ChannelWakeup } from '../../../../shared/types/channels'
import {
  buildWakeup,
  dayClock,
  isWakeupCard,
  liveWakeups,
  parseLocal,
  pickMember,
  recentEndedWakeup,
  runWakeupTag,
  untilOf,
  wakeupChoices,
  wakeupDraft,
  wakeupHead,
  wakeupHint,
  wakeupMeta,
  wakeupOrigin,
  withKind,
  type WakeupOn,
} from './wakeupModel'

const NOW = new Date(2026, 10, 18, 15, 30).getTime() // 周三 15:30
const HOUR = 3_600_000
const DAY = 86_400_000

const agent = (id: string, name = id): ChannelMember => ({ id, kind: 'agent', name }) as ChannelMember
const AGENTS = [agent('a1', '小A'), agent('a2', '小B'), { id: 'you', kind: 'human', name: '我' } as ChannelMember]
const TASK: WakeupOn = { channelId: 'c1', on: 't1', kind: 'task', title: '修登录', assigneeId: 'a1' }
const FLOW: WakeupOn = { channelId: 'c1', on: 'f1', kind: 'flow', title: '发版', assigneeId: null }

const rule = (patch: Partial<ChannelWakeup> = {}): ChannelWakeup => ({
  id: 'w1',
  on: 't1',
  memberId: 'a1',
  card: null,
  by: 'you',
  when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
  text: '检查 CI',
  until: new Date(2026, 10, 25, 23, 59).getTime(),
  next: new Date(2026, 10, 19, 9, 0).getTime(),
  fired: 0,
  state: 'active',
  createdAt: NOW - HOUR,
  ...patch,
})

describe('唤醒规则的文字', () => {
  it('卡上那一行：每天 9:00 叫谁、下次、截止；到某个时间写时间；等结束写最多等到哪天', () => {
    const r = rule()
    expect(wakeupHead(r, '小A', NOW)).toBe('每天 09:00 叫 小A')
    expect(wakeupMeta(r, NOW)).toEqual(['下次 明天 09:00', '截止 11-25'])
    expect(wakeupHead(rule({ when: { kind: 'every', freq: 'hourly', hour: 0, minute: 5 } }), '小A', NOW)).toBe(
      '每小时第 05 分 叫 小A',
    )
    expect(wakeupHead(rule({ when: { kind: 'every', freq: 'weekdays', hour: 18, minute: 30 } }), '小A', NOW)).toBe(
      '工作日 18:30 叫 小A',
    )
    // 团队卡上别的时区的人挂的：写上时区；和这台电脑同一个时区的不写
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone
    const away = here === 'Asia/Kolkata' ? 'Europe/Berlin' : 'Asia/Kolkata'
    expect(wakeupHead(rule({ when: { kind: 'every', freq: 'daily', hour: 9, minute: 0, tz: away } }), '小A', NOW)).toBe(
      `每天 09:00（${away}） 叫 小A`,
    )
    expect(wakeupHead(rule({ when: { kind: 'every', freq: 'daily', hour: 9, minute: 0, tz: here } }), '小A', NOW)).toBe(
      '每天 09:00 叫 小A',
    )
    const at = rule({ when: { kind: 'at', at: NOW + 10 * 60_000 }, until: null, next: NOW + 10 * 60_000 })
    expect(wakeupHead(at, '小A', NOW)).toBe('今天 15:40 叫 小A')
    expect(wakeupMeta(at, NOW)).toEqual([])
    const ended = rule({ when: { kind: 'ended', failed: true }, next: null, until: NOW + 3 * DAY })
    expect(wakeupHead(ended, '小B', NOW)).toBe('做完或失败后叫 小B')
    expect(wakeupHead(ended, '小B', NOW, true)).toBe('流程全部交付后叫 小B')
    expect(wakeupMeta(ended, NOW)).toEqual(['最多等到 11-21'])
  })

  it('日期：今天、明天，再往后写月-日', () => {
    expect(dayClock(new Date(2026, 10, 18, 9, 5).getTime(), NOW)).toBe('今天 09:05')
    expect(dayClock(new Date(2026, 10, 19, 0, 0).getTime(), NOW)).toBe('明天 00:00')
    expect(dayClock(new Date(2026, 11, 2, 9, 0).getTime(), NOW)).toBe('12-02 09:00')
  })

  it('只列活着的、按下次时间排，等结束的在后；最近一天里自己结束的（有原因、作废）单独写一行', () => {
    const channel = {
      wakeups: [
        rule({ id: 'ended', when: { kind: 'ended' }, next: null }),
        rule({ id: 'late', next: NOW + 5 * HOUR }),
        rule({ id: 'soon', next: NOW + HOUR }),
        rule({ id: 'other', on: 't2' }),
        rule({ id: 'gone', state: 'cancelled', endNote: '盯的卡停了', lastAt: NOW - HOUR }),
        rule({ id: 'mine', state: 'cancelled', endNote: null, lastAt: NOW - 60_000 }),
        rule({ id: 'old', state: 'expired', lastAt: NOW - 2 * DAY }),
      ],
    }
    expect(liveWakeups(channel, 't1').map(w => w.id)).toEqual(['soon', 'late', 'ended'])
    expect(recentEndedWakeup(channel, 't1', NOW)?.id).toBe('gone')
    expect(recentEndedWakeup(channel, 't1', NOW + 2 * DAY)).toBeNull()
  })

  it('看板事项：最近一次到点写「下次」，只有等结束的写前半句；悬停带指令', () => {
    const names = (id: string) => (id === 'a2' ? '小B' : '小A')
    expect(wakeupHint({ wakeups: [] }, 't1', names, NOW)).toBeNull()
    const hint = wakeupHint({ wakeups: [rule()] }, 't1', names, NOW)!
    expect(hint.text).toBe('下次 明天 09:00')
    expect(hint.title).toContain('检查 CI')
    const ended = rule({ when: { kind: 'ended' }, next: null, memberId: 'a2' })
    expect(wakeupHint({ wakeups: [ended] }, 't1', names, NOW)!.text).toBe('做完后叫 小B')
  })

  it('唤醒卡：按规则的 card 找；规则被清掉了看来源系统消息上的标记；普通卡不是', () => {
    const messages = [
      { kind: 'message', id: 'm1', replyToId: 't1', wakeup: { ruleId: 'w9', kind: 'every' } },
      { kind: 'message', id: 'm2' },
    ] as unknown as ChannelMessage[]
    expect(wakeupOrigin({ wakeups: [rule({ card: 'k1' })] }, { id: 'k1' }, messages)?.rule?.id).toBe('w1')
    expect(wakeupOrigin({ wakeups: [] }, { id: 'k2', sourceMessageId: 'm1' }, messages)).toEqual({
      rule: null,
      on: 't1',
    })
    expect(wakeupOrigin({ wakeups: [] }, { id: 'k3', sourceMessageId: 'm2' }, messages)).toBeNull()
    expect(isWakeupCard({ wakeups: [rule({ card: 'k1' })] }, { id: 'k1' })).toBe(true)
    expect(
      isWakeupCard(
        { wakeups: [] },
        {
          id: 'k2',
          runs: [{ n: 1, status: 'done', startedAt: null, endedAt: 0, wakeup: { ruleId: 'w9', kind: 'every' } }],
        },
      ),
    ).toBe(true)
    expect(isWakeupCard({ wakeups: [rule()] }, { id: 'k3', runs: [] })).toBe(false)
  })

  it('运行记录的标签：唤醒、没有要说的、连续几次合成一条写次数', () => {
    expect(runWakeupTag({})).toBeNull()
    expect(runWakeupTag({ wakeup: { ruleId: 'w1', kind: 'every' } })).toBe('唤醒')
    expect(runWakeupTag({ wakeup: { ruleId: 'w1', kind: 'every', silent: 1 } })).toBe('唤醒 · 没有要说的')
    expect(runWakeupTag({ wakeup: { ruleId: 'w1', kind: 'every', silent: 4 } })).toBe('唤醒 · 没有要说的 ×4')
  })
})

describe('唤醒对话框', () => {
  it('默认叫这张卡的负责人；「等它结束」不能叫负责人，换成别人，没有别人时为空', () => {
    const d = wakeupDraft(TASK, AGENTS, NOW)
    expect(d.memberId).toBe('a1')
    expect(wakeupChoices('ended', TASK, AGENTS).map(m => m.id)).toEqual(['a2'])
    expect(withKind(d, 'ended', TASK, AGENTS).memberId).toBe('a2')
    expect(withKind({ ...d, memberId: 'a2' }, 'at', TASK, AGENTS).memberId).toBe('a2')
    expect(pickMember('ended', TASK, [agent('a1')])).toBe('')
    // 流程卡没有负责人：第一个 AI 成员
    expect(pickMember('ended', FLOW, AGENTS)).toBe('a1')
  })

  it('到某个时间：10 分钟后、1 小时后、明天 9:00、自定义；过去的和 30 天以外的不行', () => {
    const d = { ...wakeupDraft(TASK, AGENTS, NOW), text: '  看一下部署  ' }
    const at = (patch: object) => {
      const r = buildWakeup({ ...d, ...patch }, TASK, NOW)
      return 'op' in r && r.op.when.kind === 'at' ? r.op.when.at : r
    }
    expect(at({ preset: 'm10' })).toBe(NOW + 10 * 60_000)
    expect(at({ preset: 'h1' })).toBe(NOW + HOUR)
    expect(at({ preset: 'tomorrow' })).toBe(new Date(2026, 10, 19, 9, 0).getTime())
    expect(at({ preset: 'custom', custom: '2026-11-20T08:15' })).toBe(new Date(2026, 10, 20, 8, 15).getTime())
    expect(at({ preset: 'custom', custom: '2026-11-18T15:00' })).toEqual({ error: 'past' })
    expect(at({ preset: 'custom', custom: '2027-01-30T08:00' })).toEqual({ error: 'far' })
    expect(at({ preset: 'custom', custom: '' })).toEqual({ error: 'past' })
    const ok = buildWakeup({ ...d, preset: 'h1' }, TASK, NOW)
    expect(ok).toEqual({
      op: { op: 'add', on: 't1', memberId: 'a1', text: '看一下部署', when: { kind: 'at', at: NOW + HOUR } },
    })
    expect(buildWakeup({ ...d, text: ' ' }, TASK, NOW)).toEqual({ error: 'text' })
    expect(buildWakeup({ ...d, memberId: '' }, TASK, NOW)).toEqual({ error: 'member' })
  })

  it('定期检查：截止到那天结束，最远 30 天；截止前一次都不叫的不行；每小时不带钟点', () => {
    const d = { ...wakeupDraft(TASK, AGENTS, NOW), kind: 'every' as const, text: '检查 CI' }
    const r = buildWakeup(d, TASK, NOW)
    expect(r).toEqual({
      op: {
        op: 'add',
        on: 't1',
        memberId: 'a1',
        text: '检查 CI',
        when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
        until: new Date(2026, 10, 26).getTime() - 1,
      },
    })
    expect(untilOf('2026-11-17', NOW)).toBeNull()
    expect(untilOf('2027-03-01', NOW)).toBe(NOW + 30 * DAY)
    expect(untilOf('bad', NOW)).toBeNull()
    // 今天截止、9 点已经过了：一次都不会叫
    expect(buildWakeup({ ...d, untilDay: '2026-11-18' }, TASK, NOW)).toEqual({ error: 'never' })
    expect(buildWakeup({ ...d, untilDay: '2026-11-17' }, TASK, NOW)).toEqual({ error: 'until' })
    const hourly = buildWakeup({ ...d, freq: 'hourly', hour: 14, minute: 45 }, TASK, NOW)
    expect('op' in hourly && hourly.op.when).toEqual({ kind: 'every', freq: 'hourly', hour: 0, minute: 45 })
  })

  it('等它结束：失败 / 停下勾了才带；流程卡不带；最多等几天就是截止', () => {
    const d = { ...withKind(wakeupDraft(TASK, AGENTS, NOW), 'ended', TASK, AGENTS), text: '审查改动' }
    expect(buildWakeup({ ...d, failed: true, waitDays: 3 }, TASK, NOW)).toEqual({
      op: {
        op: 'add',
        on: 't1',
        memberId: 'a2',
        text: '审查改动',
        when: { kind: 'ended', failed: true },
        until: NOW + 3 * DAY,
      },
    })
    const flow = buildWakeup({ ...d, failed: true, stopped: true }, FLOW, NOW)
    expect('op' in flow && flow.op).toMatchObject({ on: 'f1', when: { kind: 'ended' } })
  })

  it('自定义时间只认 datetime-local 的格式，不存在的日子不认', () => {
    expect(parseLocal('2026-11-20T08:15')).toBe(new Date(2026, 10, 20, 8, 15).getTime())
    expect(parseLocal('2026-02-30T08:15')).toBeNull()
    expect(parseLocal('明天')).toBeNull()
  })
})

describe('主进程报的错、取消原因', () => {
  it('中文原文在词典里，英文界面能翻（带数字的按模板）', () => {
    expect(translateMessage('一张卡上最多挂 5 条唤醒', 'en-US')).toBe('A card can have at most 5 wakeups')
    expect(translateMessage('「等结束」不能叫这张卡自己的负责人', 'en-US')).toBe(
      '"When it ends" can\'t wake the card\'s own assignee',
    )
    expect(translateMessage('盯的卡停了', 'en-US')).toBe('the watched card was stopped')
  })
})

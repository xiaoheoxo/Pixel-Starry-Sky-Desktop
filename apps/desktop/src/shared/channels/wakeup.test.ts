import { describe, expect, it } from 'vitest'
import type { ChannelRun, ChannelWakeup } from '../types/channels'
import {
  WAKEUP_KEEP_ENDED,
  WAKEUP_TEXT_MAX,
  appendWakeupRun,
  cleanWakeupAdd,
  cleanWakeupWhen,
  endedVerdict,
  pruneWakeups,
  wakeupAfterFire,
  wakeupFirst,
} from './wakeup'

const DAY = 86_400_000
/** 2026-11-18 是周三，11-20 周五，11-23 周一（本机时区） */
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()
const NOW = at(18, 10)

const rule = (patch: Partial<ChannelWakeup>): ChannelWakeup => ({
  id: 'w1',
  on: 't1',
  memberId: 'a',
  card: null,
  by: 'you',
  when: { kind: 'at', at: NOW + 60_000 },
  text: '看一下',
  until: null,
  next: null,
  fired: 0,
  state: 'active',
  createdAt: NOW,
  ...patch,
})

describe('事项唤醒的条件（docs/multica-learn.md §11.6）', () => {
  it('到某个时间：过去太久、超过 30 天、不是数字都不行；稍微过去一点（刚算好就发过来）照收', () => {
    expect(cleanWakeupWhen({ kind: 'at', at: NOW + 600_000 }, NOW)).toEqual({ kind: 'at', at: NOW + 600_000 })
    expect(cleanWakeupWhen({ kind: 'at', at: NOW - 30_000 }, NOW)).toEqual({ kind: 'at', at: NOW - 30_000 })
    expect(() => cleanWakeupWhen({ kind: 'at', at: NOW - 3_600_000 }, NOW)).toThrow('已经过了')
    expect(() => cleanWakeupWhen({ kind: 'at', at: NOW + 31 * DAY }, NOW)).toThrow('30 天')
    expect(() => cleanWakeupWhen({ kind: 'at', at: 'tomorrow' }, NOW)).toThrow('时间不对')
  })

  it('定期检查：频率只认三种，钟点要是整数；每小时只看分钟；等结束只留勾上的；别的都不认', () => {
    expect(cleanWakeupWhen({ kind: 'every', freq: 'daily', hour: 9, minute: 30, extra: 1 }, NOW)).toEqual({
      kind: 'every',
      freq: 'daily',
      hour: 9,
      minute: 30,
    })
    expect(cleanWakeupWhen({ kind: 'every', freq: 'hourly', minute: 5 }, NOW)).toEqual({
      kind: 'every',
      freq: 'hourly',
      hour: 0,
      minute: 5,
    })
    expect(() => cleanWakeupWhen({ kind: 'every', freq: 'weekly', hour: 9, minute: 0 }, NOW)).toThrow('频率')
    expect(() => cleanWakeupWhen({ kind: 'every', freq: 'daily', hour: 24, minute: 0 }, NOW)).toThrow('钟点')
    expect(() => cleanWakeupWhen({ kind: 'every', freq: 'daily', hour: 9.5, minute: 0 }, NOW)).toThrow('钟点')
    expect(cleanWakeupWhen({ kind: 'ended', failed: true, stopped: 'yes' }, NOW)).toEqual({
      kind: 'ended',
      failed: true,
    })
    expect(() => cleanWakeupWhen({ kind: 'reply' }, NOW)).toThrow('条件不对')
    expect(() => cleanWakeupWhen(null, NOW)).toThrow('条件不对')
  })

  it('挂规则：指令必填、有上限；截止没写按 7 天、最多 30 天；截止前一次都叫不到的不收；运行时的字段不认', () => {
    const every = { kind: 'every', freq: 'daily', hour: 9, minute: 0 }
    const base = { on: 't1', memberId: 'a', text: '  查 CI  ', when: every }
    expect(cleanWakeupAdd({ ...base, state: 'done', fired: 9, card: 'x', next: 1 }, NOW)).toEqual({
      on: 't1',
      memberId: 'a',
      text: '查 CI',
      when: every,
      until: NOW + 7 * DAY,
    })
    expect(cleanWakeupAdd({ ...base, until: NOW + 30 * DAY }, NOW).until).toBe(NOW + 30 * DAY)
    expect(() => cleanWakeupAdd({ ...base, until: NOW + 31 * DAY }, NOW)).toThrow('最多 30 天')
    expect(() => cleanWakeupAdd({ ...base, until: NOW }, NOW)).toThrow('截止时间不对')
    // 现在 10:00，每天 9:00、截止明天 8:00：一次都不会叫
    expect(() => cleanWakeupAdd({ ...base, until: at(19, 8) }, NOW)).toThrow('一次都不会叫')
    expect(() => cleanWakeupAdd({ ...base, text: ' ' }, NOW)).toThrow('不能为空')
    expect(() => cleanWakeupAdd({ ...base, text: 'x'.repeat(WAKEUP_TEXT_MAX + 1) }, NOW)).toThrow('最多')
    expect(() => cleanWakeupAdd({ ...base, on: '' }, NOW)).toThrow('要盯的卡')
    expect(() => cleanWakeupAdd({ ...base, memberId: 3 }, NOW)).toThrow('要叫的成员')
    // 到某个时间没有截止；等结束默认等 7 天
    expect(cleanWakeupAdd({ ...base, when: { kind: 'at', at: NOW + 60_000 }, until: 5 }, NOW).until).toBeNull()
    expect(cleanWakeupAdd({ ...base, when: { kind: 'ended' } }, NOW).until).toBe(NOW + 7 * DAY)
  })
})

describe('下次时间', () => {
  it('每小时、每天、工作日（周五之后跳过周末）；到某个时间就是它，等结束没有', () => {
    expect(wakeupFirst({ kind: 'every', freq: 'hourly', hour: 0, minute: 15 }, NOW)).toBe(at(18, 10, 15))
    expect(wakeupFirst({ kind: 'every', freq: 'daily', hour: 9, minute: 0 }, NOW)).toBe(at(19, 9))
    expect(wakeupFirst({ kind: 'every', freq: 'daily', hour: 11, minute: 0 }, NOW)).toBe(at(18, 11))
    expect(wakeupFirst({ kind: 'every', freq: 'weekdays', hour: 9, minute: 0 }, at(20, 10))).toBe(at(23, 9))
    expect(wakeupFirst({ kind: 'at', at: 123 }, NOW)).toBe(123)
    expect(wakeupFirst({ kind: 'ended' }, NOW)).toBeNull()
  })

  it('叫过之后：只一次的、等结束的结束；定期检查从现在算下一个钟点（错过几次只补一次），过了截止就结束', () => {
    expect(wakeupAfterFire(rule({}), NOW)).toMatchObject({ state: 'done', fired: 1, lastAt: NOW, next: null })
    expect(wakeupAfterFire(rule({ when: { kind: 'ended' } }), NOW)).toMatchObject({ state: 'done', next: null })
    const daily = rule({
      when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
      until: at(25, 0),
      next: at(16, 9),
    })
    // 应用关了两天，开机后补的这次之后排明天 9:00
    expect(wakeupAfterFire(daily, NOW)).toMatchObject({ state: 'active', fired: 1, next: at(19, 9) })
    expect(wakeupAfterFire({ ...daily, until: at(19, 9) }, NOW)).toMatchObject({ state: 'done', next: null })
  })
})

describe('等结束', () => {
  const card = (patch: Partial<Parameters<typeof endedVerdict>[1]>) => ({
    status: 'done' as const,
    round: 1,
    checksRunning: false,
    active: false,
    ...patch,
  })
  it('做完还要等检查跑完；又开了一轮不算；挂上时已经结束的那一轮不算；失败、停下按勾的来，没勾的停下就取消', () => {
    const when = { kind: 'ended' as const }
    expect(endedVerdict(when, card({ checksRunning: true }), null)).toBeNull()
    expect(endedVerdict(when, card({}), null)).toBe('fire')
    expect(endedVerdict(when, card({ active: true }), null)).toBeNull()
    expect(endedVerdict(when, card({}), '1')).toBeNull()
    expect(endedVerdict(when, card({ round: 2 }), '1')).toBe('fire')
    expect(endedVerdict(when, card({ status: 'running' }), null)).toBeNull()
    expect(endedVerdict(when, card({ status: 'failed' }), null)).toBeNull()
    expect(endedVerdict({ ...when, failed: true }, card({ status: 'failed' }), null)).toBe('fire')
    expect(endedVerdict(when, card({ status: 'stopped' }), null)).toBe('cancel')
    expect(endedVerdict({ ...when, stopped: true }, card({ status: 'stopped' }), null)).toBe('fire')
  })
})

describe('运行记录和留存', () => {
  const run = (n: number, silent?: number, ruleId = 'w1'): ChannelRun => ({
    n,
    status: 'done',
    startedAt: n,
    endedAt: n * 10,
    wakeup: { ruleId, kind: 'every', ...(silent ? { silent } : {}) },
  })
  it('同一条规则连续 [silent] 合成一条（计数），中间有真回复、换了规则就另起一条', () => {
    let list = appendWakeupRun(undefined, run(1))
    list = appendWakeupRun(list, run(2, 1))
    list = appendWakeupRun(list, run(3, 1))
    expect(list.map(r => [r.n, r.wakeup?.silent])).toEqual([
      [1, undefined],
      [3, 2],
    ])
    list = appendWakeupRun(list, run(4, 1, 'w2'))
    list = appendWakeupRun(list, run(5))
    list = appendWakeupRun(list, run(6, 1))
    expect(list.map(r => [r.n, r.wakeup?.silent])).toEqual([
      [1, undefined],
      [3, 2],
      [4, 1],
      [5, undefined],
      [6, 1],
    ])
  })

  it('结束了的只留最近的，活着的都留', () => {
    const ended = Array.from({ length: WAKEUP_KEEP_ENDED + 5 }, (_, i) =>
      rule({ id: `e${i}`, state: 'cancelled', lastAt: i }),
    )
    const kept = pruneWakeups([rule({ id: 'live' }), ...ended])
    expect(kept).toHaveLength(WAKEUP_KEEP_ENDED + 1)
    expect(kept[0].id).toBe('live')
    expect(kept.some(w => w.id === 'e0')).toBe(false)
    expect(kept.at(-1)?.id).toBe(`e${WAKEUP_KEEP_ENDED + 4}`)
  })
})

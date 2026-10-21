import { afterEach, describe, expect, it } from 'vitest'
import { quotaWindowId, type AccountQuota, type QuotaWindow } from '@pixelsky/protocol'
import { setCurrentLocale } from '@/i18n/core'
import {
  calendarDaysFrom,
  isNearLimit,
  maskAccount,
  percentText,
  planEntries,
  planName,
  quotaAlert,
  quotaButtonView,
  quotaButtonVisible,
  quotaEntries,
  quotaLayout,
  quotaLevel,
  quotaTarget,
  quotaTooltip,
  resetClock,
  resetFull,
  resetShort,
  tightestEntry,
  windowName,
  windowShort,
  type PlanLimit,
  type QuotaTargetInput,
} from './quotaModel'

// 2026-10-19 是周一；本机时区的时刻，测试不依赖时区
const at = (hour: number, minute: number, day = 0): number => new Date(2026, 9, 19 + day, hour, minute).getTime()
const NOW = at(14, 32)

afterEach(() => setCurrentLocale('zh-CN'))

const win = (
  durationMins: number | null,
  usedPercent: number,
  resetsAt: number | null = null,
  extra: Partial<QuotaWindow> = {},
): QuotaWindow => ({
  id: quotaWindowId(durationMins),
  durationMins,
  usedPercent,
  resetsAt,
  ...extra,
})

const quota = (over: Partial<AccountQuota> = {}): AccountQuota => ({
  provider: 'claude',
  status: 'ok',
  plan: 'max',
  account: 'linxia@example.com',
  windows: [],
  extras: {},
  blocked: null,
  observedAt: NOW - 60_000,
  fetchedAt: NOW - 60_000,
  source: 'usage',
  refreshable: true,
  error: null,
  ...over,
})

const opus = (usedPercent: number, extra: { rejected?: boolean } = {}) => ({
  name: 'Opus',
  durationMins: 10_080,
  usedPercent,
  resetsAt: null,
  ...extra,
})

const view = (q: AccountQuota | null, loading = false, provider: 'claude' | 'chatgpt' | 'platform' = 'claude') =>
  quotaButtonView(q, { provider, loading, now: NOW })

describe('窗口命名（按时长）', () => {
  it('300 / 10080 / 1440 / 60 / null', () => {
    expect(windowName(300)).toBe('5 小时内')
    expect(windowName(10_080)).toBe('本周')
    expect(windowName(1_440)).toBe('1 天内')
    expect(windowName(2_880)).toBe('2 天内')
    expect(windowName(60)).toBe('1 小时内')
    expect(windowName(90)).toBe('1.5 小时内')
    expect(windowName(null)).toBe('额度')
  })
  it('简称', () => {
    expect(windowShort(300)).toBe('5h')
    expect(windowShort(10_080)).toBe('周')
    expect(windowShort(1_440)).toBe('日')
    expect(windowShort(2_880)).toBe('2d')
    expect(windowShort(120)).toBe('2h')
    expect(windowShort(null)).toBe('')
  })
  it('英文', () => {
    setCurrentLocale('en-US')
    expect(windowName(300)).toBe('5-hour limit')
    expect(windowName(10_080)).toBe('Weekly limit')
    expect(windowName(null)).toBe('Usage limit')
    expect(windowShort(10_080)).toBe('Wk')
  })
})

describe('百分比与颜色级别', () => {
  it('整数；不到 1% 写 <1%；没用完不写 100%', () => {
    expect(percentText(0)).toBe('0%')
    expect(percentText(0.4)).toBe('<1%')
    expect(percentText(41.6)).toBe('42%')
    expect(percentText(99.6)).toBe('99%')
    expect(percentText(100)).toBe('100%')
    expect(percentText(140)).toBe('100%')
  })
  it('级别边界 79 / 80 / 99 / 100 / rejected', () => {
    expect(quotaLevel(79)).toBe('normal')
    expect(quotaLevel(80)).toBe('warn')
    expect(quotaLevel(99)).toBe('warn')
    expect(quotaLevel(100)).toBe('full')
    expect(quotaLevel(10, true)).toBe('full')
  })
  it('blocked 按用完', () => {
    expect(view(quota({ windows: [win(300, 10)], blocked: { kind: 'x', resetsAt: null } })).level).toBe('full')
  })
})

describe('最紧一项', () => {
  const tight = (q: AccountQuota) => tightestEntry(quotaEntries(q, NOW))
  it('含分模型：Opus 61% 比 5 小时 42% 紧', () => {
    const t = tight(quota({ windows: [win(300, 42), win(10_080, 18)], extras: { models: [opus(61)] } }))
    expect(t?.name).toBe('本周 · Opus')
    expect(t?.short).toBe('周')
  })
  it('用完优先于百分比更高的', () => {
    const t = tight(quota({ windows: [win(300, 95), win(10_080, 40, null, { rejected: true })] }))
    expect(t?.durationMins).toBe(10_080)
    expect(t?.percent).toBe(100)
  })
  it('同分取时长短的', () => {
    const t = tight(quota({ windows: [win(10_080, 50), win(300, 50)] }))
    expect(t?.durationMins).toBe(300)
  })
  it('没有条目为 null', () => {
    expect(tight(quota())).toBeNull()
  })
})

describe('恢复时间', () => {
  it('卡片短写三档', () => {
    expect(resetShort(at(16, 45), NOW)).toBe('16:45 恢复')
    expect(resetShort(at(9, 0, 3), NOW)).toBe('周四 09:00 恢复')
    expect(resetShort(at(9, 0, 10), NOW)).toBe('10 月 29 日恢复')
  })
  it('悬停全写三档', () => {
    expect(resetFull(at(16, 45), NOW)).toBe('2 小时 13 分后恢复（今天 16:45）')
    expect(resetFull(at(15, 14), NOW)).toBe('42 分后恢复（今天 15:14）')
    expect(resetFull(at(18, 32, 3), NOW)).toBe('3 天 4 小时后恢复（10 月 22 日 周四 18:32）')
    expect(resetFull(at(14, 32, 2), NOW)).toBe('2 天后恢复（10 月 21 日 周三 14:32）')
  })
  it('整点小时不带分', () => {
    expect(resetFull(at(16, 32), NOW)).toBe('2 小时后恢复（今天 16:32）')
  })
  it('不带「恢复」的时间点', () => {
    expect(resetClock(at(15, 18), NOW)).toBe('15:18')
    expect(resetClock(at(11, 20, 1), NOW)).toBe('明天 11:20')
    expect(resetClock(at(11, 20, 2), NOW)).toBe('周三 11:20')
  })
  it('按日历天数算，不按「差不到 7 天」：周一 10:00 时，下周一 09:00 写日期，不写「周一」', () => {
    const monday10 = at(10, 0)
    expect(resetShort(at(9, 0, 7), monday10)).toBe('10 月 26 日恢复')
    expect(resetClock(at(9, 0, 7), monday10)).toBe('10 月 26 日')
    expect(resetShort(at(11, 0, 7), monday10)).toBe('10 月 26 日恢复')
    expect(resetShort(at(9, 0, 6), monday10)).toBe('周日 09:00 恢复')
    expect(resetFull(at(9, 0, 7), monday10)).toBe('6 天 23 小时后恢复（10 月 26 日 周一 09:00）')
  })
  it('明天写「明天」，今天 / 明天 / 2–6 天各一档', () => {
    expect(resetShort(at(9, 0, 1), NOW)).toBe('明天 09:00 恢复')
    expect(resetShort(at(9, 0, 2), NOW)).toBe('周三 09:00 恢复')
    expect(resetShort(at(9, 0, 6), NOW)).toBe('周日 09:00 恢复')
    expect(resetFull(at(9, 0, 1), NOW)).toBe('18 小时 28 分后恢复（明天 09:00）')
  })
  it('跨午夜：23:30 时 1 小时后（次日 00:30）是明天，不是今天；00:10 时 23 小时后（当天 23:10）还是今天', () => {
    expect(resetShort(at(0, 30, 1), at(23, 30))).toBe('明天 00:30 恢复')
    expect(resetShort(at(23, 10), at(0, 10))).toBe('23:10 恢复')
    expect(resetShort(at(23, 59, 1), at(0, 0))).toBe('明天 23:59 恢复')
  })
  it('calendarDaysFrom 用本机日历日期（月底、年底也对）', () => {
    expect(calendarDaysFrom(new Date(2026, 9, 31, 23, 0).getTime(), new Date(2026, 10, 1, 1, 0).getTime())).toBe(1)
    expect(calendarDaysFrom(new Date(2026, 11, 31, 12, 0).getTime(), new Date(2027, 0, 7, 12, 0).getTime())).toBe(7)
    expect(calendarDaysFrom(at(23, 59), at(0, 0))).toBe(0)
  })
  it('过了恢复时间', () => {
    expect(resetShort(NOW - 1, NOW)).toBe('已过恢复时间')
    expect(resetFull(NOW - 1, NOW)).toBe('已过恢复时间，下次更新后显示新数字')
  })
  it('英文', () => {
    setCurrentLocale('en-US')
    expect(resetShort(at(16, 45), NOW)).toBe('Resets 4:45 PM')
    expect(resetShort(at(9, 0, 3), NOW)).toBe('Resets Thu 9:00 AM')
    expect(resetShort(at(9, 0, 10), NOW)).toBe('Resets Oct 29')
    expect(resetShort(at(9, 0, 1), NOW)).toBe('Resets tomorrow 9:00 AM')
    expect(resetShort(at(9, 0, 7), at(10, 0))).toBe('Resets Oct 26')
    expect(resetClock(at(9, 0, 1), NOW)).toBe('tomorrow 9:00 AM')
    expect(resetFull(at(9, 0, 1), NOW)).toBe('Resets in 18 hr 28 min (tomorrow 9:00 AM)')
    expect(resetFull(at(16, 45), NOW)).toBe('Resets in 2 hr 13 min (today 4:45 PM)')
  })
})

describe('按钮文字', () => {
  const text = (q: AccountQuota | null, loading = false) => {
    const v = view(q, loading)
    return [v.short, v.value].filter(Boolean).join(' ')
  }
  it('最紧一项的简称 + 百分比', () => {
    expect(text(quota({ windows: [win(300, 42), win(10_080, 18)] }))).toBe('5h 42%')
    expect(text(quota({ windows: [win(300, 42), win(10_080, 18)], extras: { models: [opus(61)] } }))).toBe('周 61%')
  })
  it('用完', () => {
    expect(text(quota({ windows: [win(300, 12), win(10_080, 100)] }))).toBe('本周已用完')
    expect(text(quota({ windows: [win(300, 100), win(10_080, 20)] }))).toBe('5 小时已用完')
    expect(text(quota({ windows: [win(10_080, 20)], extras: { models: [opus(100, { rejected: true })] } }))).toBe(
      '本周 Opus 已用完',
    )
    expect(text(quota({ windows: [win(300, 10)], blocked: { kind: 'rate_limit_reached', resetsAt: null } }))).toBe(
      '已用完',
    )
  })
  it('引擎报 rejected 不论百分比都按用完', () => {
    expect(text(quota({ windows: [win(10_080, 30, null, { rejected: true })] }))).toBe('本周已用完')
  })
  it('点数', () => {
    const credits = (balance: number | null, unlimited = false) =>
      quota({ provider: 'chatgpt', extras: { credits: { hasCredits: true, unlimited, balance } } })
    expect(text(credits(2480))).toBe('点数 2,480')
    expect(text(credits(null, true))).toBe('点数 不限')
    expect(text(credits(null))).toBe('')
  })
  it('读取中、失败、没数据：没有文字', () => {
    expect(view(null, true)).toMatchObject({ state: 'loading', value: '', short: '', bars: [] })
    expect(view(quota({ status: 'empty' }), true).state).toBe('loading')
    expect(view(quota({ status: 'error', windows: [win(300, 42)] }))).toMatchObject({
      state: 'error',
      value: '',
      bars: [],
    })
  })
  it('过了恢复时间按 0% 正常色', () => {
    const v = view(quota({ windows: [win(300, 95, NOW - 1000), win(10_080, 10, at(9, 0, 3))] }))
    expect(v).toMatchObject({ short: '周', value: '10%', level: 'normal' })
    expect(v.title).toContain('5 小时内已用 0% · 已过恢复时间')
  })
  it('英文', () => {
    setCurrentLocale('en-US')
    expect(view(quota({ windows: [win(10_080, 100)] })).value).toBe('Weekly limit reached')
    expect(view(quota({ windows: [win(300, 42)] })).label).toBe('Claude usage limits: 5-hour limit: 42% used')
  })
})

describe('两根小条', () => {
  const bars = (q: AccountQuota) => view(q).bars.map(b => [Math.round(b.percent), b.level])
  it('上面 5 小时，下面最紧的周额度 / 分模型', () => {
    expect(bars(quota({ windows: [win(300, 42), win(10_080, 18)], extras: { models: [opus(61)] } }))).toEqual([
      [42, 'normal'],
      [61, 'normal'],
    ])
  })
  it('各按自己的级别上色', () => {
    expect(bars(quota({ windows: [win(300, 86), win(10_080, 100)] }))).toEqual([
      [86, 'warn'],
      [100, 'full'],
    ])
  })
  it('只有一种就一根；没有 5 小时取最短的窗口', () => {
    expect(bars(quota({ windows: [win(10_080, 36)] }))).toEqual([[36, 'normal']])
    expect(bars(quota({ windows: [win(300, 20)] }))).toEqual([[20, 'normal']])
    expect(bars(quota({ windows: [win(1_440, 30), win(10_080, 50)] }))).toEqual([
      [30, 'normal'],
      [50, 'normal'],
    ])
  })
  it('只有点数一根空条；读取中两根空条（空数组）', () => {
    expect(bars(quota({ extras: { credits: { hasCredits: true, unlimited: false, balance: 5 } } }))).toEqual([
      [0, 'normal'],
    ])
    expect(view(null, true).bars).toEqual([])
  })
})

describe('悬停提示与 aria-label', () => {
  const q = quota({
    windows: [win(300, 42, at(16, 45)), win(10_080, 18, at(9, 0, 3))],
    extras: {
      models: [opus(61)],
      extraUsage: { enabled: true, used: 12.4, limit: 50, currency: 'USD', usedPercent: 24.8 },
    },
    observedAt: at(14, 31),
  })
  it('悬停提示多行', () => {
    expect(quotaTooltip(q, 'claude', NOW).split('\n')).toEqual([
      'Claude 账号额度（Max）',
      '5 小时内已用 42% · 16:45 恢复',
      '本周已用 18% · 周四 09:00 恢复',
      '本周 Opus 已用 61%',
      '额外用量（本月）：$12.40 / $50',
      '14:31 更新',
    ])
  })
  it('aria-label 全文', () => {
    expect(view(q).label).toBe('Claude 账号额度：5 小时内已用 42%，本周已用 18%，本周 Opus 已用 61%')
  })
  it('读取中 / 失败', () => {
    expect(view(null, true).label).toBe('Claude 账号额度：正在读取')
    expect(view(quota({ status: 'error' })).label).toBe('Claude 账号额度：读取失败')
  })
})

describe('卡片布局', () => {
  const layout = (q: AccountQuota, extra: Partial<Parameters<typeof quotaLayout>[1]> = {}) =>
    quotaLayout(q, { provider: q.provider, now: NOW, ...extra })

  it('5 小时 + 本周：左 5 小时、右本周；分模型和额外用量进「其它」', () => {
    const l = layout(
      quota({
        windows: [win(10_080, 18, at(9, 0, 3)), win(300, 42, at(16, 45))],
        extras: {
          models: [opus(61)],
          extraUsage: { enabled: true, used: 12.4, limit: 50, currency: 'USD', usedPercent: 24.8 },
        },
      }),
    )
    expect(l.cards.map(c => [c.name, c.value, c.unit, c.note])).toEqual([
      ['5 小时内', '42%', '已用', '16:45 恢复'],
      ['本周', '18%', '已用', '周四 09:00 恢复'],
    ])
    expect(l.cards[0].hover).toBe('2 小时 13 分后恢复（今天 16:45）')
    expect(l.rows.map(r => [r.name, r.value, r.percent === null ? null : Math.round(r.percent)])).toEqual([
      ['本周 · Opus', '61%', 61],
      ['额外用量（本月）', '$12.40 / $50', 25],
    ])
  })
  it('只有一个窗口：一张铺满', () => {
    const l = layout(quota({ provider: 'chatgpt', windows: [win(10_080, 36, at(8, 0, 3))] }))
    expect(l.cards).toHaveLength(1)
    expect(l.cards[0]).toMatchObject({ name: '本周', value: '36%' })
  })
  it('两个以上：优先 5 小时 + 本周，其余进「其它」', () => {
    const l = layout(quota({ windows: [win(1_440, 30), win(300, 40), win(10_080, 50)] }))
    expect(l.cards.map(c => c.name)).toEqual(['5 小时内', '本周'])
    expect(l.rows.map(r => r.name)).toEqual(['1 天内'])
  })
  it('没有 5 小时 + 本周：按时长取前两个', () => {
    const l = layout(quota({ windows: [win(2_880, 10), win(1_440, 30), win(43_200, 50)] }))
    expect(l.cards.map(c => c.name)).toEqual(['1 天内', '2 天内'])
    expect(l.rows.map(r => r.name)).toEqual(['30 天内'])
  })
  it('没有窗口只有点数：一张点数卡片', () => {
    const l = layout(
      quota({ provider: 'chatgpt', extras: { credits: { hasCredits: true, unlimited: false, balance: 2480 } } }),
    )
    expect(l.cards).toHaveLength(1)
    expect(l.cards[0]).toMatchObject({
      type: 'plain',
      name: 'Codex 额度点数',
      value: '2,480',
      unit: '剩余',
      note: '没有 5 小时 / 每周上限，点数用完前都能用',
    })
    expect(l.rows).toEqual([])
  })
  it('有窗口时点数进「其它」', () => {
    const l = layout(
      quota({
        provider: 'chatgpt',
        windows: [win(300, 27), win(10_080, 54)],
        extras: { credits: { hasCredits: true, unlimited: false, balance: 120 } },
      }),
    )
    expect(l.rows).toEqual([
      { id: 'credits', name: 'Codex 额度点数', percent: null, level: 'normal', value: '剩余 120' },
    ])
  })
  it('额外用量金额不明时写百分比', () => {
    const l = layout(
      quota({
        windows: [win(300, 10)],
        extras: { extraUsage: { enabled: true, used: null, limit: null, currency: null, usedPercent: 25 } },
      }),
    )
    expect(l.rows[0]).toMatchObject({ name: '额外用量（本月）', value: '25%', percent: 25 })
  })
  it('没开额外用量不出这一行', () => {
    const l = layout(
      quota({
        windows: [win(300, 10)],
        extras: { extraUsage: { enabled: false, used: null, limit: null, currency: null, usedPercent: null } },
      }),
    )
    expect(l.rows).toEqual([])
  })
  it('平台：左 5 小时（金额，不写恢复时间），右余额；套餐额度进「其它」', () => {
    const l = layout(
      quota({
        provider: 'platform',
        plan: 'Pro 月卡',
        windows: [win(300, 25, null, { money: { used: 0.5, limit: 2, currency: 'USD' } })],
        extras: { balance: { amount: 12.34, currency: 'USD' } },
      }),
      {
        balanceText: '$12.34',
        planLimits: [
          { id: 'daily', used: 1.2, limit: 10, currency: 'USD' },
          { id: 'weekly', used: 0, limit: 0, currency: 'USD' },
        ],
      },
    )
    expect(l.cards.map(c => [c.name, c.type, c.value, c.note])).toEqual([
      ['5 小时内', 'meter', '25%', '$0.50 / $2.00'],
      ['余额', 'plain', '$12.34', '账户余额'],
    ])
    expect(l.rows).toEqual([
      { id: 'plan:daily', name: '套餐 · 每天', percent: 12, level: 'normal', value: '$1.20 / $10.00' },
    ])
  })
  it('平台余额拿不到写「—」', () => {
    const l = layout(quota({ provider: 'platform', windows: [win(300, 25)], extras: { balance: null } }))
    expect(l.cards[1].value).toBe('—')
  })
  it('用完的卡片：数字写已用完', () => {
    const l = layout(quota({ windows: [win(300, 12), win(10_080, 100, at(11, 20, 1))] }))
    expect(l.cards[1]).toMatchObject({ level: 'full', value: '已用完', unit: '', note: '明天 11:20 恢复' })
  })
  it('过了恢复时间的卡片按 0%', () => {
    const l = layout(quota({ windows: [win(300, 90, NOW - 5)] }))
    expect(l.cards[0]).toMatchObject({ value: '0%', level: 'normal', note: '已过恢复时间' })
    expect(l.cards[0].hover).toBe('已过恢复时间，下次更新后显示新数字')
  })
})

describe('提示', () => {
  const alertOf = (q: AccountQuota) => quotaAlert(q, quotaEntries(q, NOW), NOW)
  it('快用完', () => {
    expect(alertOf(quota({ windows: [win(300, 86, at(15, 18)), win(10_080, 39)] }))).toEqual({
      kind: 'warn',
      strong: '5 小时内已用 86%',
      rest: '，用完后要等到 15:18 才能继续用这个账号。',
      switchChannel: false,
    })
  })
  it('用完：带「换通道」', () => {
    expect(alertOf(quota({ provider: 'chatgpt', windows: [win(300, 12), win(10_080, 100, at(11, 20, 1))] }))).toEqual({
      kind: 'full',
      strong: '本周额度已用完',
      rest: '，明天 11:20 恢复；在这之前发消息会被拒绝。',
      switchChannel: true,
    })
  })
  it('分模型用完', () => {
    const a = alertOf(
      quota({
        windows: [win(10_080, 20)],
        extras: { models: [{ ...opus(100), resetsAt: at(9, 0, 3) }] },
      }),
    )
    expect(a).toMatchObject({
      kind: 'full',
      strong: '本周 Opus 额度已用完',
      rest: '，周四 09:00 恢复；可以先换别的模型或通道。',
      switchChannel: true,
    })
  })
  it('账号整体被拒绝', () => {
    expect(alertOf(quota({ windows: [], blocked: { kind: 'rate_limit_reached', resetsAt: null } }))).toMatchObject({
      kind: 'full',
      strong: '账号额度已用完',
      switchChannel: true,
    })
  })
  it('正在用额外用量', () => {
    const a = alertOf(
      quota({
        windows: [win(300, 100)],
        extras: { extraUsage: { enabled: true, used: 1, limit: 50, currency: 'USD', usedPercent: 2, inUse: true } },
      }),
    )
    expect(a).toMatchObject({ rest: '套餐额度已用完，正在用额外用量（按量计费）', switchChannel: false })
  })
  it('正常没有提示', () => {
    expect(alertOf(quota({ windows: [win(300, 42)] }))).toBeNull()
  })
})

describe('套餐名、账号', () => {
  it('Claude', () => {
    expect(['pro', 'max', 'team', 'enterprise'].map(p => planName('claude', p))).toEqual([
      'Pro',
      'Max',
      'Team',
      'Enterprise',
    ])
  })
  it('ChatGPT', () => {
    const names = [
      'free',
      'go',
      'plus',
      'pro',
      'prolite',
      'promax',
      'team',
      'business',
      'self_serve_business_usage_based',
      'enterprise',
      'ent26',
      'edu',
      'k12',
    ]
    expect(names.map(p => planName('chatgpt', p))).toEqual([
      'Free',
      'Go',
      'Plus',
      'Pro 10x',
      'Pro 5x',
      'Pro 25x',
      'Team',
      'Business',
      'Business',
      'Enterprise',
      'Enterprise',
      'Edu',
      'K12',
    ])
    expect(planName('chatgpt', 'unknown')).toBe('')
    expect(planName('chatgpt', null)).toBe('')
  })
  it('平台原样', () => {
    expect(planName('platform', 'Pro 月卡')).toBe('Pro 月卡')
  })
  it('邮箱打码', () => {
    expect(maskAccount('linxia@example.com')).toBe('l•••@example.com')
    expect(maskAccount('林夏')).toBe('林夏')
    expect(maskAccount(null)).toBe('')
  })
})

describe('quotaTarget：什么时候有按钮', () => {
  const input = (over: Partial<QuotaTargetInput> = {}): QuotaTargetInput => ({
    enabled: true,
    machine: 'local',
    channel: 'claude',
    engines: [
      { id: 'claude', status: 'ready' },
      { id: 'codex', status: 'ready', auth: { kind: 'login' } },
      { id: 'pixel', status: 'ready' },
    ],
    platformSignedIn: true,
    platformWindows: 1,
    ...over,
  })
  it('Claude 授权 / ChatGPT 授权 / 平台', () => {
    expect(quotaTarget(input())).toBe('claude')
    expect(quotaTarget(input({ channel: 'chatgpt' }))).toBe('chatgpt')
    expect(quotaTarget(input({ channel: 'platform' }))).toBe('platform')
  })
  it('设置关掉', () => {
    expect(quotaTarget(input({ enabled: false }))).toBeNull()
  })
  it('远程机器', () => {
    expect(quotaTarget(input({ machine: 'ssh-1a2b' }))).toBeNull()
  })
  it('自定义接口', () => {
    expect(quotaTarget(input({ channel: 'custom' }))).toBeNull()
  })
  it('Codex 用 API Key / 自己的接口 / 未授权', () => {
    const codex = (status: string, auth?: { kind: string }) => [
      { id: 'claude' as const, status: 'ready' },
      { id: 'codex' as const, status, auth },
    ]
    expect(quotaTarget(input({ channel: 'chatgpt', engines: codex('ready', { kind: 'apiKey' }) }))).toBeNull()
    expect(quotaTarget(input({ channel: 'chatgpt', engines: codex('ready', { kind: 'provider' }) }))).toBeNull()
    expect(quotaTarget(input({ channel: 'chatgpt', engines: codex('unauthenticated') }))).toBeNull()
    expect(quotaTarget(input({ channel: 'chatgpt', engines: codex('ready') }))).toBe('chatgpt')
  })
  it('Claude Code 没装好', () => {
    expect(quotaTarget(input({ engines: [{ id: 'claude', status: 'missing' }] }))).toBeNull()
  })
  it('平台没登录或没有窗口（只按余额计费）', () => {
    expect(quotaTarget(input({ channel: 'platform', platformSignedIn: false }))).toBeNull()
    expect(quotaTarget(input({ channel: 'platform', platformWindows: 0 }))).toBeNull()
  })
})

const PLAN_WEEKLY_93: PlanLimit = { id: 'weekly', used: 46.5, limit: 50, currency: 'USD' }

describe('平台套餐额度参与挑最紧一项（按钮文字和颜色）', () => {
  const platform = quota({ provider: 'platform', plan: '专业版', windows: [win(300, 25)], account: '小黑' })
  const v = (limits: PlanLimit[], q = platform) =>
    quotaButtonView(q, { provider: 'platform', loading: false, now: NOW, planLimits: limits })
  it('每周 93% 比 5h 25% 紧：写「周 93%」、橙色；小进度条还是 5h 一根', () => {
    const r = v([PLAN_WEEKLY_93])
    expect(r.short).toBe('周')
    expect(r.value).toBe('93%')
    expect(r.level).toBe('warn')
    expect(r.bars).toEqual([{ percent: 25, level: 'normal' }])
  })
  it('小进度条的下面一根不取套餐额度：有 7d 窗口时仍是窗口自己的', () => {
    const q = quota({ provider: 'platform', windows: [win(300, 25), win(10_080, 40)] })
    const r = v([PLAN_WEEKLY_93], q)
    expect(r.bars).toEqual([
      { percent: 25, level: 'normal' },
      { percent: 40, level: 'normal' },
    ])
    expect(r.short).toBe('周')
    expect(r.value).toBe('93%')
  })
  it('无障碍名称和悬停提示也带上套餐额度（和按钮上的「周 93%」对得上）', () => {
    const r = v([PLAN_WEEKLY_93])
    expect(r.label).toContain('5 小时内已用 25%')
    expect(r.label).toContain('套餐 · 每周已用 93%')
    expect(r.title).toContain('套餐 · 每周已用 93%')
  })
  it('每天 / 每月的简写：日、月', () => {
    expect(v([{ id: 'daily', used: 9, limit: 10, currency: 'USD' }]).short).toBe('日')
    expect(v([{ id: 'monthly', used: 90, limit: 100, currency: 'USD' }]).short).toBe('月')
    expect(v([{ id: 'monthly', used: 90, limit: 100, currency: 'USD' }]).value).toBe('90%')
  })
  it('套餐额度没窗口紧时不抢：窗口 5h 60% 仍写「5h 60%」', () => {
    const q = quota({ provider: 'platform', windows: [win(300, 60)] })
    const r = v([{ id: 'weekly', used: 10, limit: 50, currency: 'USD' }], q)
    expect(r.short).toBe('5h')
    expect(r.value).toBe('60%')
    expect(r.level).toBe('normal')
  })
  it('套餐额度用完：红色，写「套餐 · 每周已用完」', () => {
    const r = v([{ id: 'weekly', used: 50, limit: 50, currency: 'USD' }])
    expect(r.level).toBe('full')
    expect(r.value).toBe('套餐 · 每周已用完')
  })
  it('limit 为 0 的跳过；不带套餐额度和以前一样', () => {
    expect(planEntries([{ id: 'daily', used: 1, limit: 0, currency: 'USD' }], NOW)).toEqual([])
    expect(v([]).short).toBe('5h')
  })
  it('英文：Wk / Day / Mo', () => {
    setCurrentLocale('en-US')
    expect(v([PLAN_WEEKLY_93]).short).toBe('Wk')
    expect(v([{ id: 'daily', used: 9, limit: 10, currency: 'USD' }]).short).toBe('Day')
    expect(v([{ id: 'monthly', used: 90, limit: 100, currency: 'USD' }]).short).toBe('Mo')
  })
  it('余额不参与：只有余额时没有百分比', () => {
    const q = quota({ provider: 'platform', windows: [], extras: { balance: { amount: 12, currency: 'USD' } } })
    expect(v([], q).value).toBe('')
  })
})

describe('英文：分模型那一行读起来自然', () => {
  it('Opus (Weekly limit): 61% used', () => {
    setCurrentLocale('en-US')
    const q = quota({ windows: [win(300, 42)], extras: { models: [opus(61)] } })
    expect(quotaTooltip(q, 'claude', NOW)).toContain('Opus (Weekly limit): 61% used')
    expect(view(q).label).toContain('Opus (Weekly limit): 61% used')
    expect(quotaTooltip(q, 'claude', NOW)).not.toContain('Weekly limit Opus')
  })
  it('用完：Opus (Weekly limit): used up', () => {
    setCurrentLocale('en-US')
    const q = quota({ windows: [win(300, 42)], extras: { models: [opus(100)] } })
    expect(quotaTooltip(q, 'claude', NOW)).toContain('Opus (Weekly limit): used up')
  })
})

describe('quotaButtonVisible', () => {
  const ok = quota({ windows: [win(300, 42)] })
  it('一直显示：有数据、读取中显示；unsupported、empty 且没在读取不显示；没有桥（null）不显示', () => {
    expect(quotaButtonVisible(ok, false, 'always', NOW)).toBe(true)
    expect(quotaButtonVisible(null, true, 'always', NOW)).toBe(true)
    expect(quotaButtonVisible(null, false, 'always', NOW)).toBe(false)
    expect(quotaButtonVisible(quota({ status: 'unsupported' }), false, 'always', NOW)).toBe(false)
    expect(quotaButtonVisible(quota({ status: 'empty' }), false, 'always', NOW)).toBe(false)
    expect(quotaButtonVisible(quota({ status: 'empty' }), true, 'always', NOW)).toBe(true)
    expect(quotaButtonVisible(quota({ status: 'error', windows: [win(300, 42)] }), false, 'always', NOW)).toBe(true)
  })
  it('快用完时才显示：任一项 ≥80% 或用完或 blocked 才出现', () => {
    expect(quotaButtonVisible(ok, false, 'near-limit', NOW)).toBe(false)
    expect(quotaButtonVisible(quota({ windows: [win(300, 42), win(10_080, 80)] }), false, 'near-limit', NOW)).toBe(true)
    expect(
      quotaButtonVisible(quota({ windows: [], blocked: { kind: 'x', resetsAt: null } }), false, 'near-limit', NOW),
    ).toBe(true)
    expect(
      quotaButtonVisible(quota({ windows: [win(300, 79)], extras: { models: [opus(85)] } }), false, 'near-limit', NOW),
    ).toBe(true)
  })
  it('快用完时才显示：读取中、失败、过了恢复时间都不显示；弹窗开着不收', () => {
    expect(quotaButtonVisible(null, true, 'near-limit', NOW)).toBe(false)
    expect(quotaButtonVisible(quota({ status: 'error', windows: [win(300, 95)] }), false, 'near-limit', NOW)).toBe(
      false,
    )
    expect(quotaButtonVisible(quota({ windows: [win(300, 95, NOW - 1)] }), false, 'near-limit', NOW)).toBe(false)
    expect(quotaButtonVisible(ok, false, 'near-limit', NOW, true)).toBe(true)
  })
  it('isNearLimit', () => {
    expect(isNearLimit(ok, NOW)).toBe(false)
    expect(isNearLimit(quota({ windows: [win(300, 80)] }), NOW)).toBe(true)
  })
  it('快用完时才显示：平台套餐额度到 80% 也算（窗口都很松）', () => {
    const platform = quota({ provider: 'platform', windows: [win(300, 25)] })
    expect(quotaButtonVisible(platform, false, 'near-limit', NOW)).toBe(false)
    expect(quotaButtonVisible(platform, false, 'near-limit', NOW, false, [PLAN_WEEKLY_93])).toBe(true)
    expect(isNearLimit(platform, NOW, [PLAN_WEEKLY_93])).toBe(true)
  })
})

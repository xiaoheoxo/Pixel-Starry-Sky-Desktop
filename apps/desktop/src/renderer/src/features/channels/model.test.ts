import { afterEach, describe, expect, it } from 'vitest'
import type { Channel, ChannelMember, ChannelMessage } from '@/data/types'
import { setCurrentLocale } from '../../i18n/core'
import {
  appendMessage,
  buildTimeline,
  continuesTask,
  createMessage,
  defaultMentionIndex,
  filterMentionable,
  firstUnreadAt,
  insertMention,
  markRead,
  mentionAllOption,
  mentionAt,
  mentionsAll,
  parseMentions,
  sharedDirAgents,
  splitMentions,
  unreadTotal,
} from './model'
import { isReservedMentionName } from '../../../../shared/channels/mentions'
import { formatClock, formatDay } from './format'

afterEach(() => setCurrentLocale('zh-CN'))

const DAY1 = new Date(2026, 9, 7).getTime()
const DAY2 = new Date(2026, 9, 8).getTime()
const min = (n: number) => n * 60_000
const text = (
  id: string,
  authorId: string,
  at: number,
  extra: Partial<Extract<ChannelMessage, { kind: 'message' }>> = {},
): ChannelMessage => ({ kind: 'message', id, channelId: 'c', at, authorId, text: id, format: 'plain', ...extra })

const members: ChannelMember[] = [
  { id: 'me', kind: 'human', name: '林夏', you: true },
  {
    id: 'fe',
    kind: 'agent',
    name: '前端助手',
    engine: 'claude',
    model: null,
    machineId: 'local',
    machine: '这台电脑',
    status: 'idle',
  },
  {
    id: 'fe2',
    kind: 'agent',
    name: '前端',
    engine: 'codex',
    model: null,
    machineId: 'local',
    machine: '这台电脑',
    status: 'idle',
  },
  { id: 'zn', kind: 'human', name: '周宁' },
]

const agentOf = (m: ChannelMember): Extract<ChannelMember, { kind: 'agent' }> => {
  if (m.kind !== 'agent') throw new Error('not an agent')
  return m
}

describe('频道时间线', () => {
  it('同一作者 5 分钟内合并；换人、超时、带引用、任务卡都会断开', () => {
    const rows = buildTimeline([
      text('a1', 'me', DAY1 + min(600)),
      text('a2', 'me', DAY1 + min(603)),
      text('a3', 'me', DAY1 + min(610)),
      text('b1', 'fe', DAY1 + min(611)),
      text('b2', 'fe', DAY1 + min(612), { replyToId: 'a1' }),
      {
        kind: 'task',
        id: 't1',
        channelId: 'c',
        at: DAY1 + min(613),
        authorId: 'me',
        assigneeId: 'fe',
        title: 't',
        status: 'running',
      },
      text('b3', 'fe', DAY1 + min(614)),
    ])
    expect(rows.map(r => (r.kind === 'group' ? r.items.map(i => i.id).join('+') : r.kind))).toEqual([
      'day',
      'a1+a2',
      'a3',
      'b1',
      'b2',
      'task',
      'b3',
    ])
  })
  it('跨天插日期分隔并断开分组；新消息分隔只插一次', () => {
    const rows = buildTimeline(
      [
        text('a1', 'me', DAY1 + min(23 * 60 + 58)),
        text('a2', 'me', DAY2 + min(1)),
        text('a3', 'fe', DAY2 + min(10)),
        text('a4', 'fe', DAY2 + min(11)),
      ],
      { newFrom: DAY2 + min(10) },
    )
    expect(
      rows.map(r =>
        r.kind === 'group'
          ? r.items.map(i => i.id).join('+')
          : r.kind === 'day'
            ? `day:${r.at === DAY1 ? 1 : 2}`
            : r.kind,
      ),
    ).toEqual(['day:1', 'a1', 'day:2', 'a2', 'new', 'a3+a4'])
  })
  it('最早未读：只算别人的消息和任务卡，不算事件', () => {
    const list: ChannelMessage[] = [
      text('a', 'fe', 1),
      text('b', 'me', 2),
      { kind: 'event', id: 'e', channelId: 'c', at: 3, event: 'joined', actorId: 'zn' },
      text('c', 'fe', 4),
      text('d', 'zn', 5),
    ]
    expect(firstUnreadAt(list, 2, 'me')).toBe(4)
    expect(firstUnreadAt(list, 9, 'me')).toBe(1)
    expect(firstUnreadAt(list, 0, 'me')).toBeNull()
  })
})

describe('@提及', () => {
  it('@ 前面不能紧跟英文字母 / 数字，遇到空白结束；中文和标点后面可以', () => {
    expect(mentionAt('@前端', 3)).toEqual({ start: 0, query: '前端' })
    expect(mentionAt('请 @审', 4)).toEqual({ start: 2, query: '审' })
    expect(mentionAt('请@审', 3)).toEqual({ start: 1, query: '审' })
    expect(mentionAt('好了，@构', 5)).toEqual({ start: 3, query: '构' })
    expect(mentionAt('a@b', 3)).toBeNull()
    expect(mentionAt('x.y@b', 5)).toBeNull()
    expect(mentionAt('@前端 好的', 6)).toBeNull()
    expect(mentionAt('没有', 2)).toBeNull()
  })
  it('插入名字后补空格，光标落在空格后；后面已有空白时不重复加', () => {
    expect(insertMention('请 @前 看看', { start: 2, end: 4 }, '前端助手')).toEqual({
      text: '请 @前端助手 看看',
      caret: 8,
    })
    expect(insertMention('@前', { start: 0, end: 2 }, '前端助手')).toEqual({ text: '@前端助手 ', caret: 6 })
  })
  it('名字长的优先匹配，按出现顺序去重，不认识的 @ 当普通文字', () => {
    expect(parseMentions('@前端助手 和 @前端 还有 @前端助手 以及 @不存在', members)).toEqual(['fe', 'fe2'])
    expect(splitMentions('请 @周宁 看下', members)).toEqual([
      { text: '请 ' },
      { text: '@周宁', memberId: 'zn' },
      { text: ' 看下' },
    ])
    expect(parseMentions('mail@周宁', members)).toEqual([])
    expect(parseMentions('好了，@周宁 再看一次', members)).toEqual(['zn'])
  })
  it('@全体 / @all 展开成所有 AI 成员（按成员顺序、去重），真人不算', () => {
    expect(parseMentions('@全体 你们好', members)).toEqual(['fe', 'fe2'])
    expect(parseMentions('@周宁 @All 看下', members)).toEqual(['zn', 'fe', 'fe2'])
    expect(parseMentions('@前端 先看，@全体 再一起', members)).toEqual(['fe2', 'fe'])
    expect(splitMentions('请@全体看下', members)).toEqual([
      { text: '请' },
      { text: '@全体', all: true },
      { text: '看下' },
    ])
    expect(splitMentions('@all, go', members)).toEqual([{ text: '@all', all: true }, { text: ', go' }])
    expect(mentionsAll('@全体 好', members)).toBe(true)
    expect(mentionsAll('@前端 好', members)).toBe(false)
  })
  it('@全体 的边界：@allen、mail@all、没有 AI 成员时都当普通文字；同名成员优先', () => {
    expect(parseMentions('@allen 在吗', members)).toEqual([])
    expect(parseMentions('mail@all.com', members)).toEqual([])
    expect(parseMentions('@all_x', members)).toEqual([])
    const humans = members.filter(m => m.kind === 'human')
    expect(parseMentions('@全体 你们好', humans)).toEqual([])
    expect(splitMentions('@全体', humans)).toEqual([{ text: '@全体' }])
    // 不带 kind 的成员列表：@全体 不展开
    expect(parseMentions('@全体', [{ id: 'x', name: '前端' }])).toEqual([])
    // 老数据里已经有叫「全体」的成员：@全体 指它
    const named: ChannelMember[] = [...members, { ...agentOf(members[1]), id: 'q', name: '全体' }]
    expect(parseMentions('@全体', named)).toEqual(['q'])
  })
  it('「全体」「all」是保留名，不分大小写、忽略首尾空白', () => {
    expect(isReservedMentionName('全体')).toBe(true)
    expect(isReservedMentionName(' ALL ')).toBe(true)
    expect(isReservedMentionName('全体成员')).toBe(false)
    expect(isReservedMentionName('allen')).toBe(false)
  })
  it('@ 菜单的「全体」：2 个以上 AI 成员、输入是「全体」或「all」的开头时才有', () => {
    expect(mentionAllOption(members, '')).toEqual({ count: 2 })
    expect(mentionAllOption(members, '全')).toEqual({ count: 2 })
    expect(mentionAllOption(members, 'AL')).toEqual({ count: 2 })
    expect(mentionAllOption(members, '前')).toBeNull()
    expect(mentionAllOption(members.slice(0, 2), '')).toBeNull()
  })
  it('同一个目录的提示只算这个频道里的 AI 成员，不到 2 个不提示', () => {
    const fe = agentOf(members[1])
    const fe2 = agentOf(members[2])
    expect(
      sharedDirAgents([
        members[0],
        { ...fe, sharesDirWith: ['前端'] },
        { ...fe2, sharesDirWith: ['前端助手'] },
        members[3],
      ]),
    ).toEqual(['前端助手', '前端'])
    expect(sharedDirAgents([{ ...fe, sharesDirWith: ['别的频道的'] }, fe2])).toEqual([])
    expect(sharedDirAgents([fe, fe2])).toEqual([])
  })
  it('@ 菜单默认选第一个成员；只有在输入「全」「全体」「al」「all」时默认选「全体」', () => {
    expect(defaultMentionIndex('', true, 2)).toBe(1)
    expect(defaultMentionIndex('a', true, 2)).toBe(1)
    expect(defaultMentionIndex('前', true, 2)).toBe(1)
    expect(defaultMentionIndex('全', true, 2)).toBe(0)
    expect(defaultMentionIndex('AL', true, 1)).toBe(0)
    expect(defaultMentionIndex('全体', true, 0)).toBe(0)
    expect(defaultMentionIndex('', false, 2)).toBe(0)
  })
  it('引用任务卡：没 @ 别的 AI 成员才算追加要求；@全体（2 个以上 AI）不算', () => {
    expect(continuesTask('再改一下', members, 'fe')).toBe(true)
    expect(continuesTask('@前端助手 再改一下 @周宁', members, 'fe')).toBe(true)
    expect(continuesTask('@前端 也看下', members, 'fe')).toBe(false)
    expect(continuesTask('@全体 一起看看', members, 'fe')).toBe(false)
    expect(continuesTask('@全体 看看', members.slice(0, 2), 'fe')).toBe(true)
  })
  it('演示模式发消息：@全体 也展开', () => {
    const m = createMessage({ id: 'n', channelId: 'c', authorId: 'me', text: '@全体 开工', members, now: 1 })
    expect(m.mentions).toEqual(['fe', 'fe2'])
  })
  it('候选不含自己，AI 成员在前，可按引擎名过滤', () => {
    expect(filterMentionable(members, '', 'me').map(m => m.id)).toEqual(['fe', 'fe2', 'zn'])
    expect(filterMentionable(members, 'codex', 'me').map(m => m.id)).toEqual(['fe2'])
    expect(filterMentionable(members, '周', 'me').map(m => m.id)).toEqual(['zn'])
  })
})

describe('频道状态更新', () => {
  const channels: Channel[] = [
    { id: 'a', name: 'A', topic: null, scope: 'local', memberIds: [], unread: 2, mentioned: true, createdAt: 0 },
    { id: 'b', name: 'B', topic: null, scope: 'local', memberIds: [], unread: 1, createdAt: 0 },
  ]
  it('标已读和追加消息都返回新对象，不改原值', () => {
    expect(unreadTotal(channels)).toBe(3)
    // 归档的频道不算进侧栏角标
    expect(unreadTotal([channels[0], { ...channels[1], archivedAt: 1 }])).toBe(2)
    const read = markRead(channels, 'a')
    expect(read[0]).toMatchObject({ unread: 0, mentioned: false })
    expect(channels[0].unread).toBe(2)
    expect(markRead(read, 'a')).toBe(read)
    const before = { c: [] as ChannelMessage[] }
    const after = appendMessage(before, text('x', 'me', 1))
    expect(after.c).toHaveLength(1)
    expect(before.c).toHaveLength(0)
  })
  it('新消息记录引用和提到的成员，不把自己算进去', () => {
    const m = createMessage({
      id: 'n',
      channelId: 'c',
      authorId: 'me',
      text: '@前端助手 @林夏 看一下',
      replyToId: 'x',
      members,
      now: 5,
    })
    expect(m).toMatchObject({ kind: 'message', format: 'plain', replyToId: 'x', mentions: ['fe'], at: 5 })
  })
})

describe('频道日期格式', () => {
  const now = new Date(2026, 9, 8, 15, 0).getTime()
  it('今天 / 昨天 / 具体日期，跨年带年份', () => {
    expect(formatDay(new Date(2026, 9, 8, 9).getTime(), now)).toBe('今天')
    expect(formatDay(new Date(2026, 9, 7, 23).getTime(), now)).toBe('昨天')
    expect(formatDay(new Date(2026, 9, 5).getTime(), now)).toBe('10月5日 星期一')
    expect(formatDay(new Date(2025, 11, 31).getTime(), now)).toBe('2025年12月31日 星期三')
    setCurrentLocale('en-US')
    expect(formatDay(new Date(2026, 9, 8, 9).getTime(), now)).toBe('Today')
    expect(formatDay(new Date(2026, 9, 5).getTime(), now)).toBe('Mon, Oct 5')
  })
  it('时间：中文 24 小时制，英文 12 小时制', () => {
    const at = new Date(2026, 9, 8, 9, 5).getTime()
    expect(formatClock(at)).toBe('09:05')
    setCurrentLocale('en-US')
    expect(formatClock(at)).toMatch(/^9:05\sAM$/)
  })
})

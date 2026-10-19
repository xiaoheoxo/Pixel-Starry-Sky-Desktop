import { describe, expect, it } from 'vitest'
import type { Channel, ChannelMember, ChannelMessage, ChannelTask } from '@/data/types'
import type { TeamInfo } from '../../../../shared/types/channels'
import {
  canApprove,
  canControlTask,
  canDispatch,
  canManageTeam,
  canWithdraw,
  channelOfNotice,
  groupChannels,
  inviteDaysLeft,
  isMyTask,
  isValidEmail,
  lastSeen,
  mentionNote,
  myRole,
  onlineCount,
  onlineMembers,
  parseCollapsed,
  sortTeamMembers,
  teamNotice,
  teamNoticeId,
  toggleCollapsed,
} from './teamModel'

const channel = (id: string, scope: 'local' | 'team', teamId?: string): Channel => ({
  id,
  name: id,
  topic: null,
  scope,
  teamId,
  memberIds: [],
  unread: 0,
  createdAt: 0,
})
const team = (id: string, role: TeamInfo['role'] = 'member'): TeamInfo => ({
  id,
  name: id,
  role,
  members: [],
  invites: [],
})

describe('groupChannels', () => {
  const channels = [
    channel('a', 'local'),
    channel('b', 'team', 't1'),
    channel('c', 'team', 't2'),
    channel('d', 'team', 't1'),
  ]
  it('本机在前，然后每个团队一段，团队即使没有频道也有一段', () => {
    const sections = groupChannels(channels, [team('t1'), team('t2'), team('t3')])
    expect(sections.map(s => [s.id, s.channels.map(c => c.id)])).toEqual([
      ['local', ['a']],
      ['t1', ['b', 'd']],
      ['t2', ['c']],
      ['t3', []],
    ])
  })
  it('搜索时没有匹配的段整段隐藏；找不到团队的频道不显示', () => {
    const sections = groupChannels([channel('x', 'team', 'gone'), channel('b', 'team', 't1')], [team('t1')], {
      searching: true,
    })
    expect(sections.map(s => s.id)).toEqual(['t1'])
  })
  it('归档的频道收进最后一段「已归档」；没有归档的频道时没有这一段', () => {
    const archived = { ...channel('z', 'local'), archivedAt: 5 }
    const sections = groupChannels([...channels, archived], [team('t1')])
    expect(sections.map(s => [s.id, s.channels.map(c => c.id)])).toEqual([
      ['local', ['a']],
      ['t1', ['b', 'd']],
      ['archived', ['z']],
    ])
    expect(groupChannels([archived], [], { searching: true }).map(s => s.id)).toEqual(['archived'])
  })
})

describe('折叠状态', () => {
  it('解析 localStorage 里的值，坏数据当作没有', () => {
    expect(parseCollapsed('["t1","local"]')).toEqual(['t1', 'local'])
    expect(parseCollapsed('{"a":1}')).toEqual([])
    expect(parseCollapsed('nope')).toEqual([])
    expect(parseCollapsed(null)).toEqual([])
    expect(parseCollapsed('[1,"a"]')).toEqual(['a'])
  })
  it('toggleCollapsed 加入或移除', () => {
    expect(toggleCollapsed(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleCollapsed(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('在线状态', () => {
  const now = 1_000_000_000_000
  it('lastSeen 分钟 / 小时 / 天，超过 7 天不写', () => {
    expect(lastSeen(now - 10_000, now)).toEqual({ unit: 'justNow' })
    expect(lastSeen(now - 5 * 60_000, now)).toEqual({ unit: 'minutes', count: 5 })
    expect(lastSeen(now - 2 * 3_600_000, now)).toEqual({ unit: 'hours', count: 2 })
    expect(lastSeen(now - 3 * 86_400_000, now)).toEqual({ unit: 'days', count: 3 })
    expect(lastSeen(now - 8 * 86_400_000, now)).toBeNull()
    expect(lastSeen(null, now)).toBeNull()
    expect(lastSeen(undefined, now)).toBeNull()
  })
  it('onlineCount 把自己算在线', () => {
    expect(onlineCount([{ you: true }, { online: true }, { online: false }, {}])).toBe(2)
  })
  it('onlineMembers 最多 3 个，不含自己', () => {
    const t: TeamInfo = {
      ...team('t1'),
      members: ['me', 'a', 'b', 'c', 'd'].map(id => ({ id, role: 'member', online: true, lastSeenAt: null })),
    }
    const names = new Map([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ])
    expect(onlineMembers(t, names, 'me').map(m => m.name)).toEqual(['A', 'B', 'C'])
  })
})

describe('权限', () => {
  it('观察者不能派活，其它角色和本机频道可以', () => {
    expect(canDispatch('observer')).toBe(false)
    expect(canDispatch('member')).toBe(true)
    expect(canDispatch('owner')).toBe(true)
    expect(canDispatch(undefined)).toBe(true)
    expect(canManageTeam('owner')).toBe(true)
    expect(canManageTeam('member')).toBe(false)
  })
  it('myRole 按团队 id 取', () => {
    expect(myRole([team('t1', 'owner')], 't1')).toBe('owner')
    expect(myRole([team('t1', 'owner')], 't2')).toBeUndefined()
    expect(myRole([team('t1', 'owner')], undefined)).toBeUndefined()
  })
  const task = (patch: Partial<ChannelTask>): ChannelTask => ({
    kind: 'task',
    id: 't',
    channelId: 'c',
    at: 0,
    authorId: 'zn',
    assigneeId: 'ag',
    title: '活',
    status: 'approval',
    ownerId: 'me',
    ...patch,
  })
  it('canApprove：只有主人，且在等同意时', () => {
    expect(canApprove(task({}), 'me')).toBe(true)
    expect(canApprove(task({}), 'zn')).toBe(false)
    expect(canApprove(task({ status: 'queued' }), 'me')).toBe(false)
    expect(canApprove(task({ ownerId: undefined }), null)).toBe(false)
  })
  it('canWithdraw：派活的人在等同意时可以取消', () => {
    expect(canWithdraw(task({}), 'zn')).toBe(true)
    expect(canWithdraw(task({}), 'me')).toBe(false)
    expect(canWithdraw(task({ status: 'running' }), 'zn')).toBe(false)
  })
  it('isMyTask：没有主人（本机频道）或主人是我', () => {
    expect(isMyTask(task({ ownerId: undefined }), 'me')).toBe(true)
    expect(isMyTask(task({}), 'me')).toBe(true)
    expect(isMyTask(task({}), 'zn')).toBe(false)
  })
  it('canControlTask：主人和派活的人都能停止 / 取消 / 重试，旁人不能', () => {
    expect(canControlTask(task({ status: 'running' }), 'me')).toBe(true)
    expect(canControlTask(task({ status: 'running' }), 'zn')).toBe(true)
    expect(canControlTask(task({ status: 'running' }), 'chen')).toBe(false)
    expect(canControlTask(task({ ownerId: undefined }), 'chen')).toBe(true)
  })
  const agent = (patch: Partial<Extract<ChannelMember, { kind: 'agent' }>>): ChannelMember => ({
    id: 'ag',
    kind: 'agent',
    name: 'AG',
    engine: 'claude',
    model: null,
    machineId: 'local',
    machine: '',
    status: 'idle',
    ...patch,
  })
  it('mentionNote：观察者 / 需要同意', () => {
    expect(mentionNote(agent({ mine: false, policy: 'approve' }), 'observer')).toBe('observer')
    expect(mentionNote(agent({ mine: false, policy: 'approve' }), 'member')).toBe('approval')
    expect(mentionNote(agent({ mine: false, policy: 'team' }), 'member')).toBeNull()
    expect(mentionNote(agent({ mine: true, policy: 'approve' }), 'member')).toBeNull()
    expect(mentionNote(agent({}), undefined)).toBeNull()
    expect(mentionNote({ id: 'h', kind: 'human', name: 'H' }, 'observer')).toBeNull()
  })
})

describe('邀请', () => {
  it('剩余天数向下取整，最小 0', () => {
    expect(inviteDaysLeft(13.5 * 86_400_000, 0)).toBe(13)
    expect(inviteDaysLeft(1000, 5000)).toBe(0)
  })
  it('邮箱格式', () => {
    expect(isValidEmail(' wang@example.com ')).toBe(true)
    expect(isValidEmail('wang@')).toBe(false)
    expect(isValidEmail('a b@c.d')).toBe(false)
  })
  it('成员排序：所有者、在线、名字', () => {
    const names = new Map([
      ['o', '林夏'],
      ['a', '周宁'],
      ['b', '陈一'],
    ])
    const sorted = sortTeamMembers(
      [
        { id: 'b', role: 'observer', online: false, lastSeenAt: null },
        { id: 'a', role: 'member', online: true, lastSeenAt: null },
        { id: 'o', role: 'owner', online: false, lastSeenAt: null },
      ],
      names,
    )
    expect(sorted.map(m => m.id)).toEqual(['o', 'a', 'b'])
  })
})

describe('系统通知', () => {
  const ch = { id: 'c1', scope: 'team' as const }
  const text = (patch: Partial<Extract<ChannelMessage, { kind: 'message' }>>): ChannelMessage => ({
    kind: 'message',
    id: 'm1',
    channelId: 'c1',
    at: 0,
    authorId: 'zn',
    text: '',
    format: 'plain',
    mentions: ['me'],
    ...patch,
  })
  it('@ 了我才提醒，自己发的和本机频道不提醒', () => {
    expect(teamNotice(text({}), ch, 'me')).toEqual({ kind: 'mention', messageId: 'm1', channelId: 'c1' })
    expect(teamNotice(text({ authorId: 'me' }), ch, 'me')).toBeNull()
    expect(teamNotice(text({ mentions: ['x'] }), ch, 'me')).toBeNull()
    expect(teamNotice(text({}), { id: 'c1', scope: 'local' }, 'me')).toBeNull()
    expect(teamNotice(text({}), undefined, 'me')).toBeNull()
  })
  it('我的 AI 成员有新活等同意才提醒', () => {
    const task = (patch: Partial<ChannelTask>): ChannelMessage => ({
      kind: 'task',
      id: 't1',
      channelId: 'c1',
      at: 0,
      authorId: 'zn',
      assigneeId: 'ag',
      title: '活',
      status: 'approval',
      ownerId: 'me',
      ...patch,
    })
    expect(teamNotice(task({}), ch, 'me')).toEqual({ kind: 'approval', messageId: 't1', channelId: 'c1' })
    expect(teamNotice(task({ ownerId: 'zn' }), ch, 'me')).toBeNull()
    expect(teamNotice(task({ status: 'queued' }), ch, 'me')).toBeNull()
  })
  it('通知 id 带着频道 id', () => {
    const id = teamNoticeId({ kind: 'mention', messageId: 'm1', channelId: 'tc_1' })
    expect(channelOfNotice(id)).toBe('tc_1')
    expect(channelOfNotice('feedback:1')).toBeNull()
  })
})

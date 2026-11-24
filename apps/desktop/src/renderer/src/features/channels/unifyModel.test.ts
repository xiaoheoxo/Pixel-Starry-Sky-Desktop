// 频道和团队融合（docs/ui/channels-unify.md）：任务页分组、「正在做」分格、派活预告
import { describe, expect, it } from 'vitest'
import type { AgentMember, Channel, ChannelMember, ChannelMessage, ChannelTask } from '@/data/types'
import type { ChannelFollow, ChannelNeed } from '../../../../shared/types/channels'
import { dispatchPreview, doingBoxes, groupTasks, openTaskCount, taskGroupOf } from './unifyModel'

const ME = 'u:1'
const task = (id: string, status: ChannelTask['status'], extra: Partial<ChannelTask> = {}): ChannelTask => ({
  id,
  kind: 'task',
  channelId: 'c',
  at: Number(id.replace(/\D/g, '')) || 0,
  authorId: ME,
  assigneeId: 'a1',
  title: id,
  status,
  ...extra,
})
const agent = (id: string, extra: Partial<AgentMember> = {}): AgentMember => ({
  id,
  kind: 'agent',
  name: id,
  engine: 'claude',
  model: null,
  machineId: 'local',
  machine: '这台电脑',
  status: 'idle',
  ...extra,
})
const channel = (id: string, memberIds: string[], extra: Partial<Channel> = {}): Channel => ({
  id,
  name: id,
  topic: null,
  scope: 'local',
  memberIds,
  unread: 0,
  createdAt: 0,
  ...extra,
})

describe('任务页分组', () => {
  it('本机频道（卡上没有主人）：等确认、接力停下算要我处理', () => {
    expect(taskGroupOf(task('t1', 'waiting'), 'you')).toBe('mine')
    expect(taskGroupOf(task('t2', 'queued', { relay: { chain: 'k', hop: 1, held: 'hops' } }), 'you')).toBe('mine')
    expect(taskGroupOf(task('t3', 'queued'), 'you')).toBe('queued')
    expect(taskGroupOf(task('t4', 'running'), 'you')).toBe('running')
    expect(taskGroupOf(task('t5', 'failed'), 'you')).toBe('ended')
  })

  it('团队的频道：等我同意的归我，等别人同意、等别人确认的不归我', () => {
    expect(taskGroupOf(task('t1', 'approval', { ownerId: ME, authorId: 'u:2' }), ME)).toBe('mine')
    expect(taskGroupOf(task('t2', 'approval', { ownerId: 'u:2' }), ME)).toBe('others')
    expect(taskGroupOf(task('t3', 'waiting', { ownerId: 'u:2' }), ME)).toBe('running')
    // 认不出我是谁：等同意的不算我的
    expect(taskGroupOf(task('t4', 'approval', { ownerId: ME }), null)).toBe('others')
  })

  it('按组的固定顺序返回，组里新的在前，空组不出现；消息和事件不算', () => {
    const messages: ChannelMessage[] = [
      task('t1', 'done'),
      task('t2', 'running'),
      { id: 'm', kind: 'message', channelId: 'c', at: 9, authorId: ME, text: 'hi' } as ChannelMessage,
      task('t3', 'done'),
      task('t4', 'approval', { ownerId: ME, authorId: 'u:2' }),
    ]
    const groups = groupTasks(messages, ME)
    expect(groups.map(g => g.id)).toEqual(['mine', 'running', 'ended'])
    expect(groups[2].tasks.map(t => t.id)).toEqual(['t3', 't1'])
    expect(openTaskCount(messages)).toBe(2)
  })

  it('筛选：我派的、派给我的 AI 成员', () => {
    const messages = [
      task('t1', 'running', { ownerId: 'u:2' }),
      task('t2', 'running', { ownerId: ME, authorId: 'u:2' }),
      task('t3', 'done', { ownerId: ME }),
    ]
    const ids = (filter: 'sent' | 'received') => groupTasks(messages, ME, filter).flatMap(g => g.tasks.map(t => t.id))
    expect(ids('sent')).toEqual(['t1', 't3'])
    expect(ids('received')).toEqual(['t2', 't3'])
    // 认不出我是谁：两个筛选都是空的，不把所有人的都算成我的
    expect(groupTasks(messages, null, 'sent')).toEqual([])
    expect(groupTasks(messages, null, 'received')).toEqual([])
  })
})

describe('正在做', () => {
  const follow = (taskId: string, memberId: string, status: ChannelFollow['status'] = 'running'): ChannelFollow => ({
    channelId: 'c1',
    taskId,
    memberId,
    title: taskId,
    status,
    at: 1,
    sessionId: null,
  })
  const members: ChannelMember[] = [
    { id: 'you', kind: 'human', name: '我', you: true },
    agent('idle'),
    agent('busy'),
    agent('ta_mine', { teamAgentId: 'ta_mine', mine: true, status: 'running', task: '整理文档' }),
    agent('ta_theirs', { teamAgentId: 'ta_theirs', mine: false, status: 'waiting' }),
    agent('ta_idle', { teamAgentId: 'ta_idle', mine: false }),
    agent('theirs-local', { mine: false }),
  ]
  const channels = [
    channel('c1', ['you', 'idle', 'busy']),
    channel('old', ['idle'], { archivedAt: 1 }),
    channel('t1', ['ta_mine', 'ta_theirs'], { scope: 'team', teamId: 'tm' }),
  ]

  it('我的本机 AI 成员一人一格，有活的排前面；空闲的带上所在的频道（不含归档的）', () => {
    const { mine } = doingBoxes(members, channels, [follow('k1', 'busy'), follow('k2', 'busy', 'queued')], [])
    expect(mine.map(b => b.member.id)).toEqual(['busy', 'idle'])
    expect(mine[0].items.map(i => i.taskId)).toEqual(['k1', 'k2'])
    expect(mine[1].items).toEqual([])
    expect(mine[1].channels.map(c => c.id)).toEqual(['c1'])
  })

  it('等我确认的活从「需要你」算进来，排在最前', () => {
    const need = {
      key: 'approval:k9',
      kind: 'approval',
      sig: 's',
      channelId: 'c1',
      at: 5,
      memberId: 'busy',
      taskId: 'k9',
      text: '想运行 pnpm check',
    } as ChannelNeed
    const gone = { ...need, key: 'approval:k8', taskId: 'k8', gone: 'session' } as ChannelNeed
    const { mine } = doingBoxes(members, channels, [follow('k1', 'busy')], [need, gone])
    expect(mine[0].items.map(i => [i.taskId, i.status])).toEqual([
      ['k9', 'waiting'],
      ['k1', 'running'],
    ])
  })

  it('团队的频道：只列正在做事的 AI 成员，我的和队友的都算，带上所在的频道', () => {
    const { team } = doingBoxes(members, channels, [], [])
    expect(team.map(b => b.member.id)).toEqual(['ta_mine', 'ta_theirs'])
    expect(team[0].channels.map(c => c.id)).toEqual(['t1'])
  })
})

describe('派活预告', () => {
  const human: ChannelMember = { id: 'u:2', kind: 'human', name: '周宁' }
  it('本机频道：自己的 AI 成员马上开始，真人不算', () => {
    expect(dispatchPreview([agent('a'), human], undefined, 'you').map(p => [p.member.id, p.kind])).toEqual([
      ['a', 'start'],
    ])
  })

  it('团队的频道：按主人的规则，要同意、直接派、只当文字分开', () => {
    const list = [
      agent('mine', { mine: true }),
      agent('approve', { mine: false, policy: 'approve' }),
      agent('team', { mine: false, policy: 'team' }),
      agent('owner', { mine: false, policy: 'owner' }),
      agent('listed', { mine: false, policy: 'listed', allow: [ME] }),
      agent('listed-out', { mine: false, policy: 'listed', allow: ['u:3'] }),
    ]
    expect(dispatchPreview(list, 'member', ME).map(p => p.kind)).toEqual([
      'start',
      'approval',
      'start',
      'text',
      'start',
      'approval',
    ])
  })

  it('观察者派不了活：都只当文字', () => {
    expect(dispatchPreview([agent('mine', { mine: true })], 'observer', ME).map(p => p.kind)).toEqual(['text'])
  })
})

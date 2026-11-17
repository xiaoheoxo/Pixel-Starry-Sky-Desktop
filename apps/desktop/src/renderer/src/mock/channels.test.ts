import { describe, expect, it } from 'vitest'
import { demo } from './demo'
import { DEMO_DELETED_MEMBER, DEMO_TEAMS, demoChannelData } from './channels'
import { empty } from '@/data/empty'
import type { ChannelTask } from '@/data/types'
import { unreadTotal } from '../features/channels/model'

describe('协作频道演示数据', () => {
  const ids = new Set(demo.channelMembers.map(m => m.id))
  const messages = Object.values(demo.channelMessages).flat()

  it('id 不重复，每个频道都有消息列表、包含「你」', () => {
    expect(ids.size).toBe(demo.channelMembers.length)
    expect(new Set(messages.map(m => m.id)).size).toBe(messages.length)
    const self = demo.channelMembers.filter(m => m.kind === 'human' && m.you)
    expect(self).toHaveLength(1)
    for (const c of demo.channels) {
      expect(demo.channelMessages[c.id], c.id).toBeDefined()
      expect(c.memberIds, c.id).toContain(self[0].id)
      for (const id of c.memberIds) expect(ids.has(id), `${c.id} ${id}`).toBe(true)
    }
  })
  it('作者、指派对象、引用都能找到，消息按时间排列', () => {
    for (const [channelId, list] of Object.entries(demo.channelMessages)) {
      const own = new Set(list.map(m => m.id))
      list.forEach((m, i) => {
        expect(m.channelId).toBe(channelId)
        if (i > 0) expect(m.at, m.id).toBeGreaterThanOrEqual(list[i - 1].at)
        if (m.kind === 'event') expect(ids.has(m.actorId), m.id).toBe(true)
        // 主动提醒是系统发的（SYSTEM_AUTHOR），不是成员
        else if (!(m.kind === 'message' && m.alert)) expect(ids.has(m.authorId), m.id).toBe(true)
        // 例外：一张交给已删成员的旧卡（演示「需要你」里找不到成员的那一组）
        if (m.kind === 'task' && m.assigneeId !== DEMO_DELETED_MEMBER) expect(ids.has(m.assigneeId), m.id).toBe(true)
        if (m.kind === 'message' && m.replyToId) expect(own.has(m.replyToId), m.id).toBe(true)
        if (m.kind === 'message') for (const id of m.mentions ?? []) expect(ids.has(id), m.id).toBe(true)
      })
    }
  })
  it('「打开会话」只指向演示项目里存在的会话', () => {
    const sessions = new Set(demo.projects.flatMap(p => p.sessions.map(s => s.id)))
    for (const m of messages) if (m.kind === 'task' && m.sessionId) expect(sessions.has(m.sessionId), m.id).toBe(true)
    for (const m of demo.channelMembers)
      if (m.kind === 'agent' && m.sessionId) expect(sessions.has(m.sessionId), m.id).toBe(true)
  })
  it('团队打开（默认）：演示模式带示例团队，团队连接在线', () => {
    expect(DEMO_TEAMS).toBe(true)
    expect(demo.channelTeams.connection).toBe('online')
    expect(demo.channels.some(c => c.scope === 'team')).toBe(true)
  })
  it('关着团队时（DEMO_TEAMS = false）：没有团队频道、队友、别人的 AI 成员，团队连接不可用', () => {
    const off = demoChannelData(false)
    expect(off.channelTeams).toEqual({ teams: [], invites: [], connection: 'unavailable' })
    expect(off.channels.some(c => c.scope === 'team')).toBe(false)
    expect(off.channels.length).toBeGreaterThan(0)
    for (const m of off.channelMembers) {
      if (m.kind === 'human') expect(m.you, m.id).toBe(true)
      else expect(m.mine, m.id).not.toBe(false)
    }
    expect(Object.keys(off.channelMessages).sort()).toEqual(off.channels.map(c => c.id).sort())
  })
  it('示例团队（DEMO_TEAMS 打开时）：团队频道都属于某个团队，成员 id 对得上，有一张等同意的卡和一张别人电脑上的进行中的卡', () => {
    const withTeams = demoChannelData(true)
    const ids = new Set(withTeams.channelMembers.map(m => m.id))
    const messages = Object.values(withTeams.channelMessages).flat()
    const demo = { ...withTeams }
    const { teams, invites } = demo.channelTeams
    expect(teams).toHaveLength(1)
    expect(invites).toHaveLength(1)
    const team = teams[0]
    for (const m of team.members) expect(ids.has(m.id), m.id).toBe(true)
    const teamChannels = demo.channels.filter(c => c.scope === 'team')
    expect(teamChannels.length).toBeGreaterThanOrEqual(2)
    for (const c of teamChannels) {
      expect(c.teamId, c.id).toBe(team.id)
      for (const m of team.members) expect(c.memberIds, `${c.id} ${m.id}`).toContain(m.id)
    }
    const tasks = messages.filter((m): m is ChannelTask => m.kind === 'task')
    const self = demo.channelMembers.find(m => m.kind === 'human' && m.you)!
    expect(tasks.some(t => t.status === 'approval' && t.ownerId === self.id)).toBe(true)
    expect(
      tasks.some(t => t.status === 'running' && t.ownerId && t.ownerId !== self.id && t.authorId === self.id),
    ).toBe(true)
    const foreign = demo.channelMembers.filter(m => m.kind === 'agent' && m.mine === false)
    expect(foreign.length).toBeGreaterThan(0)
    for (const a of foreign) expect(a.kind === 'agent' && a.ownerName).toBeTruthy()
  })
  it('未读合计 6（导航角标，含团队频道；关着团队时 4），空界面没有频道和团队', () => {
    expect(unreadTotal(demo.channels)).toBe(6)
    expect(unreadTotal(demoChannelData(false).channels)).toBe(4)
    expect(empty.channelTeams).toEqual({ teams: [], invites: [], connection: 'unavailable' })
    expect(empty.channels).toEqual([])
    expect(empty.channelMembers).toEqual([])
    expect(empty.channelMessages).toEqual({})
  })
})

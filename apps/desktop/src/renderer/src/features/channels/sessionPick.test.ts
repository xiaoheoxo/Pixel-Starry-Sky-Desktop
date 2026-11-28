import { describe, expect, it } from 'vitest'
import type { ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import type { AgentMember } from '@/data/types'
import { SESSION_PICK_LIMIT, firstTab, pickBlocked, sessionCandidates } from './sessionPick'

const projects = [
  { id: 'p1', name: 'web' },
  { id: 'p2', name: 'api' },
] as ProjectRecord[]

const session = (id: string, extra: Partial<SessionSummary['record']> = {}, state = 'idle'): SessionSummary =>
  ({
    record: { id, title: `会话 ${id}`, projectId: 'p1', engine: 'claude', updatedAt: 1, archivedAt: null, ...extra },
    state,
  }) as SessionSummary

const agent = (id: string, sharedSessionId: string | null, extra: Partial<AgentMember['config']> = {}) =>
  ({
    id,
    kind: 'agent',
    name: `成员${id}`,
    config: { mode: sharedSessionId ? 'shared' : 'per-task', sharedSessionId, ...extra },
  }) as AgentMember

const pick = (over: Partial<Parameters<typeof sessionCandidates>[0]> = {}) =>
  sessionCandidates({
    sessions: [],
    projects,
    members: [],
    channel: { memberIds: [] },
    projectId: null,
    query: '',
    ...over,
  })

describe('sessionCandidates', () => {
  it('只列能加入的会话：没归档、不是 Dot、不在聊天里、项目还在', () => {
    const { list } = pick({
      sessions: [
        session('ok'),
        session('archived', { archivedAt: 5 }),
        session('dot', { engine: 'dot' }),
        session('chat', { projectId: 'chat' }),
        session('remoteChat', { projectId: 'ssh-1~chat' }),
        session('gone', { projectId: 'p9' }),
      ],
    })
    expect(list.map(c => c.id)).toEqual(['ok'])
    expect(list[0].project).toBe('web')
  })

  it('按项目筛、按标题或项目名搜，最近更新的在前', () => {
    const sessions = [
      session('a', { updatedAt: 1 }),
      session('b', { updatedAt: 3, projectId: 'p2' }),
      session('c', { updatedAt: 2, title: '修登录' }),
    ]
    expect(pick({ sessions }).list.map(c => c.id)).toEqual(['b', 'c', 'a'])
    expect(pick({ sessions, projectId: 'p1' }).list.map(c => c.id)).toEqual(['c', 'a'])
    expect(pick({ sessions, query: ' 登录 ' }).list.map(c => c.id)).toEqual(['c'])
    expect(pick({ sessions, query: 'API' }).list.map(c => c.id)).toEqual(['b'])
  })

  it('超过上限时截断并标出还有更多', () => {
    const sessions = Array.from({ length: SESSION_PICK_LIMIT + 1 }, (_, i) => session(`s${i}`, { updatedAt: i }))
    const out = pick({ sessions })
    expect(out.list).toHaveLength(SESSION_PICK_LIMIT)
    expect(out.list[0].id).toBe(`s${SESSION_PICK_LIMIT}`)
    expect(out.more).toBe(true)
  })

  it('标运行中和成员占用：在这个频道里、频道共用会话的成员、别的频道里绑定的', () => {
    const members = [
      agent('m1', 'in', { bound: true }),
      agent('m2', 'used'),
      agent('m3', 'bound', { bound: true }),
      agent('m4', 'ownIn'),
      agent('m5', null),
      { ...agent('m6', 'theirs', { bound: true }), mine: false },
    ]
    const { list } = pick({
      sessions: ['in', 'used', 'bound', 'ownIn', 'free', 'theirs'].map(id =>
        session(id, {}, id === 'free' ? 'running' : 'idle'),
      ),
      members,
      channel: { memberIds: ['m1', 'm4'] },
    })
    const tags = Object.fromEntries(list.map(c => [c.id, c.tag && `${c.tag.kind}:${c.tag.name}`]))
    expect(tags).toEqual({
      in: 'in:成员m1',
      used: 'used:成员m2',
      bound: 'bound:成员m3',
      ownIn: 'in:成员m4',
      free: null,
      theirs: null,
    })
    expect(list.find(c => c.id === 'free')?.running).toBe(true)
    expect(
      list
        .filter(pickBlocked)
        .map(c => c.id)
        .sort(),
    ).toEqual(['in', 'ownIn', 'used'])
  })
})

describe('firstTab', () => {
  it('有会话先已有会话，再已有成员，最后新建', () => {
    expect(firstTab(true, true)).toBe('session')
    expect(firstTab(false, true)).toBe('member')
    expect(firstTab(false, false)).toBe('new')
  })
})

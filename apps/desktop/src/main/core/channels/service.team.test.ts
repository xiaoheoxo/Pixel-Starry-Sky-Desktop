import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineEvent, HostEvent, ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import type { AgentInput, AgentMember, ChannelMessage, ChannelTask } from '../../../shared/types/channels'
import { ChannelStore } from './store'
import { Channels, SELF_ID, UNATTENDED_DENY } from './service'
import { TeamApi } from './team/api'
import { FakeCloud, until } from './team/fake-cloud'
import type { RealtimeStatus, TeamFrame } from './team/realtime'
import { TeamSync } from './team/sync'

const projects: ProjectRecord[] = [{ id: 'p1', name: 'pixel-web', path: 'D:/web' } as ProjectRecord]

let dir: string
let opened: Channels[]
let emitted: { channel: string; value: unknown }[]
let sent: { sessionId: string; text: string; clientMessageId: string }[]
let created: Record<string, unknown>[]
let answers: unknown[][]
let sessions: SessionSummary[]
let now: number

async function open(extra: Partial<ConstructorParameters<typeof Channels>[0]> = {}) {
  const cloud = new FakeCloud()
  let handlers!: { onFrame(f: TeamFrame): void; onStatus(s: RealtimeStatus): void }
  const sync = new TeamSync({
    api: new TeamApi(cloud.fetch),
    realtime: h => {
      handlers = h
      return { start() {}, stop() {}, restart() {} }
    },
  })
  cloud.push = f => handlers.onFrame(f)
  const store = new ChannelStore(dir)
  await store.init()
  const c = new Channels({
    store,
    call: async (channel, args) => {
      if (channel === 'engine:createSession') {
        created.push(args[0] as Record<string, unknown>)
        const id = `s${sessions.length + 1}`
        sessions.push({ record: { id, projectId: 'p1' }, state: 'idle' } as SessionSummary)
        return { id }
      }
      if (channel === 'engine:answer') answers.push(args)
      if (channel === 'engine:send')
        sent.push({ sessionId: args[0] as string, ...(args[1] as { text: string; clientMessageId: string }) })
      return null
    },
    emit: (channel, value) => emitted.push({ channel, value }),
    machines: () => [{ id: 'local', name: 'PC', connected: true }],
    projects: () => projects,
    sessions: () => sessions,
    machineOf: () => 'local',
    selfName: () => '林夏',
    locale: () => 'zh-CN',
    now: () => ++now,
    team: sync,
    deviceId: 'dev-A',
    machineName: () => '林夏的电脑',
    teamTiming: { progressMs: 10, statusMs: 10 },
    ...extra,
  })
  opened.push(c)
  const online = async () => {
    sync.start()
    handlers.onStatus('online')
    await until(() => sync.connection() === 'online')
  }
  return { c, cloud, sync, store, online, status: (s: RealtimeStatus) => handlers.onStatus(s) }
}

const agent = (name: string, patch: Partial<AgentInput> = {}): AgentInput => ({
  name,
  engine: 'claude',
  projectId: 'p1',
  copyId: null,
  settings: { model: 'sonnet' },
  instructions: '只改前端',
  mode: 'per-task',
  ...patch,
})
const ev = (sessionId: string, event: EngineEvent): HostEvent => ({ kind: 'session', sessionId, seq: 0, event })
function complete(c: Channels, sessionId: string, cmid: string, reply: string): void {
  const turn = `turn-${cmid}`
  c.hostEvent(
    ev(sessionId, { type: 'item_completed', item: { kind: 'user', id: cmid, text: '', createdAt: 0, turnId: turn } }),
  )
  c.hostEvent(
    ev(sessionId, {
      type: 'item_completed',
      item: { kind: 'assistant', id: `a-${turn}`, text: reply, status: 'completed' },
    }),
  )
  c.hostEvent(ev(sessionId, { type: 'turn_completed', turnId: turn, outcome: 'completed', error: null }))
}
const pushes = (): ChannelMessage[] =>
  emitted.filter(e => e.channel === 'channels:message').map(e => (e.value as { message: ChannelMessage }).message)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsky-channels-team-'))
  opened = []
  emitted = []
  sent = []
  created = []
  answers = []
  sessions = []
  now = 1_000_000
})
afterEach(async () => {
  for (const c of opened) await c.dispose()
  // 关掉后还可能有一笔写盘没落完（runs.json 原子替换），Windows 上删目录会碰到 ENOTEMPTY / EBUSY：重试几次
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('协作频道 Phase C：快照合并', () => {
  it('state() 合并本机和团队；没登录时团队部分是空的', async () => {
    const { c, online } = await open()
    const local = await c.create({ name: '本机频道' })
    expect(c.state()).toMatchObject({ teams: [], invites: [], teamsConnection: 'signed-out', teamsSyncedAt: null })
    await online()
    const s = c.state()
    expect(s.teamsConnection).toBe('online')
    expect(s.teamsSyncedAt).toBeGreaterThan(0)
    expect(s.teams[0]).toMatchObject({ id: 'tm_1', role: 'owner' })
    expect(s.channels.map(x => [x.name, x.scope])).toEqual(
      expect.arrayContaining([
        ['本机频道', 'local'],
        ['更新日志', 'team'],
      ]),
    )
    expect(s.channels.find(x => x.id === local)?.teamId).toBeUndefined()
    expect(s.channels.find(x => x.scope === 'team')?.teamId).toBe('tm_1')
    // 本机自己仍是 you；团队里自己是 owner key，也带 you
    expect(s.self).toMatchObject({ id: SELF_ID, you: true })
    expect(s.members.find(m => m.id === 'u:1')).toMatchObject({ you: true, userId: 'u:1', kind: 'human' })
  })

  it('本机频道的读写不受团队影响（同步返回）', async () => {
    const { c, online } = await open()
    await online()
    const id = await c.create({ name: '本机' })
    const page = c.page(id)
    expect(page).not.toBeInstanceOf(Promise)
    await c.post(id, { text: '你好', clientId: 'a' })
    expect(c.page(id)).toMatchObject({ messages: [{ kind: 'message', text: '你好' }] })
  })
})

describe('协作频道 Phase C：团队频道分流', () => {
  it('发消息走云端（@ 解析按团队成员名），发了就算看过', async () => {
    const { c, cloud, online } = await open()
    await online()
    const { message, tasks } = await c.post('tc_1', { text: '@周宁 在吗', clientId: 'c1' })
    expect(tasks).toEqual([])
    expect(message).toMatchObject({ kind: 'message', text: '@周宁 在吗', mentions: ['u:2'] })
    const post = cloud.calls.find(x => x.method === 'POST' && x.path.endsWith('/messages'))!
    expect(post.body).toEqual({ client_id: 'c1', text: '@周宁 在吗', mentions: ['u:2'] })
    // 同一个 clientId 重复提交：云端返回同一条
    const again = await c.post('tc_1', { text: '@周宁 在吗', clientId: 'c1' })
    expect(again.message.id).toBe(message.id)
    const page = await c.page('tc_1')
    expect(page.messages.filter(m => m.kind === 'message')).toHaveLength(1)
    expect(pushes().some(m => m.id === message.id)).toBe(true)
  })
  it('观察者：@ AI 成员只当文字，不带 mentions', async () => {
    const { c, cloud, online } = await open()
    cloud.role = 'observer'
    cloud.addAgent('u:2', 'm-9', { policy: 'team' })
    await online()
    const { message } = await c.post('tc_1', { text: '@审查员 @周宁 看下', clientId: 'o1' })
    expect(message.mentions).toEqual(['u:2'])
    await expect(c.create({ name: '新频道', teamId: 'tm_1' })).rejects.toThrow('观察者')
    await expect(c.addMember('tc_1', 'x')).rejects.toThrow()
  })

  it('@全体：发给云端的 mentions 是本频道所有 AI 成员（含别人的），不含真人；观察者不带', async () => {
    const { c, cloud, online } = await open()
    const mine = cloud.addAgent('u:1', 'm-1', { policy: 'team' })
    const theirs = cloud.addAgent('u:2', 'm-9', { policy: 'team' })
    cloud.addAgent('u:2', 'm-8', { name: '别的频道' }, 'tc_2')
    await online()
    const { message } = await c.post('tc_1', { text: '@全体 看下', clientId: 'all1' })
    expect(message.mentions).toEqual([mine.id, theirs.id])
    const post = cloud.calls.filter(x => x.method === 'POST' && x.path.endsWith('/messages')).at(-1)!
    expect(post.body).toMatchObject({ text: '@全体 看下', mentions: [mine.id, theirs.id] })
    // 云端的任务卡标题会留着 @全体：显示时去掉
    cloud.userPost('u:2', 'tc_1', '@全体 ，再看下登录页', [mine.id as string, theirs.id as string])
    const page = await c.page('tc_1')
    const titles = page.messages.flatMap(m => (m.kind === 'task' ? [m.title] : []))
    expect(titles.at(-1)).toBe('再看下登录页')
  })

  it('@全体：观察者发的不带 AI 成员', async () => {
    const { c, cloud, online } = await open()
    cloud.role = 'observer'
    cloud.addAgent('u:2', 'm-9', { policy: 'team' })
    cloud.addAgent('u:1', 'm-1', { policy: 'team' })
    await online()
    const { message } = await c.post('tc_1', { text: '@all 看下', clientId: 'all2' })
    expect(message.mentions ?? []).toEqual([])
  })

  it('未读、已读：markRead 走云端', async () => {
    const { c, cloud, online } = await open()
    await online()
    cloud.userPost('u:2', 'tc_1', '@林夏 看看', ['u:1'])
    expect(c.state().channels.find(x => x.id === 'tc_1')).toMatchObject({ unread: 1, mentioned: true })
    expect(pushes().at(-1)).toMatchObject({ kind: 'message', mentions: ['u:1'], authorId: 'u:2' })
    c.markRead('tc_1')
    expect(c.state().channels.find(x => x.id === 'tc_1')).toMatchObject({ unread: 0, mentioned: false })
    await until(() => cloud.calls.some(x => x.path.endsWith('/read')))
  })

  it('建团队频道、改名、删除；建团队 / 邀请等走 /v1/teams', async () => {
    const { c, cloud, online } = await open()
    await online()
    const member = await c.saveMember(null, agent('前端助手'))
    const id = await c.create({ name: '设计评审', topic: '每周三', teamId: 'tm_1', memberIds: [member] })
    expect(cloud.channels.some(x => x.id === id && x.name === '设计评审' && x.topic === '每周三')).toBe(true)
    expect(cloud.agents.map(a => a.local_id)).toContain(member)
    await c.update(id, { name: '设计评审会', topic: null })
    expect(cloud.channels.find(x => x.id === id)).toMatchObject({ name: '设计评审会', topic: null })
    await c.delete(id)
    expect(cloud.channels.some(x => x.id === id)).toBe(false)
    await c.createTeam('新团队')
    await c.invite('tm_1', 'Wang@Example.com', 'observer')
    await c.respondInvite('iv_1', true)
    await c.setRole('tm_1', 'u:2', 'observer')
    await c.removeTeamMember('tm_1', 'u:2')
    await c.renameSelf('tm_1', '小林')
    const calls = cloud.calls.filter(x => x.method !== 'GET').map(x => `${x.method} ${x.path}`)
    expect(calls).toEqual(
      expect.arrayContaining([
        'POST /v1/teams',
        'POST /v1/teams/tm_1/invites',
        'POST /v1/invites/iv_1/accept',
        'PATCH /v1/teams/tm_1/members/u%3A2',
        'DELETE /v1/teams/tm_1/members/u%3A2',
        'PATCH /v1/teams/tm_1/me',
      ]),
    )
    expect(cloud.calls.find(x => x.path === '/v1/teams/tm_1/invites')?.body).toEqual({
      email: 'wang@example.com',
      role: 'observer',
    })
    await expect(c.invite('tm_1', '不是邮箱', 'member')).rejects.toThrow('邮箱')
  })

  it('加 AI 成员 = 登记自己的成员（默认「要我同意」），改派活规则，移出', async () => {
    const { c, cloud, sync, online } = await open()
    await online()
    const member = await c.saveMember(null, agent('前端助手'))
    await c.addMember('tc_1', member)
    const put = cloud.calls.find(x => x.method === 'PUT')!
    expect(put.path).toBe(`/v1/teams/tm_1/channels/tc_1/agents/${member}`)
    expect(put.body).toEqual({
      name: '前端助手',
      engine: 'claude',
      model: 'sonnet',
      machine: '林夏的电脑',
      project: 'pixel-web',
      policy: 'approve',
      // 由这台电脑接（docs/multica-learn.md §11.7）：同一账号的另一台桌面不去认领
      executor: 'dev-A',
    })
    const view = c.state().members.find(m => m.kind === 'agent' && m.teamAgentId) as AgentMember
    expect(view).toMatchObject({ mine: true, policy: 'approve', ownerId: 'u:1', status: 'idle' })
    expect(view.config?.id).toBe(member)
    expect(sync.agentById(view.id)?.executor).toBe('dev-A')
    // 再加一次不重复登记（也不把规则改回去）
    await c.setAgentPolicy('tc_1', view.id, 'team')
    expect(cloud.agent(view.id)?.policy).toBe('team')
    expect(cloud.calls.filter(x => x.method === 'PUT').at(-1)?.body).toMatchObject({ executor: 'dev-A' })
    // 已经绑了执行机的：改派活规则不带 executor（不把绑定改回这台）
    cloud.agent(view.id)!.executor = 'rn_1'
    await sync.reload('plain')
    await c.setAgentPolicy('tc_1', view.id, 'approve')
    expect(cloud.calls.filter(x => x.method === 'PUT').at(-1)?.body).not.toHaveProperty('executor')
    expect(cloud.agent(view.id)).toMatchObject({ policy: 'approve', executor: 'rn_1' })
    await c.setAgentPolicy('tc_1', view.id, 'team')
    await c.addMember('tc_1', member)
    expect(cloud.agents).toHaveLength(1)
    expect(cloud.agent(view.id)?.policy).toBe('team')
    await expect(c.setAgentPolicy('tc_1', 'ta_999', 'team')).rejects.toThrow('自己的')
    await c.removeMember('tc_1', view.id)
    expect(cloud.agents).toHaveLength(0)
    expect(sync.agentById(view.id)).toBeUndefined()
  })

  it('删除本机 AI 成员时一并撤下团队频道里的登记', async () => {
    const { c, cloud, online } = await open()
    await online()
    const member = await c.saveMember(null, agent('前端助手'))
    await c.addMember('tc_1', member)
    await c.deleteMember(member)
    expect(cloud.agents).toHaveLength(0)
  })
})

describe('协作频道 Phase C：执行端复用 Phase B', () => {
  async function ready(policy: 'approve' | 'team') {
    const t = await open()
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const view = t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).teamAgentId) as AgentMember
    if (policy === 'team') await t.c.setAgentPolicy('tc_1', view.id, 'team')
    return { ...t, member, agentId: view.id }
  }

  it('别人 @ 我的成员（团队成员可直接派活）：认领 → 开会话 → 进度 → 结果发回频道 → 卡片完成', async () => {
    const { c, cloud, agentId } = await ready('team')
    const { tasks } = cloud.userPost('u:2', 'tc_1', '@前端助手 把设置页迁到新表单', [agentId])
    const id = tasks[0].id as string
    await until(() => sent.length === 1)
    expect(cloud.task(id)).toMatchObject({ claimed_by: 'dev-A' })
    expect(sent[0].clientMessageId).toBe(`ch-${id}-1`)
    expect(sent[0].text).toContain('周宁')
    expect(sent[0].text).toContain('把设置页迁到新表单')
    expect(sent[0].text).toContain('只改前端')
    // 会话标题、侧栏「# 频道名」
    expect(c.state().sessionChannels).toEqual({ s1: '更新日志' })
    // 引擎开始做 → 云端卡片 running；主人这边的卡片带会话
    c.hostEvent(
      ev('s1', {
        type: 'item_completed',
        item: { kind: 'user', id: sent[0].clientMessageId, text: '', createdAt: 0, turnId: 'k' },
      }),
    )
    await until(() => cloud.task(id).status === 'running')
    const page = await c.page('tc_1')
    expect(page.messages.find(m => m.id === id)).toMatchObject({ status: 'running', sessionId: 's1', ownerId: 'u:1' })
    // 做完
    c.hostEvent(
      ev('s1', {
        type: 'item_completed',
        item: {
          kind: 'assistant',
          id: 'a',
          text: '迁完了。\n\n改了 3 个文件。\n\n需要你决定：是否合并旧表单',
          status: 'completed',
        },
      }),
    )
    c.hostEvent(ev('s1', { type: 'turn_completed', turnId: 'k', outcome: 'completed', error: null }))
    await until(() => cloud.task(id).status === 'done')
    expect(cloud.task(id)).toMatchObject({ summary: '迁完了。', decision: '是否合并旧表单', error: null })
    const result = cloud.messages.get('tc_1')!.find(m => m.author === agentId && m.task_id === id)!
    expect(result.text).toContain('迁完了')
    expect(result.mentions).toEqual(['u:2'])
    // 结果和卡片更新都推给了界面
    expect(pushes().some(m => m.kind === 'message' && m.authorId === agentId && m.taskId === id)).toBe(true)
    expect(
      pushes()
        .filter(m => m.id === id)
        .map(m => (m as ChannelTask).status),
    ).toContain('done')
  })

  it('要我同意：卡片停在 approval，同意后才开工；拒绝则已停止', async () => {
    const { c, cloud, agentId } = await ready('approve')
    const a = cloud.userPost('u:2', 'tc_1', '@前端助手 重构 A', [agentId]).tasks[0].id as string
    const b = cloud.userPost('u:2', 'tc_1', '@前端助手 重构 B', [agentId]).tasks[0].id as string
    await new Promise(r => setTimeout(r, 60))
    expect(sent).toHaveLength(0)
    expect(pushes().find(m => m.id === a)).toMatchObject({ status: 'approval', ownerId: 'u:1', assigneeId: agentId })
    await c.approveTask(b, false)
    expect(cloud.task(b)).toMatchObject({ status: 'stopped', note: 'rejected' })
    await c.approveTask(a, true)
    await until(() => sent.length === 1)
    expect(sent[0].clientMessageId).toBe(`ch-${a}-1`)
    expect(cloud.task(a).claimed_by).toBe('dev-A')
  })

  it('同一个成员的活排队：前面做完才做下一项', async () => {
    const { c, cloud, agentId } = await ready('team')
    const a = cloud.userPost('u:2', 'tc_1', '@前端助手 第一件', [agentId]).tasks[0].id as string
    const b = cloud.userPost('u:2', 'tc_1', '@前端助手 第二件', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    await new Promise(r => setTimeout(r, 60))
    expect(sent).toHaveLength(1)
    complete(c, 's1', sent[0].clientMessageId, '第一件做完了')
    await until(() => sent.length === 2)
    expect(sent[1].clientMessageId).toBe(`ch-${b}-1`)
    await until(() => cloud.task(a).status === 'done')
  })

  it('别人点「取消」排队中的活：本机取消并清掉请求；成员状态上报云端', async () => {
    const { c, cloud, agentId } = await ready('team')
    const a = cloud.userPost('u:2', 'tc_1', '@前端助手 第一件', [agentId]).tasks[0].id as string
    const b = cloud.userPost('u:2', 'tc_1', '@前端助手 第二件', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    await until(() => cloud.agent(agentId)?.status === 'running')
    expect(cloud.agent(agentId)?.task).toBe('第一件')
    await c.page('tc_1')
    await c.taskAction(b, 'cancel')
    expect(cloud.calls.some(x => x.path === `/v1/teams/tm_1/tasks/${b}/action`)).toBe(true)
    await until(() => cloud.task(b).status === 'stopped')
    expect(cloud.task(b)).toMatchObject({ note: 'cancelled', pending_action: null })
    complete(c, 's1', sent[0].clientMessageId, '好了')
    await until(() => cloud.task(a).status === 'done')
    await until(() => cloud.agent(agentId)?.status === 'idle')
  })

  it('做的时候别人追加要求：做完接着发下一轮', async () => {
    const { c, cloud, store, agentId } = await ready('team')
    const a = cloud.userPost('u:2', 'tc_1', '@前端助手 第一件', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    c.hostEvent(
      ev('s1', {
        type: 'item_completed',
        item: { kind: 'user', id: sent[0].clientMessageId, text: '', createdAt: 0, turnId: 'k' },
      }),
    )
    await until(() => cloud.task(a).status === 'running')
    cloud.userPost('u:3', 'tc_1', '再加个测试', [], a)
    // 观察者追加要求不算：云端不改卡片
    expect(cloud.task(a).round).toBe(1)
    cloud.userPost('u:2', 'tc_1', '顺便加个测试', [], a)
    await until(() => cloud.task(a).round === 2)
    // 执行端认领、取到追加的那条消息后才攒进本机运行记录；等它攒好再让这一轮结束（全量跑时机器忙，40ms 不一定够）
    await until(() => store.runs.get(a)?.followUps.length === 1)
    // 还在做：云端卡片被写回「进行中」
    await until(() => cloud.task(a).status === 'running')
    c.hostEvent(
      ev('s1', {
        type: 'item_completed',
        item: { kind: 'assistant', id: 'a1', text: '第一轮做完', status: 'completed' },
      }),
    )
    c.hostEvent(ev('s1', { type: 'turn_completed', turnId: 'k', outcome: 'completed', error: null }))
    await until(() => sent.length === 2)
    expect(sent[1].clientMessageId).toBe(`ch-${a}-2`)
    expect(sent[1].text).toContain('顺便加个测试')
    expect(sent[1].sessionId).toBe('s1')
    await until(() => cloud.task(a).round === 2 && cloud.task(a).status !== 'done')
  })

  it('重启后：运行信息还在，按会话快照对账并写回云端', async () => {
    const first = await ready('team')
    const a = first.cloud.userPost('u:2', 'tc_1', '@前端助手 第一件', [first.agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    first.c.hostEvent(
      ev('s1', {
        type: 'item_completed',
        item: { kind: 'user', id: sent[0].clientMessageId, text: '', createdAt: 0, turnId: 'k' },
      }),
    )
    await until(() => first.cloud.task(a).status === 'running')
    await first.c.dispose()
    // 重启：同一个本机目录、同一个云端
    const store = new ChannelStore(dir)
    await store.init()
    expect(store.runs.get(a)?.team).toMatchObject({ teamId: 'tm_1', messageId: a })
    expect(store.runs.get(a)?.phase).toBe('sent')
  })
})

describe('派活规则四档、开工前核对、运行凭证（docs/multica-learn.md §11.3）', () => {
  async function ready() {
    const t = await open()
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const view = t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).teamAgentId) as AgentMember
    await t.c.setAgentPolicy('tc_1', view.id, 'team')
    return { ...t, agentId: view.id }
  }

  it('指定的人直接派：名单存到云端，名单里的人派的直接开工', async () => {
    const { c, cloud, agentId } = await ready()
    await c.setAgentPolicy('tc_1', agentId, 'listed', ['u:2'])
    expect(cloud.agent(agentId)).toMatchObject({ policy: 'listed', allow: ['u:2'] })
    expect(c.state().members.find(m => m.id === agentId)).toMatchObject({ policy: 'listed', allow: ['u:2'] })
    cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId])
    await until(() => sent.length === 1)
    // 只有我：别人 @ 只当文字
    await c.setAgentPolicy('tc_1', agentId, 'owner')
    expect(cloud.userPost('u:2', 'tc_1', '@前端助手 再改', [agentId]).tasks).toHaveLength(0)
  })

  it('核对通过：开工前拿凭证，结果和写回都走凭证接口', async () => {
    const { c, cloud, agentId } = await ready()
    const id = cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    const start = cloud.calls.find(x => x.path === `/v1/teams/tm_1/tasks/${id}/start`)
    expect(start?.body).toEqual({ device: 'dev-A' })
    const token = cloud.runTokens.get(id)!
    expect(token).toMatch(/^rt_/)
    complete(c, 's1', sent[0].clientMessageId, '改好了。')
    await until(() => cloud.task(id).status === 'done')
    const viaRun = cloud.calls.filter(x => x.runToken === token).map(x => `${x.method} ${x.path}`)
    expect(viaRun).toEqual(
      expect.arrayContaining([`POST /v1/teams/tm_1/runs/${id}/result`, `PATCH /v1/teams/tm_1/runs/${id}`]),
    )
    expect(cloud.calls.some(x => x.method === 'PATCH' && x.path === `/v1/teams/tm_1/tasks/${id}`)).toBe(false)
    expect(cloud.messages.get('tc_1')!.find(m => m.author === agentId && m.task_id === id)?.text).toContain('改好了')
  })

  it('核对不通过（主人改成要同意）：不开工、本机不留运行信息；同意后重新认领开工', async () => {
    const { c, cloud, store, agentId } = await ready()
    cloud.startOutcome = 'approval'
    const id = cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => cloud.task(id).status === 'approval')
    await new Promise(r => setTimeout(r, 30))
    expect(sent).toHaveLength(0)
    expect(store.runs.has(id)).toBe(false)
    expect(sessions).toHaveLength(0)
    cloud.startOutcome = 'ok'
    await c.approveTask(id, true)
    await until(() => sent.length === 1)
    expect(sent[0].clientMessageId).toBe(`ch-${id}-1`)
  })

  it('旧云端没有核对接口：照常开工，写回走登录令牌', async () => {
    const { c, cloud, agentId } = await ready()
    cloud.startOutcome = null
    const id = cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    complete(c, 's1', sent[0].clientMessageId, '改好了。')
    await until(() => cloud.task(id).status === 'done')
    expect(cloud.calls.some(x => x.runToken)).toBe(false)
  })

  it('失败后重试：卡先回到排队再核对，核对通过开下一轮（不会被「状态不对」拦下）', async () => {
    const { c, cloud, agentId } = await ready()
    const id = cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    const turn = 'turn-x'
    c.hostEvent(
      ev('s1', {
        type: 'item_completed',
        item: { kind: 'user', id: sent[0].clientMessageId, text: '', createdAt: 0, turnId: turn },
      }),
    )
    c.hostEvent(ev('s1', { type: 'turn_completed', turnId: turn, outcome: 'failed', error: '额度不足' }))
    // 宿主每轮结束都紧跟一个队列事件；不在队列里（没有自动重连）才算失败
    c.hostEvent(ev('s1', { type: 'queue', items: [], paused: true }))
    await until(() => cloud.task(id).status === 'failed')
    await c.taskAction(id, 'retry')
    await until(() => sent.length === 2)
    expect(sent[1].clientMessageId).toBe(`ch-${id}-2`)
    await until(() => cloud.task(id).pending_action === null)
    expect(cloud.runTokens.get(id)).toMatch(/^rt_/)
  })

  it('凭证被拒（过期、云端换了）：退回登录令牌，收尾照样写回', async () => {
    const { c, cloud, agentId } = await ready()
    const id = cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    cloud.runTokens.clear()
    complete(c, 's1', sent[0].clientMessageId, '改好了。')
    await until(() => cloud.task(id).status === 'done')
    expect(cloud.calls.some(x => x.method === 'PATCH' && x.path === `/v1/teams/tm_1/tasks/${id}`)).toBe(true)
    expect(cloud.messages.get('tc_1')!.some(m => m.author === agentId && m.task_id === id)).toBe(true)
  })
})

describe('队友派来的活的限制（docs/multica-learn.md §8、§11.4）', () => {
  const madeCopies: { projectId: string; name: string; branch: string }[] = []
  async function ready(patch: Partial<AgentInput> = {}) {
    madeCopies.length = 0
    const t = await open({
      defaultMode: () => 'full',
      copies: {
        create: async (projectId, input) => {
          madeCopies.push({ projectId, name: input.name, branch: input.branch })
          return { id: `cp-${madeCopies.length}`, branch: input.branch, path: `D:/copies/${input.name}` }
        },
        remove: async () => {},
        dirty: async () => false,
      },
    })
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手', patch))
    await t.c.addMember('tc_1', member)
    const view = t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).teamAgentId) as AgentMember
    await t.c.setAgentPolicy('tc_1', view.id, 'team')
    return { ...t, agentId: view.id }
  }

  it('默认：新开会话、权限降到自动改文件、独立副本、不带我的 MCP；主人的卡上写明', async () => {
    const { c, cloud, store, agentId } = await ready({ mode: 'shared' })
    const id = cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    expect(created[0]).toMatchObject({ permissionMode: 'edits', copyId: 'cp-1' })
    expect(madeCopies[0].branch).toMatch(/^pixelsky\/team-/)
    // 共用会话的成员也不记成共用会话
    expect(store.members[0].sharedSessionId ?? null).toBeNull()
    expect(store.runs.get(id)?.guard).toMatchObject({ capped: 'full', isolate: true, copy: { id: 'cp-1' } })
    expect(c.sessionMember('s1')).toMatchObject({ isolated: true, tools: { mode: 'only', ids: [] } })
    const page = await c.page('tc_1')
    expect(page.messages.find(m => m.id === id)).toMatchObject({
      guard: { capped: 'full', copy: madeCopies[0].branch },
    })
  })

  it('队友在我派的卡上追加要求：不接着用我那个没限制的会话，按限制新开', async () => {
    const { cloud, store, agentId } = await ready()
    const card = cloud.userPost('u:1', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    expect(created[0].permissionMode).toBeUndefined()
    complete(opened[0], 's1', sent[0].clientMessageId, '改好了。')
    await until(() => cloud.task(card).status === 'done')
    cloud.userPost('u:2', 'tc_1', '顺便把颜色也改了', [], card)
    await until(() => sent.length === 2)
    expect(sent[1].sessionId).toBe('s2')
    expect(created[1]).toMatchObject({ permissionMode: 'edits', copyId: 'cp-1' })
    expect(store.runs.get(card)?.guard).toMatchObject({ capped: 'full', isolate: true })
  })

  it('我自己派的活不受限制', async () => {
    const { c, cloud, store, agentId } = await ready()
    const id = cloud.userPost('u:1', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    expect(created[0].permissionMode).toBeUndefined()
    expect(created[0].copyId).toBeUndefined()
    expect(madeCopies).toHaveLength(0)
    expect(store.runs.get(id)?.guard).toBeUndefined()
    expect(c.sessionMember('s1')?.isolated).toBeUndefined()
  })

  it('不在允许的项目里：不开工，卡片失败、原因是这个项目不接', async () => {
    const { c, cloud, agentId } = await ready()
    await c.setTeammate({ projects: ['p2'], copy: true, isolateMcp: true })
    expect(c.state().teammate).toEqual({ projects: ['p2'], copy: true, isolateMcp: true })
    const id = cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => cloud.task(id).status === 'failed')
    expect(sent).toHaveLength(0)
    expect(sessions).toHaveLength(0)
    expect(cloud.task(id).reason).toBe('project_blocked')
  })

  it('关掉副本和隔离、成员本来就要问：照原样开，不降级', async () => {
    const { c, cloud, store, agentId } = await ready({ settings: { model: 'sonnet', permissionMode: 'ask' } })
    await c.setTeammate({ projects: null, copy: false, isolateMcp: false })
    const id = cloud.userPost('u:2', 'tc_1', '@前端助手 改按钮', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    expect(created[0]).toMatchObject({ permissionMode: 'ask' })
    expect(madeCopies).toHaveLength(0)
    expect(store.runs.get(id)?.guard ?? {}).toEqual({})
    expect(c.sessionMember('s1')?.isolated).toBeUndefined()
  })

  it('设置存盘，重开还在；不认识的字段丢掉', async () => {
    const { c } = await ready()
    await c.setTeammate({ projects: ['p1', 'p1', 3], copy: false, extra: 1 })
    const again = new ChannelStore(dir)
    await again.init()
    expect(again.teammate).toEqual({ projects: ['p1'], copy: false, isolateMcp: true })
  })
})

describe('收件箱（docs/multica-learn.md §11.5）', () => {
  const row = (key: string, patch: Record<string, unknown> = {}) => ({
    team_id: 'tm_1',
    key,
    channel_id: 'tc_1',
    kind: 'mention',
    actor: 'u:2',
    text: '@林夏 看下',
    count: 1,
    at: '2026-11-18T08:00:00Z',
    read: false,
    archived: false,
    snooze_until: null,
    muted: false,
    ...patch,
  })

  it('连上时拉一次；帧来了换那一行，归档的拿掉；改一行走云端', async () => {
    const t = await open()
    t.cloud.inbox = [row('tg_1'), row('tg_2', { kind: 'nope' })]
    await t.online()
    await until(() => t.c.state().inboxSupported === true)
    expect(t.c.state().inbox).toEqual([
      expect.objectContaining({ teamId: 'tm_1', key: 'tg_1', kind: 'mention', at: Date.parse('2026-11-18T08:00:00Z') }),
    ])
    t.cloud.push({
      type: 'inbox',
      team: 'tm_1',
      item: { ...t.c.state().inbox![0], key: 'tg_3', kind: 'failed', at: Date.parse('2026-11-18T09:00:00Z') },
    })
    expect(t.c.state().inbox!.map(i => i.key)).toEqual(['tg_3', 'tg_1'])
    t.cloud.push({ type: 'inbox', team: 'tm_1', item: { ...t.c.state().inbox![0], archived: true } })
    expect(t.c.state().inbox!.map(i => i.key)).toEqual(['tg_1'])
    const at = Date.parse('2026-11-19T01:00:00Z')
    await t.c.patchInbox('tm_1', 'tg_1', { read: true, snoozeUntil: at })
    const call = t.cloud.calls.find(x => x.method === 'PATCH' && x.path === '/v1/teams/tm_1/inbox/tg_1')
    expect(call?.body).toEqual({ read: true, snooze_until: new Date(at).toISOString() })
    expect(t.c.state().inbox![0]).toMatchObject({ read: true, snoozeUntil: at })
    await t.c.patchInbox('tm_1', 'tg_1', { muted: true })
    expect(t.c.state().inbox).toEqual([])
  })

  it('拉取期间推来的行不会被较早发出的那次请求盖掉', async () => {
    const t = await open()
    t.cloud.inbox = [row('tg_1')]
    let release!: () => void
    t.cloud.inboxGate = new Promise(r => (release = r))
    await t.online()
    await until(() => t.cloud.calls.some(x => x.path === '/v1/inbox'))
    // 请求在路上时：tg_1 被另一台电脑标了已读，tg_2 新来
    const base = {
      teamId: 'tm_1',
      channelId: 'tc_1',
      actor: 'u:2',
      text: 'x',
      count: 1,
      archived: false,
      snoozeUntil: null,
      muted: false,
    }
    t.cloud.push({ type: 'inbox', team: 'tm_1', item: { ...base, key: 'tg_1', kind: 'mention', at: 1, read: true } })
    t.cloud.push({ type: 'inbox', team: 'tm_1', item: { ...base, key: 'tg_2', kind: 'failed', at: 2, read: false } })
    release()
    // 等那次较早的请求回来、写进去之后再看
    await new Promise(r => setTimeout(r, 30))
    expect(
      t.c
        .state()
        .inbox!.map(i => i.key)
        .sort(),
    ).toEqual(['tg_1', 'tg_2'])
    expect(t.c.state().inbox!.find(i => i.key === 'tg_1')?.read).toBe(true)
  })

  it('旧云端没有收件箱：inboxSupported 为 false', async () => {
    const t = await open()
    t.cloud.inbox = null
    await t.online()
    await until(() => t.c.state().teamsConnection === 'online')
    expect(t.c.state()).toMatchObject({ inbox: [], inboxSupported: false })
  })
})

describe('事项唤醒：团队卡（docs/multica-learn.md §11.6 团队部分）', () => {
  const DAY = 86_400_000
  const rulesOf = (c: Channels) => c.state().channels.find(x => x.id === 'tc_1')?.wakeups ?? []

  it('挂、取消、主人同意都转给云端；规则进频道快照，等同意的带主人，云端的结束原因换成中文', async () => {
    const t = await open()
    const theirs = t.cloud.addAgent('u:2', 'm-9', { policy: 'approve' })
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const mine = (t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).mine) as AgentMember).id
    const card = t.cloud.userPost('u:1', 'tc_1', '@审查员 看看最近的改动', [theirs.id as string]).tasks[0].id as string
    const page = await t.c.page('tc_1')
    expect(page.messages.find(m => m.id === card)).toMatchObject({ teamWakeups: true })
    // 别人「要我同意」的成员：挂上是等同意
    const end = now + 3 * DAY
    const { id } = await t.c.wakeup('tc_1', {
      op: 'add',
      on: card,
      memberId: theirs.id as string,
      when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
      text: '每天看一眼 CI',
      until: end,
    })
    const add = t.cloud.calls.find(x => x.method === 'POST' && x.path === `/v1/teams/tm_1/tasks/${card}/wakeups`)
    expect(add?.body).toMatchObject({
      member: theirs.id,
      text: '每天看一眼 CI',
      when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
      until: new Date(end).toISOString(),
    })
    expect(typeof (add?.body?.when as { tz?: unknown }).tz).toBe('string')
    expect(rulesOf(t.c)).toEqual([
      expect.objectContaining({ id, on: card, memberId: theirs.id, by: 'u:1', owner: 'u:2', state: 'pending' }),
    ])
    // 挂的人取消
    await t.c.wakeup('tc_1', { op: 'cancel', id: id! })
    expect(
      t.cloud.calls.some(x => x.method === 'DELETE' && x.path === `/v1/teams/tm_1/tasks/${card}/wakeups/${id}`),
    ).toBe(true)
    expect(rulesOf(t.c).find(w => w.id === id)?.state).toBe('cancelled')
    // 周宁挂在我的成员上、等我同意的：同意走云端
    const asked = t.cloud.putWakeup(card, { member: mine, owner: 'u:1', by: 'u:2', state: 'pending' })
    await until(() => rulesOf(t.c).some(w => w.id === asked.id))
    await t.c.wakeup('tc_1', { op: 'approve', id: asked.id as string, approve: true })
    const approve = t.cloud.calls.find(x => x.path === `/v1/teams/tm_1/tasks/${card}/wakeups/${asked.id}/approve`)
    expect(approve?.body).toEqual({ approve: true })
    expect(rulesOf(t.c).find(w => w.id === asked.id)).toMatchObject({ state: 'active', owner: 'u:1', by: 'u:2' })
    // 云端自己结束的：原因代码换成卡上那句话
    const gone = t.cloud.putWakeup(card, { member: mine, state: 'cancelled', end_note: 'creator_left', next: null })
    await until(() => rulesOf(t.c).some(w => w.id === gone.id))
    expect(rulesOf(t.c).find(w => w.id === gone.id)?.endNote).toBe('挂这条唤醒的人离开了团队')
    // 团队卡只能按时间叫；找不到的规则不发请求
    await expect(
      t.c.wakeup('tc_1', { op: 'add', on: card, memberId: mine, when: { kind: 'ended' }, text: '审查一遍' }),
    ).rejects.toThrow('只能按时间叫')
    await expect(t.c.wakeup('tc_1', { op: 'cancel', id: 'tw_nope' })).rejects.toThrow('不存在')
  })

  it('手机收件箱点「同意 / 拒绝」（key 是卡 id）：卡本身不在等我同意时，处理的是卡上等我同意的唤醒', async () => {
    const t = await open()
    const theirs = t.cloud.addAgent('u:2', 'm-9', { policy: 'team' })
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const mine = (t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).mine) as AgentMember).id
    const card = t.cloud.userPost('u:1', 'tc_1', '@审查员 看看', [theirs.id as string]).tasks[0].id as string
    await t.c.page('tc_1')
    const asked = t.cloud.putWakeup(card, { member: mine, owner: 'u:1', by: 'u:2', state: 'pending' })
    await until(() => rulesOf(t.c).some(w => w.id === asked.id))
    await t.c.approveTask(card, false)
    const call = t.cloud.calls.find(x => x.path === `/v1/teams/tm_1/tasks/${card}/wakeups/${asked.id}/approve`)
    expect(call?.body).toEqual({ approve: false })
    expect(t.cloud.calls.some(x => x.path === `/v1/teams/tm_1/tasks/${card}/approve`)).toBe(false)
    expect(t.cloud.task(card).status).toBe('queued')
    expect(rulesOf(t.c).find(w => w.id === asked.id)?.state).toBe('cancelled')
  })

  it('旧云端（卡上没有 wakeups 字段）：卡上没有入口标记，挂唤醒直接报错、不发请求', async () => {
    const t = await open()
    t.cloud.wakeups = false
    const theirs = t.cloud.addAgent('u:2', 'm-9', { policy: 'team' })
    await t.online()
    const card = t.cloud.userPost('u:1', 'tc_1', '@审查员 看看', [theirs.id as string]).tasks[0].id as string
    const page = await t.c.page('tc_1')
    expect(page.messages.find(m => m.id === card)).not.toHaveProperty('teamWakeups')
    await expect(
      t.c.wakeup('tc_1', {
        op: 'add',
        on: card,
        memberId: theirs.id as string,
        when: { kind: 'at', at: now + 3_600_000 },
        text: '看看 CI',
      }),
    ).rejects.toThrow('还不支持唤醒')
    expect(t.cloud.calls.some(x => x.path.includes('/wakeups'))).toBe(false)
    expect(rulesOf(t.c)).toEqual([])
  })

  it('云端叫起来的唤醒轮：带唤醒要求；回 [silent] 不发结果、不覆盖摘要；有人追加要求后不再算唤醒轮', async () => {
    const t = await open()
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const agentId = (t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).teamAgentId) as AgentMember)
      .id
    await t.c.setAgentPolicy('tc_1', agentId, 'team')
    // 被盯的卡：周宁派的，做完了
    const a = t.cloud.userPost('u:2', 'tc_1', '@前端助手 改登录页', [agentId]).tasks[0].id as string
    await until(() => sent.length === 1)
    complete(t.c, 's1', sent[0].clientMessageId, '改好了')
    await until(() => t.cloud.task(a).status === 'done')
    // 周宁挂的定期检查，到点了（云端先发一条 @ 成员的消息，派一张带 wake 的唤醒卡）
    const rule = t.cloud.putWakeup(a, {
      member: agentId,
      owner: 'u:1',
      by: 'u:2',
      when: { kind: 'every', freq: 'hourly', hour: 0, minute: 5, tz: 'Asia/Shanghai' },
      until: '2026-10-20T00:00:00Z',
    })
    const w = t.cloud.fireWakeup(a, rule.id as string).id as string
    await until(() => sent.length === 2)
    expect(sent[1].clientMessageId).toBe(`ch-${w}-1`)
    expect(sent[1].text).toContain('定期检查的时间到了')
    expect(sent[1].text).toContain('看看 CI')
    expect(sent[1].text).toContain('盯着的卡：「改登录页」')
    expect(sent[1].text).toContain('改好了')
    expect(sent[1].text).toContain('[silent]')
    expect(t.store.runs.get(w)?.wakeup).toEqual({ ruleId: rule.id, kind: 'every' })
    // 有结果：照常发
    const results = () => t.cloud.messages.get('tc_1')!.filter(m => m.author === agentId && m.task_id === w)
    complete(t.c, sent[1].sessionId, sent[1].clientMessageId, 'CI 挂了一个用例')
    await until(() => t.cloud.task(w).status === 'done' && results().length === 1)
    expect(t.cloud.task(w).summary).toBe('CI 挂了一个用例')
    // 第二次到点：在唤醒卡上开下一轮；回 [silent] 不发结果、不覆盖摘要
    t.cloud.fireWakeup(a, rule.id as string)
    await until(() => sent.length === 3)
    expect(sent[2].clientMessageId).toBe(`ch-${w}-2`)
    expect(sent[2].text).toContain('定期检查的时间到了')
    expect(sent[2].text).toContain('[silent]')
    expect(t.store.runs.get(w)?.wakeup).toEqual({ ruleId: rule.id, kind: 'every' })
    complete(t.c, sent[2].sessionId, sent[2].clientMessageId, '[silent]')
    await until(() => t.cloud.task(w).status === 'done' && t.cloud.task(w).round === 2)
    await new Promise(r => setTimeout(r, 30))
    expect(results()).toHaveLength(1)
    expect(t.cloud.task(w).summary).toBe('CI 挂了一个用例')
    expect((t.cloud.task(w).runs as unknown[]).length).toBe(2)
    // 主人这边：会话提醒按频道的说法、认得是唤醒轮；卡上这一轮记成「没有要说的」（回 [silent] 的不弹「做完了」）
    expect(t.c.state().sessionTasks?.[sent[2].sessionId]).toEqual({
      channelId: 'tc_1',
      taskId: w,
      memberId: agentId,
      wakeup: true,
    })
    const shown = pushes()
      .filter(m => m.id === w)
      .at(-1) as ChannelTask
    expect(shown.runs?.at(-1)).toMatchObject({ n: 2, wakeup: { ruleId: rule.id, kind: 'every', silent: 1 } })
    // 有人追加要求：云端清掉唤醒标记，这一轮照常（不带 [silent] 那句）
    t.cloud.userPost('u:2', 'tc_1', '再看看日志', [], w)
    await until(() => sent.length === 4)
    expect(sent[3].text).toContain('再看看日志')
    expect(sent[3].text).not.toContain('[silent]')
    expect(t.store.runs.get(w)?.wakeup).toBeUndefined()
    expect(t.c.state().sessionTasks?.[sent[3].sessionId]).toBeUndefined()
  })
})

describe('执行机（docs/multica-learn.md §11.7）', () => {
  it('没人看着：团队活里的权限请求自动拒绝，卡不停在等确认', async () => {
    const t = await open({ unattended: true })
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const view = t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).teamAgentId) as AgentMember
    await t.c.setAgentPolicy('tc_1', view.id, 'team')
    const id = t.cloud.userPost('u:2', 'tc_1', '@前端助手 装依赖', [view.id]).tasks[0].id as string
    await until(() => sent.length === 1)
    t.c.hostEvent(
      ev('s1', {
        type: 'approval_request',
        request: { requestId: 'r1', itemId: null, kind: 'command', title: '运行命令', alwaysScopes: [] },
      }),
    )
    await until(() => answers.length === 1)
    expect(answers[0]).toEqual(['s1', 'r1', { type: 'deny', message: UNATTENDED_DENY }])
    expect(t.store.runs.get(id)?.phase).toBe('sent')
  })

  it('成员改由执行机接：团队频道的登记改「由谁接」，改回这台电脑', async () => {
    const t = await open()
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const reg = () => t.cloud.agents.filter(a => a.local_id === member)
    expect(reg()[0].executor).toBe('dev-A')
    await t.c.bindRunner(member, 'rn_1')
    await until(() => t.c.runnerMembers('rn_1').length === 1)
    expect(reg().map(a => a.executor)).toEqual(['rn_1'])
    // 不能给像素星空引擎的成员绑
    const pixel = await t.c.saveMember(null, agent('写手', { engine: 'pixel' }))
    await expect(t.c.bindRunner(pixel, 'rn_1')).rejects.toThrow('只能跑 Claude Code / Codex')
    await t.c.bindRunner(member, null)
    await until(() => t.c.runnerMembers('rn_1').length === 0)
    expect(reg().map(a => a.executor)).toEqual(['dev-A'])
  })

  it('同时最多跑几件：满了排着，做完一件再开下一件（不同成员也算）', async () => {
    const t = await open({ maxRunning: 1 })
    await t.online()
    const ids: string[] = []
    for (const name of ['前端助手', '后端助手']) {
      const member = await t.c.saveMember(null, agent(name))
      await t.c.addMember('tc_1', member)
      const view = t.c
        .state()
        .members.find(m => m.kind === 'agent' && m.name === name && (m as AgentMember).teamAgentId) as AgentMember
      await t.c.setAgentPolicy('tc_1', view.id, 'team')
      ids.push(view.id)
    }
    t.cloud.userPost('u:2', 'tc_1', '@前端助手 第一件', [ids[0]])
    t.cloud.userPost('u:2', 'tc_1', '@后端助手 第二件', [ids[1]])
    await until(() => sent.length === 1)
    await new Promise(r => setTimeout(r, 60))
    expect(sent).toHaveLength(1)
    complete(t.c, sent[0].sessionId, sent[0].clientMessageId, '做完了')
    await until(() => sent.length === 2)
  })
})

describe('频道和团队融合：共享到团队、改回只有我（docs/ui/channels-unify.md §5.2）', () => {
  /** 建一个带两个 AI 成员的只有我的频道，说一句话 */
  async function localChannel(t: Awaited<ReturnType<typeof open>>) {
    const a = await t.c.saveMember(null, agent('前端助手'))
    const b = await t.c.saveMember(null, agent('审查员'))
    const local = await t.c.create({ name: '网页版改版', topic: '迁移表单', memberIds: [a, b] })
    await t.c.post(local, { text: '只有我看的话', clientId: 'x1' })
    return { a, b, local }
  }
  const texts = (t: Awaited<ReturnType<typeof open>>, id: string): string[] =>
    (t.store.messages.get(id) ?? []).flatMap(m => (m.kind === 'message' ? [m.text] : []))

  it('共享：团队里建同名频道，列出来的 AI 成员按规则登记，以前的消息不上传，原频道归档并记下去向', async () => {
    const t = await open()
    await t.online()
    const { a, b, local } = await localChannel(t)
    const { channelId, failed } = await t.c.share(local, { teamId: 'tm_1', policies: { [a]: 'team' } })
    expect(failed).toEqual([])
    expect(t.cloud.channels.find(x => x.id === channelId)).toMatchObject({ name: '网页版改版', topic: '迁移表单' })
    const regs = t.cloud.agents.filter(x => x.channel_id === channelId)
    expect(regs.map(x => [x.local_id, x.policy, x.name])).toEqual([[a, 'team', '前端助手']])
    expect(regs.some(x => x.local_id === b)).toBe(false)
    expect((t.cloud.messages.get(channelId) ?? []).filter(m => m.kind === 'message')).toEqual([])
    const origin = t.store.channels.get(local)!
    expect(origin.sharedTo).toBe(channelId)
    expect(origin.archivedAt).toBeGreaterThan(0)
    expect(texts(t, local)).toEqual(['只有我看的话'])
  })

  it('共享：还有没做完的活、已经在团队里的频道、不在的团队都不行，云端不建频道', async () => {
    const t = await open()
    await t.online()
    const { a, local } = await localChannel(t)
    await t.c.post(local, { text: '@前端助手 改一下标题', clientId: 'x2' })
    await expect(t.c.share(local, { teamId: 'tm_1', policies: { [a]: 'approve' } })).rejects.toThrow(
      '频道里还有没做完的活，做完或停掉后再共享',
    )
    await expect(t.c.share('tc_1', { teamId: 'tm_1', policies: {} })).rejects.toThrow('这个频道已经在团队里了')
    const idle = await t.c.create({ name: '空的' })
    await expect(t.c.share(idle, { teamId: 'tm_x', policies: {} })).rejects.toThrow('团队不存在')
    expect(t.cloud.channels.map(x => x.id)).toEqual(['tc_1'])
    expect(t.store.channels.get(local)?.archivedAt ?? null).toBeNull()
  })

  it('共享：观察者不能', async () => {
    const t = await open()
    t.cloud.role = 'observer'
    await t.online()
    const idle = await t.c.create({ name: '空的' })
    await expect(t.c.share(idle, { teamId: 'tm_1', policies: {} })).rejects.toThrow('观察者不能建频道')
  })

  it('改回只有我：云端的消息写成记录留在原频道，我的 AI 成员跟着回来，云端的频道删掉', async () => {
    const t = await open()
    await t.online()
    const { a, local } = await localChannel(t)
    const { channelId } = await t.c.share(local, { teamId: 'tm_1', policies: { [a]: 'approve' } })
    await until(() => t.sync.hasChannel(channelId))
    t.cloud.userPost('u:2', channelId, '稿子放好了')
    await t.c.post(channelId, { text: '我看一下', clientId: 'y1' })
    const back = await t.c.unshare(channelId)
    expect(back.channelId).toBe(local)
    expect(t.cloud.channels.some(x => x.id === channelId)).toBe(false)
    const kept = t.store.channels.get(local)!
    expect(kept).toMatchObject({ archivedAt: null, sharedTo: null, unsharedFrom: null })
    expect(kept.memberIds).toContain(a)
    const record = texts(t, local)
    expect(record[0]).toBe('只有我看的话')
    expect(record[1]).toBe('从团队「' + t.c.state().teams[0].name + '」收回的记录：2 条。')
    expect(record[2]).toContain('**周宁**')
    expect(record[2]).toContain('稿子放好了')
    expect(record[2]).toContain('**林夏**')
    // 记录是 Markdown、算我发的，不算未读
    const last = (t.store.messages.get(local) ?? []).at(-1)
    expect(last).toMatchObject({ kind: 'message', authorId: SELF_ID, format: 'markdown' })
    expect(t.c.state().channels.find(x => x.id === local)).toMatchObject({ scope: 'local', unread: 0 })
  })

  it('改回只有我：不是所有者不行；原频道不在了就新建一个不重名的', async () => {
    const t = await open()
    await t.online()
    await t.c.create({ name: '更新日志' })
    t.cloud.userPost('u:2', 'tc_1', '0.9.2 的日志看过了')
    const back = await t.c.unshare('tc_1')
    expect(t.store.channels.get(back.channelId)).toMatchObject({ name: '更新日志 2', memberIds: [SELF_ID] })
    expect(texts(t, back.channelId).join('\n')).toContain('0.9.2 的日志看过了')
    expect(t.cloud.channels).toEqual([])

    const m = await open()
    m.cloud.role = 'member'
    await m.online()
    await expect(m.c.unshare('tc_1')).rejects.toThrow('只有团队所有者能把频道改回只有我')
    expect(m.cloud.channels.map(x => x.id)).toEqual(['tc_1'])
  })

  it('改回只有我：云端没删掉时本机的记录留着，再点一次只删云端、不重复留记录', async () => {
    const t = await open()
    await t.online()
    t.cloud.userPost('u:2', 'tc_1', '第一条')
    t.cloud.failures['DELETE /v1/teams/tm_1/channels'] = 500
    await expect(t.c.unshare('tc_1')).rejects.toThrow()
    const local = [...t.store.channels.values()].find(x => x.unsharedFrom === 'tc_1')!
    expect(local).toBeTruthy()
    const before = texts(t, local.id)
    expect(before.join('\n')).toContain('第一条')
    t.cloud.failures = {}
    const back = await t.c.unshare('tc_1')
    expect(back.channelId).toBe(local.id)
    expect(texts(t, local.id)).toEqual(before)
    expect(t.store.channels.get(local.id)?.unsharedFrom ?? null).toBeNull()
    expect(t.cloud.channels).toEqual([])
  })
})

describe('团队的频道：讨论串、置顶、归档（docs/ui/channels-unify.md §7.1）', () => {
  /** 我的成员登记进团队频道（团队成员可直接派活） */
  async function withAgent() {
    const t = await open()
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const view = t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).teamAgentId) as AgentMember
    await t.c.setAgentPolicy('tc_1', view.id, 'team')
    return { ...t, member, agentId: view.id }
  }
  const channel = (t: { c: Channels }) => t.c.state().channels.find(x => x.id === 'tc_1')!

  it('讨论串：发在串里的消息带着串的根，串里不 @ 只是留言、@ 同一个成员是追加要求', async () => {
    const t = await withAgent()
    const { tasks } = t.cloud.userPost('u:2', 'tc_1', '@前端助手 写更新日志', [t.agentId])
    const card = tasks[0].id as string
    await until(() => sent.length === 1)
    const note = await t.c.post('tc_1', { text: '标题再短一点会更好', threadId: card, clientId: 'th1' })
    expect(note.message.threadId).toBe(card)
    expect(note.tasks).toEqual([])
    expect(t.cloud.task(card).round).toBe(1)
    const follow = await t.c.post('tc_1', { text: '@前端助手 把标题改短', threadId: note.message.id, clientId: 'th2' })
    expect(follow.message.threadId).toBe(card)
    expect(follow.tasks).toEqual([card])
    expect(t.cloud.task(card).round).toBe(2)
    // 界面拿到的一页消息里带着 threadId
    const page = await t.c.page('tc_1')
    expect(page.messages.filter(m => m.kind === 'message' && m.threadId === card)).toHaveLength(2)
  })

  it('置顶：存在云端，频道上带着；派活时作为资料带上', async () => {
    const t = await withAgent()
    const tip = await t.c.post('tc_1', { text: '发版步骤：先打标签再发公告', clientId: 'p1' })
    await t.c.pin('tc_1', tip.message.id, true)
    expect(channel(t).pinned).toEqual([tip.message.id])
    t.cloud.userPost('u:2', 'tc_1', '@前端助手 发个版', [t.agentId])
    await until(() => sent.length === 1)
    expect(sent[0].text).toContain('频道里置顶的资料')
    expect(sent[0].text).toContain('林夏：发版步骤：先打标签再发公告')
    await t.c.pin('tc_1', tip.message.id, false)
    expect(channel(t).pinned).toEqual([])
  })

  it('归档：还有没结束的活不让归档；归档后只读，恢复后又能发', async () => {
    const t = await withAgent()
    const { tasks } = t.cloud.userPost('u:2', 'tc_1', '@前端助手 写更新日志', [t.agentId])
    await until(() => sent.length === 1)
    await expect(t.c.update('tc_1', { archived: true })).rejects.toThrow('频道里还有没结束的活')
    complete(t.c, 's1', sent[0].clientMessageId, '写好了')
    await until(() => t.cloud.task(tasks[0].id as string).status === 'done')
    await t.c.update('tc_1', { archived: true })
    expect(channel(t).archivedAt).toBeGreaterThan(0)
    await expect(t.c.post('tc_1', { text: '还能发吗', clientId: 'a1' })).rejects.toThrow('频道已归档')
    await t.c.update('tc_1', { archived: false })
    expect(channel(t).archivedAt).toBeNull()
    await t.c.post('tc_1', { text: '又能发了', clientId: 'a2' })
    const events = (await t.c.page('tc_1')).messages.flatMap(m => (m.kind === 'event' ? [m.event] : []))
    expect(events.filter(e => e === 'archived' || e === 'restored')).toEqual(['archived', 'restored'])
  })

  it('旧版云端：频道上没有这三样的标记，置顶、归档报「还不支持」，发消息不带串', async () => {
    const t = await open()
    t.cloud.threads = false
    await t.online()
    expect(channel(t).pinned).toBeUndefined()
    const first = await t.c.post('tc_1', { text: '一条', clientId: 'o1' })
    await expect(t.c.pin('tc_1', first.message.id, true)).rejects.toThrow('云端还不支持在团队的频道里置顶')
    await expect(t.c.update('tc_1', { archived: true })).rejects.toThrow('云端还不支持归档团队的频道')
    const second = await t.c.post('tc_1', { text: '两条', threadId: first.message.id, clientId: 'o2' })
    expect(second.message.threadId ?? null).toBeNull()
    expect(
      t.cloud.calls.filter(x => x.method === 'POST' && x.path.endsWith('/messages')).at(-1)?.body,
    ).not.toHaveProperty('thread_id')
  })
})

describe('团队的频道：附件（docs/ui/channels-unify.md §9）', () => {
  /** 1×1 的 PNG */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = (id: string, bytes = 70) => ({
    id,
    name: `${id}.png`,
    mediaType: 'image/png' as const,
    bytes,
    width: 1,
    height: 1,
    dataBase64: PNG,
  })
  const file = (id: string, text = 'hello') => ({
    id,
    name: `${id}.log`,
    bytes: 5,
    lines: 1,
    encoding: 'utf-8' as const,
    text,
  })
  /** 别人传到云端的一份附件（还没挂到消息上） */
  const put = (cloud: FakeCloud, kind: 'image' | 'file', name: string, text = 'hello'): string => {
    const id = `tf_x${cloud.files.size + 1}`
    cloud.files.set(id, {
      id,
      kind,
      name,
      mime: kind === 'image' ? 'image/png' : 'text/plain',
      bytes: 70,
      width: kind === 'image' ? 1 : 0,
      height: kind === 'image' ? 1 : 0,
      lines: kind === 'image' ? 0 : 1,
      encoding: kind === 'image' ? '' : 'utf-8',
      data_base64: kind === 'image' ? PNG : Buffer.from(text, 'utf8').toString('base64'),
      message: null,
    })
    return id
  }
  async function withAgent(extra: Parameters<typeof open>[0] = {}) {
    const t = await open(extra)
    await t.online()
    const member = await t.c.saveMember(null, agent('前端助手'))
    await t.c.addMember('tc_1', member)
    const view = t.c.state().members.find(m => m.kind === 'agent' && (m as AgentMember).teamAgentId) as AgentMember
    await t.c.setAgentPolicy('tc_1', view.id, 'team')
    return { ...t, member, agentId: view.id }
  }
  const channel = (t: { c: Channels }) => t.c.state().channels.find(x => x.id === 'tc_1')!
  /** 发给引擎的那条消息带的附件 */
  const carried = (i: number) => {
    const m = sent[i] as unknown as { attachments?: { name: string }[]; files?: { name: string; text: string }[] }
    return { images: (m.attachments ?? []).map(a => a.name), files: (m.files ?? []).map(f => [f.name, f.text]) }
  }
  const gets = (cloud: FakeCloud) => cloud.calls.filter(x => x.method === 'GET' && x.path.includes('/attachments/'))

  it('发：先一份份传上去再跟消息一起发，正文可以为空；消息上带着说明，自己刚发的不用再取', async () => {
    const t = await open()
    await t.online()
    expect(channel(t).attach).toEqual({ images: 5, files: 5, imageBytes: 2 << 20, fileBytes: 256 << 10 })
    const { message } = await t.c.post('tc_1', {
      text: '',
      clientId: 'f1',
      attachments: [image('shot')],
      files: [file('err')],
    })
    const ups = t.cloud.calls.filter(x => x.method === 'POST' && x.path.endsWith('/attachments'))
    expect(ups.map(x => [x.body?.kind, x.body?.name])).toEqual([
      ['image', 'shot.png'],
      ['file', 'err.log'],
    ])
    expect(message.attached?.images.map(i => [i.name, i.width])).toEqual([['shot.png', 1]])
    expect(message.attached?.files.map(f => [f.name, f.lines, f.encoding])).toEqual([['err.log', 1, 'utf-8']])
    const data = await t.c.attachments('tc_1', message.id)
    expect(data.images.map(i => i.dataBase64)).toEqual([PNG])
    expect(data.files.map(f => f.text)).toEqual(['hello'])
    expect(gets(t.cloud)).toHaveLength(0)
    // 什么都没有还是不能发
    await expect(t.c.post('tc_1', { text: ' ', clientId: 'f2' })).rejects.toThrow('消息不能为空')
  })

  it('看：别人发的从云端取一次，再看不重复取；内容过期了说明原因', async () => {
    const t = await open()
    await t.online()
    const pic = put(t.cloud, 'image', '设计稿.png')
    const { message } = t.cloud.userPost('u:2', 'tc_1', '看图', [], null, '', null, [pic])
    await until(() => pushes().some(m => m.id === message.id))
    expect(pushes().find(m => m.id === message.id)).toMatchObject({ attached: { images: [{ name: '设计稿.png' }] } })
    expect((await t.c.attachments('tc_1', message.id as string)).images.map(i => i.name)).toEqual(['设计稿.png'])
    await t.c.attachments('tc_1', message.id as string)
    expect(gets(t.cloud)).toHaveLength(1)
    const old = put(t.cloud, 'file', '旧日志.log')
    t.cloud.files.get(old)!.expired = true
    const gone = t.cloud.userPost('u:2', 'tc_1', '很久以前的', [], null, '', null, [old]).message
    await until(() => pushes().some(m => m.id === gone.id))
    await expect(t.c.attachments('tc_1', gone.id as string)).rejects.toThrow('附件取不到')
  })

  it('交给 AI 成员：@ 的那条消息带的、它回复的那条消息带的都带上；取不到的告诉 AI', async () => {
    const t = await withAgent()
    const pic = put(t.cloud, 'image', '设计稿.png')
    const first = t.cloud.userPost('u:2', 'tc_1', '这是设计稿', [], null, '', null, [pic]).message
    const log = put(t.cloud, 'file', '报错.log', 'TypeError: x')
    const lost = put(t.cloud, 'file', '旧日志.log')
    t.cloud.files.get(lost)!.expired = true
    t.cloud.userPost('u:2', 'tc_1', '@前端助手 照这张图改', [t.agentId], first.id as string, '', null, [log, lost])
    await until(() => sent.length === 1)
    expect(carried(0)).toEqual({ images: ['设计稿.png'], files: [['报错.log', 'TypeError: x']] })
    expect(sent[0].text).toContain('1 个附件从云端取不到')
  })

  it('追加要求带的附件：还在做时并进下一轮，做完了开的下一轮也带', async () => {
    const t = await withAgent()
    const { tasks } = t.cloud.userPost('u:2', 'tc_1', '@前端助手 写更新日志', [t.agentId])
    const card = tasks[0].id as string
    await until(() => sent.length === 1)
    expect(carried(0)).toEqual({ images: [], files: [] })
    const a = put(t.cloud, 'file', '补充.log', '补充一')
    t.cloud.userPost('u:2', 'tc_1', '把这个也写上', [], card, '', null, [a])
    await until(() => t.store.runs.get(card)?.followUps.length === 1)
    complete(t.c, 's1', sent[0].clientMessageId, '写好了')
    await until(() => sent.length === 2)
    expect(carried(1).files).toEqual([['补充.log', '补充一']])
    complete(t.c, 's1', sent[1].clientMessageId, '补上了')
    await until(() => t.cloud.task(card).status === 'done')
    const b = put(t.cloud, 'image', '截图.png')
    t.cloud.userPost('u:2', 'tc_1', '再对一下这张截图', [], card, '', null, [b])
    await until(() => sent.length === 3)
    expect(carried(2)).toEqual({ images: ['截图.png'], files: [] })
  })

  it('只发附件的追加要求：提示词里说一句附了什么（正文是空的）', async () => {
    const t = await withAgent()
    const log = put(t.cloud, 'file', '报错.log')
    const { tasks } = t.cloud.userPost('u:2', 'tc_1', '@前端助手 看日志', [t.agentId], null, '', null, [log])
    await until(() => sent.length === 1)
    expect(sent[0].text).toContain('（附 1 个文件）')
    complete(t.c, 's1', sent[0].clientMessageId, '看完了')
    await until(() => t.cloud.task(tasks[0].id as string).status === 'done')
    const pic = put(t.cloud, 'image', '截图.png')
    t.cloud.userPost('u:2', 'tc_1', '', [], tasks[0].id as string, '', null, [pic])
    await until(() => sent.length === 2)
    expect(sent[1].text).toContain('（附 1 张图片）')
  })

  it('还没开始就失败的重试：附件原样再带', async () => {
    let broken = true
    const t = await withAgent({
      call: async (channel, args) => {
        if (channel === 'engine:createSession') {
          if (broken) throw new Error('引擎没装')
          sessions.push({ record: { id: 's1', projectId: 'p1' }, state: 'idle' } as SessionSummary)
          return { id: 's1' }
        }
        if (channel === 'engine:send')
          sent.push({ sessionId: 's1', ...(args[1] as { text: string; clientMessageId: string }) })
        return null
      },
    })
    const pic = put(t.cloud, 'image', '设计稿.png')
    const { tasks } = t.cloud.userPost('u:2', 'tc_1', '@前端助手 照图改', [t.agentId], null, '', null, [pic])
    const card = tasks[0].id as string
    await until(() => t.cloud.task(card).status === 'failed')
    broken = false
    await t.c.taskAction(card, 'retry')
    await until(() => sent.length === 1)
    expect(carried(0).images).toEqual(['设计稿.png'])
  })

  it('限制：只有路径的文件不让发；太大的图先转小；旧版云端没有入口，带附件报「还不支持」', async () => {
    const shrunk: number[] = []
    const t = await open({
      fitImage: (i, max) => {
        shrunk.push(max)
        return { ...i, bytes: 70, dataBase64: PNG }
      },
    })
    await t.online()
    await expect(
      t.c.post('tc_1', {
        text: '看这个包',
        clientId: 'l1',
        files: [{ ...file('pkg', ''), lines: 0, pathOnly: true, path: 'D:/pkg.zip' }],
      }),
    ).rejects.toThrow('只带了路径')
    expect(t.cloud.calls.some(x => x.path.endsWith('/attachments'))).toBe(false)
    const raw = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(3 << 20)])
    await t.c.post('tc_1', {
      text: '大图',
      clientId: 'l2',
      attachments: [{ ...image('big', raw.length), dataBase64: raw.toString('base64') }],
    })
    expect(shrunk).toEqual([2 << 20])
    expect(t.cloud.calls.filter(x => x.path.endsWith('/attachments')).map(x => x.body?.data_base64)).toEqual([PNG])
    const old = await open()
    old.cloud.attach = false
    await old.online()
    expect(channel(old).attach).toBeUndefined()
    await expect(old.c.post('tc_1', { text: '带图', clientId: 'l3', attachments: [image('a')] })).rejects.toThrow(
      '云端还不支持在团队的频道里带附件',
    )
    const plain = await old.c.post('tc_1', { text: '不带图', clientId: 'l4' })
    expect(plain.message.attached).toBeUndefined()
  })
})

describe('团队频道的「我的协作」（docs/ui/channels-unify.md §7.2）', () => {
  /** 两个本机成员，只有「前端助手」登记在团队频道里；打开「我的协作」 */
  async function withSide() {
    // @ 一个成员直接派活（不先出计划），测的是结果发到团队频道；流程要本机成员有频道工具
    const t = await open({ planFirst: false, channelTools: true })
    await t.online()
    const a = await t.c.saveMember(null, agent('前端助手'))
    const b = await t.c.saveMember(null, agent('审查员'))
    await t.c.addMember('tc_1', a)
    const { channelId: side } = await t.c.side('tc_1')
    return { ...t, a, b, side }
  }
  /** 团队频道里的文字消息：[谁发的, 正文]，自己发的写「我」，AI 成员写名字 */
  const cloudTexts = (t: { cloud: FakeCloud }): [string, string][] =>
    (t.cloud.messages.get('tc_1') ?? [])
      .filter(m => m.kind === 'message')
      .map(m => [
        m.author === t.cloud.me.id ? '我' : ((t.cloud.agents.find(x => x.id === m.author)?.name as string) ?? '?'),
        m.text as string,
      ])

  it('第一次打开时建：成员是我登记在团队频道里的 AI 成员，不占只有我的频道的名字；再打开是同一份', async () => {
    const t = await withSide()
    expect(t.store.channels.get(t.side)).toMatchObject({ name: '更新日志', sideOf: 'tc_1', memberIds: [SELF_ID, t.a] })
    expect(t.c.state().channels.find(x => x.id === t.side)).toMatchObject({
      scope: 'local',
      sideOf: 'tc_1',
      sideMirror: true,
    })
    expect((await t.c.side('tc_1')).channelId).toBe(t.side)
    await expect(t.c.create({ name: '更新日志' })).resolves.toBeTruthy()
    await expect(t.c.share(t.side, { teamId: 'tm_1', policies: {} })).rejects.toThrow('已经挂在一个团队频道下面了')
    await expect(t.c.side('不存在')).rejects.toThrow('频道不存在')
  })

  it('之后再登记进团队频道的成员，打开时补上；在这一页移出的不再加回（docs/ui/channels-side-sync.md）', async () => {
    const t = await withSide()
    await t.c.addMember('tc_1', t.b)
    expect(t.store.channels.get(t.side)?.memberIds).toEqual([SELF_ID, t.a])
    // 再打开：补上审查员，时间线记一条加入
    expect((await t.c.side('tc_1')).channelId).toBe(t.side)
    expect(t.store.channels.get(t.side)?.memberIds).toEqual([SELF_ID, t.a, t.b])
    const added = t.c
      .messages(t.side)
      .messages.filter(m => m.kind === 'event' && m.event === 'added')
      .map(m => (m.kind === 'event' ? m.targetId : null))
    expect(added).toEqual([t.b])
    // 牵头能派给它了
    await t.c.update(t.side, { lead: t.a })
    expect(t.c.state().channels.find(x => x.id === t.side)?.lead).toBe(t.a)
    // 在这一页移出：再打开不加回
    await t.c.removeMember(t.side, t.b)
    await t.c.side('tc_1')
    expect(t.store.channels.get(t.side)?.memberIds).toEqual([SELF_ID, t.a])
  })

  it('旧的「我的协作」没记同步过哪些：第一次打开把缺的补一次，之后照常', async () => {
    const t = await withSide()
    await t.c.addMember('tc_1', t.b)
    const { sideSeen: _seen, ...legacy } = t.store.channels.get(t.side)!
    await t.store.saveChannel(legacy)
    await t.c.side('tc_1')
    expect(t.store.channels.get(t.side)?.memberIds).toEqual([SELF_ID, t.a, t.b])
    expect(t.store.channels.get(t.side)?.sideSeen).toHaveLength(2)
    await t.c.removeMember(t.side, t.b)
    await t.c.side('tc_1')
    expect(t.store.channels.get(t.side)?.memberIds).toEqual([SELF_ID, t.a])
  })

  it('观察者没有这一页', async () => {
    const t = await open()
    t.cloud.role = 'observer'
    await t.online()
    await expect(t.c.side('tc_1')).rejects.toThrow('观察者没有「我的协作」')
  })

  it('结果发到团队频道：登记了的成员以它的名义发，没登记的以我的名义发并写上名字；关掉后不发', async () => {
    const t = await withSide()
    await t.c.post(t.side, { text: '@前端助手 写更新日志', clientId: 'k1' })
    await until(() => sent.length === 1)
    complete(t.c, 's1', sent[0].clientMessageId, '日志写好了')
    await until(() => cloudTexts(t).length === 1)
    expect(cloudTexts(t)).toEqual([['前端助手', '日志写好了']])
    // 团队频道里没有这张任务卡：卡只在自己这边
    expect((t.cloud.messages.get('tc_1') ?? []).some(m => m.kind === 'task')).toBe(false)

    await t.c.addMember(t.side, t.b)
    await t.c.post(t.side, { text: '@审查员 看一眼', clientId: 'k2' })
    await until(() => sent.length === 2)
    complete(t.c, 's2', sent[1].clientMessageId, '没问题')
    await until(() => cloudTexts(t).length === 2)
    expect(cloudTexts(t)[1]).toEqual(['我', '**审查员**\n\n没问题'])
    expect(t.cloud.calls.filter(x => x.method === 'POST' && x.path.endsWith('/messages')).at(-1)?.body).toMatchObject({
      format: 'markdown',
    })

    await t.c.update(t.side, { sideMirror: false })
    expect(t.c.state().channels.find(x => x.id === t.side)?.sideMirror).toBe(false)
    await t.c.post(t.side, { text: '@前端助手 再改改', clientId: 'k3' })
    await until(() => sent.length === 3)
    complete(t.c, 's3', sent[2].clientMessageId, '改好了')
    await new Promise(r => setTimeout(r, 30))
    expect(cloudTexts(t)).toHaveLength(2)
  })

  it('流程：开始时列出步骤，每一步的结果照发，完成时说一句', async () => {
    const t = await withSide()
    const { messageId } = await t.c.flowAction(t.side, {
      type: 'create',
      title: '发版',
      steps: [{ id: 's1', title: '写日志', memberId: t.a, deps: [], kind: 'work' }],
    })
    expect(cloudTexts(t)).toEqual([])
    await t.c.flowAction(t.side, { type: 'start', messageId })
    await until(() => sent.length === 1)
    t.c.toolDone('s1', { summary: '日志写好了' })
    complete(t.c, 's1', sent[0].clientMessageId, '日志写好了')
    await until(() => cloudTexts(t).length === 3)
    expect(cloudTexts(t)).toEqual([
      ['我', '开始流程「发版」（1 步）：\n1. 写日志（前端助手）'],
      ['前端助手', '日志写好了'],
      ['我', '流程「发版」完成了。'],
    ])
  })

  it('团队频道改回只有我：这一页变回普通的只有我的频道，名字不和留下的记录撞', async () => {
    const t = await withSide()
    const { channelId: kept } = await t.c.unshare('tc_1')
    const side = t.store.channels.get(t.side)!
    expect(side.sideOf ?? null).toBeNull()
    expect(t.c.state().channels.find(x => x.id === t.side)?.sideOf).toBeUndefined()
    expect(side.name).not.toBe(t.store.channels.get(kept)!.name)
  })
})

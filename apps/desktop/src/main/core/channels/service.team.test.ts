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

  it('团队频道不收附件', async () => {
    const { c, online } = await open()
    await online()
    await expect(
      c.post('tc_1', {
        text: '看图',
        clientId: 'att',
        files: [{ id: 'f', name: 'a.log', bytes: 1, lines: 1, encoding: 'utf-8', text: 'a' }],
      }),
    ).rejects.toThrow('团队频道暂不支持附件')
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

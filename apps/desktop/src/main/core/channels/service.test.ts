import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent, HostEvent, ProjectRecord, SessionSnapshot, SessionSummary } from '@pixelsky/protocol'
import {
  RELAY_PRESETS,
  type AgentInput,
  type AgentMember,
  type ChannelTask,
  type ChannelTextMessage,
} from '../../../shared/types/channels'
import { ChannelStore } from './store'
import { Channels, SELF_ID, type MachineLite } from './service'

/** 等派活的异步步骤（新建会话、写盘、发送）都走完 */
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2))
    for (const c of opened) await (c as unknown as { store: ChannelStore }).store.flush()
  }
}

/** 假引擎：记下调用，会话列表跟着新建 / 删除变 */
function fakeEngine() {
  const calls: { channel: string; args: unknown[] }[] = []
  const sessions: SessionSummary[] = []
  const snapshots = new Map<string, SessionSnapshot>()
  let n = 0
  const fail = new Map<string, string>()
  const call = async (channel: string, args: unknown[]): Promise<unknown> => {
    calls.push({ channel, args })
    if (fail.has(channel)) throw new Error(fail.get(channel))
    if (channel === 'engine:createSession') {
      const o = args[0] as { projectId: string }
      const prefix = o.projectId.includes('~') ? o.projectId.slice(0, o.projectId.indexOf('~') + 1) : ''
      const id = `${prefix}s${++n}`
      sessions.push({ record: { id, projectId: o.projectId }, state: 'idle' } as SessionSummary)
      return { id }
    }
    if (channel === 'engine:openSession') {
      const snapshot = snapshots.get(args[0] as string)
      if (!snapshot) throw new Error('会话不存在')
      return { snapshot, seq: 1 }
    }
    if (channel === 'engine:send')
      return { queueId: (args[1] as { clientMessageId: string }).clientMessageId, status: 'queued' }
    return null
  }
  const sends = () =>
    calls
      .filter(c => c.channel === 'engine:send')
      .map(c => ({ sessionId: c.args[0] as string, ...(c.args[1] as { text: string; clientMessageId: string }) }))
  return { calls, sessions, snapshots, call, sends, fail }
}

const projects: ProjectRecord[] = [
  { id: 'p1', name: 'pixel-web', path: 'D:/web' } as ProjectRecord,
  { id: 'ssh-ab~p2', name: 'build', path: '/srv/build' } as ProjectRecord,
]

let dir: string
let engine: ReturnType<typeof fakeEngine>
let machines: MachineLite[]
let now: number
let emitted: { channel: string; value: unknown }[]
let opened: Channels[]

async function open(): Promise<Channels> {
  const store = new ChannelStore(dir)
  await store.init()
  const c = new Channels({
    store,
    call: engine.call,
    emit: (channel, value) => emitted.push({ channel, value }),
    machines: () => machines,
    projects: () => projects,
    sessions: () => engine.sessions,
    machineOf: id => (/^ssh-[a-f0-9-]+~/.test(id) ? id.slice(0, id.indexOf('~')) : 'local'),
    selfName: () => '林夏',
    locale: () => 'zh-CN',
    now: () => ++now,
  })
  opened.push(c)
  return c
}

const agent = (name: string, patch: Partial<AgentInput> = {}): AgentInput => ({
  name,
  engine: 'claude',
  projectId: 'p1',
  copyId: null,
  settings: { permissionMode: 'ask' },
  instructions: '',
  mode: 'per-task',
  ...patch,
})

const ev = (sessionId: string, event: EngineEvent): HostEvent => ({ kind: 'session', sessionId, seq: 0, event })
const userItem = (cmid: string, turnId: string): EngineEvent => ({
  type: 'item_completed',
  item: { kind: 'user', id: cmid, text: '', createdAt: 0, turnId },
})
/** 让一轮从开始做到完成 */
function complete(c: Channels, sessionId: string, cmid: string, reply: string, turn = `turn-${cmid}`): void {
  c.hostEvent(ev(sessionId, userItem(cmid, turn)))
  c.hostEvent(
    ev(sessionId, {
      type: 'item_completed',
      item: { kind: 'assistant', id: `a-${turn}`, text: reply, status: 'completed' },
    }),
  )
  c.hostEvent(ev(sessionId, { type: 'turn_completed', turnId: turn, outcome: 'completed', error: null }))
}
const tasks = (c: Channels, channelId: string) =>
  c.messages(channelId).messages.filter((m): m is ChannelTask => m.kind === 'task')
const texts = (c: Channels, channelId: string) =>
  c.messages(channelId).messages.filter((m): m is ChannelTextMessage => m.kind === 'message')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsky-channels-'))
  engine = fakeEngine()
  machines = [{ id: 'local', name: 'PC', connected: true }]
  now = 1_000_000
  emitted = []
  opened = []
})
afterEach(async () => {
  for (const c of opened) await c.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('协作频道：团队关着', () => {
  it('没有团队同步：团队部分是空的，连接报「不可用」（界面据此藏起团队入口）；团队操作报暂不可用', async () => {
    const c = await open()
    expect(c.state()).toMatchObject({ teams: [], invites: [], teamsConnection: 'unavailable', teamsSyncedAt: null })
    await expect(c.createTeam('小队')).rejects.toThrow('团队功能暂不可用')
  })
})

describe('协作频道：说明和置顶（docs/ui/channels-local-ai.md §3.1 #9）', () => {
  it('说明去掉首尾空白存下来，空的算没有；派活提示词带上说明和置顶的消息', async () => {
    const c = await open()
    const memberId = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: '说明', memberIds: [memberId] })
    await c.update(channelId, { notes: '  改完要跑 pnpm check  ' })
    expect(c.state().channels[0]).toMatchObject({ notes: '改完要跑 pnpm check', pinned: [] })
    const { message } = await c.post(channelId, { text: '设计稿在 Figma 上', clientId: 'n1' })
    await c.pin(channelId, message.id, true)
    expect(c.state().channels[0].pinned).toEqual([message.id])
    await c.post(channelId, { text: '@前端助手 改一下首页', clientId: 'n2' })
    await settle()
    const [send] = engine.sends()
    expect(send.text).toContain('频道说明（这个频道里每项活都要照着做）：\n改完要跑 pnpm check')
    expect(send.text).toContain('频道里置顶的资料：\n- 林夏：设计稿在 Figma 上')
    await c.update(channelId, { notes: '   ' })
    expect(c.state().channels[0].notes).toBeNull()
  })
  it('置顶：只能置顶文字消息，同一条不重复，可以取消，最多 10 条；重启后还在', async () => {
    const c = await open()
    const channelId = await c.create({ name: '置顶' })
    const ids: string[] = []
    for (let i = 0; i < 11; i++)
      ids.push((await c.post(channelId, { text: `第 ${i} 条`, clientId: `p${i}` })).message.id)
    await c.pin(channelId, ids[0], true)
    await c.pin(channelId, ids[0], true)
    expect(c.state().channels[0].pinned).toEqual([ids[0]])
    for (const id of ids.slice(1, 10)) await c.pin(channelId, id, true)
    await expect(c.pin(channelId, ids[10], true)).rejects.toThrow('最多置顶 10 条')
    await c.pin(channelId, ids[3], false)
    expect(c.state().channels[0].pinned).not.toContain(ids[3])
    await expect(c.pin(channelId, 'nope', true)).rejects.toThrow('只能置顶文字消息')
    const again = await open()
    expect(again.state().channels[0].pinned).toHaveLength(9)
  })
})

describe('协作频道：提醒（docs/ui/channels-local-ai.md §3.1 #12、#13）', () => {
  it('快照里有「会话 → 频道、任务卡、成员」，提醒按频道的说法写；提醒级别默认全部，可以改，乱写报错', async () => {
    const c = await open()
    const memberId = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: '提醒', memberIds: [memberId] })
    const { tasks: ids } = await c.post(channelId, { text: '@前端助手 改首页', clientId: 'r1' })
    await settle()
    expect(c.state().sessionTasks).toEqual({ s1: { channelId, taskId: ids[0], memberId } })
    expect(c.state().channels[0].notify).toBe('all')
    await c.update(channelId, { notify: 'important' })
    expect(c.state().channels[0].notify).toBe('important')
    await expect(c.update(channelId, { notify: 'loud' as never })).rejects.toThrow('提醒设置无效')
    const again = await open()
    expect(again.state().channels[0].notify).toBe('important')
  })
})

describe('协作频道：消息搜索（docs/ui/channels-local-ai.md §3.1 #8）', () => {
  it('搜文字消息和任务卡标题：每个词都要出现、不分大小写，新的在前；归档的频道也搜；可以按项目筛', async () => {
    const c = await open()
    const memberId = await c.saveMember(null, agent('前端助手'))
    const web = await c.create({ name: '网页版', memberIds: [memberId], projectId: 'p1' })
    const old = await c.create({ name: '旧项目' })
    const { message: first } = await c.post(web, { text: '首页的 Banner 要换', clientId: 's1' })
    const { tasks } = await c.post(web, { text: '@前端助手 换掉首页 banner', clientId: 's2' })
    const { message: third } = await c.post(old, { text: 'banner 尺寸 1200×400，首页用', clientId: 's3' })
    await c.post(old, { text: '无关的消息', clientId: 's4' })
    await c.taskAction(tasks[0], 'stop')
    await settle()
    await c.update(old, { archived: true })

    const result = c.search('首页 BANNER')
    expect(result.truncated).toBe(false)
    expect(result.hits.map(h => [h.kind, h.channelId])).toEqual([
      ['message', old],
      ['task', web],
      ['message', web],
      ['message', web],
    ])
    expect(result.hits[0]).toMatchObject({ messageId: third.id, authorId: SELF_ID })
    expect(result.hits[1]).toMatchObject({ messageId: tasks[0], authorId: memberId })
    expect(result.hits.at(-1)!.messageId).toBe(first.id)
    expect(result.hits[0].snippet.filter(f => f.match).map(f => f.text)).toEqual(['banner', '首页'])
    expect(c.search('首页 尺寸').hits).toHaveLength(1)
    expect(c.search('  ').hits).toEqual([])
    expect(c.search('banner', { projectId: 'p1' }).hits.every(h => h.channelId === web)).toBe(true)
    expect(c.search('banner', { limit: 2 })).toMatchObject({ truncated: true, hits: [{}, {}] })
  })
})

describe('协作频道：归档（docs/ui/channels-local-ai.md §3.1 #11）', () => {
  it('还有没做完的活不能归档；归档后只读、可以恢复，时间线记一笔，重启后还在', async () => {
    const c = await open()
    const memberId = await c.saveMember(null, agent('前端助手'))
    const other = await c.saveMember(null, agent('审查员'))
    const channelId = await c.create({ name: '旧项目', memberIds: [memberId] })
    const { message, tasks: ids } = await c.post(channelId, { text: '@前端助手 改首页', clientId: 'a1' })
    await settle()
    await expect(c.update(channelId, { archived: true })).rejects.toThrow('频道里还有没做完的活')
    await c.taskAction(ids[0], 'stop')
    await settle()
    expect(tasks(c, channelId)[0].status).toBe('stopped')

    await c.update(channelId, { archived: true })
    const archivedAt = c.state().channels[0].archivedAt
    expect(archivedAt).toEqual(expect.any(Number))
    expect(c.state().channels[0].unread).toBe(0)
    const readOnly = '频道已归档，恢复后才能操作'
    await expect(c.post(channelId, { text: '还在吗', clientId: 'a2' })).rejects.toThrow(readOnly)
    await expect(c.pin(channelId, message.id, true)).rejects.toThrow(readOnly)
    await expect(c.update(channelId, { name: '改名' })).rejects.toThrow(readOnly)
    await expect(c.taskAction(ids[0], 'retry')).rejects.toThrow(readOnly)
    await expect(c.addMember(channelId, other)).rejects.toThrow(readOnly)
    await expect(c.saveMember(channelId, agent('新成员'))).rejects.toThrow(readOnly)
    await expect(c.removeMember(channelId, memberId)).rejects.toThrow(readOnly)
    // 已经在频道里的成员照常能改（成员是全局的）
    await c.saveMember(channelId, { ...agent('前端助手'), id: memberId, instructions: '只改前端' })
    await c.update(channelId, { archived: true })
    expect((await open()).state().channels[0].archivedAt).toBe(archivedAt)

    await c.update(channelId, { archived: false, name: '新项目' })
    expect(c.state().channels[0]).toMatchObject({ archivedAt: null, name: '新项目' })
    await c.post(channelId, { text: '回来了', clientId: 'a3' })
    const events = c
      .messages(channelId)
      .messages.flatMap(m => (m.kind === 'event' && m.event !== 'added' ? [m.event] : []))
    expect(events).toEqual(['archived', 'restored', 'renamed'])
  })
})

describe('协作频道：成员的额度来源', () => {
  it('平台额度：存进成员配置，派活开会话时带上分组和账号；自定义接口同样带上接口 id', async () => {
    const c = await open()
    const platform = { groupId: 'g1', account: 'me@example.com' }
    const a = await c.saveMember(null, agent('平台助手', { settings: { model: 'claude-opus-5-5', platform } }))
    const b = await c.saveMember(
      null,
      agent('接口助手', { settings: { model: 'my-claude', provider: { id: 'anth' } } }),
    )
    expect(c.state().members.find(m => m.id === a)).toMatchObject({ config: { settings: { platform } } })
    const channelId = await c.create({ name: '额度', memberIds: [a, b] })
    await c.post(channelId, { text: '@平台助手 @接口助手 看一下', clientId: 'c1' })
    await settle()
    const creates = engine.calls.filter(x => x.channel === 'engine:createSession').map(x => x.args[0])
    expect(creates).toContainEqual({
      projectId: 'p1',
      engine: 'claude',
      model: 'claude-opus-5-5',
      platform,
      rememberChoices: false,
    })
    expect(creates).toContainEqual({
      projectId: 'p1',
      engine: 'claude',
      model: 'my-claude',
      provider: { id: 'anth' },
      rememberChoices: false,
    })
  })
  it('一直用同一个会话的成员换了额度来源：下一项活开新会话（来源是开会话时定的）', async () => {
    const c = await open()
    const id = await c.saveMember(null, agent('共用', { mode: 'shared' }))
    const channelId = await c.create({ name: '共用', memberIds: [id] })
    await c.post(channelId, { text: '@共用 第一项', clientId: 'd1' })
    await settle()
    const [first] = engine.sends()
    complete(c, first.sessionId, first.clientMessageId, '好了')
    await settle()
    const config = c.state().members.find(m => m.id === id)
    expect(config).toMatchObject({ config: { sharedSessionId: 's1' } })
    await c.saveMember(null, agent('共用', { id, mode: 'shared', settings: { provider: { id: 'anth' } } }))
    expect(c.state().members.find(m => m.id === id)).toMatchObject({ config: { sharedSessionId: null } })
  })
  it('不写就是自有账号；形状不对、平台和接口同时给都报「额度来源无效」', async () => {
    const c = await open()
    const id = await c.saveMember(null, agent('自有'))
    expect(c.state().members.find(m => m.id === id)).toMatchObject({ config: { settings: { permissionMode: 'ask' } } })
    const both = { platform: { groupId: 'g', account: 'a' }, provider: { id: 'p' } }
    await expect(c.saveMember(null, agent('两个', { settings: both }))).rejects.toThrow('额度来源无效')
    const bad = { platform: { groupId: '', account: 'a' } }
    await expect(c.saveMember(null, agent('坏的', { settings: bad }))).rejects.toThrow('额度来源无效')
    await expect(c.saveMember(null, agent('坏接口', { settings: { provider: { id: '../x' } } }))).rejects.toThrow(
      '额度来源无效',
    )
  })
})

describe('协作频道：派活', () => {
  it('@成员 → 新开会话、改名、发提示词；做完后结果发回频道，任务卡更新摘要 / 改动 / 需要你决定', async () => {
    const c = await open()
    const memberId = await c.saveMember(null, agent('前端助手', { instructions: '只改前端' }))
    const channelId = await c.create({ name: '网页版改版', topic: '10 月', memberIds: [memberId] })
    const { tasks: ids } = await c.post(channelId, { text: '@前端助手 把设置页迁到新表单', clientId: 'x1' })
    await settle()
    expect(ids).toHaveLength(1)
    const create = engine.calls.find(x => x.channel === 'engine:createSession')!
    expect(create.args[0]).toEqual({ projectId: 'p1', engine: 'claude', permissionMode: 'ask', rememberChoices: false })
    expect(engine.calls.find(x => x.channel === 'engine:renameSession')?.args).toEqual(['s1', '把设置页迁到新表单'])
    const [send] = engine.sends()
    expect(send.sessionId).toBe('s1')
    expect(send.clientMessageId).toBe(`ch-${ids[0]}-1`)
    expect(send.text).toContain('#网页版改版')
    expect(send.text).toContain('只改前端')
    expect(tasks(c, channelId)[0]).toMatchObject({ status: 'queued', sessionId: 's1', title: '把设置页迁到新表单' })
    expect(c.state().members.find(m => m.id === memberId)).toMatchObject({
      status: 'running',
      task: '把设置页迁到新表单',
    })

    c.hostEvent(ev('s1', userItem(send.clientMessageId, 'k')))
    expect(tasks(c, channelId)[0].status).toBe('running')
    c.hostEvent(
      ev('s1', {
        type: 'item_completed',
        item: {
          kind: 'file_change',
          id: 'f',
          status: 'completed',
          changes: [{ path: 'a.tsx', kind: 'update', diff: '', added: 42, removed: 10 }],
        },
      }),
    )
    c.hostEvent(
      ev('s1', {
        type: 'item_completed',
        item: { kind: 'assistant', id: 'a', text: '改好了设置页。\n\n需要你决定：删旧组件吗？', status: 'completed' },
      }),
    )
    c.hostEvent(ev('s1', { type: 'turn_completed', turnId: 'k', outcome: 'completed', error: null }))
    const task = tasks(c, channelId)[0]
    expect(task).toMatchObject({
      status: 'done',
      summary: '改好了设置页。',
      decision: '删旧组件吗？',
      diff: { added: 42, removed: 10 },
    })
    const result = texts(c, channelId).at(-1)!
    expect(result).toMatchObject({
      authorId: memberId,
      format: 'markdown',
      replyToId: task.id,
      taskId: task.id,
      mentions: [SELF_ID],
    })
    // 结果算未读，带「需要你决定」算 @你
    expect(c.state().channels[0]).toMatchObject({ unread: 1, mentioned: true })
    c.markRead(channelId)
    expect(c.state().channels[0]).toMatchObject({ unread: 0, mentioned: false })
    expect(c.state().members.find(m => m.id === memberId)).toMatchObject({
      status: 'idle',
      stats: { total: 1, done: 1, failed: 0 },
    })
    expect(c.state().sessionChannels).toEqual({ s1: '网页版改版' })
  })

  it('同一个成员的活排队，前一项结束后自动开始；不同成员同时做', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员', { engine: 'codex' }))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    await c.post(channelId, { text: '@前端助手 @审查员 第一项', clientId: '1' })
    await c.post(channelId, { text: '@前端助手 第二项', clientId: '2' })
    await settle()
    expect(engine.sends().map(s => s.sessionId)).toEqual(['s1', 's2'])
    const [first, review, second] = tasks(c, channelId)
    expect(review.assigneeId).toBe(b)
    expect(second).toMatchObject({ status: 'queued', ahead: 1, sessionId: null })
    complete(c, 's1', `ch-${first.id}-1`, '完成')
    await settle()
    // 每项活新开会话
    expect(engine.sends().at(-1)).toMatchObject({ sessionId: 's3', clientMessageId: `ch-${second.id}-1` })
    expect(tasks(c, channelId)[2]).toMatchObject({ ahead: 0, sessionId: 's3' })
  })

  it('@全体 → 频道里每个 AI 成员各开一张任务卡，提示词写明还有谁收到；不在频道里的成员不算', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员', { engine: 'codex' }))
    const outside = await c.saveMember(null, agent('构建'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    const { message, tasks: ids } = await c.post(channelId, { text: '@全体 自我介绍一下', clientId: 'all1' })
    await settle()
    expect(message.mentions).toEqual([a, b])
    expect(ids).toHaveLength(2)
    const cards = tasks(c, channelId)
    expect(cards.map(t => t.assigneeId)).toEqual([a, b])
    expect(cards.every(t => t.title === '自我介绍一下')).toBe(true)
    expect(cards.some(t => t.assigneeId === outside)).toBe(false)
    const sends = engine.sends()
    expect(sends).toHaveLength(2)
    expect(sends[0].text).toContain('审查员 也同时收到了')
    expect(sends[1].text).toContain('前端助手 也同时收到了')
    // 只 @ 一个成员时不写
    await c.post(channelId, { text: '@前端助手 再看下', clientId: 'all2' })
    complete(c, 's1', sends[0].clientMessageId, '好')
    await settle()
    expect(engine.sends().at(-1)?.text ?? '').not.toContain('全体 AI 成员')
  })

  it('引用任务卡再 @全体：多个成员时各开新任务卡，不当成追加要求', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员', { engine: 'codex' }))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    await c.post(channelId, { text: '@前端助手 改登录页', clientId: 'q1' })
    await settle()
    const [card] = tasks(c, channelId)
    const { tasks: ids } = await c.post(channelId, { text: '@全体 一起看看', clientId: 'q2', replyToId: card.id })
    await settle()
    expect(ids).toHaveLength(2)
    expect(ids).not.toContain(card.id)
    expect(tasks(c, channelId)).toHaveLength(3)
  })

  it('一直用同一个会话：第二项活发到同一个会话，只补上次之后的讨论', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('文档助手', { mode: 'shared' }))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '早先的讨论', clientId: '0' })
    await c.post(channelId, { text: '@文档助手 第一项', clientId: '1' })
    await settle()
    expect(engine.calls.find(x => x.channel === 'engine:renameSession')?.args).toEqual(['s1', '文档助手'])
    complete(c, 's1', `ch-${tasks(c, channelId)[0].id}-1`, '好')
    await c.post(channelId, { text: '中间的话', clientId: '2' })
    await c.post(channelId, { text: '@文档助手 第二项', clientId: '3' })
    await settle()
    const send = engine.sends().at(-1)!
    expect(send.sessionId).toBe('s1')
    expect(send.text).toContain('中间的话')
    expect(send.text).not.toContain('早先的讨论')
  })

  it('回复任务卡 = 追加要求：做完后发到同一个会话，轮次加 1；还在做时等这一轮做完', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    const task = tasks(c, channelId)[0]
    // 还在做：先记着
    await c.post(channelId, { text: '顺便改颜色', replyToId: task.id, clientId: '2' })
    expect(engine.sends()).toHaveLength(1)
    complete(c, 's1', `ch-${task.id}-1`, '改好了')
    await settle()
    expect(engine.sends().at(-1)).toMatchObject({ sessionId: 's1', clientMessageId: `ch-${task.id}-2` })
    expect(engine.sends().at(-1)!.text).toContain('顺便改颜色\n\n（来自频道 #ch，林夏）')
    complete(c, 's1', `ch-${task.id}-2`, '颜色也改了')
    // 回复结果消息也算追加要求
    const result = texts(c, channelId).at(-1)!
    await c.post(channelId, { text: '再加个图标', replyToId: result.id, clientId: '3' })
    await settle()
    expect(engine.sends().at(-1)).toMatchObject({ sessionId: 's1', clientMessageId: `ch-${task.id}-3` })
    expect(tasks(c, channelId)).toHaveLength(1)
    expect(tasks(c, channelId)[0]).toMatchObject({ round: 3, status: 'queued' })
    // 引用的同时 @ 了别的成员：给它开新活
    const b = await c.saveMember(channelId, agent('审查员'))
    await c.post(channelId, { text: '@审查员 帮忙看看', replyToId: result.id, clientId: '4' })
    await settle()
    expect(tasks(c, channelId).map(t => t.assigneeId)).toEqual([a, b])
    expect(engine.sends().at(-1)!.text).toContain('引用的消息：\n> 前端助手：颜色也改了')
  })

  it('重复提交同一条消息不重复派活', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 做', clientId: 'same' })
    await c.post(channelId, { text: '@前端助手 做', clientId: 'same' })
    await settle()
    expect(tasks(c, channelId)).toHaveLength(1)
    expect(texts(c, channelId)).toHaveLength(1)
  })
})

/** 1×1 的 PNG */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const image = (id: string) => ({
  id,
  name: `${id}.png`,
  mediaType: 'image/png' as const,
  bytes: 70,
  width: 1,
  height: 1,
  dataBase64: PNG,
})
/** 最近发给会话的那一轮做完：可选先改几个文件 */
async function finishLast(c: Channels, reply: string, files: string[] = []): Promise<void> {
  const s = engine.sends().at(-1)!
  const turn = `turn-${s.clientMessageId}`
  c.hostEvent(ev(s.sessionId, userItem(s.clientMessageId, turn)))
  if (files.length)
    c.hostEvent(
      ev(s.sessionId, {
        type: 'item_completed',
        item: {
          kind: 'file_change',
          id: `f-${turn}`,
          status: 'completed',
          changes: files.map(path => ({ path, kind: 'update' as const, diff: '', added: 1, removed: 1 })),
        },
      }),
    )
  c.hostEvent(
    ev(s.sessionId, {
      type: 'item_completed',
      item: { kind: 'assistant', id: `a-${turn}`, text: reply, status: 'completed' },
    }),
  )
  c.hostEvent(ev(s.sessionId, { type: 'turn_completed', turnId: turn, outcome: 'completed', error: null }))
  await settle()
}

describe('协作频道：AI 互相派活（docs/ui/import-collab.md 第 5 项①）', () => {
  it('频道没开：AI 回复里的 @成员 只是文字，不派活', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    expect(c.state().channels[0].relay).toBe(false)
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    expect(engine.sends()[0].text).not.toContain('互相派活')
    await finishLast(c, '改好了。\n\n@审查员 请看一下。')
    expect(tasks(c, channelId)).toHaveLength(1)
    expect(engine.sends()).toHaveLength(1)
  })

  it('开了以后：回复里 @ 别的成员就交给他，卡片写谁交的、第几跳，提示词带交接内容；代码里的和 @自己不算', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手', { instructions: '负责前端页面\n第二行不带' }))
    const b = await c.saveMember(null, agent('审查员', { instructions: '负责代码审查' }))
    const d = await c.saveMember(null, agent('构建'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b, d] })
    await c.update(channelId, { relay: true })
    expect(c.state().channels[0].relay).toBe(true)
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    // 派活时告诉 AI 能交给谁
    const first = engine.sends()[0].text
    expect(first).toContain('这个频道允许 AI 成员互相派活')
    expect(first).toContain('- 审查员：负责代码审查')
    expect(first).toContain('- 构建')
    expect(first).not.toContain('- 前端助手')
    await finishLast(
      c,
      '按钮改好了。\n\n@审查员 请看一下按钮改动。\n\n```\n@构建 代码里的不算\n```\n~~~\n@构建 波浪线围栏里的也不算\n~~~\n顺便提一句 `@构建` 和 @前端助手 也不算',
      ['src/Button.tsx', 'src/tokens.css'],
    )
    const [orig, relay] = tasks(c, channelId)
    expect(tasks(c, channelId)).toHaveLength(2)
    expect(relay).toMatchObject({
      authorId: a,
      assigneeId: b,
      title: '请看一下按钮改动。',
      status: 'queued',
      relay: { chain: orig.id, hop: 1, held: null },
    })
    const send = engine.sends().at(-1)!
    expect(send.clientMessageId).toBe(`ch-${relay.id}-1`)
    expect(send.text).toContain('交给你的人：前端助手')
    expect(send.text).toContain('前端助手 做完「改按钮」后把活交给了你。')
    expect(send.text).toContain('> 按钮改好了。')
    expect(send.text).toContain('改动的文件：src/Button.tsx、src/tokens.css')
    expect(send.text).toContain('这次的要求：\n@审查员 请看一下按钮改动。')
    expect(send.text).toContain('- 前端助手：负责前端页面')
    // 结果消息照常发回，没有被拦下就不算 @你
    expect(texts(c, channelId).at(-1)).toMatchObject({ authorId: a, mentions: [] })
    // 第二跳：审查员交回前端助手
    await finishLast(c, '有一处问题。@前端助手 把禁用状态的颜色改深一点。')
    expect(tasks(c, channelId)[2]).toMatchObject({ authorId: b, assigneeId: a, relay: { chain: orig.id, hop: 2 } })
  })

  it('同一对成员 10 分钟内互派到 4 次，第 5 次停下等你；点「继续」放行，计数重新开始', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    await c.update(channelId, { relay: true, relayRules: RELAY_PRESETS.careful })
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    // 前端助手和审查员轮流做，每次都交给对方
    const other = (i: number) => (i % 2 ? '@前端助手 再改改' : '@审查员 请看看')
    for (let i = 0; i < 4; i++) await finishLast(c, other(i))
    expect(tasks(c, channelId).map(t => t.relay?.hop ?? 0)).toEqual([0, 1, 2, 3, 4])
    expect(tasks(c, channelId).at(-1)).toMatchObject({ assigneeId: a, relay: { held: null } })
    const sent = engine.sends().length
    await finishLast(c, other(4))
    const held = tasks(c, channelId).at(-1)!
    expect(held).toMatchObject({ authorId: a, assigneeId: b, status: 'queued', relay: { hop: 5, held: 'pair' } })
    expect(engine.sends()).toHaveLength(sent)
    expect(c.state().channels[0].mentioned).toBe(true)
    // 放行：派出去，计数从现在重新算
    await c.taskAction(held.id, 'continue')
    await settle()
    expect(tasks(c, channelId).at(-1)).toMatchObject({ relay: { hop: 5, held: null }, sessionId: expect.any(String) })
    expect(engine.sends().at(-1)!.clientMessageId).toBe(`ch-${held.id}-1`)
    await finishLast(c, other(5))
    expect(tasks(c, channelId).at(-1)).toMatchObject({ assigneeId: a, relay: { hop: 6, held: null } })
    // 不是被拦下的卡：继续不起作用
    await c.taskAction(tasks(c, channelId)[0].id, 'continue')
  })

  it('你在频道里发言后防刷计数重新开始', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    await c.update(channelId, { relay: true, relayRules: RELAY_PRESETS.careful })
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    const other = (i: number) => (i % 2 ? '@前端助手 再改改' : '@审查员 请看看')
    for (let i = 0; i < 4; i++) await finishLast(c, other(i))
    await c.post(channelId, { text: '你们继续，别停', clientId: '2' })
    await finishLast(c, other(4))
    expect(tasks(c, channelId).at(-1)).toMatchObject({ relay: { hop: 5, held: null } })
  })

  it('一条接力超过 6 跳停下等你；取消后不再派', async () => {
    const c = await open()
    const ids = [
      await c.saveMember(null, agent('甲')),
      await c.saveMember(null, agent('乙')),
      await c.saveMember(null, agent('丙')),
    ]
    const names = ['甲', '乙', '丙']
    const channelId = await c.create({ name: 'ch', memberIds: ids })
    await c.update(channelId, { relay: true, relayRules: RELAY_PRESETS.careful })
    await c.post(channelId, { text: '@甲 开始', clientId: '1' })
    await settle()
    // 甲 → 乙 → 丙 → 甲 → 乙 → 丙 → 甲：6 跳，每一对都只有 2 次
    for (let hop = 1; hop <= 6; hop++) await finishLast(c, `@${names[hop % 3]} 接着做`)
    expect(tasks(c, channelId).at(-1)).toMatchObject({ relay: { hop: 6, held: null } })
    const sent = engine.sends().length
    await finishLast(c, '@乙 第 7 跳')
    const held = tasks(c, channelId).at(-1)!
    expect(held).toMatchObject({ assigneeId: ids[1], status: 'queued', relay: { hop: 7, held: 'hops' } })
    expect(engine.sends()).toHaveLength(sent)
    // 被拦下算 @你
    expect(texts(c, channelId).at(-1)?.mentions).toEqual([SELF_ID])
    await c.taskAction(held.id, 'cancel')
    await settle()
    expect(tasks(c, channelId).at(-1)).toMatchObject({ status: 'stopped', note: 'cancelled' })
    expect(engine.sends()).toHaveLength(sent)
  })

  it('接力规则：没设过的频道按「标准」；规则不对时报错', async () => {
    const c = await open()
    const channelId = await c.create({ name: 'ch' })
    expect(c.state().channels[0].relayRules).toEqual(RELAY_PRESETS.standard)
    await c.update(channelId, { relayRules: RELAY_PRESETS.long })
    expect(c.state().channels[0].relayRules).toEqual(RELAY_PRESETS.long)
    await expect(c.update(channelId, { relayRules: { ...RELAY_PRESETS.long, hops: 0 } })).rejects.toThrow('跳数')
    await expect(c.update(channelId, { relayRules: { ...RELAY_PRESETS.long, windowMinutes: 7 } })).rejects.toThrow(
      '时间窗口',
    )
  })

  it('跳数、互派不限时运行满最长时间停下（记下上限）；不提醒时不算 @你', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    await c.update(channelId, { relay: true, relayRules: { ...RELAY_PRESETS.long, maxMinutes: 30, notify: false } })
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    const other = (i: number) => (i % 2 ? '@前端助手 再改改' : '@审查员 请看看')
    // 不限次数：互派 10 次也不停
    for (let i = 0; i < 10; i++) await finishLast(c, other(i))
    expect(tasks(c, channelId).at(-1)).toMatchObject({ relay: { hop: 10, held: null } })
    now += 31 * 60_000
    await finishLast(c, other(10))
    expect(tasks(c, channelId).at(-1)).toMatchObject({
      status: 'queued',
      relay: { hop: 11, held: 'duration', limit: 30 },
    })
    expect(texts(c, channelId).at(-1)?.mentions).toEqual([])
  })

  it('「这条接力不再限制」：放行，之后这条接力不再拦；改宽规则时已经停下的直接放行', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    await c.update(channelId, { relay: true, relayRules: { ...RELAY_PRESETS.careful, hops: 2, pair: null } })
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    const other = (i: number) => (i % 2 ? '@前端助手 再改改' : '@审查员 请看看')
    for (let i = 0; i < 3; i++) await finishLast(c, other(i))
    const held = tasks(c, channelId).at(-1)!
    expect(held).toMatchObject({ relay: { hop: 3, held: 'hops', limit: 2 } })
    await c.taskAction(held.id, 'unlimit')
    await settle()
    expect(tasks(c, channelId).at(-1)).toMatchObject({ relay: { hop: 3, held: null }, sessionId: expect.any(String) })
    for (let i = 3; i < 8; i++) await finishLast(c, other(i))
    expect(tasks(c, channelId).at(-1)).toMatchObject({ relay: { hop: 8, held: null } })
  })

  it('把接力规则改宽：已经停下、按新规则不该拦的接力直接放行', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('审查员'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    await c.update(channelId, { relay: true, relayRules: { ...RELAY_PRESETS.careful, hops: 2, pair: null } })
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    const other = (i: number) => (i % 2 ? '@前端助手 再改改' : '@审查员 请看看')
    for (let i = 0; i < 3; i++) await finishLast(c, other(i))
    const held = tasks(c, channelId).at(-1)!
    expect(held).toMatchObject({ relay: { hop: 3, held: 'hops' } })
    const sent = engine.sends().length
    // 只改提醒：还是 2 跳，照样停着
    await c.update(channelId, { relayRules: { ...RELAY_PRESETS.careful, hops: 2, pair: null, notify: false } })
    await settle()
    expect(tasks(c, channelId).at(-1)).toMatchObject({ relay: { held: 'hops' } })
    await c.update(channelId, { relayRules: RELAY_PRESETS.standard })
    await settle()
    expect(tasks(c, channelId).at(-1)).toMatchObject({ id: held.id, relay: { held: null } })
    expect(engine.sends().length).toBe(sent + 1)
  })
})

describe('协作频道：聊天派的活（消息通道）', () => {
  const setup = async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('小明'))
    const loose = await c.saveMember(null, agent('阿强', { settings: { permissionMode: 'full' } }))
    const ch = await c.create({ name: 'ch', memberIds: [a, loose] })
    await c.update(ch, { relay: true, relayRules: RELAY_PRESETS.long })
    return { c, a, loose, ch }
  }

  it('消息和任务都带上来源；接力的下一跳跟着带', async () => {
    const { c, a, ch } = await setup()
    const b = await c.saveMember(ch, agent('小红'))
    const { message, root } = await c.post(ch, { text: '@小明 改按钮', clientId: '1' }, undefined, 'qq')
    expect(root).toBe(message.id)
    expect(message.chat).toEqual({ via: 'qq', root: message.id })
    await settle()
    expect(tasks(c, ch)[0]).toMatchObject({ assigneeId: a, chat: { via: 'qq', root: message.id } })
    await finishLast(c, '改好了。\n\n@小红 看一下')
    expect(tasks(c, ch)[1]).toMatchObject({ assigneeId: b, chat: { root: message.id }, relay: { held: null } })
  })

  it('接力给放宽模式的成员：拦下，「不再限制」也绕不过；电脑上点继续才放行', async () => {
    const { c, loose, ch } = await setup()
    await c.post(ch, { text: '@小明 改按钮', clientId: '1' }, undefined, 'wechat')
    await settle()
    const sent = () => engine.sends().length
    await finishLast(c, '改好了。\n\n@阿强 接着做')
    const before = sent()
    const held = tasks(c, ch)[1]
    expect(held).toMatchObject({ assigneeId: loose, status: 'queued', relay: { held: 'chat' } })
    await settle()
    expect(sent()).toBe(before)
    // 改规则会重新算一遍被拦下的，聊天这条不放
    await c.update(ch, { relayRules: RELAY_PRESETS.standard })
    await settle()
    expect(tasks(c, ch)[1]).toMatchObject({ relay: { held: 'chat' } })
    // 电脑上放行，并且记成「不再限制」：这一跳走了，再交回放宽的成员还是拦
    await c.taskAction(held.id, 'unlimit')
    await settle()
    expect(sent()).toBe(before + 1)
    await finishLast(c, '好了。\n\n@小明 再看看')
    await settle()
    await finishLast(c, '看了。\n\n@阿强 收尾')
    expect(tasks(c, ch).at(-1)).toMatchObject({ assigneeId: loose, relay: { held: 'chat' } })
  })

  it('电脑上派的活接力给放宽模式的成员：不拦', async () => {
    const { c, loose, ch } = await setup()
    await c.post(ch, { text: '@小明 改按钮', clientId: '1' })
    await settle()
    await finishLast(c, '改好了。\n\n@阿强 接着做')
    expect(tasks(c, ch)[0].chat).toBeUndefined()
    expect(tasks(c, ch)[1]).toMatchObject({ assigneeId: loose, relay: { held: null } })
  })

  it('能不能派：看成员设置；没设、SSH 上查不到默认值的当不能派', async () => {
    const { c, a, loose } = await setup()
    expect(c.chatAccess(a)).toEqual({ name: '小明', allowed: true, local: true })
    expect(c.chatAccess(loose)).toMatchObject({ allowed: false })
    const unset = await c.saveMember(null, agent('没设', { settings: {} }))
    expect(c.chatAccess(unset)).toMatchObject({ allowed: false })
    const remote = await c.saveMember(
      null,
      agent('老周', { projectId: 'ssh-ab~p2', settings: { permissionMode: 'ask' } }),
    )
    expect(c.chatAccess(remote)).toMatchObject({ allowed: true, local: false })
    expect(c.chatAccess('nobody')).toMatchObject({ allowed: false, local: false })
  })

  it('共用会话的成员：会话实际的模式和成员设置（流程里的步骤按它开会话）都要是询问或计划', async () => {
    const { c, ch } = await setup()
    const id = await c.saveMember(ch, agent('共用', { mode: 'shared' }))
    await c.post(ch, { text: '@共用 看看', clientId: '1' })
    await settle()
    const record = engine.sessions.at(-1)!.record
    record.permissionMode = 'ask'
    expect(c.chatAccess(id).allowed).toBe(true)
    record.permissionMode = 'full'
    expect(c.chatAccess(id).allowed).toBe(false)
    record.permissionMode = 'ask'
    await c.saveMember(ch, { ...agent('共用', { mode: 'shared', settings: { permissionMode: 'edits' } }), id } as never)
    expect(c.chatAccess(id).allowed).toBe(false)
  })

  it('聊天能选的频道不含归档的；提到的成员不含自己', async () => {
    const { c, a, ch } = await setup()
    expect(c.chatTargets().map(x => x.id)).toEqual([ch])
    expect(c.chatMentions(ch, '@小明 看看')).toEqual([a])
    await c.update(ch, { archived: true })
    expect(c.chatTargets()).toEqual([])
  })

  it('聊天里发言不算看过电脑上的频道：未读留着；电脑上发言照旧清掉', async () => {
    const { c, ch } = await setup()
    await c.post(ch, { text: '@小明 改按钮', clientId: '1' })
    await settle()
    await finishLast(c, '改好了。')
    expect(c.state().channels[0].unread).toBe(1)
    await c.post(ch, { text: '手机上发一句', clientId: '2' }, undefined, 'qq')
    await settle()
    expect(c.state().channels[0].unread).toBe(1)
    await c.post(ch, { text: '电脑上发一句', clientId: '3' })
    await settle()
    expect(c.state().channels[0].unread).toBe(0)
  })

  it('接力来的卡在电脑上改派：新卡沿用来源，结果才回得到聊天', async () => {
    const { c, ch } = await setup()
    const b = await c.saveMember(ch, agent('小红'))
    const d = await c.saveMember(ch, agent('老王'))
    const { message } = await c.post(ch, { text: '@小明 改按钮', clientId: '1' }, undefined, 'qq')
    await settle()
    await finishLast(c, '改好了。\n\n@小红 看一下')
    const relayed = tasks(c, ch)[1]
    expect(relayed).toMatchObject({ assigneeId: b, chat: { root: message.id } })
    await c.taskAction(relayed.id, 'reassign', d)
    expect(tasks(c, ch).at(-1)).toMatchObject({ assigneeId: d, chat: { via: 'qq', root: message.id } })
  })

  it('没 @、没牵头：root 是 null（没人接），消息照样进频道', async () => {
    const { c, ch } = await setup()
    const { message, root } = await c.post(ch, { text: '大家看一下这个问题', clientId: '1' }, undefined, 'qq')
    expect(root).toBeNull()
    expect(c.chatItems(ch).some(m => m.id === message.id)).toBe(true)
  })
})

describe('协作频道：已有会话加入频道（docs/ui/import-collab.md 第 5 项②）', () => {
  /** 假引擎里放一个自己开的会话 */
  const own = (id: string, patch: Record<string, unknown> = {}) =>
    engine.sessions.push({
      record: { id, projectId: 'p1', engine: 'codex', title: '修登录页样式', archivedAt: null, ...patch },
      state: 'idle',
    } as unknown as SessionSummary)

  it('加入已有频道：成员绑着这个会话，派活直接发到它，不新开、不改名；侧栏和成员面板认得出来', async () => {
    const c = await open()
    own('mine')
    const channelId = await c.create({ name: '发版' })
    const { channelId: joined, memberId } = await c.joinSession({
      sessionId: 'mine',
      channelId,
      name: '前端助手',
      instructions: '负责前端',
    })
    expect(joined).toBe(channelId)
    const view = c.state().members.find(m => m.id === memberId)
    expect(view).toMatchObject({
      kind: 'agent',
      engine: 'codex',
      config: { mode: 'shared', sharedSessionId: 'mine', bound: true, instructions: '负责前端' },
      boundSession: { id: 'mine', title: '修登录页样式' },
    })
    expect(c.state().sessionBindings).toEqual({ mine: [{ channelId, memberId }] })
    expect(c.state().sessionChannels).toEqual({ mine: '发版' })
    await c.post(channelId, { text: '@前端助手 圆角改成 6px', clientId: '1' })
    await settle()
    expect(engine.calls.some(x => x.channel === 'engine:createSession')).toBe(false)
    expect(engine.calls.some(x => x.channel === 'engine:renameSession')).toBe(false)
    expect(engine.sends()[0]).toMatchObject({ sessionId: 'mine' })
    expect(engine.sends()[0].text).toContain('负责前端')
  })

  it('新建频道并加入；同一个会话再加入别的频道用同一个成员；退出最后一个频道时删掉成员，会话不动', async () => {
    const c = await open()
    own('mine')
    const first = await c.joinSession({ sessionId: 'mine', channelName: '登录页', name: '前端助手' })
    expect(c.state().channels.find(x => x.id === first.channelId)).toMatchObject({ name: '登录页', projectId: 'p1' })
    const otherId = await c.create({ name: '发版' })
    const second = await c.joinSession({ sessionId: 'mine', channelId: otherId, name: '随便写的' })
    expect(second.memberId).toBe(first.memberId)
    expect(c.state().members.filter(m => m.kind === 'agent')).toHaveLength(1)
    expect(c.state().sessionBindings?.mine).toHaveLength(2)
    await c.leaveSession('mine', first.channelId)
    expect(c.state().sessionBindings?.mine).toEqual([{ channelId: otherId, memberId: first.memberId }])
    expect(c.state().members.some(m => m.id === first.memberId)).toBe(true)
    await c.leaveSession('mine', otherId)
    expect(c.state().members.some(m => m.id === first.memberId)).toBe(false)
    expect(c.state().sessionBindings).toEqual({})
    expect(engine.sessions.some(s => s.record.id === 'mine')).toBe(true)
  })

  it('不能加入：会话不存在、归档了、名字重了（名字不对时不留下新建的空频道）；编辑成员不丢绑定', async () => {
    const c = await open()
    own('mine')
    own('old', { archivedAt: 1 })
    await c.saveMember(null, agent('审查员'))
    await expect(c.joinSession({ sessionId: 'nope', channelName: 'x', name: 'a' })).rejects.toThrow('会话不存在')
    await expect(c.joinSession({ sessionId: 'old', channelName: 'x', name: 'a' })).rejects.toThrow('归档')
    await expect(c.joinSession({ sessionId: 'mine', channelName: '新频道', name: '审查员' })).rejects.toThrow(
      '已经有同名的 AI 成员',
    )
    await expect(c.joinSession({ sessionId: 'mine', channelName: '新频道', name: '全体' })).rejects.toThrow('全体')
    expect(c.state().channels).toHaveLength(0)
    const { memberId } = await c.joinSession({ sessionId: 'mine', channelName: '新频道', name: '前端助手' })
    const config = c.state().members.find(m => m.id === memberId)!
    if (config.kind !== 'agent' || !config.config) throw new Error('成员不对')
    await c.saveMember(null, { ...config.config, instructions: '改了职责' })
    expect(c.state().members.find(m => m.id === memberId)).toMatchObject({
      config: { bound: true, sharedSessionId: 'mine', instructions: '改了职责' },
    })
  })
})

const file = (id: string) => ({
  id,
  name: `${id}.log`,
  bytes: 5,
  lines: 1,
  encoding: 'utf-8' as const,
  text: 'hello',
})
/** 发给会话的消息里带的附件 */
const sentWith = () =>
  engine.calls
    .filter(x => x.channel === 'engine:send')
    .map(x => x.args[1] as { text: string; attachments?: { id: string }[]; files?: { id: string }[] })

describe('协作频道：附件（本机频道）', () => {
  it('消息带图片和文件：全文另存，消息里只有说明；派活时一起发给会话，提示词说一句', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    const { message } = await c.post(channelId, {
      text: '@前端助手 看下这个报错',
      clientId: 'p1',
      attachments: [image('shot')],
      files: [file('err')],
    })
    await settle()
    expect(message.attached).toEqual({
      images: [{ id: 'shot', name: 'shot.png', mediaType: 'image/png', bytes: 70, width: 1, height: 1 }],
      files: [{ id: 'err', name: 'err.log', bytes: 5, lines: 1, encoding: 'utf-8' }],
    })
    expect(JSON.stringify(texts(c, channelId)[0])).not.toContain(PNG)
    expect(await c.attachments(channelId, message.id)).toEqual({ images: [image('shot')], files: [file('err')] })
    const [sent] = sentWith()
    expect(sent.attachments?.map(i => i.id)).toEqual(['shot'])
    expect(sent.files?.map(f => f.id)).toEqual(['err'])
    expect(sent.text).toContain('这次的要求：\n@前端助手 看下这个报错\n（附 1 张图片、1 个文件）')
    // 重启后附件还在；runs.json 里不存图片
    await c.dispose()
    const again = await open()
    expect(await again.attachments(channelId, message.id)).toEqual({ images: [image('shot')], files: [file('err')] })
    expect(JSON.stringify([...(again as unknown as { store: ChannelStore }).store.runs.values()])).not.toContain(PNG)
  })

  it('只有图片也能发；没 @ 人就只是一条消息，标题用文件名；历史里写明带了附件', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await expect(c.post(channelId, { text: '  ', clientId: 'e' })).rejects.toThrow('消息不能为空')
    const { tasks: none } = await c.post(channelId, { text: '', clientId: 'i1', attachments: [image('a')] })
    expect(none).toEqual([])
    await c.post(channelId, { text: '@前端助手', clientId: 'i2', attachments: [image('b')] })
    await settle()
    expect(tasks(c, channelId)[0].title).toBe('b.png')
    expect(sentWith()[0].text).toContain('林夏：（附 1 张图片）')
  })

  it('还在做时追加的要求带附件：做完后跟着下一轮一起发；还没开始就失败的重试照样带', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    const task = tasks(c, channelId)[0]
    await c.post(channelId, { text: '按这张图改', replyToId: task.id, clientId: '2', attachments: [image('ref')] })
    complete(c, 's1', `ch-${task.id}-1`, '改好了')
    await settle()
    expect(
      sentWith()
        .at(-1)
        ?.attachments?.map(i => i.id),
    ).toEqual(['ref'])
    expect(sentWith().at(-1)?.text).toContain('按这张图改\n（附 1 张图片）')

    engine.fail.set('engine:send', '发送失败')
    await c.post(channelId, { text: '@前端助手 再看看', clientId: '3', files: [file('f')] })
    complete(c, 's1', `ch-${task.id}-2`, '好')
    await settle()
    const second = tasks(c, channelId)[1]
    expect(second.status).toBe('failed')
    engine.fail.delete('engine:send')
    await c.taskAction(second.id, 'retry')
    await settle()
    expect(
      sentWith()
        .at(-1)
        ?.files?.map(f => f.id),
    ).toEqual(['f'])
  })

  it('追加要求的附件和原来的合起来超过 5 张：多的不带，并告诉 AI', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 改按钮', clientId: '1' })
    await settle()
    const task = tasks(c, channelId)[0]
    const pics = (ids: string[]) => ids.map(image)
    await c.post(channelId, {
      text: '参考图',
      replyToId: task.id,
      clientId: '2',
      attachments: pics(['a', 'b', 'c', 'd']),
    })
    await c.post(channelId, { text: '还有这些', replyToId: task.id, clientId: '3', attachments: pics(['e', 'f']) })
    complete(c, 's1', `ch-${task.id}-1`, '改好了')
    await settle()
    const last = sentWith().at(-1)!
    expect(last.attachments?.map(i => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(last.text).toContain('（频道里还有 1 张图片 超过一条消息的上限，这次没带上）')
  })

  it('读附件期间取消了任务卡：不再发给会话，卡片仍是已取消', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    const store = (c as unknown as { store: ChannelStore }).store
    const original = store.readAttachments.bind(store)
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    vi.spyOn(store, 'readAttachments').mockImplementation(async (...args) => {
      await gate
      return original(...args)
    })
    await c.post(channelId, { text: '@前端助手 看下这个报错', clientId: 'p1', files: [file('err')] })
    await settle()
    const task = tasks(c, channelId)[0]
    await c.taskAction(task.id, 'cancel')
    release()
    await settle()
    expect(sentWith()).toEqual([])
    expect(tasks(c, channelId)[0]).toMatchObject({ status: 'stopped', note: 'cancelled' })
  })

  it('路径引用：本机成员带路径；SSH 成员不带、提示词说一声，内联内容的只去掉路径', async () => {
    machines.push({ id: 'ssh-ab', name: 'dev-box', connected: true })
    const c = await open()
    const here = await c.saveMember(null, agent('本机助手'))
    const there = await c.saveMember(null, agent('远端助手', { projectId: 'ssh-ab~p2' }))
    const channelId = await c.create({ name: 'ch', memberIds: [here, there] })
    const reference = {
      id: 'jar',
      name: 'mod.jar',
      bytes: 9,
      lines: 0,
      encoding: 'utf-8' as const,
      text: '',
      path: 'E:\\mods\\mod.jar',
      pathOnly: true,
    }
    const log = { ...file('err'), path: 'E:\\mods\\err.log' }
    await c.post(channelId, { text: '@本机助手 @远端助手 看下', clientId: 'p1', files: [reference, log] })
    await settle()
    const sends = sentWith() as { text: string; files?: { id: string; path?: string }[] }[]
    expect(sends).toHaveLength(2)
    const remote = sends.find(s => s.text.includes('附件 mod.jar 在发送人的电脑上'))!
    const local = sends.find(s => s !== remote)!
    expect(local.files?.map(f => f.path)).toEqual([reference.path, log.path])
    expect(remote.files?.map(f => [f.id, f.path])).toEqual([['err', undefined]])
  })

  it('格式不对的附件不收；团队频道不支持附件', async () => {
    const c = await open()
    const channelId = await c.create({ name: 'ch', memberIds: [] })
    await expect(
      c.post(channelId, {
        text: 'x',
        clientId: 'b',
        attachments: [{ ...image('x'), mediaType: 'image/bmp' as 'image/png' }],
      }),
    ).rejects.toThrow('图片附件格式不正确')
    expect(await c.attachments(channelId, 'nope')).toEqual({ images: [], files: [] })
  })
})

describe('协作频道：失败、停止、重试', () => {
  it('机器没连上 → 失败；重试时还没开始的原样再发，做到一半的发「继续」', async () => {
    machines.push({ id: 'ssh-ab', name: 'build-01', connected: false })
    const c = await open()
    const a = await c.saveMember(null, agent('构建助手', { projectId: 'ssh-ab~p2' }))
    expect(c.state().members.find(m => m.id === a)).toMatchObject({
      status: 'offline',
      machineId: 'ssh-ab',
      machine: 'build-01',
    })
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@构建助手 打包', clientId: '1' })
    await settle()
    const task = tasks(c, channelId)[0]
    expect(task).toMatchObject({ status: 'failed', error: '机器「build-01」未连接' })
    machines[1].connected = true
    await c.taskAction(task.id, 'retry')
    await settle()
    const first = engine.sends()[0]
    expect(first).toMatchObject({ sessionId: 'ssh-ab~s1', clientMessageId: `ch-${task.id}-2` })
    expect(first.text).toContain('打包')
    // 开始后失败 → 重试发「继续」
    c.hostEvent(ev('ssh-ab~s1', userItem(first.clientMessageId, 'k')))
    c.hostEvent(
      ev('ssh-ab~s1', { type: 'turn_completed', turnId: 'k', outcome: 'failed', error: '502 Bad Gateway\nmore' }),
    )
    // 宿主每轮结束都紧跟一个队列事件；这条不在队列里（没有自动重连）才算失败
    c.hostEvent(ev('ssh-ab~s1', { type: 'queue', items: [], paused: true }))
    expect(tasks(c, channelId)[0]).toMatchObject({ status: 'failed', error: '502 Bad Gateway' })
    await c.taskAction(task.id, 'retry')
    await settle()
    expect(engine.sends().at(-1)).toMatchObject({
      sessionId: 'ssh-ab~s1',
      text: '继续',
      clientMessageId: `ch-${task.id}-3`,
    })
  })

  it('取消排队的活；停止进行中的活；会话被删 → 失败', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 一', clientId: '1' })
    await c.post(channelId, { text: '@前端助手 二', clientId: '2' })
    await settle()
    const [one, two] = tasks(c, channelId)
    await c.taskAction(two.id, 'cancel')
    expect(tasks(c, channelId)[1]).toMatchObject({ status: 'stopped', note: 'cancelled' })
    c.hostEvent(ev('s1', userItem(`ch-${one.id}-1`, 'k')))
    await c.taskAction(one.id, 'stop')
    expect(engine.calls.at(-1)).toEqual({ channel: 'engine:interruptTurn', args: ['s1', 'k'] })
    c.hostEvent(ev('s1', { type: 'turn_completed', turnId: 'k', outcome: 'interrupted', error: null }))
    expect(tasks(c, channelId)[0].status).toBe('stopped')
    // 再派一项，然后删会话
    await c.post(channelId, { text: '@前端助手 三', clientId: '3' })
    await settle()
    engine.sessions.splice(0)
    c.hostEvent({ kind: 'sessions', sessions: [] })
    expect(tasks(c, channelId)[2]).toMatchObject({ status: 'failed', error: '会话已删除' })
  })

  it('会话发送失败时卡片显示失败原因', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    engine.fail.set('engine:send', '项目目录不存在')
    await c.post(channelId, { text: '@前端助手 做', clientId: '1' })
    await settle()
    expect(tasks(c, channelId)[0]).toMatchObject({ status: 'failed', error: '项目目录不存在' })
  })
})

describe('成员的推理强度、Fast、Ultracode（docs/ui/channels-pipeline.md 第 19 项）', () => {
  it('存进成员配置，新开会话时带上、不改「记住会话里的选择」的默认值；不写就是跟随默认，乱写的不收', async () => {
    const c = await open()
    const a = await c.saveMember(
      null,
      agent('前端助手', { settings: { effort: 'max', fast: true, ultracode: false, permissionMode: 'ask' } }),
    )
    const b = await c.saveMember(null, agent('后端助手', { settings: { fast: 'yes' as never } }))
    const config = (id: string) => c.state().members.find((m): m is AgentMember => m.id === id && m.kind === 'agent')
    expect(config(a)).toMatchObject({ config: { settings: { effort: 'max', fast: true, ultracode: false } } })
    expect(config(b)?.config?.settings).not.toHaveProperty('fast')
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 做', clientId: '1' })
    await settle()
    expect(engine.calls.find(x => x.channel === 'engine:createSession')?.args[0]).toMatchObject({
      effort: 'max',
      fast: true,
      ultracode: false,
      rememberChoices: false,
    })
  })

  it('一直用同一个会话的成员：改了推理强度那几项，同步到那个会话；改回跟随默认的不动', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手', { mode: 'shared' }))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 做', clientId: '1' })
    await settle()
    await c.saveMember(null, agent('前端助手', { id: a, mode: 'shared', settings: { effort: 'low', fast: true } }))
    expect(engine.calls.at(-1)).toEqual({
      channel: 'engine:updateSession',
      args: ['s1', { effort: 'low', fast: true }],
    })
    const before = engine.calls.length
    await c.saveMember(null, agent('前端助手', { id: a, mode: 'shared', settings: { effort: 'low' } }))
    expect(engine.calls.length).toBe(before)
  })
})

describe('「需要你」：标为已处理、找不到目标（docs/ui/channels-collab-v2.md §2.1）', () => {
  it('会话删了的失败算找不到会话；标为已处理后不再出现，重启后还记得，可以恢复', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const b = await c.saveMember(null, agent('后端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a, b] })
    await c.post(channelId, { text: '@前端助手 一', clientId: '1' })
    await c.post(channelId, { text: '@后端助手 二', clientId: '2' })
    await settle()
    const two = tasks(c, channelId)[1]
    engine.sessions.splice(1)
    c.hostEvent({ kind: 'sessions', sessions: engine.sessions })
    const need = c.state().needs?.find(n => n.key === `failed:${two.id}`)
    expect(need).toMatchObject({ kind: 'failed', gone: 'session', detail: '会话已删除' })

    await c.markNeeds([{ channelId, key: need!.key, sig: need!.sig }], true)
    expect(c.state().needs?.some(n => n.key === need!.key)).toBe(false)
    expect(c.state().needsDone?.map(n => n.key)).toEqual([need!.key])
    await settle()
    await c.dispose()

    const again = await open()
    expect(again.state().needs?.some(n => n.key === need!.key)).toBe(false)
    await again.markNeeds([{ channelId, key: need!.key, sig: need!.sig }], false)
    expect(again.state().needs?.some(n => n.key === need!.key)).toBe(true)
    expect(again.state().needsDone).toEqual([])
  })

  it('会话列表里还没有那台机器的会话（刚连上、没拉到列表）时不算找不到会话', async () => {
    machines.push({ id: 'ssh-ab', name: 'build-01', connected: true })
    const c = await open()
    const a = await c.saveMember(null, agent('构建助手', { projectId: 'ssh-ab~p2' }))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@构建助手 打包', clientId: '1' })
    await settle()
    const task = tasks(c, channelId)[0]
    const cmid = engine.sends()[0].clientMessageId
    c.hostEvent(ev('ssh-ab~s1', userItem(cmid, 'k')))
    c.hostEvent(ev('ssh-ab~s1', { type: 'turn_completed', turnId: 'k', outcome: 'failed', error: '502' }))
    c.hostEvent(ev('ssh-ab~s1', { type: 'queue', items: [], paused: true }))
    expect(tasks(c, channelId)[0]).toMatchObject({ status: 'failed', sessionId: 'ssh-ab~s1' })
    // 本机还有会话，build-01 的一个都没有：不判断
    engine.sessions.splice(0)
    engine.sessions.push({ record: { id: 'local-1', projectId: 'p1' }, state: 'idle' } as SessionSummary)
    const key = `failed:${task.id}`
    expect(c.state().needs?.find(n => n.key === key)?.gone).toBeUndefined()
    // 拉到了 build-01 的会话列表、里面没有这个会话：找不到会话
    engine.sessions.push({ record: { id: 'ssh-ab~s9', projectId: 'ssh-ab~p2' }, state: 'idle' } as SessionSummary)
    expect(c.state().needs?.find(n => n.key === key)?.gone).toBe('session')
  })

  it('又失败一次（sig 变了）重新出现；成员删了的算找不到成员', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    engine.fail.set('engine:send', '项目目录不存在')
    await c.post(channelId, { text: '@前端助手 做', clientId: '1' })
    await settle()
    const task = tasks(c, channelId)[0]
    const first = c.state().needs!.find(n => n.key === `failed:${task.id}`)!
    expect(first.gone).toBeUndefined()
    await c.markNeeds([{ channelId, key: first.key, sig: first.sig }], true)
    expect(c.state().needs).toEqual([])
    await c.taskAction(task.id, 'retry')
    await settle()
    expect(c.state().needs!.find(n => n.key === first.key)).toMatchObject({ sig: '2' })

    await c.deleteMember(a)
    expect(c.state().needs!.find(n => n.key === first.key)?.gone).toBe('member')
  })

  it('启动时还没结束、却没有运行记录的任务卡标成已停止，不再挂在跟进中', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: 'ch', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 改', clientId: '1' })
    await settle()
    const task = tasks(c, channelId)[0]
    c.hostEvent(ev('s1', userItem(`ch-${task.id}-1`, 'k')))
    expect(c.state().following?.map(f => f.taskId)).toEqual([task.id])
    await settle()
    await c.dispose()
    await writeFile(join(dir, 'runs.json'), '[]')

    const again = await open()
    expect(tasks(again, channelId)[0]).toMatchObject({ status: 'stopped' })
    expect(again.state().following).toEqual([])
  })
})

describe('协作频道：存储与对账', () => {
  it('重启后消息、任务、成员都还在；没做完的按会话快照对账', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: '网页版', memberIds: [a] })
    await c.post(channelId, { text: '@前端助手 改', clientId: '1' })
    await settle()
    const task = tasks(c, channelId)[0]
    c.hostEvent(ev('s1', userItem(`ch-${task.id}-1`, 'k')))
    await settle()
    await c.dispose()

    engine.snapshots.set('s1', {
      record: { id: 's1', lastOutcome: 'completed' },
      state: 'idle',
      turnId: null,
      pending: [],
      queue: [],
      items: [
        { kind: 'user', id: `ch-${task.id}-1`, text: '', createdAt: 0, turnId: 'k' },
        { kind: 'assistant', id: 'a', text: '离线时做完了', status: 'completed' },
      ],
    } as unknown as SessionSnapshot)
    const again = await open()
    expect(again.state().channels.map(x => x.name)).toEqual(['网页版'])
    expect(tasks(again, channelId)[0]).toMatchObject({ status: 'running', sessionId: 's1' })
    await again.reconcile()
    expect(tasks(again, channelId)[0]).toMatchObject({ status: 'done', summary: '离线时做完了' })
    expect(texts(again, channelId).at(-1)?.text).toBe('离线时做完了')
  })

  it('老数据里已经叫「全体」的成员：不改名照样能保存', async () => {
    const c = await open()
    const id = await c.saveMember(null, agent('旧名'))
    const store = (c as unknown as { store: ChannelStore }).store
    store.members = store.members.map(m => (m.id === id ? { ...m, name: '全体' } : m))
    await expect(c.saveMember(null, { ...agent('全体', { instructions: '新职责' }), id })).resolves.toBe(id)
    await expect(c.saveMember(null, { ...agent('All'), id })).rejects.toThrow('留给 @全体')
  })

  it('改名、改主题、移除成员、删除频道', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端助手'))
    const channelId = await c.create({ name: '旧名', memberIds: [a] })
    await expect(c.create({ name: '旧名' })).rejects.toThrow('已经有同名的频道')
    await expect(c.saveMember(null, agent('前端助手'))).rejects.toThrow('已经有同名的 AI 成员')
    await expect(c.saveMember(null, agent('全体'))).rejects.toThrow('留给 @全体')
    await expect(c.saveMember(null, agent('All'))).rejects.toThrow('留给 @全体')
    await expect(c.saveMember(null, { ...agent('全体'), id: a })).rejects.toThrow('留给 @全体')
    await c.update(channelId, { name: '新名', topic: '主题' })
    await c.removeMember(channelId, a)
    const events = c
      .messages(channelId)
      .messages.filter(m => m.kind === 'event')
      .map(m => m.kind === 'event' && m.event)
    expect(events).toEqual(['added', 'renamed', 'topic', 'removed'])
    expect(c.state().channels[0]).toMatchObject({ name: '新名', topic: '主题', memberIds: [SELF_ID] })
    await c.deleteMember(a)
    expect(c.state().members.map(m => m.id)).toEqual([SELF_ID])
    await c.delete(channelId)
    expect(c.state().channels).toEqual([])
    const again = await open()
    expect(again.state().channels).toEqual([])
  })
})

describe('消息分页', () => {
  it('同一毫秒的几条消息跨在两页之间：按最早那条的 id 往前取，一条不漏；只给时间时照旧按时间', async () => {
    const c = await open()
    const channelId = await c.create({ name: '分页' })
    const texts: string[] = []
    const post = async (i: number, at?: number) => {
      // 指定 at 时把时钟拨回去，这一条的时间就是 at（和上一条同一毫秒）
      if (at !== undefined) now = at - 1
      const { message } = await c.post(channelId, { text: `第 ${i} 条`, clientId: `m${i}` })
      texts.push(`第 ${i} 条`)
      return message
    }
    await post(0)
    const first = await post(1)
    const second = await post(2, first.at)
    expect(second.at).toBe(first.at)
    for (let i = 3; i < 202; i++) await post(i)

    const latest = c.messages(channelId)
    expect(latest.messages).toHaveLength(200)
    expect(latest.more).toBe(true)
    const oldest = latest.messages[0]
    expect(oldest.id).toBe(second.id)

    const older = c.messages(channelId, oldest.at, oldest.id)
    expect(older.more).toBe(false)
    const shown = [...older.messages, ...latest.messages].map(m => (m as ChannelTextMessage).text)
    expect(shown).toEqual(texts)
    // 不给 id（老的调用）：按时间，同一毫秒的被排除
    expect(c.messages(channelId, oldest.at).messages.map(m => m.id)).not.toContain(first.id)
    // id 不在了：退回按时间
    expect(c.messages(channelId, oldest.at, 'gone').messages).toHaveLength(1)
    // 要发 202 条（每条写盘）：整套测试并行跑时比单跑慢得多
  }, 30_000)
})

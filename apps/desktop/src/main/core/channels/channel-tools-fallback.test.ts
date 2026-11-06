// 模型拿不到 task_done、看不到图的兜底：回复里交付、步骤和交接带图、attachment_read、主对话带图
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineEvent, HostEvent, Item, OpenedSession, ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import type { AgentInput, ChannelFlow, ChannelTask, ChannelTextMessage } from '../../../shared/types/channels'
import { ChannelStore } from './store'
import { sessionTail, tailOptions } from '../engine/tail'
import { Channels, type ChannelsDeps } from './service'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const image = (id: string) => ({
  id,
  name: `${id}.png`,
  mediaType: 'image/png' as const,
  bytes: 70,
  width: 1,
  height: 1,
  dataBase64: PNG,
})
const projects = [{ id: 'p1', name: 'web', path: 'D:/web' } as ProjectRecord]

let dir: string
let opened: Channels[]
let calls: { channel: string; args: unknown[] }[]
let sessions: SessionSummary[]
let tail: Item[]

async function open(extra: Partial<ChannelsDeps> = {}): Promise<Channels> {
  const store = new ChannelStore(dir)
  await store.init()
  let n = 0
  let now = 1_000_000
  const c = new Channels({
    store,
    call: async (channel, args) => {
      calls.push({ channel, args })
      if (channel === 'engine:createSession') {
        const id = `s${++n}`
        sessions.push({ record: { id, projectId: 'p1' }, state: 'idle' } as SessionSummary)
        return { id }
      }
      if (channel === 'engine:send')
        return { queueId: (args[1] as { clientMessageId: string }).clientMessageId, status: 'queued' }
      // 用真实的 sessionTail：返回形状和去掉图片数据都和线上一样
      if (channel === 'engine:openSessionTail')
        return sessionTail({ snapshot: { items: tail }, seq: 0 } as unknown as OpenedSession, tailOptions(args[1]))
      if (channel === 'engine:image') return image(args[2] as string)
      return null
    },
    emit: () => {},
    machines: () => [{ id: 'local', name: 'PC', connected: true }],
    projects: () => projects,
    sessions: () => sessions,
    machineOf: () => 'local',
    selfName: () => '林夏',
    locale: () => 'zh-CN',
    now: () => ++now,
    channelTools: true,
    alertTimer: false,
    planFirst: false,
    ...extra,
  })
  opened.push(c)
  return c
}

const agent = (name: string): AgentInput => ({
  name,
  engine: 'claude',
  projectId: 'p1',
  copyId: null,
  settings: {},
  instructions: '',
  mode: 'per-task',
})
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2))
    for (const c of opened) await (c as unknown as { store: ChannelStore }).store.flush()
  }
}
type Sent = { sessionId: string; text: string; clientMessageId: string; attachments?: { id: string }[] }
const sends = (): Sent[] =>
  calls
    .filter(c => c.channel === 'engine:send')
    .map(c => ({ sessionId: c.args[0] as string, ...(c.args[1] as Omit<Sent, 'sessionId'>) }))
const lastTo = (s: string) =>
  sends()
    .filter(x => x.sessionId === s)
    .at(-1)!
const tasks = (c: Channels, id: string) => c.messages(id).messages.filter((m): m is ChannelTask => m.kind === 'task')
const flowOf = (c: Channels, id: string): ChannelFlow =>
  c.messages(id).messages.find((m): m is ChannelTextMessage => m.kind === 'message' && !!m.flow)!.flow!
const ev = (sessionId: string, event: EngineEvent): HostEvent => ({ kind: 'session', sessionId, seq: 0, event })
async function endTurn(c: Channels, s: string, reply: string): Promise<void> {
  const turn = `turn-${lastTo(s).clientMessageId}`
  c.hostEvent(
    ev(s, {
      type: 'item_completed',
      item: { kind: 'user', id: lastTo(s).clientMessageId, text: '', createdAt: 0, turnId: turn },
    }),
  )
  c.hostEvent(
    ev(s, { type: 'item_completed', item: { kind: 'assistant', id: `a-${turn}`, text: reply, status: 'completed' } }),
  )
  c.hostEvent(ev(s, { type: 'turn_completed', turnId: turn, outcome: 'completed', error: null }))
  await settle()
}
const userItem = (id: string, attachments?: ReturnType<typeof image>[]): Item =>
  ({ kind: 'user', id, text: '', createdAt: 0, ...(attachments ? { attachments } : {}) }) as Item

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsky-chtools-'))
  opened = []
  calls = []
  sessions = []
  tail = []
})
afterEach(async () => {
  for (const c of opened) await (c as unknown as { store: ChannelStore }).store.flush()
  await rm(dir, { recursive: true, force: true })
})

async function oneStepFlow(c: Channels, kind: 'work' | 'review' = 'work') {
  const a = await c.saveMember(null, agent('画师'))
  const ch = await c.create({ name: 'web', memberIds: [a] })
  const steps = [{ id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' as const }]
  if (kind === 'review')
    steps.push({ id: 's2', title: '审', memberId: a, deps: ['s1'], kind: 'review', target: 's1' } as never)
  const { messageId } = await c.flowAction(ch, { type: 'create', title: '画图', steps })
  await c.flowAction(ch, { type: 'start', messageId })
  await settle()
  return { ch, s1: tasks(c, ch).find(t => t.flow?.stepId === 's1')!.sessionId! }
}

describe('没有 task_done 工具时写在回复里交付', () => {
  it('带 task_done: true 的 JSON 算交付，流程往下走，不再提醒', async () => {
    const c = await open()
    const { ch, s1 } = await oneStepFlow(c)
    expect(lastTo(s1).text).toContain('"task_done": true')
    await endTurn(c, s1, '画好了\n```json\n{"task_done": true, "summary": "贴图画好了", "files": ["a.png"]}\n```')
    expect(sends()).toHaveLength(1)
    expect(flowOf(c, ch).steps[0]).toMatchObject({ status: 'delivered', result: { summary: '贴图画好了' } })
    expect(flowOf(c, ch).status).toBe('done')
  })

  it('没有标记的 JSON、没写 summary 的都不算，照常提醒', async () => {
    const c = await open()
    const { ch, s1 } = await oneStepFlow(c)
    await endTurn(c, s1, '```json\n{"summary": "只是举个例子"}\n```')
    expect(lastTo(s1).text).toContain('还没有调用 task_done')
    expect(flowOf(c, ch).steps[0].status).toBe('running')
    await endTurn(c, s1, '```json\n{"task_done": true}\n```')
    expect(flowOf(c, ch)).toMatchObject({ status: 'paused', paused: { reason: 'no-delivery' } })
  })

  it('审查步骤同样要写 verdict', async () => {
    const c = await open()
    const { ch, s1 } = await oneStepFlow(c, 'review')
    await endTurn(c, s1, '```json\n{"task_done": true, "summary": "好了"}\n```')
    await settle()
    const s2 = tasks(c, ch).find(t => t.flow?.stepId === 's2')!.sessionId!
    await endTurn(c, s2, '```json\n{"task_done": true, "summary": "看过了"}\n```')
    expect(flowOf(c, ch).steps[1].status).toBe('running')
    await endTurn(c, s2, '```json\n{"task_done": true, "summary": "看过了", "verdict": "pass"}\n```')
    expect(flowOf(c, ch).steps[1]).toMatchObject({ status: 'delivered', result: { verdict: 'pass' } })
  })
})

describe('带图', () => {
  it('流程的每一步开工时带上发起消息的图；第二轮不重发', async () => {
    const c = await open({ planFirst: true })
    const a = await c.saveMember(null, agent('画师'))
    const ch = await c.create({ name: 'web', memberIds: [a] })
    await c.post(ch, { text: '@画师 按这张图改', clientId: 'p', attachments: [image('i')] })
    await settle()
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    expect(flowOf(c, ch).attach).toHaveLength(1)
    await endTurn(
      c,
      tasks(c, ch)[0].sessionId!,
      '```json\n{"summary": "计划", "steps": [{"title": "改", "member": "画师"}]}\n```',
    )
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s = tasks(c, ch).find(t => t.flow?.stepId && t.flow.stepId !== '')!.sessionId!
    expect(lastTo(s).attachments?.map(i => i.id)).toEqual(['i'])
    expect(lastTo(s).text).toContain('attachment_read')
    await endTurn(c, s, '做好了')
    expect(lastTo(s).text).toContain('还没有调用 task_done')
    expect(lastTo(s).attachments ?? []).toHaveLength(0)
    // 第二轮不重发，但工具还读得到
    const read = await c.toolAttachments(s)
    expect(read.images.map(i => i.id)).toEqual(['i'])
  })

  it('交接带上手上那项活的图；提议派出去时也带', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const b = await c.saveMember(null, agent('审查员'))
    const d = await c.saveMember(null, agent('文档'))
    const ch = await c.create({ name: 'web', memberIds: [a, b, d] })
    await c.update(ch, { relay: true })
    await c.post(ch, { text: '@前端 按图改', clientId: 'go', attachments: [image('i')] })
    await settle()
    const s = sends()[0].sessionId
    await c.toolHandover(s, '审查员', '看一下')
    await settle()
    expect(
      sends()
        .at(-1)!
        .attachments?.map(i => i.id),
    ).toEqual(['i'])

    await c.toolPropose(s, '文档', '补说明')
    const proposal = c
      .messages(ch)
      .messages.filter((m): m is ChannelTextMessage => m.kind === 'message')
      .at(-1)!
    await c.proposal(ch, proposal.id, true)
    await settle()
    expect(
      sends()
        .at(-1)!
        .attachments?.map(i => i.id),
    ).toEqual(['i'])
  })

  it('attachment_read：只读这个频道的；不存在的 id 报错；没有附件时说明', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const ch = await c.create({ name: 'web', memberIds: [a] })
    const other = await c.create({ name: 'other', memberIds: [] })
    const secret = await c.post(other, { text: '别的频道', clientId: 'x', attachments: [image('secret')] })
    const { message } = await c.post(ch, { text: '@前端 看', clientId: 'go' })
    await settle()
    const s = sends()[0].sessionId
    expect((await c.toolAttachments(s)).text).toContain('没有图片')
    await expect(c.toolAttachments(s, secret.message.id)).rejects.toThrow('频道里没有')
    await expect(c.toolAttachments(s, '../../x')).rejects.toThrow('频道里没有')
    expect((await c.toolAttachments(s, message.id)).images).toEqual([])
  })

  it('不能看图的引擎：不给图，说明别开电脑控制', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const ch = await c.create({ name: 'web', memberIds: [a] })
    await c.post(ch, { text: '@前端 看', clientId: 'go', attachments: [image('i')] })
    await settle()
    const s = sends()[0].sessionId
    const store = (c as unknown as { store: ChannelStore }).store
    store.members = store.members.map(m => ({ ...m, engine: 'nope' as never }))
    const read = await c.toolAttachments(s)
    expect(read.images).toEqual([])
    expect(read.text).toContain('不要开电脑控制')
  })
})

describe('修过的回归', () => {
  it('照抄示例的占位摘要不算交付，走提醒', async () => {
    const c = await open()
    const { ch, s1 } = await oneStepFlow(c)
    await endTurn(c, s1, '还没做完，做完后会写 {"task_done": true, "summary": "...", "files": ["..."]} 交付')
    expect(flowOf(c, ch).steps[0].status).toBe('running')
    expect(lastTo(s1).text).toContain('还没有调用 task_done')
  })

  it('继承的图第二轮还在；追加要求带的图第三轮还在，再交接也带上', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const b = await c.saveMember(null, agent('审查员'))
    const d = await c.saveMember(null, agent('文档'))
    const ch = await c.create({ name: 'web', memberIds: [a, b, d] })
    await c.update(ch, { relay: true })
    await c.post(ch, { text: '@前端 按图改', clientId: 'go', attachments: [image('i')] })
    await settle()
    const s = sends()[0].sessionId
    await c.toolPropose(s, '审查员', '看一下')
    const proposal = c
      .messages(ch)
      .messages.filter((m): m is ChannelTextMessage => m.kind === 'message')
      .at(-1)!
    expect((await c.toolAttachments(s, proposal.id)).images.map(i => i.id)).toEqual(['i'])
    await c.proposal(ch, proposal.id, true)
    await settle()
    const peer = tasks(c, ch).at(-1)!
    const s2 = peer.sessionId!
    await endTurn(c, s2, '看了')
    await c.post(ch, { text: '再看看', replyToId: peer.id, clientId: 'r2', attachments: [image('j')] })
    await settle()
    expect(lastTo(s2).attachments?.map(i => i.id)).toEqual(['j'])
    await endTurn(c, s2, '又看了')
    await c.post(ch, { text: '最后看看', replyToId: peer.id, clientId: 'r3' })
    await settle()
    expect(lastTo(s2).attachments ?? []).toHaveLength(0)
    expect((await c.toolAttachments(s2)).images.map(i => i.id).sort()).toEqual(['i', 'j'])
    await c.toolHandover(s2, '文档', '补说明')
    await settle()
    expect(
      sends()
        .at(-1)!
        .attachments?.map(i => i.id)
        .sort(),
    ).toEqual(['i', 'j'])
  })

  it('改计划时补的图：工具读得到，开工后每一步都带', async () => {
    const c = await open({ planFirst: true })
    const a = await c.saveMember(null, agent('画师'))
    const ch = await c.create({ name: 'web', memberIds: [a] })
    await c.post(ch, { text: '@画师 拆一下', clientId: 'p' })
    await settle()
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    const planner = tasks(c, ch)[0].sessionId!
    await endTurn(c, planner, '```json\n{"summary": "计划", "steps": [{"title": "改", "member": "画师"}]}\n```')
    await c.post(ch, { text: '按这张图改', clientId: 'r', attachments: [image('new')] })
    await settle()
    expect(lastTo(planner).text).toContain('attachment_read')
    expect((await c.toolAttachments(planner)).images.map(i => i.id)).toEqual(['new'])
    await endTurn(c, planner, '```json\n{"summary": "计划", "steps": [{"title": "改", "member": "画师"}]}\n```')
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s = tasks(c, ch).find(t => t.flow?.stepId)!.sessionId!
    expect(lastTo(s).attachments?.map(i => i.id)).toEqual(['new'])
  })
})

describe('第二轮复审的回归', () => {
  it('摘要是真的、files 是占位符：占位项不进文件列表', async () => {
    const c = await open()
    const { ch, s1 } = await oneStepFlow(c)
    await endTurn(c, s1, '{"task_done": true, "summary": "贴图画好了", "files": ["…", "a.png"]}')
    const result = flowOf(c, ch).steps[0].result!
    expect(result.summary).toBe('贴图画好了')
    expect(result.files).not.toContain('…')
    expect(result.files.some(f => f.endsWith('a.png'))).toBe(true)
  })

  it('改过一轮计划后换人：新成员照样收到原消息的图', async () => {
    const c = await open({ planFirst: true })
    const a = await c.saveMember(null, agent('画师'))
    const b = await c.saveMember(null, agent('程序员'))
    const ch = await c.create({ name: 'web', memberIds: [a, b] })
    await c.post(ch, { text: '@画师 按图拆一下', clientId: 'p', attachments: [image('i')] })
    await settle()
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    const planner = tasks(c, ch)[0].sessionId!
    const plan = '{"summary": "计划", "steps": [{"title": "改", "member": "画师"}]}'
    await endTurn(c, planner, plan)
    await c.post(ch, { text: '再细一点', clientId: 'r' })
    await settle()
    await endTurn(c, planner, plan)
    await c.flowAction(ch, { type: 'replan', messageId, memberId: b })
    await settle()
    expect(lastTo(tasks(c, ch).at(-1)!.sessionId!).attachments?.map(i => i.id)).toEqual(['i'])
  })
})

describe('主对话带图', () => {
  async function bound() {
    const c = await open()
    sessions.push({ record: { id: 'mine', projectId: 'p1', engine: 'claude' }, state: 'idle' } as SessionSummary)
    const b = await c.saveMember(null, agent('审查员'))
    const ch = await c.create({ name: 'web', memberIds: [b] })
    await c.joinSession({ sessionId: 'mine', channelId: ch, name: '主对话' })
    return { c, ch }
  }

  it('提议带上最近一条带图的用户消息，派出去后对方收到', async () => {
    const { c, ch } = await bound()
    tail = [userItem('old', [image('old')]), userItem('u1', [image('shot')]), userItem('u2')]
    await c.toolPropose('mine', '审查员', '看这张图')
    const m = c
      .messages(ch)
      .messages.filter((x): x is ChannelTextMessage => x.kind === 'message')
      .at(-1)!
    expect(m.attached?.images.map(i => i.id)).toEqual(['shot'])
    expect(m.attached?.images[0]).not.toHaveProperty('dataBase64')
    await c.proposal(ch, m.id, true)
    await settle()
    expect(
      sends()
        .at(-1)!
        .attachments?.map(i => i.id),
    ).toEqual(['shot'])
  })

  it('太早的图不带；读图失败不挡提议', async () => {
    const { c, ch } = await bound()
    tail = [userItem('old', [image('old')]), ...['a', 'b', 'c', 'd', 'e'].map(id => userItem(id))]
    await c.toolPropose('mine', '审查员', '看看')
    const last = () =>
      c
        .messages(ch)
        .messages.filter((x): x is ChannelTextMessage => x.kind === 'message')
        .at(-1)!
    expect(last().attached).toBeUndefined()

    tail = [{ kind: 'user' } as Item, null as unknown as Item]
    await expect(c.toolPropose('mine', '审查员', '再看看')).resolves.toContain('已提议')
    expect(last().attached).toBeUndefined()
  })

  it('频道发进来的消息带的图不算主对话的，不存第二份', async () => {
    const { c, ch } = await bound()
    tail = [userItem('ch-task-1', [image('from-channel')])]
    await c.toolPropose('mine', '审查员', '看看')
    const m = c
      .messages(ch)
      .messages.filter((x): x is ChannelTextMessage => x.kind === 'message')
      .at(-1)!
    expect(m.attached).toBeUndefined()
  })

  it('同一张图既在频道原消息上又在主对话里：只发一张，不会被引擎拒收', async () => {
    const { c, ch } = await bound()
    await c.update(ch, { relay: true })
    await c.post(ch, { text: '@主对话 看图', clientId: 'go', attachments: [image('x')] })
    await settle()
    tail = [userItem('mine-1', [image('x')])]
    await c.toolHandover('mine', '审查员', '你也看看')
    await settle()
    const peer = tasks(c, ch).at(-1)!.sessionId!
    expect(lastTo(peer).attachments?.map(i => i.id)).toEqual(['x'])
    const carried = await c.toolAttachments(peer)
    expect(carried.images.map(i => i.id)).toEqual(['x'])
  })

  it('长回合：用户那条在 128 KB 之外也找得到', async () => {
    const { c, ch } = await bound()
    const noise = Array.from(
      { length: 80 },
      (_, n) => ({ kind: 'assistant', id: 'n' + n, text: 'x'.repeat(4000), status: 'completed' }) as Item,
    )
    tail = [userItem('u1', [image('shot')]), ...noise]
    await c.toolPropose('mine', '审查员', '看这张图')
    const m = c
      .messages(ch)
      .messages.filter((x): x is ChannelTextMessage => x.kind === 'message')
      .at(-1)!
    expect(m.attached?.images.map(i => i.id)).toEqual(['shot'])
    expect(calls.filter(x => x.channel === 'engine:openSessionTail').length).toBeGreaterThan(1)
  })

  it('早就做完的频道任务带的图，不跟着新的活走', async () => {
    const { c, ch } = await bound()
    await c.post(ch, { text: '@主对话 看图', clientId: 'go', attachments: [image('old')] })
    await settle()
    await endTurn(c, 'mine', '看完了')
    await c.toolPropose('mine', '审查员', '另一件事')
    const m = c
      .messages(ch)
      .messages.filter((x): x is ChannelTextMessage => x.kind === 'message')
      .at(-1)!
    expect(m.proposal?.attach).toBeUndefined()
    await c.proposal(ch, m.id, true)
    await settle()
    expect(lastTo(tasks(c, ch).at(-1)!.sessionId!).attachments ?? []).toHaveLength(0)
  })

  it('不是绑定的会话不读主对话', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const b = await c.saveMember(null, agent('审查员'))
    const ch = await c.create({ name: 'web', memberIds: [a, b] })
    await c.post(ch, { text: '@前端 改', clientId: 'go' })
    await settle()
    tail = [userItem('u', [image('x')])]
    await c.toolPropose(sends()[0].sessionId, '审查员', '看看')
    expect(calls.some(x => x.channel === 'engine:openSessionTail')).toBe(false)
  })
})

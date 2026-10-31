// 流程（docs/ui/channels-pipeline.md §4）接进频道服务：依赖调度、task_done、审查打回、member_ask、拆流程、没交付的提醒
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent, HostEvent, ProjectRecord, SessionSummary, UsageRecord } from '@pixelsky/protocol'
import type {
  AgentInput,
  ChannelFlow,
  ChannelMessage,
  ChannelTask,
  ChannelTextMessage,
} from '../../../shared/types/channels'
import { ChannelStore } from './store'
import { Channels, SELF_ID, type ChannelsDeps } from './service'

const projects: ProjectRecord[] = [{ id: 'p1', name: 'pixel-web', path: 'D:/web' } as ProjectRecord]

let dir: string
let now: number
let opened: Channels[]
let calls: { channel: string; args: unknown[] }[]
let sessions: SessionSummary[]
/** 假的用量记录（engine:usageList 按 filter.session 取） */
let usage: UsageRecord[]
/** 设了就让 engine:createSession 等它（模拟建会话很慢） */
let slowCreate: Promise<void> | null
/** 设了就让 engine:cancelQueued 等它（模拟停止很慢） */
let slowCancel: Promise<void> | null

const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2))
    for (const c of opened) await (c as unknown as { store: ChannelStore }).store.flush()
  }
}

async function open(extra: Partial<ChannelsDeps> = {}): Promise<Channels> {
  const store = new ChannelStore(dir)
  await store.init()
  let n = 0
  const c = new Channels({
    store,
    call: async (channel, args) => {
      calls.push({ channel, args })
      if (channel === 'engine:createSession') {
        if (slowCreate) await slowCreate
        const id = `s${++n}`
        sessions.push({ record: { id, projectId: 'p1' }, state: 'idle' } as SessionSummary)
        return { id }
      }
      if (channel === 'engine:cancelQueued' && slowCancel) await slowCancel
      if (channel === 'engine:send')
        return { queueId: (args[1] as { clientMessageId: string }).clientMessageId, status: 'queued' }
      if (channel === 'engine:usageList') {
        const q = args[0] as { filter: { session: string }; offset: number; limit: number }
        const all = usage.filter(r => r.sessionId === q.filter.session)
        return { records: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset }
      }
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
    // @ 派活先出计划另有测试打开；这里沿用直接派活
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
const sends = () =>
  calls
    .filter(c => c.channel === 'engine:send')
    .map(c => ({ sessionId: c.args[0] as string, ...(c.args[1] as { text: string; clientMessageId: string }) }))
const lastTo = (s: string) =>
  sends()
    .filter(x => x.sessionId === s)
    .at(-1)!
const tasks = (c: Channels, id: string) => c.messages(id).messages.filter((m): m is ChannelTask => m.kind === 'task')
const flowOf = (c: Channels, id: string): ChannelFlow =>
  c.messages(id).messages.find((m): m is ChannelTextMessage => m.kind === 'message' && !!m.flow)!.flow!
const stepOf = (c: Channels, ch: string, id: string) => flowOf(c, ch).steps.find(s => s.id === id)!
const sessionOf = (c: Channels, ch: string, stepId: string) =>
  tasks(c, ch).find(t => t.flow?.stepId === stepId)!.sessionId!
const ev = (sessionId: string, event: EngineEvent): HostEvent => ({ kind: 'session', sessionId, seq: 0, event })
const storeOf = (c: Channels) => (c as unknown as { store: ChannelStore }).store
const gate = () => {
  let release!: () => void
  const wait = new Promise<void>(resolve => (release = resolve))
  return { wait, release }
}
/** 符合条件的消息写盘卡住，直到 release（模拟写盘慢） */
function holdAppend(c: Channels, which: (m: ChannelMessage) => boolean): () => void {
  const store = storeOf(c)
  const g = gate()
  const append = store.append.bind(store)
  vi.spyOn(store, 'append').mockImplementation(async m => {
    if (which(m)) await g.wait
    return append(m)
  })
  return g.release
}

/** 这个会话最后收到的那条消息这一轮做完，回复 reply */
async function endTurn(c: Channels, s: string, reply: string): Promise<void> {
  const x = lastTo(s)
  const turn = `turn-${x.clientMessageId}`
  c.hostEvent(
    ev(s, {
      type: 'item_completed',
      item: { kind: 'user', id: x.clientMessageId, text: '', createdAt: 0, turnId: turn },
    }),
  )
  c.hostEvent(
    ev(s, { type: 'item_completed', item: { kind: 'assistant', id: `a-${turn}`, text: reply, status: 'completed' } }),
  )
  c.hostEvent(ev(s, { type: 'turn_completed', turnId: turn, outcome: 'completed', error: null }))
  await settle()
}

async function setup(extra: Partial<ChannelsDeps> = {}) {
  const c = await open(extra)
  const a = await c.saveMember(null, agent('画师'))
  const b = await c.saveMember(null, agent('程序员'))
  const r = await c.saveMember(null, agent('审查员'))
  const ch = await c.create({ name: 'web', memberIds: [a, b, r] })
  return { c, a, b, r, ch }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsky-flow-'))
  now = 1_000_000
  opened = []
  calls = []
  sessions = []
  usage = []
  slowCreate = null
  slowCancel = null
})
afterEach(async () => {
  for (const c of opened) await c.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('流程调度', () => {
  it('① 交付 → ② 带着 ① 的结果开始 → ③ 打回 → ② 第 2 轮 → ③ 再审通过 → ④ 汇总 → 流程完成', async () => {
    const { c, a, b, r, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '登录页新按钮',
      steps: [
        { id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '写代码', memberId: b, deps: ['s1'], kind: 'work', settings: { effort: 'high' } },
        { id: 's3', title: '审查代码', memberId: r, deps: [], kind: 'review', target: 's2' },
        { id: 's4', title: '汇总', memberId: r, deps: ['s3'], kind: 'summary' },
      ],
    })
    await expect(c.flowAction(ch, { type: 'resume', messageId })).resolves.toEqual({ messageId })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    expect(sends()).toHaveLength(1)
    const s1 = sessionOf(c, ch, 's1')
    expect(lastTo(s1).text).toContain('→ ① 画贴图 · 画师 · 进行中')
    expect(c.toolDone(s1, { summary: '贴图画好了', files: ['assets/btn.png'] })).toContain('已交付')
    expect(() => c.toolDone(s1, { summary: '再交一次' })).toThrow('已经交付过了')
    await endTurn(c, s1, '画好了')
    // 迟到的调用不记到别的卡上
    expect(() => c.toolDone(s1, { summary: '晚了' })).toThrow('不在流程里')
    expect(stepOf(c, ch, 's1')).toMatchObject({ status: 'delivered', result: { summary: '贴图画好了' } })

    const s2 = sessionOf(c, ch, 's2')
    expect(lastTo(s2).text).toContain('① 画贴图（画师）：贴图画好了')
    expect(lastTo(s2).text).toContain('assets/btn.png')
    // 这一步的临时设置用在新开的会话上
    const created = calls.filter(x => x.channel === 'engine:createSession').map(x => x.args[0] as { effort?: string })
    expect(created[1].effort).toBe('high')
    c.toolDone(s2, { summary: '按钮写好了' })
    await endTurn(c, s2, '写好了')

    const s3 = sessionOf(c, ch, 's3')
    expect(lastTo(s3).text).toContain('审查 ②「写代码」')
    // 审查自己跑检查、不自己改（docs/ui/channels-pipeline.md §12 第 4 条）
    expect(lastTo(s3).text).toContain('不要采信前一步说的测试结果')
    expect(() => c.toolDone(s3, { summary: '有问题' })).toThrow('verdict')
    expect(() => c.toolDone(s3, { summary: '有问题', verdict: 'reject' })).toThrow('issues')
    c.toolDone(s3, { summary: '有问题', verdict: 'reject', issues: ['按钮没对齐'] })
    await endTurn(c, s3, '打回')
    expect(stepOf(c, ch, 's2')).toMatchObject({ status: 'running', rejects: 1 })
    expect(stepOf(c, ch, 's3').status).toBe('pending')
    expect(lastTo(s2).text).toContain('1. 按钮没对齐')
    expect(lastTo(s2).text).toContain('第 1 / 3 次')

    c.toolDone(s2, { summary: '对齐了' })
    await endTurn(c, s2, '改好了')
    // 再审用原来那张卡、原来的会话
    expect(tasks(c, ch).filter(t => t.flow?.stepId === 's3')).toHaveLength(1)
    expect(lastTo(s3).text).toContain('按你的意见改过了')
    expect(lastTo(s3).text).toContain('对齐了')
    c.toolDone(s3, { summary: '没问题了', verdict: 'pass' })
    await endTurn(c, s3, '通过')

    const s4 = sessionOf(c, ch, 's4')
    expect(s4).not.toBe(s3)
    const prompt = lastTo(s4).text
    expect(prompt).toContain('这是最后一步')
    // 汇总分开验证过的和只是声称的（§12 第 5 条）
    expect(prompt).toContain('只是声称的分开写')
    expect(prompt).toContain('贴图画好了')
    expect(prompt).toContain('对齐了')
    c.toolDone(s4, { summary: '都做完了' })
    await endTurn(c, s4, '总结')
    expect(flowOf(c, ch).status).toBe('done')
    // 步骤的回复里提到同事不另外派活
    expect(tasks(c, ch)).toHaveLength(4)
  })

  it('做完了没 task_done：提醒一次；第二次还没有就停下，出现在「需要你」里；继续后再提醒', async () => {
    const { c, a, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '画图',
      steps: [{ id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' }],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    await endTurn(c, s1, '画好了')
    expect(lastTo(s1).text).toContain('还没有调用 task_done')
    expect(sends()).toHaveLength(2)
    await endTurn(c, s1, '真的画好了')
    expect(sends()).toHaveLength(2)
    expect(flowOf(c, ch)).toMatchObject({ status: 'paused', paused: { reason: 'no-delivery', stepId: 's1' } })
    expect(c.state().needs?.some(n => n.kind === 'flow' && n.pause === 'no-delivery')).toBe(true)

    await c.flowAction(ch, { type: 'resume', messageId })
    await settle()
    expect(sends()).toHaveLength(3)
    c.toolDone(s1, { summary: '好了' })
    await endTurn(c, s1, '好了')
    expect(flowOf(c, ch).status).toBe('done')
  })

  it('member_ask：对方在做时等它这一轮做完再答；回答转给提问的人；对方空闲时马上答', async () => {
    const { c, a, b, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '并行',
      steps: [
        { id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '写代码', memberId: b, deps: [], kind: 'work' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    const s2 = sessionOf(c, ch, 's2')
    await expect(c.toolAsk(s2, '程序员', '自己问自己')).rejects.toThrow('不能交给你自己')
    expect(await c.toolAsk(s2, '画师', '按钮多大？')).toContain('问题已发给 画师')
    await expect(c.toolAsk(s2, '画师', '再问')).rejects.toThrow('已经问过')
    await endTurn(c, s2, '等回答')
    expect(stepOf(c, ch, 's2').status).toBe('asking')
    // 画师还在做：问题排在它这一轮后面
    expect(sends().filter(x => x.sessionId === s1)).toHaveLength(1)
    c.toolDone(s1, { summary: '贴图好了' })
    await endTurn(c, s1, '画好了')
    expect(lastTo(s1).text).toContain('程序员（流程里的另一个成员）问你')
    expect(lastTo(s1).text).toContain('按钮多大？')
    // 回答的那一轮不能 task_done
    expect(() => c.toolDone(s1, { summary: 'x' })).toThrow('回答别的成员')
    await endTurn(c, s1, '48 像素')
    expect(stepOf(c, ch, 's1').status).toBe('delivered')
    expect(stepOf(c, ch, 's2').status).toBe('running')
    expect(lastTo(s2).text).toContain('画师 的回答')
    expect(lastTo(s2).text).toContain('48 像素')

    // 画师已经交付、空闲：马上答
    const before = sends().length
    await c.toolAsk(s2, '画师', '颜色呢？')
    await settle()
    expect(sends()).toHaveLength(before + 1)
    expect(lastTo(s1).text).toContain('颜色呢？')
    expect(flowOf(c, ch).asks).toHaveLength(2)
  })

  it('让成员拆流程：交回的步骤成为草稿，成员名字不对时报错让它改；SSH 之外的校验沿用草稿校验', async () => {
    const { c, a, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '登录页',
      planner: { memberId: a, request: '做一个登录页新按钮' },
    })
    await settle()
    expect(flowOf(c, ch)).toMatchObject({ status: 'planning' })
    const s = tasks(c, ch)[0].sessionId!
    expect(lastTo(s).text).toContain('做一个登录页新按钮')
    expect(lastTo(s).text).toContain('- 程序员')
    expect(() => c.toolDone(s, { summary: '拆好了', steps: [{ title: '写', member: '路人' }] })).toThrow('不在频道里')
    c.toolDone(s, {
      summary: '拆好了',
      steps: [
        { title: '写代码', member: '程序员' },
        { title: '审查', member: '审查员', kind: 'review', target: 1 },
      ],
    })
    await endTurn(c, s, '拆好了')
    const f = flowOf(c, ch)
    expect(f.status).toBe('draft')
    expect(f.steps.map(x => [x.title, x.deps])).toEqual([
      ['写代码', []],
      ['审查', ['s1']],
    ])
    await expect(c.flowAction(ch, { type: 'discard', messageId })).resolves.toEqual({ messageId })
    expect(flowOf(c, ch).status).toBe('stopped')
  })

  it('打回到上限时你已经点了暂停：照样记成「打回到上限」，继续后再打回一次；交付后卡上的追加要求不改交付', async () => {
    const { c, a, r, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '审查循环',
      steps: [
        { id: 's1', title: '写代码', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '审查', memberId: r, deps: [], kind: 'review', target: 's1' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    for (let i = 0; i < 4; i++) {
      c.toolDone(s1, { summary: `第 ${i + 1} 版` })
      await endTurn(c, s1, '写好了')
      const s2 = sessionOf(c, ch, 's2')
      c.toolDone(s2, { summary: '不行', verdict: 'reject', issues: ['还是不对'] })
      if (i === 3) await c.flowAction(ch, { type: 'pause', messageId })
      await endTurn(c, s2, '打回')
    }
    expect(flowOf(c, ch)).toMatchObject({ status: 'paused', paused: { reason: 'reject-limit', stepId: 's2' } })
    expect(stepOf(c, ch, 's1')).toMatchObject({ status: 'delivered', rejects: 3 })
    await c.flowAction(ch, { type: 'resume', messageId })
    await settle()
    expect(lastTo(s1).text).toContain('第 4 / 4 次')
    expect(stepOf(c, ch, 's1')).toMatchObject({ status: 'running', rejects: 4 })

    c.toolDone(s1, { summary: '第 5 版' })
    await endTurn(c, s1, '写好了')
    const s2 = sessionOf(c, ch, 's2')
    c.toolDone(s2, { summary: '可以了', verdict: 'pass' })
    await endTurn(c, s2, '通过')
    expect(flowOf(c, ch).status).toBe('done')
    // 流程完成后在交付过的卡上追加要求：流程不动
    const card = tasks(c, ch).find(t => t.flow?.stepId === 's1')!
    await c.post(ch, { text: '@画师 顺便加个注释', threadId: card.id, clientId: 'more' })
    await settle()
    expect(() => c.toolDone(s1, { summary: 'x' })).toThrow('已经交付过了')
    await endTurn(c, s1, '加好了')
    expect(flowOf(c, ch).status).toBe('done')
    expect(stepOf(c, ch, 's1').result?.summary).toBe('第 5 版')
  })

  it('不是流程里的活调用 task_done 报错；草稿有问题时不能开始', async () => {
    const { c, a, ch } = await setup()
    await c.post(ch, { text: '@画师 画个图', clientId: 'x' })
    await settle()
    expect(() => c.toolDone(sends()[0].sessionId, { summary: 'x' })).toThrow('不在流程里')
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '空',
      steps: [{ id: 's1', title: '', memberId: a, deps: [], kind: 'work' }],
    })
    await expect(c.flowAction(ch, { type: 'start', messageId })).rejects.toThrow('还没写要做什么')
  })
})

describe('流程第二批（docs/ui/channels-pipeline.md §6）', () => {
  it('人工关卡：交付后等你确认，下游不开始；打回要写原因，同一张卡再来一轮；通过后接着走', async () => {
    const { c, a, b, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '先看贴图',
      steps: [
        { id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work', gate: true },
        { id: 's2', title: '写代码', memberId: b, deps: ['s1'], kind: 'work' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    c.toolDone(s1, { summary: '三张按钮图' })
    await endTurn(c, s1, '画好了')
    expect(stepOf(c, ch, 's1').status).toBe('gated')
    expect(tasks(c, ch).some(t => t.flow?.stepId === 's2')).toBe(false)
    expect(c.state().needs?.some(n => n.pause === 'gate' && n.stepId === 's1')).toBe(true)
    await expect(c.flowAction(ch, { type: 'gate', messageId, stepId: 's1', decision: 'reject' })).rejects.toThrow(
      '写一句',
    )
    await c.flowAction(ch, { type: 'gate', messageId, stepId: 's1', decision: 'reject', note: '按钮再圆一点' })
    await settle()
    expect(lastTo(s1).text).toContain('按钮再圆一点')
    expect(stepOf(c, ch, 's1').status).toBe('running')
    c.toolDone(s1, { summary: '改圆了' })
    await endTurn(c, s1, '改好了')
    expect(stepOf(c, ch, 's1').status).toBe('gated')
    // 等你确认等了很久：时长不算，通过后接着走
    now += 300 * 60_000
    await c.checkAlerts()
    expect(flowOf(c, ch).status).toBe('running')
    await c.flowAction(ch, { type: 'gate', messageId, stepId: 's1', decision: 'approve' })
    await settle()
    expect(stepOf(c, ch, 's1').status).toBe('delivered')
    expect(flowOf(c, ch).status).toBe('running')
    expect(lastTo(sessionOf(c, ch, 's2')).text).toContain('改圆了')
    await expect(c.flowAction(ch, { type: 'gate', messageId, stepId: 's1', decision: 'approve' })).rejects.toThrow(
      '不在等你确认',
    )
  })

  it('停止流程时等你确认的步骤也停下', async () => {
    const { c, a, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '停',
      steps: [{ id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work', gate: true }],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    c.toolDone(s1, { summary: '好了' })
    await endTurn(c, s1, '好了')
    await c.flowAction(ch, { type: 'stop', messageId })
    expect(stepOf(c, ch, 's1').status).toBe('stopped')
    expect(c.state().needs?.some(n => n.pause === 'gate')).toBe(false)
  })

  it('护栏：轮次到上限就停下，继续再给一整份；时长超了巡检时停下', async () => {
    const { c, a, b, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '护栏',
      limits: { rounds: 2, minutes: null },
      steps: [
        { id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '写代码', memberId: b, deps: ['s1'], kind: 'work' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    c.toolDone(s1, { summary: '好了' })
    await endTurn(c, s1, '好了')
    const s2 = sessionOf(c, ch, 's2')
    // 用了 2 轮：没交付时不再提醒，停在护栏上
    await endTurn(c, s2, '写了一半')
    expect(flowOf(c, ch)).toMatchObject({ status: 'paused', paused: { reason: 'limit', limit: 'rounds' } })
    const before = sends().length
    await c.flowAction(ch, { type: 'resume', messageId })
    await settle()
    expect(sends()).toHaveLength(before + 1)
    expect(lastTo(s2).text).toContain('还没有调用 task_done')
    expect(flowOf(c, ch).since?.rounds).toBe(2)
    c.toolDone(s2, { summary: '写完了' })
    await endTurn(c, s2, '写完了')
    expect(flowOf(c, ch).status).toBe('done')

    // 没设护栏的按默认上限开始；时长到了巡检时停下
    const other = await c.flowAction(ch, {
      type: 'create',
      title: '时长',
      steps: [{ id: 's1', title: '慢活', memberId: a, deps: [], kind: 'work' }],
    })
    await c.flowAction(ch, { type: 'start', messageId: other.messageId })
    await settle()
    const f = c.messages(ch).messages.find(m => m.id === other.messageId) as ChannelTextMessage
    expect(f.flow?.limits).toEqual({ rounds: 12, minutes: 120 })
    now += 121 * 60_000
    await c.checkAlerts()
    const g = c.messages(ch).messages.find(m => m.id === other.messageId) as ChannelTextMessage
    expect(g.flow?.paused).toMatchObject({ reason: 'limit', limit: 'time' })
  })

  it('并行的步骤各用一个副本；汇总在主目录合并，主目录有改动时先停下；做完删副本；交付的文件规整成相对路径', async () => {
    let dirty = false
    const created: { name: string; branch: string; base: string }[] = []
    const removed: string[] = []
    const { c, a, b, r, ch } = await setup({
      copies: {
        create: async (_projectId, input) => {
          created.push(input)
          return { id: `c${created.length}`, branch: input.branch, path: `D:/copies/${input.name}` }
        },
        remove: async id => void removed.push(id),
        dirty: async () => dirty,
      },
    })
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '并行',
      steps: [
        { id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '写代码', memberId: b, deps: [], kind: 'work' },
        { id: 's3', title: '合并汇总', memberId: r, deps: ['s1', 's2'], kind: 'summary' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const tag = messageId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6)
    expect(created.map(x => [x.branch, x.base])).toEqual([
      [`pixelsky/flow-${tag}-a`, ''],
      [`pixelsky/flow-${tag}-b`, ''],
    ])
    const sessionsMade = calls
      .filter(x => x.channel === 'engine:createSession')
      .map(x => x.args[0] as { copyId?: string })
    expect(sessionsMade.map(x => x.copyId)).toEqual(['c1', 'c2'])
    const s1 = sessionOf(c, ch, 's1')
    expect(lastTo(s1).text).toContain(`分支 pixelsky/flow-${tag}-a`)
    expect(stepOf(c, ch, 's1').copy).toMatchObject({ id: 'c1' })
    const reply = c.toolDone(s1, {
      summary: '图好了',
      files: [`D:/copies/flow-${tag}-a/img/btn.png`, '../x', 'C:/other/y'],
    })
    expect(reply).toContain('没有记下')
    await endTurn(c, s1, '好了')
    expect(stepOf(c, ch, 's1').result?.files).toEqual(['img/btn.png'])
    dirty = true
    const s2 = sessionOf(c, ch, 's2')
    c.toolDone(s2, { summary: '代码好了' })
    await endTurn(c, s2, '好了')
    // 主目录有没提交的改动：汇总这一步先不开始
    expect(flowOf(c, ch)).toMatchObject({ status: 'paused', paused: { reason: 'dirty', stepId: 's3' } })
    dirty = false
    await c.flowAction(ch, { type: 'resume', messageId })
    await settle()
    const s3 = sessionOf(c, ch, 's3')
    const last = calls.filter(x => x.channel === 'engine:createSession').at(-1)!.args[0] as { copyId?: string }
    expect(last.copyId).toBeUndefined()
    expect(lastTo(s3).text).toContain(`pixelsky/flow-${tag}-a`)
    expect(lastTo(s3).text).toContain('git merge --no-ff')
    // 上一轮没开成会话就失败了：重试时提示词只发一遍
    expect(lastTo(s3).text.split('这是最后一步').length).toBe(2)
    c.toolDone(s3, { summary: '合好了' })
    await endTurn(c, s3, '合好了')
    expect(flowOf(c, ch).status).toBe('done')
    await settle()
    expect(removed.sort()).toEqual(['c1', 'c2'])
  })

  it('前一步在主目录做完没提交（新建的文件也算）：从主目录分副本前先停下，提交后继续再分', async () => {
    let dirty = false
    const asked: (boolean | undefined)[] = []
    const created: { name: string; branch: string; base: string }[] = []
    const { c, a, b, r, ch } = await setup({
      copies: {
        create: async (_projectId, input) => {
          created.push(input)
          return { id: `c${created.length}`, branch: input.branch, path: `D:/copies/${input.name}` }
        },
        remove: async () => {},
        dirty: async (_projectId, untracked) => {
          asked.push(untracked)
          return dirty
        },
      },
    })
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '先定接口',
      steps: [
        { id: 's1', title: '定共用接口', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '主进程实现', memberId: b, deps: ['s1'], kind: 'work' },
        { id: 's3', title: '界面实现', memberId: r, deps: ['s1'], kind: 'work' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    // 后面两步要从主目录分副本：提示词让它交付前提交自己改的文件
    expect(lastTo(s1).text).toContain('提交')
    c.toolDone(s1, { summary: '接口定好了' })
    dirty = true
    await endTurn(c, s1, '好了')
    expect(created).toEqual([])
    expect(asked).toContain(true)
    expect(flowOf(c, ch)).toMatchObject({ status: 'paused', paused: { reason: 'dirty' } })
    dirty = false
    await c.flowAction(ch, { type: 'resume', messageId })
    await settle()
    expect(created.map(x => x.base)).toEqual(['', ''])
    expect(stepOf(c, ch, 's2').status).toBe('running')
    expect(stepOf(c, ch, 's3').status).toBe('running')
  })

  it('汇合前算出几个分支都改了的文件；交付的「没做完」交给后面的步骤', async () => {
    const changed: Record<string, string[]> = {}
    const { c, a, b, r, ch } = await setup({
      copies: {
        create: async (_projectId, input) => ({
          id: input.name,
          branch: input.branch,
          path: `D:/copies/${input.name}`,
        }),
        remove: async () => {},
        dirty: async () => false,
        changed: async (_projectId, branch) => changed[branch] ?? [],
      },
    })
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '导出',
      steps: [
        { id: 's1', title: '主进程', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '界面', memberId: b, deps: [], kind: 'work' },
        { id: 's3', title: '合并汇总', memberId: r, deps: ['s1', 's2'], kind: 'summary' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const tag = messageId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6)
    changed[`pixelsky/flow-${tag}-a`] = ['src/main/export.ts', 'src/shared/types.ts', 'src/preload/index.ts']
    changed[`pixelsky/flow-${tag}-b`] = ['src/shared/types.ts', 'src/renderer/Export.tsx', 'src/preload/index.ts']
    const s1 = sessionOf(c, ch, 's1')
    c.toolDone(s1, { summary: '通道写好了', open: ['大文件分块写没做', ' ', 42] })
    await endTurn(c, s1, '好了')
    expect(stepOf(c, ch, 's1').result?.open).toEqual(['大文件分块写没做'])
    const s2 = sessionOf(c, ch, 's2')
    c.toolDone(s2, { summary: '按钮好了' })
    await endTurn(c, s2, '好了')
    expect(stepOf(c, ch, 's2').result?.open).toBeUndefined()
    expect(stepOf(c, ch, 's3').overlap).toEqual([
      { path: 'src/shared/types.ts', steps: ['s1', 's2'] },
      { path: 'src/preload/index.ts', steps: ['s1', 's2'] },
    ])
    const prompt = lastTo(sessionOf(c, ch, 's3')).text
    expect(prompt).toContain('- src/shared/types.ts（①、②）')
    expect(prompt).toContain('没做完 / 没验证：大文件分块写没做')
  })
})

describe('流程第三批（docs/ui/channels-pipeline.md §8）', () => {
  it('任务卡记下真正开始的时间（第一轮，不含排队）', async () => {
    const { c, a, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '计时',
      steps: [{ id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' }],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    expect(tasks(c, ch)[0].startedAt ?? null).toBeNull()
    c.toolDone(s1, { summary: '好了' })
    await endTurn(c, s1, '好了')
    const card = tasks(c, ch)[0]
    expect(card.startedAt).toBeGreaterThan(card.at)
    expect(card.endedAt).toBeGreaterThan(card.startedAt!)
  })

  it('牵头成员：不带 @ 的需求自动拆成流程；一次只拆一个；@、太短、斜杠、讨论串不触发；直接回答时不留草稿', async () => {
    const { c, a, b, ch } = await setup()
    await expect(c.update(ch, { lead: 'nobody' })).rejects.toThrow('牵头成员')
    // 没设牵头：只是留言
    await c.post(ch, { text: '帮我把登录页改成两步验证', clientId: 'p0' })
    await settle()
    expect(sends()).toHaveLength(0)

    await c.update(ch, { lead: a })
    expect(c.state().channels.find(x => x.id === ch)?.lead).toBe(a)
    await c.post(ch, { text: '好的', clientId: 'p1' })
    await c.post(ch, { text: '/compact 现在整理一下上下文', clientId: 'p2' })
    await settle()
    expect(sends()).toHaveLength(0)

    await c.post(ch, { text: '帮我把登录页改成两步验证', clientId: 'p3' })
    await c.post(ch, { text: '顺便把注册页也改了吧谢谢', clientId: 'p4' })
    await settle()
    const flows = () => c.messages(ch).messages.filter((m): m is ChannelTextMessage => m.kind === 'message' && !!m.flow)
    expect(flows()).toHaveLength(1)
    expect(flows()[0].flow).toMatchObject({ status: 'planning', planner: { memberId: a, auto: true } })
    expect(tasks(c, ch)[0].title).toContain('牵头处理')
    const s = tasks(c, ch)[0].sessionId!
    expect(lastTo(s).text).toContain('你是这个频道的牵头成员')

    // 拆的时候接着说的（p4）排在这一轮后面，交给牵头一起看
    await endTurn(c, s, '两步验证用短信验证码就行。')
    expect(flows()[0].flow?.status).toBe('planning')
    expect(lastTo(s).text).toContain('顺便把注册页也改了吧谢谢')
    // 只是问题：不调 task_done 直接回答，流程不留草稿
    await endTurn(c, s, '注册页也一样。')
    expect(flows()[0].flow?.status).toBe('stopped')

    // 有 @ 的照常派活，不交给牵头
    await c.post(ch, { text: '@程序员 写一下单元测试吧', clientId: 'p5' })
    await settle()
    expect(flows()).toHaveLength(1)
    expect(tasks(c, ch).at(-1)?.assigneeId).toBe(b)

    // 再来一条需求：这次拆成步骤，变成草稿等你确认
    await c.post(ch, { text: '做一个新的设置页并且审查一遍', clientId: 'p6' })
    await settle()
    const planning = tasks(c, ch).at(-1)!
    expect(planning.assigneeId).toBe(a)
    c.toolDone(planning.sessionId!, { summary: '拆好了', steps: [{ title: '写设置页', member: '程序员' }] })
    await endTurn(c, planning.sessionId!, '拆好了')
    expect(flows().at(-1)?.flow?.status).toBe('draft')

    // 讨论串里的不触发
    await c.post(ch, { text: '这个设置页也要支持深色主题', threadId: planning.id, clientId: 'p7' })
    await settle()
    expect(flows()).toHaveLength(2)

    // 牵头被移出频道：设置清掉
    await c.removeMember(ch, a)
    expect(c.state().channels.find(x => x.id === ch)?.lead).toBeNull()
  })
})

describe('流程第四批（docs/ui/channels-pipeline.md §10）', () => {
  /** 这个会话最后一轮的用量记录 */
  const record = (s: string, costUsd: number | null, input = 100): UsageRecord =>
    ({
      id: `${s}:turn-${lastTo(s).clientMessageId}:m`,
      sessionId: s,
      turnId: `turn-${lastTo(s).clientMessageId}`,
      model: 'm',
      engine: 'claude',
      input,
      cacheRead: 0,
      cacheWrite: 0,
      output: 10,
      costUsd,
      costSource: costUsd === null ? null : 'estimate',
    }) as unknown as UsageRecord

  it('用量：步骤记下跑过的轮次，按轮次从用量记录算 token 和花费；按会话取、带 sessionId 走本机', async () => {
    const { c, a, b, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '用量',
      steps: [
        { id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '写代码', memberId: b, deps: ['s1'], kind: 'work' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    usage.push(record(s1, 0.25))
    await endTurn(c, s1, '还没好')
    usage.push(record(s1, null, 50))
    c.toolDone(s1, { summary: '好了' })
    await endTurn(c, s1, '好了')
    expect(stepOf(c, ch, 's1').turns).toHaveLength(2)
    await c.refreshUsage()
    expect(stepOf(c, ch, 's1').usage).toMatchObject({
      input: 150,
      output: 20,
      costUsd: 0.25,
      costKnown: 1,
      records: 2,
      turns: 2,
      unrecorded: 0,
    })
    const q = calls.find(x => x.channel === 'engine:usageList')!.args[0] as Record<string, unknown>
    expect(q).toMatchObject({ sessionId: s1, filter: { session: s1 } })
    // 还没有记录的轮次算「没记录」；没变不重写
    const s2 = sessionOf(c, ch, 's2')
    await endTurn(c, s2, '写了一半')
    await c.refreshUsage()
    expect(stepOf(c, ch, 's2').usage).toMatchObject({ records: 0, turns: 1, unrecorded: 1 })
    const before = JSON.stringify(flowOf(c, ch))
    await c.refreshUsage()
    expect(JSON.stringify(flowOf(c, ch))).toBe(before)
    // 记录超出 30 天取不到了：留着原来的
    usage = []
    await c.refreshUsage()
    expect(stepOf(c, ch, 's1').usage).toMatchObject({ costUsd: 0.25, records: 2 })
  })

  it('花费上限：已知花费到了就停下；继续后从当时的花费再给一整份', async () => {
    const { c, a, b, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '花费',
      limits: { rounds: null, minutes: null, costUsd: 1 },
      steps: [
        { id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '写代码', memberId: b, deps: ['s1'], kind: 'work' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    usage.push(record(s1, 1.2))
    c.toolDone(s1, { summary: '好了' })
    await endTurn(c, s1, '好了')
    await c.refreshUsage()
    expect(flowOf(c, ch)).toMatchObject({ status: 'paused', paused: { reason: 'limit', limit: 'cost' } })
    await c.flowAction(ch, { type: 'resume', messageId })
    await settle()
    expect(flowOf(c, ch)).toMatchObject({ status: 'running', since: { cost: 1.2 } })
    await c.refreshUsage()
    expect(flowOf(c, ch).status).toBe('running')
  })

  it('定时运行：到点开一条流程，同一天不重复；上一次没结束就跳过；没开成记原因；没有能计价的成员不能存', async () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
    now = at(25, 8)
    const { c, a, ch } = await setup()
    const schedule = {
      title: '早巡检',
      hour: 9,
      enabled: true,
      limits: { rounds: 5, minutes: 30, costUsd: 2 },
      steps: [{ id: 's1', title: '巡检', memberId: a, deps: [], kind: 'work' as const }],
    }
    await c.update(ch, { schedules: [schedule] })
    const saved = c.state().channels.find(x => x.id === ch)!.schedules![0]
    expect(saved).toMatchObject({ title: '早巡检', lastFlowMessageId: null })
    await c.checkAlerts()
    expect(c.messages(ch).messages.some(m => m.kind === 'message' && m.flow)).toBe(false)

    now = at(25, 9, 5)
    // 两次巡检重叠也只开一条
    await Promise.all([c.checkAlerts(), c.checkAlerts()])
    await settle()
    expect(flowOf(c, ch)).toMatchObject({ title: '早巡检', status: 'running', limits: schedule.limits })
    const first = c.state().channels.find(x => x.id === ch)!.schedules![0]
    expect(first.lastFlowMessageId).toBeTruthy()
    // 同一天不再开；改设置保留运行时的字段
    await c.update(ch, { schedules: [{ ...schedule, id: first.id, title: '早巡检2' }] })
    await c.checkAlerts()
    const flows = () => c.messages(ch).messages.filter(m => m.kind === 'message' && m.flow)
    expect(flows()).toHaveLength(1)
    expect(c.state().channels.find(x => x.id === ch)!.schedules![0].lastFlowMessageId).toBe(first.lastFlowMessageId)

    // 第二天上一次还在跑：跳过，记原因
    now = at(26, 10)
    await c.checkAlerts()
    expect(flows()).toHaveLength(1)
    expect(c.state().channels.find(x => x.id === ch)!.schedules![0].lastError).toContain('还没结束')

    // 第三天上一次结束了，但成员被移出频道：没开成，草稿丢掉，记原因
    const s1 = sessionOf(c, ch, 's1')
    c.toolDone(s1, { summary: '好了' })
    await endTurn(c, s1, '好了')
    await c.removeMember(ch, a)
    now = at(27, 9)
    await c.checkAlerts()
    await settle()
    expect(flows()).toHaveLength(1)
    expect(c.state().channels.find(x => x.id === ch)!.schedules![0].lastError).toBeTruthy()
    // 成员删掉了：步骤没改的旧定时照样能关
    await c.deleteMember(a)
    await c.update(ch, { schedules: [{ ...schedule, id: first.id, enabled: false }] })
    expect(c.state().channels.find(x => x.id === ch)!.schedules![0].enabled).toBe(false)

    // 只有 Codex（不报价格）的不能定时
    const x = await c.saveMember(null, { ...agent('跑腿'), engine: 'codex' })
    await expect(
      c.update(ch, { schedules: [{ ...schedule, steps: [{ ...schedule.steps[0], memberId: x }] }] }),
    ).rejects.toThrow('花费上限不会起作用')
    await expect(
      c.update(ch, { schedules: [{ ...schedule, limits: { ...schedule.limits, costUsd: null } }] as never }),
    ).rejects.toThrow('都要设')
  })
})

describe('频道问题修复（docs/ui/channels-features.md §8）', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const image = {
    id: 'i',
    name: 'i.png',
    mediaType: 'image/png' as const,
    bytes: 70,
    width: 1,
    height: 1,
    dataBase64: PNG,
  }

  it('建会话期间追加的要求不丢：这一轮做完接着发', async () => {
    const { c, a, ch } = await setup()
    let release!: () => void
    slowCreate = new Promise(r => (release = r))
    const { tasks: ids } = await c.post(ch, { text: '@画师 画个按钮', clientId: '1' })
    await settle()
    await c.post(ch, { text: '顺便加个阴影', replyToId: ids[0], clientId: '2' })
    release()
    await settle()
    const s = tasks(c, ch)[0].sessionId!
    expect(sends().filter(x => x.sessionId === s)).toHaveLength(1)
    await endTurn(c, s, '画好了')
    expect(lastTo(s).text).toContain('顺便加个阴影')
    expect(a).toBeTruthy()
  })

  it('上次退出时正在建会话：重启后放回排队重新开始，成员不被卡住', async () => {
    const { c, ch } = await setup()
    slowCreate = new Promise(() => {})
    await c.post(ch, { text: '@画师 画个按钮', clientId: '1' })
    await settle()
    ;(c as unknown as { saveRuns: () => void }).saveRuns()
    await c.dispose()
    opened = opened.filter(x => x !== c)
    slowCreate = null
    const again = await open()
    await again.reconcile()
    await settle()
    expect(tasks(again, ch)[0].sessionId).toBeTruthy()
    expect(sends().some(x => x.sessionId === tasks(again, ch)[0].sessionId)).toBe(true)
  })

  it('已停止的流程里重试步骤卡：卡片自己再做一轮，步骤不被拉回进行中', async () => {
    const { c, a, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '停止',
      steps: [{ id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' }],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    await c.flowAction(ch, { type: 'stop', messageId })
    await settle()
    expect(stepOf(c, ch, 's1').status).toBe('stopped')
    await c.taskAction(tasks(c, ch)[0].id, 'retry')
    await settle()
    expect(flowOf(c, ch).status).toBe('stopped')
    expect(stepOf(c, ch, 's1').status).toBe('stopped')
  })

  it('发带附件的消息期间改了频道设置、或删了频道：不被旧的频道对象改回 / 复活', async () => {
    const { c, ch } = await setup()
    const p = c.post(ch, { text: '看图', clientId: '1', attachments: [image] })
    await c.update(ch, { topic: '新主题' })
    await p
    expect(c.state().channels.find(x => x.id === ch)?.topic).toBe('新主题')
    const q = c.post(ch, { text: '再看', clientId: '2', attachments: [{ ...image, id: 'j' }] })
    await c.delete(ch)
    await q.catch(() => undefined)
    expect(c.state().channels.some(x => x.id === ch)).toBe(false)
  })
})

describe('频道问题修复第二轮（复审）', () => {
  it('建会话期间点停止：取消这项活，建好会话后也不发', async () => {
    const { c, ch } = await setup()
    let release!: () => void
    slowCreate = new Promise(r => (release = r))
    const { tasks: ids } = await c.post(ch, { text: '@画师 画个按钮', clientId: '1' })
    await settle()
    await c.taskAction(ids[0], 'stop')
    release()
    await settle()
    expect(tasks(c, ch)[0].status).toBe('stopped')
    expect(sends()).toHaveLength(0)
  })

  it('重启时流程恢复刚开始的步骤不被当成上次没建完的：只建一个会话', async () => {
    const { c, a, b, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '重启',
      steps: [
        { id: 's1', title: '画贴图', memberId: a, deps: [], kind: 'work' },
        { id: 's2', title: '写代码', memberId: b, deps: ['s1'], kind: 'work' },
      ],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    c.toolDone(s1, { summary: '好了' })
    await endTurn(c, s1, '好了')
    // 退出前 ② 还没来得及开始：回到没开始、没有运行记录
    const inner = c as unknown as {
      store: ChannelStore
      updateFlow: (ch: string, id: string, fn: (f: ChannelFlow) => ChannelFlow) => void
      saveRuns: () => void
    }
    const s2Task = stepOf(c, ch, 's2').taskId!
    inner.updateFlow(ch, messageId, f => ({
      ...f,
      steps: f.steps.map(s => (s.id === 's2' ? { ...s, status: 'pending', taskId: null } : s)),
    }))
    inner.store.runs.delete(s2Task)
    inner.saveRuns()
    await c.dispose()
    opened = opened.filter(x => x !== c)
    let release!: () => void
    slowCreate = new Promise(r => (release = r))
    const before = calls.filter(x => x.channel === 'engine:createSession').length
    const again = await open()
    await again.reconcile()
    release()
    await settle()
    expect(calls.filter(x => x.channel === 'engine:createSession').length - before).toBe(1)
  })
})

describe('频道问题修复第二轮复审', () => {
  it('建会话期间停止又马上重试：旧的那一轮不再发，只发新的一轮', async () => {
    const { c, ch } = await setup()
    let release!: () => void
    slowCreate = new Promise(r => (release = r))
    const { tasks: ids } = await c.post(ch, { text: '@画师 画个按钮', clientId: '1' })
    await settle()
    await c.taskAction(ids[0], 'stop')
    await c.taskAction(ids[0], 'retry')
    await settle()
    release()
    await settle()
    expect(sends()).toHaveLength(1)
    expect(sends()[0].clientMessageId).toContain('-2')
  })
})

describe('分工提案和问用户', () => {
  it('提案带要点；草稿期间不带 @ 的话交给牵头改、不派活；必答没定不能开工；要点写进步骤提示词', async () => {
    const { c, a, b, ch } = await setup()
    await c.update(ch, { lead: a })
    await c.post(ch, { text: '做个新法术万剑归宗：飞剑环绕自己自动攻击', clientId: 'p1' })
    await settle()
    const plan = tasks(c, ch)[0]
    const s = plan.sessionId!
    expect(lastTo(s).text).toContain('brief')
    c.toolDone(s, {
      summary: '拆好了',
      steps: [
        { title: '定数值', member: '画师' },
        { title: '实现', member: '程序员', deps: [1] },
      ],
      brief: {
        goal: '万剑归宗',
        facts: [{ k: '效果', v: '飞剑环绕', by: '画师' }],
        open: [
          { q: '持续时间（建议 8 秒）', required: true },
          { q: '特效谁出', required: false },
        ],
      },
    })
    await endTurn(c, s, '拆好了')
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    // 成员交回的「谁定的」不认，记成你
    expect(flowOf(c, ch)).toMatchObject({
      status: 'draft',
      rev: 1,
      brief: { goal: '万剑归宗', facts: [{ k: '效果', v: '飞剑环绕', by: SELF_ID }] },
    })
    await expect(c.flowAction(ch, { type: 'start', messageId })).rejects.toThrow('还有要先定的：持续时间（建议 8 秒）')

    // 接着说：不另开流程、不派活，交给牵头改
    const before = sends().length
    await c.post(ch, { text: '持续 8 秒，特效小李出', clientId: 'p2' })
    await settle()
    expect(c.messages(ch).messages.filter(m => m.kind === 'message' && m.flow)).toHaveLength(1)
    expect(tasks(c, ch)).toHaveLength(1)
    expect(flowOf(c, ch).status).toBe('planning')
    expect(sends().length).toBe(before + 1)
    expect(lastTo(s).text).toContain('持续 8 秒，特效小李出')
    expect(lastTo(s).text).toContain('1. 定数值 · 画师')
    await expect(c.flowAction(ch, { type: 'start', messageId })).rejects.toThrow('只有草稿能开始')
    c.toolDone(s, {
      summary: '改好了',
      steps: [
        { title: '定数值', member: '画师' },
        { title: '实现', member: '程序员', deps: [1] },
      ],
      brief: {
        goal: '万剑归宗',
        facts: [
          { k: '效果', v: '飞剑环绕' },
          { k: '持续时间', v: '8 秒' },
        ],
        open: [{ q: '攻击间隔', required: true }],
      },
    })
    await endTurn(c, s, '改好了')
    expect(flowOf(c, ch)).toMatchObject({ status: 'draft', rev: 2 })
    expect(flowOf(c, ch).brief?.facts.map(f => f.k)).toEqual(['效果', '持续时间'])

    // 只是闲聊：牵头不交回，提案原样留着（不会像头一回那样被当成直接回答而停掉）
    await c.post(ch, { text: '辛苦了，这个提案挺好', clientId: 'p3' })
    await settle()
    await endTurn(c, s, '不客气')
    expect(flowOf(c, ch)).toMatchObject({ status: 'draft', rev: 2 })
    expect(flowOf(c, ch).steps).toHaveLength(2)

    // @ 的照常直接派
    await c.post(ch, { text: '@程序员 先看看现有的法术代码', clientId: 'p4' })
    await settle()
    expect(tasks(c, ch).at(-1)?.assigneeId).toBe(b)
    expect(flowOf(c, ch).status).toBe('draft')

    // 剩下的交给 AI 定（必答改成非必答）：能开工，要点写进步骤提示词
    await c.flowAction(ch, {
      type: 'update',
      messageId,
      brief: { ...flowOf(c, ch).brief!, open: [{ q: '攻击间隔', required: false }] },
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    expect(lastTo(s1).text).toContain('频道里大家定下来的要点')
    expect(lastTo(s1).text).toContain('- 持续时间：8 秒')
    expect(lastTo(s1).text).toContain('还没定的（按合理默认值定，交付时写明你定了什么）：攻击间隔')
    expect(lastTo(s1).text).toContain('user_ask')
  })

  it('user_ask：一步问你，卡上等你回答；回答记进要点、发回给它接着做；这一轮没结束时先存着', async () => {
    const { c, a, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '问用户',
      steps: [{ id: 's1', title: '做法术', memberId: a, deps: [], kind: 'work' }],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    await expect(c.flowAction(ch, { type: 'answer', messageId, stepId: 's1', text: '8 秒' })).rejects.toThrow(
      '这一步没在等你回答',
    )
    await c.toolUserAsk(s1, '持续时间多少？')
    await expect(c.toolUserAsk(s1, '再问一个')).rejects.toThrow('已经问过')
    await endTurn(c, s1, '等你回答')
    expect(stepOf(c, ch, 's1')).toMatchObject({ status: 'asking', question: { text: '持续时间多少？' } })
    // 问题也记在这一步的讨论串里
    const card = tasks(c, ch)[0]
    expect(
      c.messages(ch).messages.some(m => m.kind === 'message' && m.threadId === card.id && m.text === '持续时间多少？'),
    ).toBe(true)
    await expect(c.flowAction(ch, { type: 'answer', messageId, stepId: 's1', text: '  ' })).rejects.toThrow(
      '写一句回答',
    )
    await c.flowAction(ch, { type: 'answer', messageId, stepId: 's1', text: '8 秒' })
    await settle()
    expect(stepOf(c, ch, 's1')).toMatchObject({ status: 'running', question: null })
    expect(flowOf(c, ch).brief?.facts).toEqual([{ k: '持续时间多少？', v: '8 秒', by: SELF_ID }])
    expect(lastTo(s1).text).toContain('8 秒')

    // 这一轮还没结束就答了：先存着，这一轮结束后发给它
    await c.toolUserAsk(s1, '攻击间隔呢？')
    await c.flowAction(ch, { type: 'answer', messageId, stepId: 's1', text: '0.5 秒' })
    await settle()
    expect(stepOf(c, ch, 's1').question).toBeNull()
    await endTurn(c, s1, '先做了别的部分')
    expect(stepOf(c, ch, 's1').status).toBe('running')
    expect(lastTo(s1).text).toContain('0.5 秒')
    expect(flowOf(c, ch).brief?.facts.map(f => f.v)).toEqual(['8 秒', '0.5 秒'])
  })

  it('回归：回答写进讨论串的同时这一轮结束了：照样把回答发给它，运行记录不被改回旧的', async () => {
    const { c, a, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '问用户',
      steps: [{ id: 's1', title: '做法术', memberId: a, deps: [], kind: 'work' }],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    await c.toolUserAsk(s1, '持续时间多少？')
    // 回答写进讨论串那一下卡住，这期间这一轮结束
    const store = (c as unknown as { store: ChannelStore }).store
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const append = store.append.bind(store)
    vi.spyOn(store, 'append').mockImplementationOnce(async m => {
      await gate
      return append(m)
    })
    const answering = c.flowAction(ch, { type: 'answer', messageId, stepId: 's1', text: '8 秒' })
    await endTurn(c, s1, '等你回答')
    release()
    await answering
    await settle()
    expect(stepOf(c, ch, 's1')).toMatchObject({ status: 'running', question: null })
    expect(lastTo(s1).text).toContain('8 秒')
  })

  it('回归：回答写进讨论串期间停止了流程：之后不再发新一轮，停止能取消它', async () => {
    const { c, a, ch } = await setup()
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '问用户',
      steps: [{ id: 's1', title: '做法术', memberId: a, deps: [], kind: 'work' }],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const s1 = sessionOf(c, ch, 's1')
    await c.toolUserAsk(s1, '持续时间多少？')
    await endTurn(c, s1, '等你回答')
    const release = holdAppend(c, m => m.kind === 'message' && !!m.threadId)
    const answering = c.flowAction(ch, { type: 'answer', messageId, stepId: 's1', text: '8 秒' })
    await c.flowAction(ch, { type: 'stop', messageId })
    release()
    await answering
    await settle()
    expect(flowOf(c, ch).status).toBe('stopped')
    expect(stepOf(c, ch, 's1').status).toBe('stopped')
    expect(storeOf(c).runs.get(tasks(c, ch)[0].id)?.phase).toBe('ended')
  })
})

describe('@ 派活先出计划', () => {
  it('@ 一个 AI：它先一次问完，答完一次出完整计划；不派活；问过就不再问', async () => {
    const { c, a, b, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '@画师 帮我设计一个数据中心', clientId: 'p1' })
    await settle()
    const flows = () => c.messages(ch).messages.filter((m): m is ChannelTextMessage => m.kind === 'message' && !!m.flow)
    expect(flows()).toHaveLength(1)
    expect(flows()[0].flow).toMatchObject({
      title: '帮我设计一个数据中心',
      status: 'planning',
      planner: { memberId: a, mention: true },
    })
    // 没有直接派活：只有拟计划那一张卡
    expect(tasks(c, ch)).toHaveLength(1)
    const s = tasks(c, ch)[0].sessionId!
    expect(lastTo(s).text).toContain('用户点名把这件事交给你')
    expect(lastTo(s).text).toContain('questions')
    const messageId = flows()[0].id

    expect(
      c.toolDone(s, {
        summary: '先问两件事',
        questions: [
          { q: '哪种数据中心？', options: ['游戏内', '机房', '管理软件', '多余的', '再多余'] },
          { q: '主要解决什么问题？' },
        ],
      }),
    ).toContain('问题已交给用户')
    await endTurn(c, s, '先问两件事')
    expect(flowOf(c, ch)).toMatchObject({ status: 'draft', steps: [] })
    expect(flowOf(c, ch).questions).toEqual([
      { q: '哪种数据中心？', options: ['游戏内', '机房', '管理软件', '多余的'] },
      { q: '主要解决什么问题？', options: [] },
    ])
    await expect(c.flowAction(ch, { type: 'start', messageId })).rejects.toThrow()
    await expect(c.flowAction(ch, { type: 'answers', messageId, answers: ['管理软件'] })).rejects.toThrow(
      '每个问题都要回答',
    )
    await c.flowAction(ch, { type: 'answers', messageId, answers: ['管理软件', '资产管理'] })
    await settle()
    expect(flowOf(c, ch).status).toBe('planning')
    // 回答作为你的一条消息留在频道里，计划卡记下它
    const reply = c.messages(ch).messages.find(x => x.id === flowOf(c, ch).answersId) as ChannelTextMessage
    expect(reply).toMatchObject({ authorId: SELF_ID, text: '1. 管理软件\n2. 资产管理' })
    expect(tasks(c, ch)).toHaveLength(1)
    expect(lastTo(s).text).toContain('1. 哪种数据中心？')
    expect(lastTo(s).text).toContain('回答: 管理软件')
    await expect(c.flowAction(ch, { type: 'answers', messageId, answers: ['a', 'b'] })).rejects.toThrow('没在等你回答')

    expect(() => c.toolDone(s, { summary: '再问', questions: [{ q: '再问一个？' }] })).toThrow('已经问过一轮了')
    c.toolDone(s, {
      summary: '计划好了',
      steps: [
        { title: '定数据模型和接口', member: '画师', effort: 'high' },
        { title: '写后端', member: '程序员', deps: [1], effort: '超强' },
      ],
      brief: {
        goal: '数据中心管理软件',
        facts: [
          { k: '类型', v: '管理软件' },
          { k: '技术栈', v: 'React + FastAPI', suggested: true },
        ],
      },
    })
    await endTurn(c, s, '计划好了')
    const f = flowOf(c, ch)
    expect(f).toMatchObject({ status: 'draft', rev: 1 })
    expect(f.steps[0].settings).toEqual({ effort: 'high' })
    expect(f.steps[1].settings ?? null).toBeNull()
    expect(f.brief?.facts).toEqual([
      { k: '类型', v: '管理软件', by: SELF_ID },
      { k: '技术栈', v: 'React + FastAPI', by: a, suggested: true },
    ])
    expect(tasks(c, ch).some(t => t.assigneeId === b)).toBe(false)
  })

  it('换拟计划的成员、模型和推理强度：停掉正在拟的那一轮，由新的接手（带上回答），新会话按设置开', async () => {
    const { c, a, b, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '@画师 帮我设计一个数据中心', clientId: 'p1' })
    await settle()
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    const first = tasks(c, ch)[0]
    await expect(c.flowAction(ch, { type: 'replan', messageId, memberId: 'nobody' })).rejects.toThrow('不在频道里')
    await c.flowAction(ch, {
      type: 'replan',
      messageId,
      memberId: b,
      settings: { model: 'big', effort: 'xhigh', junk: 1 },
    })
    await settle()
    expect(flowOf(c, ch)).toMatchObject({
      status: 'planning',
      planner: { memberId: b, mention: true, settings: { model: 'big', effort: 'xhigh' } },
    })
    const second = tasks(c, ch).at(-1)!
    expect(second.id).not.toBe(first.id)
    expect(second.assigneeId).toBe(b)
    expect(second.title).toContain('出计划')
    const created = calls.filter(x => x.channel === 'engine:createSession').at(-1)!.args[0] as Record<string, unknown>
    // 拟计划一律在计划模式里（只读）
    expect(created).toMatchObject({ model: 'big', effort: 'xhigh', permissionMode: 'plan' })
    // 旧的那一轮迟到的交付不算数
    expect(() => c.toolDone(first.sessionId!, { summary: 'x', steps: [{ title: 'x', member: '画师' }] })).toThrow()

    // 新的先问、答完再换人：交接里带上回答
    const s2 = second.sessionId!
    c.toolDone(s2, { summary: '问', questions: [{ q: '哪种？' }] })
    await endTurn(c, s2, '问')
    await c.flowAction(ch, { type: 'answers', messageId, answers: ['管理软件'] })
    await settle()
    await c.flowAction(ch, { type: 'replan', messageId, memberId: a })
    await settle()
    expect(lastTo(tasks(c, ch).at(-1)!.sessionId!).text).toContain('哪种？：管理软件')
  })

  it('拟计划在计划模式里用频道工具不用你批准：自动放行；别的工具照常等你确认', async () => {
    const { c, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '@画师 帮我设计一个数据中心', clientId: 'p1' })
    await settle()
    const task = () => tasks(c, ch)[0]
    const s = task().sessionId!
    const ask = (id: string, toolName: string) =>
      c.hostEvent(
        ev(s, {
          type: 'approval_request',
          request: { requestId: id, itemId: null, kind: 'tool', title: `使用 ${toolName}`, toolName, alwaysScopes: [] },
        }),
      )
    // 这一轮开始了（引擎回显了发出去的那条）
    const x = lastTo(s)
    c.hostEvent(
      ev(s, {
        type: 'item_completed',
        item: { kind: 'user', id: x.clientMessageId, text: '', createdAt: 0, turnId: 't1' },
      }),
    )
    ask('r1', 'mcp__pixelsky_channel__task_done')
    await settle()
    expect(calls.filter(x => x.channel === 'engine:answer').map(x => x.args)).toEqual([[s, 'r1', { type: 'allow' }]])
    expect(task().request ?? null).toBeNull()
    ask('r2', 'Write')
    await settle()
    expect(calls.filter(x => x.channel === 'engine:answer')).toHaveLength(1)
    expect(task().request?.requestId).toBe('r2')
  })

  it('拿不到 task_done 时把 JSON 写在回复里也认（计划模式里的 Codex）；短标题替换原话', async () => {
    const { c, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '我想设计一个数据中心', clientId: 'p0' })
    await c.post(ch, { text: '@画师', clientId: 'p1' })
    await settle()
    // 只发了 @：前面那句一起交给它，也拿来当标题
    expect(flowOf(c, ch)).toMatchObject({ title: '我想设计一个数据中心', status: 'planning' })
    const s = tasks(c, ch)[0].sessionId!
    expect(lastTo(s).text).toContain('我想设计一个数据中心')
    await endTurn(
      c,
      s,
      '当前环境没有 task_done 工具。\n```json\n{"summary":"先问","questions":[{"q":"哪种数据中心？","options":["游戏内","机房"]}]}\n```',
    )
    expect(flowOf(c, ch)).toMatchObject({
      status: 'draft',
      questions: [{ q: '哪种数据中心？', options: ['游戏内', '机房'] }],
    })
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    await c.flowAction(ch, { type: 'answers', messageId, answers: ['机房'] })
    await settle()
    // 不合格的（成员名字不对）不认，草稿也不留空步骤
    await endTurn(c, s, '{"summary":"计划","steps":[{"title":"x","member":"没这个人"}]}')
    expect(flowOf(c, ch).steps).toHaveLength(0)
  })

  it('task_done 带短标题：计划卡标题换成它', async () => {
    const { c, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '@画师 两个任务，一个是检查为什么不亮灯，另一个是加字节显示', clientId: 'p1' })
    await settle()
    const s = tasks(c, ch)[0].sessionId!
    c.toolDone(s, { summary: '好了', title: '不亮灯 + 字节显示', steps: [{ title: '查原因', member: '画师' }] })
    await endTurn(c, s, '好了')
    expect(flowOf(c, ch)).toMatchObject({ status: 'draft', title: '不亮灯 + 字节显示' })
  })

  it('带截图 @ 也先出计划：图片跟着交给拟计划的成员', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const image = {
      id: 'i',
      name: 'i.png',
      mediaType: 'image/png' as const,
      bytes: 70,
      width: 1,
      height: 1,
      dataBase64: PNG,
    }
    const { c, a, b, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '@画师 看图，这个界面怎么改', clientId: 'p1', attachments: [image] })
    await settle()
    expect(flowOf(c, ch)).toMatchObject({ status: 'planning', planner: { memberId: a, mention: true } })
    const sent = lastTo(tasks(c, ch)[0].sessionId!) as unknown as { attachments?: unknown[] }
    expect(sent.attachments).toHaveLength(1)

    // 换人拟计划：新成员也收到原消息带的图（回归：以前只有文字）
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    await c.flowAction(ch, { type: 'replan', messageId, memberId: b })
    await settle()
    const again = lastTo(tasks(c, ch).at(-1)!.sessionId!) as unknown as { text: string; attachments?: unknown[] }
    expect(again.text).toContain('看图，这个界面怎么改')
    expect(again.attachments).toHaveLength(1)
  })

  it('回归：拟计划期间补充的要求，换人拟计划后新成员照样看得到（排着没处理的也不丢）', async () => {
    const { c, b, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '@画师 先设计一个界面', clientId: 'p1' })
    await settle()
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    // 画师这一轮还没结束：补充排在后面
    await c.post(ch, { text: '必须支持离线运行，数据不能上传到服务器', clientId: 'p2' })
    await settle()
    await c.flowAction(ch, { type: 'replan', messageId, memberId: b })
    await settle()
    const text = lastTo(tasks(c, ch).at(-1)!.sessionId!).text
    expect(text).toContain('先设计一个界面')
    expect(text).toContain('必须支持离线运行，数据不能上传到服务器')
  })

  /** @画师 拟计划，交回一个问题后流程是草稿 */
  async function asked() {
    const x = await setup({ planFirst: true })
    await x.c.post(x.ch, { text: '@画师 帮我设计一个数据中心', clientId: 'p1' })
    await settle()
    const messageId = x.c.messages(x.ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    const first = tasks(x.c, x.ch)[0]
    x.c.toolDone(first.sessionId!, { summary: '问', questions: [{ q: '哪种数据中心？' }] })
    await endTurn(x.c, first.sessionId!, '问')
    expect(flowOf(x.c, x.ch).status).toBe('draft')
    // 你的回答那条消息写盘卡住
    const release = holdAppend(x.c, m => m.kind === 'message' && m.authorId === SELF_ID && !m.flow)
    return { ...x, messageId, first, release }
  }

  it('回归：计划问题的回答写盘期间丢弃了草稿：流程还是停止，不再发给拟计划的成员', async () => {
    const { c, ch, messageId, first, release } = await asked()
    const answering = c.flowAction(ch, { type: 'answers', messageId, answers: ['管理软件'] })
    await c.flowAction(ch, { type: 'discard', messageId })
    release()
    await answering
    await settle()
    expect(flowOf(c, ch).status).toBe('stopped')
    expect(storeOf(c).runs.get(first.id)?.phase).toBe('ended')
  })

  it('回归：计划问题的回答写盘期间换了拟计划的成员：新成员拿到回答，旧成员不再开', async () => {
    const { c, b, ch, messageId, first, release } = await asked()
    const answering = c.flowAction(ch, { type: 'answers', messageId, answers: ['管理软件'] })
    await c.flowAction(ch, { type: 'replan', messageId, memberId: b })
    release()
    await answering
    await settle()
    const next = tasks(c, ch).at(-1)!
    expect(next.assigneeId).toBe(b)
    expect(flowOf(c, ch).planner?.taskId).toBe(next.id)
    expect(lastTo(next.sessionId!).text).toContain('哪种数据中心？：管理软件')
    expect(storeOf(c).runs.get(first.id)?.phase).toBe('ended')
  })

  it('回归：换拟计划的成员、停旧的那一轮期间丢弃了草稿：不再派新的', async () => {
    const { c, b, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '@画师 帮我设计一个数据中心', clientId: 'p1' })
    await settle()
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    const g = gate()
    slowCancel = g.wait
    const replanning = c.flowAction(ch, { type: 'replan', messageId, memberId: b })
    const discarding = c.flowAction(ch, { type: 'discard', messageId })
    g.release()
    await Promise.all([replanning, discarding])
    await settle()
    expect(flowOf(c, ch).status).toBe('stopped')
    expect(tasks(c, ch)).toHaveLength(1)
  })

  it('换了人拟计划：旧的那一项还在跑时交回，报错而不是回「已交回」', async () => {
    const { c, b, ch } = await setup({ planFirst: true })
    await c.post(ch, { text: '@画师 帮我设计一个数据中心', clientId: 'p1' })
    await settle()
    const messageId = c.messages(ch).messages.find(m => m.kind === 'message' && m.flow)!.id
    const first = tasks(c, ch)[0]
    // 旧的那一轮已经开始：中断发出去了，引擎回「结束」之前它还在跑
    const store = storeOf(c)
    store.runs.set(first.id, { ...store.runs.get(first.id)!, started: true, turnId: 't1' })
    await c.flowAction(ch, { type: 'replan', messageId, memberId: b })
    await settle()
    expect(store.runs.get(first.id)?.phase).toBe('sent')
    expect(() => c.toolDone(first.sessionId!, { summary: 'x', steps: [{ title: 'x', member: '画师' }] })).toThrow(
      '已经换别的成员拟计划了',
    )
  })

  it('不先出计划的情况：频道关了、@ 了两个；只是问题时它直接回答，流程不留', async () => {
    const { c, a, b, ch } = await setup({ planFirst: true })
    const flows = () => c.messages(ch).messages.filter(m => m.kind === 'message' && m.flow)
    await c.post(ch, { text: '@画师 @程序员 一起看看', clientId: 'p1' })
    await settle()
    expect(flows()).toHaveLength(0)
    expect(tasks(c, ch).map(t => t.assigneeId)).toEqual([a, b])
    for (const t of tasks(c, ch)) await endTurn(c, t.sessionId!, '看了')

    await c.post(ch, { text: '@画师 这个函数是干嘛的', clientId: 'p2' })
    await settle()
    expect(flows()).toHaveLength(1)
    const s = tasks(c, ch).at(-1)!.sessionId!
    await endTurn(c, s, '它是算价格的。')
    expect(flowOf(c, ch).status).toBe('stopped')

    await c.update(ch, { planFirst: false })
    expect(c.state().channels.find(x => x.id === ch)?.planFirst).toBe(false)
    await c.post(ch, { text: '@画师 直接改一下', clientId: 'p3' })
    await settle()
    expect(flows()).toHaveLength(1)
    expect(tasks(c, ch).at(-1)?.title).toContain('直接改一下')
  })
})

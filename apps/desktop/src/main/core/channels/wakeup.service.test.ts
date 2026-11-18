// 事项唤醒（docs/multica-learn.md §11.6）接进频道服务：巡检逐条（到点、错过补一次、截止、在做时等、排队时并入、
// 等结束要等检查、同一轮只叫一次、流程、静默不覆盖、失效取消、卡停掉取消、两次巡检不重复、一个频道出错不影响别的）
// 和 schedule_wakeup 的条件、上限
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent, HostEvent, ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import type {
  AgentInput,
  ChannelTask,
  ChannelTextMessage,
  ChannelWakeup,
  WakeupOp,
} from '../../../shared/types/channels'
import { RELAY_PRESETS, SYSTEM_AUTHOR } from '../../../shared/types/channels'
import type { CheckRun } from '../../../shared/types/checks'
import { ChannelStore } from './store'
import { Channels, SELF_ID, type ChannelsDeps } from './service'

const projects: ProjectRecord[] = [{ id: 'p1', name: 'pixel-web', path: 'D:/web' } as ProjectRecord]
const MIN = 60_000
/** 2026-11-18 是周三（本机时区） */
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime()

let dir: string
let now: number
let opened: Channels[]
let calls: { channel: string; args: unknown[] }[]
let sessions: SessionSummary[]

const storeOf = (c: Channels) => (c as unknown as { store: ChannelStore }).store
const settle = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 2))
    for (const c of opened) await storeOf(c).flush()
  }
}

let sessionNo = 0
async function open(extra: Partial<ChannelsDeps> = {}): Promise<Channels> {
  const store = new ChannelStore(dir)
  await store.init()
  const c = new Channels({
    store,
    call: async (channel, args) => {
      calls.push({ channel, args })
      if (channel === 'engine:createSession') {
        const id = `s${++sessionNo}`
        sessions.push({ record: { id, projectId: 'p1' }, state: 'idle' } as SessionSummary)
        return { id }
      }
      if (channel === 'engine:send')
        return { queueId: (args[1] as { clientMessageId: string }).clientMessageId, status: 'queued' }
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
const sends = () =>
  calls
    .filter(c => c.channel === 'engine:send')
    .map(c => ({ sessionId: c.args[0] as string, ...(c.args[1] as { text: string; clientMessageId: string }) }))
const lastTo = (s: string) =>
  sends()
    .filter(x => x.sessionId === s)
    .at(-1)!
const tasks = (c: Channels, ch: string) => c.messages(ch).messages.filter((m): m is ChannelTask => m.kind === 'task')
const texts = (c: Channels, ch: string) =>
  c.messages(ch).messages.filter((m): m is ChannelTextMessage => m.kind === 'message')
const ev = (sessionId: string, event: EngineEvent): HostEvent => ({ kind: 'session', sessionId, seq: 0, event })
const rules = (c: Channels, ch: string): ChannelWakeup[] => c.state().channels.find(x => x.id === ch)?.wakeups ?? []
const rule = (c: Channels, ch: string, id: string) => rules(c, ch).find(r => r.id === id)!
const cardOf = (c: Channels, ch: string, id: string) => tasks(c, ch).find(t => t.id === rule(c, ch, id).card)!
const wakeMsgs = (c: Channels, ch: string) => texts(c, ch).filter(m => m.authorId === SYSTEM_AUTHOR && m.wakeup)
const add = (c: Channels, ch: string, op: Omit<Extract<WakeupOp, { op: 'add' }>, 'op'>) =>
  c.wakeupAction(ch, { op: 'add', ...op }).id!
const tick = async (c: Channels) => {
  await c.checkAlerts()
  await settle()
}

/** 这个会话最后收到的那一轮结束：回复 reply；可选改了文件、失败 */
async function endTurn(
  c: Channels,
  s: string,
  reply: string,
  opts: { files?: string[]; failed?: boolean } = {},
): Promise<void> {
  const x = lastTo(s)
  const turn = `turn-${x.clientMessageId}`
  c.hostEvent(
    ev(s, {
      type: 'item_completed',
      item: { kind: 'user', id: x.clientMessageId, text: '', createdAt: 0, turnId: turn },
    }),
  )
  if (opts.files?.length)
    c.hostEvent(
      ev(s, {
        type: 'item_completed',
        item: {
          kind: 'file_change',
          id: `f-${turn}`,
          status: 'completed',
          changes: opts.files.map(path => ({ path, kind: 'update' as const, diff: '', added: 2, removed: 1 })),
        },
      }),
    )
  if (reply)
    c.hostEvent(
      ev(s, { type: 'item_completed', item: { kind: 'assistant', id: `a-${turn}`, text: reply, status: 'completed' } }),
    )
  if (opts.failed) {
    c.hostEvent(ev(s, { type: 'turn_completed', turnId: turn, outcome: 'failed', error: '出错了' }))
    c.hostEvent(ev(s, { type: 'queue', items: [], paused: true }))
  } else c.hostEvent(ev(s, { type: 'turn_completed', turnId: turn, outcome: 'completed', error: null }))
  await settle()
}

/** 频道里两个成员：前端（a）接了「改登录按钮」（卡 x，会话 s1，还在做），测试（b）空着 */
async function setup(extra: Partial<ChannelsDeps> = {}) {
  const c = await open(extra)
  const a = await c.saveMember(null, agent('前端'))
  const b = await c.saveMember(null, agent('测试'))
  const ch = await c.create({ name: 'web', memberIds: [a, b] })
  await c.post(ch, { text: '@前端 改登录按钮', clientId: 'go' })
  await settle()
  const x = tasks(c, ch)[0]
  return { c, a, b, ch, x, s1: x.sessionId! }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsky-wakeup-'))
  now = at(18, 10)
  opened = []
  calls = []
  sessions = []
  sessionNo = 0
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of opened) await c.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('到某个时间、定期检查', () => {
  it('到点：发一条 @ 它的系统消息（回复被盯的卡）、派一张唤醒卡，提示词带指令和被盯卡的情况；被盯的卡不动；两次巡检不重复叫', async () => {
    const { c, b, ch, x, s1 } = await setup()
    await endTurn(c, s1, '按钮改好了。\n\n改了 Login.tsx。')
    const before = tasks(c, ch)[0]
    const id = add(c, ch, { on: x.id, memberId: b, when: { kind: 'at', at: now + 10 * MIN }, text: '验一下登录按钮' })
    await tick(c)
    expect(rule(c, ch, id)).toMatchObject({ state: 'active', fired: 0, card: null, by: SELF_ID })

    now += 10 * MIN
    // 上一次巡检还没跑完时又来一次：判断和记下之间没有 await，只叫一次
    await Promise.all([c.checkAlerts(), c.checkAlerts()])
    await settle()
    expect(rule(c, ch, id)).toMatchObject({ state: 'done', fired: 1 })
    const sys = wakeMsgs(c, ch)
    expect(sys).toHaveLength(1)
    expect(sys[0]).toMatchObject({ replyToId: x.id, mentions: [b], wakeup: { ruleId: id, kind: 'at' } })
    expect(tasks(c, ch)).toHaveLength(2)
    const w = cardOf(c, ch, id)
    expect(w).toMatchObject({
      assigneeId: b,
      authorId: SELF_ID,
      sourceMessageId: sys[0].id,
      title: '唤醒：验一下登录按钮',
    })
    const sent = lastTo(w.sessionId!).text
    expect(sent).toContain('交给你的人：林夏')
    expect(sent).toContain('验一下登录按钮')
    expect(sent).toContain('盯着的卡：「改登录按钮」· 已完成 · 负责人 前端')
    expect(sent).toContain('> 按钮改好了。')
    expect(sent).toContain('[silent]')
    // 被盯的卡不动
    expect(tasks(c, ch)[0]).toMatchObject({ round: 1, status: 'done', summary: before.summary, runs: before.runs })

    await endTurn(c, w.sessionId!, '验过了，没问题')
    const result = texts(c, ch).find(m => m.taskId === w.id)!
    expect(result.wakeup).toEqual({ ruleId: id, kind: 'at' })
    expect(tasks(c, ch).find(t => t.id === w.id)!.runs).toMatchObject([
      { n: 1, status: 'done', wakeup: { ruleId: id, kind: 'at' } },
    ])
    now += 60 * MIN
    await tick(c)
    expect(tasks(c, ch)).toHaveLength(2)
  })

  it('指令是斜杠命令：原样发，不拼背景', async () => {
    const { c, b, ch, x, s1 } = await setup()
    await endTurn(c, s1, '好了')
    const id = add(c, ch, { on: x.id, memberId: b, when: { kind: 'at', at: now + MIN }, text: '/review' })
    now += 2 * MIN
    await tick(c)
    expect(lastTo(cardOf(c, ch, id).sessionId!).text).toBe('/review')
  })

  it('定期检查：每次到点在同一张唤醒卡上开下一轮；应用关着错过几次，开机只补一次、下次从现在算；过了截止就结束', async () => {
    const { c, a, ch, x, s1 } = await setup()
    await endTurn(c, s1, '改好了')
    // 定期检查可以叫被盯卡自己的负责人
    const id = add(c, ch, {
      on: x.id,
      memberId: a,
      when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
      text: '看看线上有没有报错',
      until: at(25, 0),
    })
    expect(rule(c, ch, id)).toMatchObject({ next: at(19, 9), until: at(25, 0) })
    now = at(19, 9)
    await tick(c)
    const w1 = cardOf(c, ch, id)
    expect(w1).toMatchObject({ round: 1, assigneeId: a })
    expect(rule(c, ch, id)).toMatchObject({ state: 'active', fired: 1, next: at(20, 9) })
    await endTurn(c, w1.sessionId!, '没发现报错')

    now = at(20, 9, 1)
    await tick(c)
    // 同一张卡第 2 轮，不再发系统消息；提示词带着要求
    expect(wakeMsgs(c, ch)).toHaveLength(1)
    const w2 = cardOf(c, ch, id)
    expect(w2).toMatchObject({ id: w1.id, round: 2 })
    expect(lastTo(w2.sessionId!).text).toContain('（事项唤醒：定期检查的时间到了）\n看看线上有没有报错')
    await endTurn(c, w2.sessionId!, '还是没有')

    // 应用关了两天多：开机后只补一次，下次按现在算
    await c.dispose()
    now = at(22, 15)
    const d = await open()
    await tick(d)
    expect(cardOf(d, ch, id).round).toBe(3)
    expect(rule(d, ch, id)).toMatchObject({ state: 'active', fired: 3, next: at(23, 9) })
    await endTurn(d, cardOf(d, ch, id).sessionId!, '没有')
    // 截止前错过的也不补：过了截止就结束
    now = at(25, 0, 1)
    await tick(d)
    expect(rule(d, ch, id)).toMatchObject({ state: 'done', fired: 3, next: null })
    expect(cardOf(d, ch, id).round).toBe(3)
  })

  it('唤醒卡这一轮还在做：到点不叫，做完后接着叫；排着的是追加要求就把指令并进去，排着的已经是这条规则叫的不重复拼', async () => {
    const { c, b, ch, x, s1 } = await setup()
    await endTurn(c, s1, '改好了')
    const id = add(c, ch, {
      on: x.id,
      memberId: b,
      when: { kind: 'every', freq: 'hourly', hour: 0, minute: 0 },
      text: '查一下 CI',
    })
    now = at(18, 11)
    await tick(c)
    const w = cardOf(c, ch, id)
    expect(w.round).toBe(1)
    // 12:00 时第 1 轮还在做：不叫，规则也不往后排
    now = at(18, 12)
    await tick(c)
    expect(cardOf(c, ch, id).round).toBe(1)
    expect(rule(c, ch, id)).toMatchObject({ fired: 1, next: at(18, 12) })
    // 做完了：下一拍就叫
    await endTurn(c, w.sessionId!, '还在跑')
    expect(cardOf(c, ch, id).round).toBe(2)
    expect(rule(c, ch, id)).toMatchObject({ fired: 2, next: at(18, 13) })
    await endTurn(c, w.sessionId!, '过了')

    // 测试在忙别的；你在唤醒卡的串里追加要求，排着队
    await c.post(ch, { text: '@测试 跑一遍全部测试', clientId: 'y' })
    await settle()
    const y = tasks(c, ch).at(-1)!
    await c.post(ch, { text: '@测试 顺便看下日志', threadId: w.id, clientId: 'more' })
    await settle()
    expect(cardOf(c, ch, id)).toMatchObject({ round: 3, status: 'queued' })
    now = at(18, 13)
    await tick(c)
    expect(rule(c, ch, id)).toMatchObject({ fired: 3, next: at(18, 14) })
    // 14:00 还排着：并过一次的不再拼
    now = at(18, 14)
    await tick(c)
    expect(rule(c, ch, id)).toMatchObject({ fired: 4, next: at(18, 15) })
    await endTurn(c, y.sessionId!, '测试都过了')
    // 排着的追加要求开始了：带着一份唤醒指令，不带「只回 [silent]」（这一轮不算唤醒，要照常回复）
    const third = lastTo(w.sessionId!).text
    expect(third).toContain('顺便看下日志')
    expect(third.split('查一下 CI')).toHaveLength(2)
    expect(third).not.toContain('[silent]')
    await endTurn(c, w.sessionId!, '日志没问题')
    expect(
      texts(c, ch)
        .filter(m => m.taskId === w.id)
        .at(-1)!.wakeup,
    ).toBeUndefined()

    // 又在忙：15:00 叫的那一轮排着；16:00 到点时不重复拼
    await c.post(ch, { text: '@测试 再跑一遍', clientId: 'z' })
    await settle()
    const z = tasks(c, ch).at(-1)!
    now = at(18, 15)
    await tick(c)
    expect(cardOf(c, ch, id)).toMatchObject({ round: 4, status: 'queued' })
    now = at(18, 16)
    await tick(c)
    expect(rule(c, ch, id)).toMatchObject({ fired: 6, next: at(18, 17) })
    await endTurn(c, z.sessionId!, '过了')
    expect(lastTo(w.sessionId!).text.split('查一下 CI')).toHaveLength(2)
  })
})

describe('等某件事结束', () => {
  it('盯的卡做完、产出检查跑完才叫；同一轮只叫一次；挂上时已经结束的那一轮不算；不能叫被盯卡自己的负责人', async () => {
    let release!: (run: CheckRun | null) => void
    const { c, a, b, ch, x, s1 } = await setup({ runChecks: () => new Promise(r => (release = r)) })
    expect(() => add(c, ch, { on: x.id, memberId: a, when: { kind: 'ended' }, text: '测一遍' })).toThrow('负责人')
    const id = add(c, ch, { on: x.id, memberId: b, when: { kind: 'ended' }, text: '按验收标准测一遍' })
    expect(rule(c, ch, id)).toMatchObject({ next: null, sig: null })
    await endTurn(c, s1, '改好了')
    // 做完紧接着开始检查：还不叫
    expect(tasks(c, ch)[0].checks?.status).toBe('running')
    await tick(c)
    expect(rule(c, ch, id)).toMatchObject({ state: 'active', fired: 0 })
    release({ id: 'k1', at: 1, status: 'done', items: [] })
    await settle()
    expect(rule(c, ch, id)).toMatchObject({ state: 'done', fired: 1 })
    const w = cardOf(c, ch, id)
    expect(w.assigneeId).toBe(b)
    expect(lastTo(w.sessionId!).text).toContain('（事项唤醒：等着的那件事结束了）')
    await tick(c)
    expect(tasks(c, ch)).toHaveLength(2)
    // 测试做完（同一个目录，不然前端的追加要求要排在它后面）
    await endTurn(c, w.sessionId!, '测过了')

    // 卡已经结束时挂上：这一轮不算，等下一次结束
    const again = add(c, ch, { on: x.id, memberId: b, when: { kind: 'ended' }, text: '再测一遍' })
    expect(rule(c, ch, again).sig).toBe('1')
    await tick(c)
    expect(rule(c, ch, again).fired).toBe(0)
    await c.post(ch, { text: '@前端 再调一下颜色', threadId: x.id, clientId: 'more' })
    await settle()
    await endTurn(c, s1, '调好了')
    expect(rule(c, ch, again).fired).toBe(0)
    release(null)
    await settle()
    expect(rule(c, ch, again)).toMatchObject({ state: 'done', fired: 1 })
  })

  it('勾了失败也叫；没勾停下的，盯的卡停了就取消；到某个时间的规则也一起取消', async () => {
    const { c, b, ch, x, s1 } = await setup()
    const failed = add(c, ch, { on: x.id, memberId: b, when: { kind: 'ended', failed: true }, text: '看看为什么失败' })
    const ended = add(c, ch, { on: x.id, memberId: b, when: { kind: 'ended' }, text: '测一遍' })
    const later = add(c, ch, { on: x.id, memberId: b, when: { kind: 'at', at: now + 60 * MIN }, text: '一小时后看看' })
    await endTurn(c, s1, '', { failed: true })
    expect(tasks(c, ch)[0].status).toBe('failed')
    expect(rule(c, ch, failed)).toMatchObject({ state: 'done', fired: 1 })
    expect(rule(c, ch, ended).state).toBe('active')
    expect(lastTo(cardOf(c, ch, failed).sessionId!).text).toContain('「改登录按钮」· 失败')

    // 重试后还没开始就停掉
    await c.taskAction(x.id, 'retry')
    await settle()
    await c.taskAction(x.id, 'stop')
    await settle()
    expect(tasks(c, ch)[0].status).toBe('stopped')
    expect(rule(c, ch, ended)).toMatchObject({ state: 'cancelled', endNote: '盯的卡停了' })
    expect(rule(c, ch, later)).toMatchObject({ state: 'cancelled', endNote: '盯的卡停了' })
    // 停了的卡不能再挂
    expect(() => add(c, ch, { on: x.id, memberId: b, when: { kind: 'at', at: now + MIN }, text: 'x' })).toThrow('停了')
  })

  it('流程：全部交付了叫；流程停了，挂在上面的规则取消；流程步骤卡不能挂', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const b = await c.saveMember(null, agent('测试'))
    const ch = await c.create({ name: 'web', memberIds: [a, b] })
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '登录页',
      steps: [{ id: 's1', title: '写代码', memberId: a, deps: [], kind: 'work' }],
    })
    const id = add(c, ch, { on: messageId, memberId: b, when: { kind: 'ended' }, text: '流程做完了，写个总结' })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const step = tasks(c, ch).find(t => t.flow?.stepId === 's1')!
    expect(() => add(c, ch, { on: step.id, memberId: b, when: { kind: 'at', at: now + MIN }, text: 'x' })).toThrow(
      '流程里的步骤卡',
    )
    c.toolDone(step.sessionId!, { summary: '代码写好了' })
    await endTurn(c, step.sessionId!, '写好了')
    expect(rule(c, ch, id)).toMatchObject({ state: 'done', fired: 1 })
    const sent = lastTo(cardOf(c, ch, id).sessionId!).text
    expect(sent).toContain('盯着的卡：流程「登录页」· 全部交付了')
    expect(sent).toContain('① 写代码 · 前端 · 已交付：代码写好了')
    // 全部交付了的流程不能再挂「等结束」
    expect(() => add(c, ch, { on: messageId, memberId: b, when: { kind: 'ended' }, text: 'x' })).toThrow('交付')

    const second = await c.flowAction(ch, {
      type: 'create',
      title: '注册页',
      steps: [{ id: 's1', title: '写代码', memberId: a, deps: [], kind: 'work' }],
    })
    const daily = add(c, ch, {
      on: second.messageId,
      memberId: b,
      when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
      text: '看看进度',
    })
    await c.flowAction(ch, { type: 'start', messageId: second.messageId })
    await c.flowAction(ch, { type: 'stop', messageId: second.messageId })
    await settle()
    expect(rule(c, ch, daily)).toMatchObject({ state: 'cancelled', endNote: '盯的流程停了' })
  })
})

describe('静默、失效、出错', () => {
  it('[silent]：不发消息，不覆盖摘要、要你决定的事和改动统计；连续几次只留一条运行记录；没改文件不跑产出检查', async () => {
    let checked = 0
    const { c, b, ch, x, s1 } = await setup({
      runChecks: async () => {
        checked++
        return null
      },
    })
    await endTurn(c, s1, '改好了')
    expect(checked).toBe(1)
    const id = add(c, ch, {
      on: x.id,
      memberId: b,
      when: { kind: 'every', freq: 'hourly', hour: 0, minute: 0 },
      text: '看看线上',
    })
    now = at(18, 11)
    await tick(c)
    const w = cardOf(c, ch, id)
    await endTurn(c, w.sessionId!, '线上有 3 个报错，已经修了。\n需要你决定：要不要回滚？', { files: ['a.ts'] })
    // 改了文件的唤醒轮照常检查
    expect(checked).toBe(2)
    const first = cardOf(c, ch, id)
    expect(first).toMatchObject({ decision: '要不要回滚？', diff: { added: 2, removed: 1 } })
    expect(first.summary).toBeTruthy()
    const results = () => texts(c, ch).filter(m => m.taskId === w.id)
    expect(results()).toHaveLength(1)

    for (const hour of [12, 13]) {
      now = at(18, hour)
      await tick(c)
      // 唤醒的一轮开始时不清掉上一轮要你决定的事
      expect(cardOf(c, ch, id)).toMatchObject({ round: hour - 10, decision: '要不要回滚？' })
      await endTurn(c, w.sessionId!, '[silent]')
    }
    expect(results()).toHaveLength(1)
    expect(cardOf(c, ch, id)).toMatchObject({
      round: 3,
      status: 'done',
      summary: first.summary,
      decision: '要不要回滚？',
      diff: { added: 2, removed: 1 },
    })
    expect(cardOf(c, ch, id).runs?.map(r => [r.n, r.wakeup?.silent])).toEqual([
      [1, undefined],
      [3, 2],
    ])
    expect(checked).toBe(2)
  })

  it('规则失效写原因：成员移出频道、被盯的卡合并了；看板事项验收完按卡取消；取消一条', async () => {
    const { c, a, b, ch, x, s1 } = await setup()
    await endTurn(c, s1, '改好了')
    const gone = add(c, ch, { on: x.id, memberId: b, when: { kind: 'at', at: now + 60 * MIN }, text: '看看' })
    const merged = add(c, ch, {
      on: x.id,
      memberId: a,
      when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
      text: '每天看',
    })
    await c.removeMember(ch, b)
    await tick(c)
    expect(rule(c, ch, gone)).toMatchObject({ state: 'cancelled', endNote: '要叫的成员不在频道里了' })
    expect(() => add(c, ch, { on: x.id, memberId: b, when: { kind: 'at', at: now + MIN }, text: 'x' })).toThrow(
      '不在频道里',
    )
    const one = add(c, ch, { on: x.id, memberId: a, when: { kind: 'at', at: now + 60 * MIN }, text: '一' })
    const two = add(c, ch, { on: x.id, memberId: a, when: { kind: 'at', at: now + 60 * MIN }, text: '二' })
    c.wakeupAction(ch, { op: 'cancel', id: one })
    expect(rule(c, ch, one)).toMatchObject({ state: 'cancelled', endNote: null })
    expect(() => c.wakeupAction(ch, { op: 'cancel' })).toThrow('参数不正确')
    expect(() => c.wakeupAction(ch, { op: 'cancel', id: 'nope' })).toThrow('不存在')
    // 看板事项点了完成：这张卡上活着的全部取消，别的卡上的不动
    await c.post(ch, { text: '@前端 改注册页', clientId: 'y' })
    await settle()
    const y = tasks(c, ch).at(-1)!
    const left = add(c, ch, { on: y.id, memberId: a, when: { kind: 'at', at: now + 60 * MIN }, text: '看看' })
    const done = add(c, ch, { on: y.id, memberId: a, when: { kind: 'at', at: now + 60 * MIN }, text: '看看' })
    c.wakeupAction(ch, { op: 'cancel', id: done })
    c.wakeupAction(ch, { op: 'cancel', on: y.id })
    expect(rule(c, ch, left)).toMatchObject({ state: 'cancelled', endNote: '事项已经验收完了' })
    expect(rule(c, ch, done).endNote).toBeNull()
    expect(rule(c, ch, two).state).toBe('active')

    storeOf(c).patchTask(ch, x.id, { land: { kind: 'merged', commit: 'abc', base: 'main', at: now } })
    await tick(c)
    expect(rule(c, ch, merged)).toMatchObject({ state: 'cancelled', endNote: '盯的卡已经合并回去了' })
    expect(rule(c, ch, two)).toMatchObject({ state: 'cancelled', endNote: '盯的卡已经合并回去了' })
    expect(() => c.wakeupAction(ch, { op: 'snooze' } as unknown as WakeupOp)).toThrow('不支持')
  })

  it('「等结束」等的是下一轮时盯的卡合并回去了：取消写原因', async () => {
    const { c, b, ch, x, s1 } = await setup()
    await endTurn(c, s1, '改好了')
    const id = add(c, ch, { on: x.id, memberId: b, when: { kind: 'ended' }, text: '再测一遍' })
    expect(rule(c, ch, id).sig).toBe('1')
    storeOf(c).patchTask(ch, x.id, { land: { kind: 'merged', commit: 'abc', base: 'main', at: now } })
    await tick(c)
    expect(rule(c, ch, id)).toMatchObject({ state: 'cancelled', endNote: '盯的卡已经合并回去了' })
  })

  it('重试唤醒的一轮还算唤醒轮：回 [silent] 照样不发消息、只记运行记录；会话标着是唤醒轮（不弹「做完了」）', async () => {
    const { c, b, ch, x, s1 } = await setup()
    await endTurn(c, s1, '改好了')
    const id = add(c, ch, { on: x.id, memberId: b, when: { kind: 'at', at: now + MIN }, text: '看看' })
    now += 2 * MIN
    await tick(c)
    const w = cardOf(c, ch, id)
    expect(c.state().sessionTasks?.[w.sessionId!]).toMatchObject({ taskId: w.id, wakeup: true })
    await endTurn(c, w.sessionId!, '', { failed: true })
    expect(cardOf(c, ch, id).status).toBe('failed')
    await c.taskAction(w.id, 'retry')
    await settle()
    await endTurn(c, w.sessionId!, '[silent]')
    expect(texts(c, ch).filter(m => m.taskId === w.id)).toHaveLength(0)
    expect(cardOf(c, ch, id)).toMatchObject({ status: 'done', round: 2 })
    expect(cardOf(c, ch, id).runs?.at(-1)).toMatchObject({ n: 2, wakeup: { ruleId: id, silent: 1 } })
  })

  it('一个频道出错不影响别的频道；开不了的规则标成取消写原因', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const b = await c.saveMember(null, agent('测试'))
    const one = await c.create({ name: 'one', memberIds: [a, b] })
    const two = await c.create({ name: 'two', memberIds: [a, b] })
    await c.post(one, { text: '@前端 改一', clientId: '1' })
    await c.post(two, { text: '@前端 改二', clientId: '2' })
    await settle()
    const r1 = add(c, one, { on: tasks(c, one)[0].id, memberId: b, when: { kind: 'at', at: now + MIN }, text: '看一' })
    const r2 = add(c, two, { on: tasks(c, two)[0].id, memberId: b, when: { kind: 'at', at: now + MIN }, text: '看二' })
    const inner = c as unknown as Record<string, (...args: unknown[]) => unknown>
    const verdict = inner.wakeupVerdict.bind(c)
    vi.spyOn(inner, 'wakeupVerdict').mockImplementation((ch: unknown, ...rest: unknown[]) => {
      if ((ch as { id: string }).id === one) throw new Error('坏了')
      return verdict(ch, ...rest)
    })
    now += 2 * MIN
    await tick(c)
    expect(rule(c, one, r1)).toMatchObject({ state: 'active', fired: 0 })
    expect(rule(c, two, r2)).toMatchObject({ state: 'done', fired: 1 })
    vi.restoreAllMocks()
    vi.spyOn(inner, 'wakeupTarget').mockImplementationOnce(() => {
      throw new Error('读不到卡')
    })
    await tick(c)
    expect(rule(c, one, r1)).toMatchObject({ state: 'cancelled', endNote: '读不到卡' })
  })
})

describe('schedule_wakeup', () => {
  it('只在正在做的这一轮里、只叫自己；在唤醒卡上挂的算在被盯的卡上；活着最多 3 条、一共最多 10 条', async () => {
    const { c, a, ch, x, s1 } = await setup()
    expect(c.toolWakeup(s1, { text: '看 CI', after_minutes: 30 })).toContain('已挂上唤醒')
    const [first] = rules(c, ch)
    expect(first).toMatchObject({ on: x.id, memberId: a, by: a, when: { kind: 'at' }, until: null })
    expect((first.when as { at: number }).at - now).toBeGreaterThan(29 * MIN)
    expect(() => c.toolWakeup(s1, { text: 'x' })).toThrow('要填一个')
    expect(() => c.toolWakeup(s1, { text: 'x', after_minutes: 5, every: 'daily' })).toThrow('只能填一个')
    expect(() => c.toolWakeup(s1, { text: 'x', every: 'daily' })).toThrow('time')
    expect(() => c.toolWakeup(s1, { text: 'x', every: 'daily', time: '9点' })).toThrow('HH:MM')
    expect(() => c.toolWakeup(s1, { text: 'x', every: 'daily', time: '09:00', until_days: 31 })).toThrow('until_days')
    expect(() => c.toolWakeup(s1, { text: 'x', after_minutes: 0 })).toThrow('after_minutes')
    await endTurn(c, s1, '改好了')
    // 这一轮做完了：不能再挂
    expect(() => c.toolWakeup(s1, { text: 'x', after_minutes: 5 })).toThrow('正在做的这项活')

    now += 31 * MIN
    await tick(c)
    const w = cardOf(c, ch, first.id)
    expect(w).toMatchObject({ assigneeId: a, authorId: a })
    expect(lastTo(w.sessionId!).text).toContain('交给你的人：前端')
    // 在唤醒卡上做的：挂在它盯的那张卡上
    expect(c.toolWakeup(w.sessionId!, { text: '每天看一次', every: 'daily', time: '09:30' })).toContain('定期检查')
    expect(rules(c, ch).at(-1)).toMatchObject({
      on: x.id,
      by: a,
      when: { kind: 'every', freq: 'daily', hour: 9, minute: 30 },
      next: at(19, 9, 30),
    })
    c.toolWakeup(w.sessionId!, { text: '二', after_minutes: 10 })
    c.toolWakeup(w.sessionId!, { text: '三', after_minutes: 10 })
    expect(() => c.toolWakeup(w.sessionId!, { text: '四', after_minutes: 10 })).toThrow('3 条')
    // 你挂的不算 AI 的
    add(c, ch, { on: x.id, memberId: a, when: { kind: 'at', at: now + 60 * MIN }, text: '你挂的' })
    const cancelAi = () => {
      for (const r of rules(c, ch))
        if (r.state === 'active' && r.by === a) c.wakeupAction(ch, { op: 'cancel', id: r.id })
    }
    for (let total = 4; total < 10; total++) {
      if (total % 3 === 1) cancelAi()
      c.toolWakeup(w.sessionId!, { text: `第 ${total + 1} 条`, after_minutes: 10 })
    }
    cancelAi()
    expect(rules(c, ch).filter(r => r.by === a)).toHaveLength(10)
    expect(() => c.toolWakeup(w.sessionId!, { text: '十一', after_minutes: 10 })).toThrow('一共只能挂 10 条')
    // 结束了的规则被修剪掉（频道只留最近 50 条）也不重新算
    const stored = storeOf(c).channels.get(ch)!
    storeOf(c).channels.set(ch, { ...stored, wakeups: stored.wakeups!.filter(r => r.state === 'active') })
    expect(() => c.toolWakeup(w.sessionId!, { text: '十一', after_minutes: 10 })).toThrow('一共只能挂 10 条')

    // 从已有会话加入的成员不给
    storeOf(c).members = storeOf(c).members.map(m => (m.id === a ? { ...m, bound: true } : m))
    expect(() => c.toolWakeup(w.sessionId!, { text: 'x', after_minutes: 5 })).toThrow('从已有会话加入')
  })

  it('AI 挂的：唤醒卡接着算挂它的那条接力的跳数，超了防刷规则照旧停下等你放行', async () => {
    const { c, a, ch, x, s1 } = await setup()
    await c.update(ch, { relay: true, relayRules: { ...RELAY_PRESETS.careful, hops: 2, pair: null } })
    await endTurn(c, s1, '@测试 请看看')
    const y1 = tasks(c, ch).at(-1)!
    await endTurn(c, y1.sessionId!, '@前端 再改改')
    const y2 = tasks(c, ch).at(-1)!
    expect(y2).toMatchObject({ assigneeId: a, relay: { chain: x.id, hop: 2, held: null } })
    c.toolWakeup(y2.sessionId!, { text: '过会儿再看', after_minutes: 1 })
    const [r] = rules(c, ch)
    expect(r).toMatchObject({ on: y2.id, relay: { chain: x.id, hop: 2 } })
    await endTurn(c, y2.sessionId!, '好了')
    now += 2 * MIN
    await tick(c)
    expect(cardOf(c, ch, r.id)).toMatchObject({
      status: 'queued',
      sessionId: null,
      relay: { chain: x.id, hop: 3, held: 'hops', limit: 2 },
    })
  })

  it('流程步骤里不能用', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const ch = await c.create({ name: 'web', memberIds: [a] })
    const { messageId } = await c.flowAction(ch, {
      type: 'create',
      title: '登录页',
      steps: [{ id: 's1', title: '写代码', memberId: a, deps: [], kind: 'work' }],
    })
    await c.flowAction(ch, { type: 'start', messageId })
    await settle()
    const step = tasks(c, ch).find(t => t.flow?.stepId === 's1')!
    expect(() => c.toolWakeup(step.sessionId!, { text: 'x', after_minutes: 5 })).toThrow('流程里的步骤')
  })
})

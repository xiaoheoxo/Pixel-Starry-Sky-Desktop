// 牵头派活自动放行（docs/ui/channels-lead-auto-approve.md）：只认牵头本人、到上限转回提议卡、
// 同时开工数、接着用同一个对话、一批交回后叫一次牵头、全局策略
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineEvent, HostEvent, ProjectRecord, SessionSummary, UsageRecord } from '@pixelsky/protocol'
import type { AgentInput, ChannelTask, ChannelTextMessage } from '../../../shared/types/channels'
import { DEFAULT_LEAD_AUTO, cleanLeadAuto, cleanLeadAutoPolicy, leadAutoOf } from '../../../shared/types/channels'
import { ChannelStore } from './store'
import { Channels, type ChannelsDeps } from './service'

const projects: ProjectRecord[] = [{ id: 'p1', name: 'pixel-web', path: 'D:/web' } as ProjectRecord]

let dir: string
let now: number
let opened: Channels[]
let calls: { channel: string; args: unknown[] }[]
let sessions: SessionSummary[]
/** engine:openSession 回的上下文占用（按会话） */
let context: Record<string, { used: number; window: number }>
/** engine:createSession 存下的会话记录 */
let records: Record<string, Record<string, unknown>>

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
        const id = `s${++n}`
        // 会话记录按开的时候的设置存（引擎、成员设置）
        records[id] = { model: null, ...(args[0] as Record<string, unknown>), id }
        sessions.push({ record: { id, projectId: 'p1' }, state: 'idle' } as SessionSummary)
        return { id }
      }
      if (channel === 'engine:openSession') {
        const id = args[0] as string
        const u = context[id] ?? { used: 10_000, window: 200_000 }
        return {
          snapshot: {
            record: records[id] ?? { id, projectId: 'p1', engine: 'claude', model: null },
            usage: { contextTokens: u.used, contextWindow: u.window },
            items: [],
            pending: [],
          },
        }
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
    planFirst: false,
    alertTimer: false,
    ...extra,
  })
  opened.push(c)
  return c
}

const agent = (name: string, patch: Partial<AgentInput> = {}): AgentInput => ({
  name,
  engine: 'claude',
  projectId: 'p1',
  copyId: null,
  settings: {},
  instructions: '',
  mode: 'per-task',
  sameDir: 'together',
  ...patch,
})
const sends = () =>
  calls
    .filter(c => c.channel === 'engine:send')
    .map(c => ({ sessionId: c.args[0] as string, ...(c.args[1] as { text: string; clientMessageId: string }) }))
const created = () => calls.filter(c => c.channel === 'engine:createSession').length
const tasks = (c: Channels, id: string) => c.messages(id).messages.filter((m): m is ChannelTask => m.kind === 'task')
const texts = (c: Channels, id: string) =>
  c.messages(id).messages.filter((m): m is ChannelTextMessage => m.kind === 'message')
const ev = (sessionId: string, event: EngineEvent): HostEvent => ({ kind: 'session', sessionId, seq: 0, event })

/** 某次发出去的那一轮做完 */
function finish(c: Channels, s: { sessionId: string; clientMessageId: string }, reply: string): void {
  const turn = `turn-${s.clientMessageId}`
  c.hostEvent(
    ev(s.sessionId, {
      type: 'item_completed',
      item: { kind: 'user', id: s.clientMessageId, text: '', createdAt: 0, turnId: turn },
    }),
  )
  c.hostEvent(
    ev(s.sessionId, {
      type: 'item_completed',
      item: { kind: 'assistant', id: `a-${turn}`, text: reply, status: 'completed' },
    }),
  )
  c.hostEvent(ev(s.sessionId, { type: 'turn_completed', turnId: turn, outcome: 'completed', error: null }))
}

/** 一个有牵头的频道：牵头、前端、后端、文档；牵头接了一项活，返回牵头的会话 */
async function withLead(c: Channels, patch: Partial<AgentInput> = {}) {
  const lead = await c.saveMember(null, agent('牵头'))
  const fe = await c.saveMember(null, agent('前端'))
  const be = await c.saveMember(null, agent('后端'))
  const doc = await c.saveMember(null, agent('文档', patch))
  const ch = await c.create({ name: 'web', memberIds: [lead, fe, be, doc] })
  await c.update(ch, { lead })
  await c.post(ch, { text: '@牵头 登录改成验证码', clientId: 'go' })
  await settle()
  return { ch, lead, fe, be, doc, s: sends()[0] }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsky-leadauto-'))
  now = 1_000_000
  opened = []
  calls = []
  sessions = []
  context = {}
  records = {}
})
afterEach(async () => {
  for (const c of opened) await c.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('牵头派活自动放行', () => {
  it('新频道按全局策略默认开；牵头的提议直接派出，挂在牵头这张卡的接力链上；别的成员照旧出提议卡', async () => {
    const c = await open()
    const { ch, lead, fe, be, s } = await withLead(c)
    expect(c.state().channels.find(x => x.id === ch)?.leadAuto?.on).toBe(true)
    const [leadTask] = tasks(c, ch)
    expect(await c.toolPropose(s.sessionId, '前端', '改登录页')).toContain('已派给 前端')
    await settle()
    const sent = tasks(c, ch).find(t => t.assigneeId === fe)!
    expect(sent).toMatchObject({
      authorId: lead,
      routedBy: { memberId: lead, auto: true },
      batch: `${leadTask.id}:1`,
      relay: { chain: leadTask.id, hop: 1, held: null },
    })
    expect(texts(c, ch).at(-1)?.proposal).toMatchObject({ state: 'sent', auto: true, taskId: sent.id })
    expect(texts(c, ch).at(-1)?.mentions).toEqual([])
    // 前端做的时候提议：不是牵头，照旧等你
    const feSend = sends().find(x => x.sessionId !== s.sessionId)!
    expect(await c.toolPropose(feSend.sessionId, '后端', '加接口')).toContain('等用户决定')
    expect(texts(c, ch).at(-1)?.proposal).toMatchObject({ assigneeId: be, state: 'open' })
    expect(texts(c, ch).at(-1)?.proposal?.auto).toBeUndefined()
  })

  it('同一个成员手上有同样的活不再派；关掉开关、全局一律人工复核时照旧出提议卡', async () => {
    const c = await open()
    const { ch, fe, s } = await withLead(c)
    await c.toolPropose(s.sessionId, '前端', '改登录页')
    expect(await c.toolPropose(s.sessionId, '前端', '改 登录页！')).toContain('手上已经有同样的活')
    expect(tasks(c, ch).filter(t => t.assigneeId === fe)).toHaveLength(1)

    await c.update(ch, { leadAuto: { ...DEFAULT_LEAD_AUTO, on: false } })
    expect(await c.toolPropose(s.sessionId, '后端', '加接口')).toContain('等用户决定')
    await c.update(ch, { leadAuto: DEFAULT_LEAD_AUTO })
    await c.setLeadAutoPolicy('locked')
    expect(c.state().channels.find(x => x.id === ch)?.leadAuto?.on).toBe(false)
    expect(await c.toolPropose(s.sessionId, '文档', '写说明')).toContain('等用户决定')
    await expect(c.update(ch, { leadAuto: DEFAULT_LEAD_AUTO })).rejects.toThrow('一律人工复核')
    // 一律人工复核、默认关：新频道都是关的
    const off = await c.create({ name: 'off' })
    expect(c.state().channels.find(x => x.id === off)?.leadAuto?.on).toBe(false)
  })

  it('牵头被结果叫醒后接着派算下一轮：到上限转回等你，你放行后重新数', async () => {
    const c = await open()
    const { ch, s } = await withLead(c)
    // 不允许互相派活也叫醒牵头：只叫自动派出的活
    await c.update(ch, { leadAuto: { ...DEFAULT_LEAD_AUTO, rounds: 1 } })
    await c.toolPropose(s.sessionId, '前端', '改登录页')
    finish(c, s, '分好了')
    await settle()
    finish(c, sends().at(-1)!, '改好了')
    await settle()
    // 牵头被叫醒（回到原来的对话），在唤醒卡上接着派：第 2 轮
    expect(tasks(c, ch).filter(t => t.wake)).toHaveLength(1)
    // 回复里 @ 不会派活：叫醒时让牵头用 task_propose 接着派
    expect(sends().at(-1)!.text).toContain('用 task_propose 派给对应的成员')
    expect(await c.toolPropose(s.sessionId, '后端', '加日志')).toContain('派活的轮数')
    const held = texts(c, ch).at(-1)!
    expect(held.proposal).toMatchObject({ state: 'open', held: 'rounds' })
    await c.proposal(ch, held.id, true)
    expect(await c.toolPropose(s.sessionId, '文档', '写说明')).toContain('已派给')
    // 你放行的那项交回：不允许互相派活时不叫牵头
    await settle()
    const accepted = tasks(c, ch).find(t => t.sourceMessageId === held.id)!
    expect(accepted.routedBy?.auto).toBeFalsy()
    const send = sends().find(x => x.sessionId === accepted.sessionId)!
    finish(c, send, '加好了')
    await settle()
    expect(tasks(c, ch).filter(t => t.wake)).toHaveLength(1)
  })

  it('到上限转回提议卡并写明原因：一次几项、完全放行的成员、每小时用量', async () => {
    let records: UsageRecord[] = []
    const c = await open({ usageRecords: async () => records })
    const { ch, s } = await withLead(c, { settings: { permissionMode: 'full' } })
    await c.update(ch, { leadAuto: { ...DEFAULT_LEAD_AUTO, perBatch: 1, concurrent: 10 } })
    expect(await c.toolPropose(s.sessionId, '文档', '写说明')).toContain('完全放行')
    expect(texts(c, ch).at(-1)?.proposal).toMatchObject({ state: 'open', held: 'full' })
    await c.toolPropose(s.sessionId, '前端', '改登录页')
    expect(await c.toolPropose(s.sessionId, '后端', '加接口')).toContain('这一轮自动派出的已经到')
    expect(texts(c, ch).at(-1)?.proposal).toMatchObject({ state: 'open', held: 'batch' })

    // 每小时用量：自动派出的卡跑过的轮次这一小时用满了
    const auto = tasks(c, ch).filter(t => t.routedBy?.auto)
    const fe = sends().find(x => x.sessionId !== s.sessionId)!
    finish(c, fe, '改好了')
    await settle()
    const turns = tasks(c, ch).find(t => t.id === auto[0].id)!.turns ?? []
    expect(turns.length).toBeGreaterThan(0)
    records = turns.map(
      key =>
        ({
          sessionId: key.slice(0, key.lastIndexOf(':')),
          turnId: key.slice(key.lastIndexOf(':') + 1),
          endedAt: now,
          input: 400_000,
          output: 100_000,
          cacheRead: 9_000_000,
          cacheWrite: 1,
        }) as UsageRecord,
    )
    await c.update(ch, { leadAuto: { ...DEFAULT_LEAD_AUTO, perBatch: 50 } })
    expect(await c.toolPropose(s.sessionId, '前端', '改注册页')).toContain('token 到了')
    expect(texts(c, ch).at(-1)?.proposal).toMatchObject({ held: 'hour' })
  })

  it('同时开工数满了排着等空位；同一个成员接着用最近的对话（缓存还在、上下文不大），太久、太大的新开', async () => {
    const c = await open()
    const { ch, fe, be, s } = await withLead(c)
    await c.update(ch, { leadAuto: { ...DEFAULT_LEAD_AUTO, concurrent: 1 } })
    await c.toolPropose(s.sessionId, '前端', '改登录页')
    await c.toolPropose(s.sessionId, '后端', '加接口')
    await settle()
    const feTask = tasks(c, ch).find(t => t.assigneeId === fe)!
    const beTask = tasks(c, ch).find(t => t.assigneeId === be)!
    // 牵头、前端发出去了；后端排着
    expect(sends()).toHaveLength(2)
    expect(feTask.sessionId).toBeTruthy()
    expect(beTask).toMatchObject({ status: 'queued', autoQueued: true, sessionId: null })
    const feSend = sends().at(-1)!

    // 前端做完：后端开工；前端再接一项，接着用刚才的对话
    finish(c, feSend, '改好了')
    await settle()
    expect(tasks(c, ch).find(t => t.id === beTask.id)).toMatchObject({ autoQueued: false })
    const beSend = sends().at(-1)!
    finish(c, beSend, '加好了')
    await settle()
    const before = created()
    await c.toolPropose(s.sessionId, '前端', '改错误提示')
    await settle()
    expect(created()).toBe(before)
    expect(sends().at(-1)!.sessionId).toBe(feSend.sessionId)
    expect(tasks(c, ch).at(-1)).toMatchObject({ assigneeId: fe, reused: { context: 5 } })

    // 上下文到了一半：新开
    finish(c, sends().at(-1)!, '改好了')
    await settle()
    context[feSend.sessionId] = { used: 120_000, window: 200_000 }
    await c.toolPropose(s.sessionId, '前端', '改空状态')
    await settle()
    expect(created()).toBe(before + 1)
    expect(tasks(c, ch).at(-1)?.reused).toBeUndefined()

    // 放了一个多小时：缓存过期，新开
    finish(c, sends().at(-1)!, '改好了')
    await settle()
    now += 31 * 60_000
    await c.toolPropose(s.sessionId, '前端', '改深色主题')
    await settle()
    expect(created()).toBe(before + 2)

    // 回归：成员改了权限，按旧设置开的会话不接着用；会话里被改过权限的也不用
    const fresh = sends().at(-1)!
    finish(c, fresh, '改好了')
    await settle()
    await c.saveMember(null, { ...agent('前端'), id: fe, settings: { permissionMode: 'edits' } })
    await c.toolPropose(s.sessionId, '前端', '改按钮颜色')
    await settle()
    expect(created()).toBe(before + 3)
    expect(tasks(c, ch).at(-1)?.reused).toBeUndefined()
    const edits = sends().at(-1)!
    finish(c, edits, '改好了')
    await settle()
    records[edits.sessionId].permissionMode = 'full'
    await c.toolPropose(s.sessionId, '前端', '改图标')
    await settle()
    expect(created()).toBe(before + 4)
  })

  it('回归：上一项活被停下的，那段对话不接着用', async () => {
    const c = await open()
    const { ch, fe, s } = await withLead(c)
    await c.toolPropose(s.sessionId, '前端', '改登录页')
    await settle()
    const first = tasks(c, ch).find(t => t.assigneeId === fe)!
    await c.taskAction(first.id, 'stop')
    await settle()
    expect(tasks(c, ch).find(t => t.id === first.id)?.status).toBe('stopped')
    const before = created()
    await c.toolPropose(s.sessionId, '前端', '改错误提示')
    await settle()
    expect(created()).toBe(before + 1)
    expect(tasks(c, ch).at(-1)?.reused).toBeUndefined()
  })

  it('一批都交回后才叫牵头一次，两份结果并在同一张唤醒卡上；牵头回到派活的那个对话', async () => {
    const c = await open()
    const { ch, lead, s } = await withLead(c)
    await c.update(ch, { relay: true })
    await c.toolPropose(s.sessionId, '前端', '改登录页')
    await c.toolPropose(s.sessionId, '后端', '加接口')
    finish(c, s, '分好了，等结果')
    await settle()
    const [feSend, beSend] = sends().filter(x => x.sessionId !== s.sessionId)
    finish(c, feSend, '登录页改好了')
    await settle()
    expect(tasks(c, ch).filter(t => t.wake)).toHaveLength(0)
    finish(c, beSend, '接口加好了')
    await settle()
    const wakes = tasks(c, ch).filter(t => t.wake)
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({ assigneeId: lead, wake: { from: ['前端', '后端'] }, reused: { context: 5 } })
    expect(sends().at(-1)!.sessionId).toBe(s.sessionId)
  })
})

describe('自动放行设置的整理', () => {
  it('超出范围、类型不对报中文错误；没设过的频道按关，一律人工复核时关', () => {
    expect(cleanLeadAuto(DEFAULT_LEAD_AUTO)).toEqual(DEFAULT_LEAD_AUTO)
    expect(() => cleanLeadAuto({ ...DEFAULT_LEAD_AUTO, concurrent: 0 })).toThrow('同时开工的项数')
    expect(() => cleanLeadAuto({ ...DEFAULT_LEAD_AUTO, hourTokens: 1.5 })).toThrow('token 上限')
    expect(() => cleanLeadAuto({ ...DEFAULT_LEAD_AUTO, on: 'yes' })).toThrow('自动放行的设置不对')
    expect(() => cleanLeadAutoPolicy('sometimes')).toThrow('全局策略')
    expect(leadAutoOf({}, 'on').on).toBe(false)
    expect(leadAutoOf({ leadAuto: DEFAULT_LEAD_AUTO }, 'locked').on).toBe(false)
    expect(leadAutoOf({ leadAuto: DEFAULT_LEAD_AUTO }, 'off').on).toBe(true)
  })
})

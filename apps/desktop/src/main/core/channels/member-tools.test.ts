// 频道成员工具（docs/ui/channels-member-tools.md）：member_list / member_update / member_remove 和成员卡
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import type { AgentConfig, AgentInput, ChannelTextMessage } from '../../../shared/types/channels'
import { ChannelStore } from './store'
import { Channels, SELF_ID, type ChannelsDeps } from './service'
import { MEMBER_UNDO_MS, changeSummary, checkUpdate, inputWith, memberDetail } from './member-tools'

const projects: ProjectRecord[] = [{ id: 'p1', name: 'pixel-web', path: 'D:/web' } as ProjectRecord]

let dir: string
let now: number
let opened: Channels[]
let calls: { channel: string; args: unknown[] }[]
let sessions: SessionSummary[]

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
        const o = args[0] as { projectId: string }
        const id = `s${++n}`
        sessions.push({ record: { id, projectId: o.projectId }, state: 'idle' } as SessionSummary)
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
    now: () => now,
    channelTools: true,
    planFirst: false,
    alertTimer: false,
    memberModels: async m => (m.engine === 'claude' ? ['claude-opus-5-5', 'claude-sonnet-5-5'] : null),
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
const members = (c: Channels): AgentConfig[] => (c as unknown as { store: ChannelStore }).store.members
const memberOf = (c: Channels, id: string) => members(c).find(m => m.id === id)!
const cards = (c: Channels, ch: string) =>
  c.messages(ch).messages.filter((m): m is ChannelTextMessage => m.kind === 'message' && !!m.memberChange)
const lastCard = (c: Channels, ch: string) => cards(c, ch).at(-1)!
const sentSession = () => (calls.find(x => x.channel === 'engine:send')!.args[0] as string) ?? ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pixelsky-member-tools-'))
  now = 1_000_000
  opened = []
  calls = []
  sessions = []
})
afterEach(async () => {
  for (const c of opened) await c.dispose()
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 频道 web：前端（派了活，调工具的就是它）、画师（也在 docs 频道里）、你 */
async function setup(extra: Partial<ChannelsDeps> = {}) {
  const c = await open(extra)
  const a = await c.saveMember(null, agent('前端', { instructions: '写界面\n第二行' }))
  const b = await c.saveMember(
    null,
    agent('画师', {
      settings: { model: 'claude-sonnet-5-5', effort: 'low', permissionMode: 'edits' },
      instructions: '出样稿',
      tools: { mode: 'only', ids: ['mcp:figma'] },
      copyPerTask: true,
      sameDir: 'copy',
    }),
  )
  const ch = await c.create({ name: 'web', memberIds: [a, b] })
  await c.create({ name: 'docs', memberIds: [b] })
  await c.post(ch, { text: '@前端 改按钮', clientId: 'go' })
  await settle()
  return { c, a, b, ch, s: sentSession() }
}

describe('纯函数', () => {
  const m = {
    id: 'm',
    name: '画师',
    engine: 'claude',
    machineId: 'local',
    projectId: 'p1',
    copyId: null,
    settings: { model: 'claude-sonnet-5-5', effort: 'low' },
    instructions: '出样稿',
    mode: 'per-task',
    sharedSessionId: null,
    createdAt: 1,
  } as AgentConfig

  it('checkUpdate 只留真要改的；模型不在目录、强度不对、绑定会话改模型都报错；读不到目录只查格式', () => {
    expect(
      checkUpdate(m, { model: 'claude-sonnet-5-5', effort: 'high', reason: 'x' }, ['claude-sonnet-5-5'], 2000),
    ).toEqual({
      from: { effort: 'low' },
      to: { effort: 'high' },
    })
    expect(() => checkUpdate(m, { model: 'gpt-5.5', reason: 'x' }, ['claude-sonnet-5-5'], 2000)).toThrow(
      '能换的：claude-sonnet-5-5',
    )
    expect(checkUpdate(m, { model: 'whatever', reason: 'x' }, null, 2000).to).toEqual({ model: 'whatever' })
    expect(() => checkUpdate(m, { effort: 'ultra', reason: 'x' }, null, 2000)).toThrow('强度只能是')
    expect(() => checkUpdate(m, { effort: 'low', reason: 'x' }, null, 2000)).toThrow('没有要改的')
    expect(() => checkUpdate(m, { reason: 'x' }, null, 2000)).toThrow('至少给一项')
    expect(() => checkUpdate(m, { instructions: 'x'.repeat(2001), reason: 'x' }, null, 2000)).toThrow('最多 2000')
    expect(() => checkUpdate({ ...m, bound: true }, { effort: 'high', reason: 'x' }, null, 2000)).toThrow('只能改职责')
    expect(checkUpdate({ ...m, bound: true }, { instructions: '新职责', reason: 'x' }, null, 2000).to).toEqual({
      instructions: '新职责',
    })
    // 空字符串是跟随默认；平台 / 自定义接口必须有模型
    expect(checkUpdate(m, { model: '', reason: 'x' }, null, 2000).to).toEqual({ model: null })
    const platform = { ...m, settings: { ...m.settings, platform: { groupId: '1', account: 'a@b' } } }
    expect(() => checkUpdate(platform, { model: '', reason: 'x' }, null, 2000)).toThrow('必须指定一个模型')
  })

  it('inputWith 合并进现有配置，跟随默认时去掉这一项；memberDetail 超过 30 个模型截断', () => {
    const input = inputWith({ ...m, tools: { mode: 'only', ids: ['x'] } }, { model: null, effort: 'high' })
    expect(input.settings).toEqual({ effort: 'high' })
    expect(input).toMatchObject({ id: 'm', name: '画师', tools: { mode: 'only', ids: ['x'] }, instructions: '出样稿' })
    expect(input).not.toHaveProperty('createdAt')
    const models = Array.from({ length: 35 }, (_, i) => `m${i}`)
    expect(memberDetail(m, models, ['docs'])).toContain('（还有 5 个没列）')
    expect(memberDetail(m, models, ['docs'])).toContain('#docs（改了那边一起变）')
    expect(
      changeSummary(
        { op: 'update', memberId: 'm', from: { effort: 'low' }, to: { effort: 'high' }, reason: '难', state: 'open' },
        '画师',
        false,
      ),
    ).toBe('想改 画师 的强度 low → high：难')
  })
})

describe('member_list', () => {
  it('列出成员：用户、自己、牵头、在做几项、跟随默认；给名字时多列模型、强度、别的频道', async () => {
    const { c, a, ch, s } = await setup()
    await c.update(ch, { lead: a })
    const list = await c.toolMembers(s)
    expect(list).toContain('有 3 个成员')
    expect(list).toContain('- 林夏（用户）')
    expect(list).toContain(
      '- 前端（AI，你自己，牵头） · claude · 跟随默认 · 强度 跟随默认 · 每项活新开会话 · 在做 1 项 · 职责：写界面',
    )
    expect(list).toContain('- 画师（AI） · claude · claude-sonnet-5-5 · 强度 low')
    const detail = await c.toolMembers(s, '画师')
    expect(detail).toContain('能换的模型：claude-opus-5-5、claude-sonnet-5-5')
    expect(detail).toContain('能选的强度：low / medium / high / xhigh / max')
    expect(detail).toContain('#docs（改了那边一起变）')
    await expect(c.toolMembers(s, '后端')).rejects.toThrow('可以选：前端、画师')
  })
})

describe('member_update', () => {
  it('发卡（@你），点「改」才改，其它设置原样保留；channel_read 看得到结果；能改回去', async () => {
    const { c, b, ch, s } = await setup()
    await expect(c.toolMemberUpdate(s, '林夏', { effort: 'high', reason: '想' })).rejects.toThrow('是用户')
    await expect(c.toolMemberUpdate(s, '画师', { model: 'gpt-5.5', reason: '想' })).rejects.toThrow('能换的')
    await expect(c.toolMemberUpdate(s, '画师', { effort: 'high', reason: ' ' })).rejects.toThrow('reason')

    const reply = await c.toolMemberUpdate(s, '画师', { model: 'claude-opus-5-5', effort: 'high', reason: '做不对' })
    expect(reply).toContain('用户点「改」才生效')
    const card = lastCard(c, ch)
    expect(card).toMatchObject({
      mentions: [SELF_ID],
      text: '想改 画师 的模型 claude-sonnet-5-5 → claude-opus-5-5、强度 low → high：做不对',
      memberChange: { op: 'update', memberId: b, state: 'open', from: { model: 'claude-sonnet-5-5', effort: 'low' } },
    })
    expect(memberOf(c, b).settings.effort).toBe('low')
    expect((c.state().needs ?? []).some(n => n.kind === 'member' && n.messageId === card.id)).toBe(true)

    await c.memberChange(ch, card.id, 'accept')
    const after = memberOf(c, b)
    expect(after.settings).toEqual({ model: 'claude-opus-5-5', effort: 'high', permissionMode: 'edits' })
    expect(after).toMatchObject({ tools: { mode: 'only', ids: ['mcp:figma'] }, copyPerTask: true, sameDir: 'copy' })
    expect(lastCard(c, ch).memberChange?.state).toBe('done')
    expect(c.toolRead(s, {})).toContain('做不对（已改）')
    expect((c.state().needs ?? []).some(n => n.kind === 'member')).toBe(false)

    await c.memberChange(ch, card.id, 'undo')
    expect(memberOf(c, b).settings).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', permissionMode: 'edits' })
    expect(lastCard(c, ch).memberChange?.state).toBe('undone')
  })

  it('卡发出来后你改过：点「改」不覆盖，标已失效；改了之后又被改过，改不回去；超过 24 小时不能撤回', async () => {
    const { c, b, ch, s } = await setup()
    await c.toolMemberUpdate(s, '画师', { effort: 'high', reason: '难' })
    await c.saveMember(null, { ...inputWith(memberOf(c, b), { effort: 'max' }), id: b })
    await c.memberChange(ch, lastCard(c, ch).id, 'accept')
    expect(lastCard(c, ch).memberChange).toMatchObject({ state: 'stale', why: 'changed' })
    expect(memberOf(c, b).settings.effort).toBe('max')

    await c.toolMemberUpdate(s, '画师', { effort: 'medium', reason: '降一档' })
    const card = lastCard(c, ch)
    await c.memberChange(ch, card.id, 'accept')
    await c.saveMember(null, { ...inputWith(memberOf(c, b), { effort: 'low' }), id: b })
    await expect(c.memberChange(ch, card.id, 'undo')).rejects.toThrow('改不回去')

    await c.saveMember(null, { ...inputWith(memberOf(c, b), { effort: 'medium' }), id: b })
    now += MEMBER_UNDO_MS + 1
    await expect(c.memberChange(ch, card.id, 'undo')).rejects.toThrow('不能撤回')
  })

  it('一直用同一个会话的成员：模型、强度同步到那个会话', async () => {
    const c = await open()
    const a = await c.saveMember(null, agent('前端'))
    const b = await c.saveMember(null, agent('助手', { mode: 'shared', settings: { model: 'claude-sonnet-5-5' } }))
    const ch = await c.create({ name: 'web', memberIds: [a, b] })
    await c.post(ch, { text: '@助手 看看', clientId: 'x' })
    await settle()
    await c.post(ch, { text: '@前端 改按钮', clientId: 'go' })
    await settle()
    const shared = memberOf(c, b).sharedSessionId!
    const s = calls.filter(x => x.channel === 'engine:send').at(-1)!.args[0] as string
    // 会话里原来的强度是引擎默认给的（成员没设）：改回去时放回会话原来的值
    Object.assign(sessions.find(x => x.record.id === shared)!.record, { model: 'claude-sonnet-5-5', effort: 'medium' })
    await c.toolMemberUpdate(s, '助手', { model: 'claude-opus-5-5', effort: 'high', reason: '要想深' })
    const card = lastCard(c, ch)
    await c.memberChange(ch, card.id, 'accept')
    const updates = () => calls.filter(x => x.channel === 'engine:updateSession').map(x => x.args)
    expect(updates().at(-1)).toEqual([shared, { model: 'claude-opus-5-5', effort: 'high' }])
    await c.memberChange(ch, card.id, 'undo')
    expect(memberOf(c, b).settings).toEqual({ model: 'claude-sonnet-5-5' })
    expect(updates().at(-1)).toEqual([shared, { model: 'claude-sonnet-5-5', effort: 'medium' }])
  })

  it('同时来两次同一种改动：只留一张开着的', async () => {
    const { c, ch, s } = await setup()
    await c.toolMemberUpdate(s, '画师', { effort: 'high', reason: '1' })
    await Promise.all([
      c.toolMemberUpdate(s, '画师', { effort: 'medium', reason: '2' }),
      c.toolMemberUpdate(s, '画师', { effort: 'max', reason: '3' }),
    ])
    expect(
      cards(c, ch)
        .filter(m => m.memberChange?.state === 'open')
        .map(m => m.memberChange?.reason),
    ).toEqual(['3'])
  })

  it('每个成员开着的卡最多 3 张；同一个成员同一种改动只留新的（不算多）；处理掉一张就能再发', async () => {
    const { c, ch, s } = await setup()
    const t = await c.saveMember(null, agent('测试'))
    await c.addMember(ch, t)
    await c.toolMemberUpdate(s, '画师', { effort: 'high', reason: '1' })
    await c.toolMemberUpdate(s, '画师', { effort: 'medium', reason: '2' })
    expect(cards(c, ch).map(m => m.memberChange?.state)).toEqual(['stale', 'open'])
    expect(cards(c, ch)[0].memberChange?.why).toBe('replaced')
    await c.toolMemberUpdate(s, '前端', { effort: 'high', reason: '3' })
    await c.toolMemberRemove(s, '画师', '4')
    await expect(c.toolMemberRemove(s, '测试', '5')).rejects.toThrow('还有 3 张没处理')
    await c.toolMemberUpdate(s, '画师', { effort: 'max', reason: '6' })
    const open = cards(c, ch).filter(m => m.memberChange?.state === 'open')
    expect(open.map(m => m.memberChange?.reason)).toEqual(['3', '4', '6'])
    await c.memberChange(ch, open[0].id, 'dismiss')
    await expect(c.toolMemberRemove(s, '测试', '7')).resolves.toContain('卡已发到')
  })
})

describe('member_remove', () => {
  it('不能移出自己；点「移出」才移出（牵头清掉），能加回来；成员不在了标已失效', async () => {
    const { c, a, b, ch, s } = await setup()
    await expect(c.toolMemberRemove(s, '前端', '累了')).rejects.toThrow('不能把你自己移出频道')
    await c.update(ch, { lead: b })
    await c.toolMemberRemove(s, '画师', '用不上')
    const card = lastCard(c, ch)
    expect(card.text).toBe('想把 画师 移出频道：用不上')
    await c.memberChange(ch, card.id, 'accept')
    const channel = c.state().channels.find(x => x.id === ch)!
    expect(channel.memberIds).not.toContain(b)
    expect(channel.memberIds).toContain(a)
    expect(channel.lead ?? null).toBeNull()
    expect(c.toolRead(s, {})).toContain('用不上（已移出）')
    await c.memberChange(ch, card.id, 'undo')
    expect(c.state().channels.find(x => x.id === ch)!.memberIds).toContain(b)

    await c.toolMemberRemove(s, '画师', '还是用不上')
    await c.removeMember(ch, b)
    await c.memberChange(ch, lastCard(c, ch).id, 'accept')
    expect(lastCard(c, ch).memberChange).toMatchObject({ state: 'stale', why: 'gone' })
  })
})

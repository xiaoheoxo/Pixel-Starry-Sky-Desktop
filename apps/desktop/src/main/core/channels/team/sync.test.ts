import { describe, expect, it, vi } from 'vitest'
import type { AgentMember, ChannelMessage } from '../../../../shared/types/channels'
import { TeamApi } from './api'
import { FakeCloud, until } from './fake-cloud'
import type { RealtimeStatus, TeamFrame } from './realtime'
import { CACHE_MAX, TeamSync } from './sync'

function setup() {
  const cloud = new FakeCloud()
  let handlers!: { onFrame(f: TeamFrame): void; onStatus(s: RealtimeStatus): void }
  const realtime = { start: vi.fn(), stop: vi.fn(), restart: vi.fn() }
  const sync = new TeamSync({
    api: new TeamApi(cloud.fetch),
    realtime: h => {
      handlers = h
      return realtime
    },
  })
  cloud.push = f => handlers.onFrame(f)
  const pushes: { channelId: string; message: ChannelMessage }[] = []
  let changes = 0
  sync.subscribe({ message: p => pushes.push(p), changed: () => changes++ })
  const online = async () => {
    sync.start()
    handlers.onStatus('online')
    await until(() => sync.connection() === 'online')
  }
  return {
    cloud,
    sync,
    realtime,
    pushes,
    online,
    status: (s: RealtimeStatus) => handlers.onStatus(s),
    frame: (f: TeamFrame) => handlers.onFrame(f),
    changes: () => changes,
  }
}

describe('TeamSync', () => {
  it('连上后拉总览，映射成频道和成员', async () => {
    const t = setup()
    t.cloud.addAgent('u:2', 'm-2')
    t.cloud.addAgent('u:1', 'm-1')
    t.sync.bindLocal(
      id =>
        ({
          status: 'running',
          task: '改设置页',
          config: { id } as AgentMember['config'],
          queued: 1,
        }) satisfies Partial<AgentMember>,
    )
    expect(t.sync.connection()).toBe('signed-out')
    await t.online()
    const snap = t.sync.snapshot()
    expect(snap.connection).toBe('online')
    expect(snap.syncedAt).toBeGreaterThan(0)
    expect(snap.teams[0]).toMatchObject({ id: 'tm_1', role: 'owner' })
    expect(snap.teams[0].members.map(m => [m.id, m.online])).toEqual([
      ['u:1', true],
      ['u:2', true],
      ['u:3', false],
    ])
    const [ch] = t.sync.channels()
    expect(ch).toMatchObject({ id: 'tc_1', scope: 'team', teamId: 'tm_1', unread: 0, name: '更新日志' })
    expect(ch.memberIds).toEqual(expect.arrayContaining(['u:1', 'u:2', 'u:3', 'ta_1', 'ta_2']))
    const members = t.sync.members()
    expect(members.find(m => m.id === 'u:1')).toMatchObject({
      kind: 'human',
      you: true,
      userId: 'u:1',
      role: 'owner',
      online: true,
    })
    expect(members.find(m => m.id === 'u:3')).toMatchObject({ online: false, role: 'observer' })
    // 别人的 AI 成员：主人在线按云端上报的状态，不是你的就没有 config
    const theirs = members.find(m => m.id === 'ta_1') as AgentMember
    expect(theirs).toMatchObject({
      mine: false,
      ownerId: 'u:2',
      ownerName: '周宁',
      teamAgentId: 'ta_1',
      policy: 'approve',
      status: 'idle',
    })
    expect(theirs.config).toBeUndefined()
    // 自己的：本机的状态和配置
    const mine = members.find(m => m.id === 'ta_2') as AgentMember
    expect(mine).toMatchObject({
      mine: true,
      status: 'running',
      task: '改设置页',
      ownerId: 'u:1',
      teamAgentId: 'ta_2',
      queued: 1,
    })
    expect(mine.config).toMatchObject({ id: 'm-1' })
  })

  it('主人不在线时他的 AI 成员显示离线', async () => {
    const t = setup()
    t.cloud.users['u:2'].online = false
    t.cloud.addAgent('u:2', 'm-2', { status: 'running' })
    await t.online()
    expect(t.sync.members().find(m => m.id === 'ta_1')).toMatchObject({ status: 'offline' })
    // 在线状态帧
    t.frame({ type: 'presence', team: 'tm_1', user: 'u:2', online: true })
    expect(t.sync.members().find(m => m.id === 'ta_1')).toMatchObject({ status: 'running' })
    t.frame({ type: 'presence', team: 'tm_1', user: 'u:2', online: false })
    expect(t.sync.snapshot().teams[0].members.find(m => m.id === 'u:2')).toMatchObject({ online: false })
    expect(t.sync.snapshot().teams[0].members.find(m => m.id === 'u:2')?.lastSeenAt).toBeGreaterThan(0)
    t.frame({ type: 'hello', online: { tm_1: ['u:3'] } })
    expect(t.sync.snapshot().teams[0].members.find(m => m.id === 'u:3')?.online).toBe(true)
  })

  it('推送来的消息计未读和 @，看过后清零并告诉云端读到哪条', async () => {
    const t = setup()
    await t.online()
    t.cloud.userPost('u:2', 'tc_1', '大家好')
    t.cloud.userPost('u:2', 'tc_1', '@林夏 看一下', ['u:1'])
    expect(t.sync.channels()[0]).toMatchObject({ unread: 2, mentioned: true })
    expect(t.pushes.map(p => p.message.kind)).toEqual(['message', 'message'])
    // 自己发的不算未读
    t.cloud.userPost('u:1', 'tc_1', '收到')
    expect(t.sync.channels()[0].unread).toBe(2)
    t.sync.markRead('tc_1')
    expect(t.sync.channels()[0]).toMatchObject({ unread: 0, mentioned: false })
    await until(() => t.cloud.calls.some(c => c.path.endsWith('/read')))
    expect(t.cloud.calls.find(c => c.path.endsWith('/read'))?.body).toEqual({ n: 3 })
    // 没有新内容不再重复通知
    t.sync.markRead('tc_1')
    expect(t.cloud.calls.filter(c => c.path.endsWith('/read'))).toHaveLength(1)
    // 同一条消息推两遍只算一次
    const before = t.pushes.length
    t.cloud.userPost('u:2', 'tc_1', '又一条')
    const dup = (t.cloud.messages.get('tc_1') ?? []).at(-1)!
    t.cloud.push({
      type: 'message',
      team: 'tm_1',
      channel: 'tc_1',
      seq: dup.seq as number,
      message: (await import('./api')).parseMessage(dup)!,
    })
    expect(t.pushes.length).toBe(before + 1)
    expect(t.sync.channels()[0].unread).toBe(1)
  })

  it('消息分页：先拉最近的，往上翻再拉更早的', async () => {
    const t = setup()
    for (let i = 1; i <= 130; i++) t.cloud.userPost('u:2', 'tc_1', `第 ${i} 条`)
    await t.online()
    const first = await t.sync.page('tc_1')
    expect(first.messages).toHaveLength(100)
    expect(first.more).toBe(true)
    expect(first.messages.at(-1)).toMatchObject({ text: '第 130 条' })
    const oldest = first.messages[0]
    const older = await t.sync.page('tc_1', oldest.at)
    expect(older.messages).toHaveLength(30)
    expect(older.more).toBe(false)
    expect(older.messages[0]).toMatchObject({ text: '第 1 条' })
    expect(t.cloud.calls.some(c => c.path.includes('before='))).toBe(true)
  })

  it('消息分页：全部在同一毫秒时按最早那条的 id 往前取，一条不漏', async () => {
    const t = setup()
    const clock = t.cloud as unknown as { tick: number }
    for (let i = 1; i <= 130; i++) {
      // 假云端每条消息的时间 = 基准 + (++tick) 秒：每次拨回同一刻
      clock.tick = 0
      t.cloud.userPost('u:2', 'tc_1', `第 ${i} 条`)
    }
    await t.online()
    const first = await t.sync.page('tc_1')
    expect(first.messages).toHaveLength(100)
    const oldest = first.messages[0]
    expect(new Set(first.messages.map(m => m.at)).size).toBe(1)
    // 只给时间：同一毫秒的全被排除（老的调用）
    expect((await t.sync.page('tc_1', oldest.at)).messages).toHaveLength(0)
    const older = await t.sync.page('tc_1', oldest.at, oldest.id)
    expect(older.messages).toHaveLength(30)
    expect(older.more).toBe(false)
    expect(older.messages[0]).toMatchObject({ text: '第 1 条' })
    expect(older.messages.at(-1)).toMatchObject({ text: '第 30 条' })
  })

  it('缓存只留最近 500 条', async () => {
    const t = setup()
    await t.online()
    await t.sync.page('tc_1')
    for (let i = 0; i < CACHE_MAX + 5; i++) t.cloud.userPost('u:2', 'tc_1', `m${i}`)
    const page = await t.sync.page('tc_1')
    expect(page.messages).toHaveLength(200)
    expect(page.more).toBe(true)
    expect(page.messages.at(-1)).toMatchObject({ text: `m${CACHE_MAX + 4}` })
  })

  it('断线期间错过的消息，重连后按 seq 补齐', async () => {
    const t = setup()
    await t.online()
    await t.sync.page('tc_1')
    t.cloud.userPost('u:2', 'tc_1', '在线时')
    // 断线：推送丢了
    t.status('offline')
    expect(t.sync.connection()).toBe('offline')
    t.cloud.push = () => {}
    t.cloud.userPost('u:2', 'tc_1', '错过 1')
    t.cloud.userPost('u:3', 'tc_1', '错过 2')
    t.cloud.calls.length = 0
    t.status('online')
    await until(() => t.sync.connection() === 'online')
    await until(() => t.cloud.calls.some(c => c.path.includes('after=')))
    const page = await t.sync.page('tc_1')
    expect(page.messages.map(m => (m.kind === 'message' ? m.text : ''))).toEqual(['在线时', '错过 1', '错过 2'])
    expect(t.sync.channels()[0].unread).toBe(3)
    // 补齐之后不再重复拉
    t.cloud.calls.length = 0
    await t.sync.reload('plain')
    expect(t.cloud.calls.some(c => c.path.includes('after='))).toBe(false)
  })

  it('team 帧触发重拉总览，新频道出现', async () => {
    const t = setup()
    await t.online()
    t.cloud.channels.push({ id: 'tc_9', name: '设计评审', topic: null, createdBy: 'u:2' })
    t.cloud.messages.set('tc_9', [])
    t.frame({ type: 'team', team: 'tm_1', seq: 200 })
    await until(() => t.sync.channels().length === 2)
    expect(t.sync.channels().map(c => c.name)).toContain('设计评审')
  })

  it('被移出：这个团队的数据马上消失', async () => {
    const t = setup()
    await t.online()
    expect(t.sync.channels()).toHaveLength(1)
    t.cloud.deployed = true
    t.frame({ type: 'removed', team: 'tm_1' })
    expect(t.sync.snapshot().teams).toHaveLength(0)
    expect(t.sync.channels()).toHaveLength(0)
  })

  it('云端没部署团队接口（404）：unavailable，不再连实时通道', async () => {
    const t = setup()
    t.cloud.deployed = false
    t.sync.start()
    await until(() => t.sync.connection() === 'unavailable')
    expect(t.realtime.stop).toHaveBeenCalled()
    expect(t.sync.snapshot().teams).toEqual([])
    // 手动重试：部署好了就恢复
    t.cloud.deployed = true
    const refresh = t.sync.refresh()
    t.status('online')
    await refresh
    await until(() => t.sync.connection() === 'online')
    expect(t.sync.channels()).toHaveLength(1)
  })

  it('云端没部署后，排着的重拉 / 操作触发的重拉又成功了：重新开实时通道，不假装 online', async () => {
    const t = setup()
    await t.online()
    expect(t.realtime.start).toHaveBeenCalledTimes(1)
    t.cloud.deployed = false
    await t.sync.reload('plain')
    expect(t.sync.connection()).toBe('unavailable')
    expect(t.realtime.stop).toHaveBeenCalled()
    t.cloud.deployed = true
    await t.sync.reload('plain')
    expect(t.realtime.start).toHaveBeenCalledTimes(2)
    expect(t.sync.connection()).toBe('connecting')
    t.status('online')
    await until(() => t.sync.connection() === 'online')
    expect(t.sync.channels()).toHaveLength(1)
    t.sync.stop()
  })

  it('正在拉总览时又要重拉（比如改动之后）：等的是拉完再拉的那一次，拿到改动后的数据', async () => {
    const t = setup()
    await t.online()
    const first = t.sync.reload('plain')
    // 正在拉的那次已经发出，之后云端才改名
    t.cloud.channels[0].name = '新名字'
    await t.sync.reload('plain')
    expect(t.sync.channels()[0].name).toBe('新名字')
    await first
    t.sync.stop()
  })

  it('连不上云端：offline，缓存的数据还在；恢复后自动重试', async () => {
    const t = setup()
    await t.online()
    t.cloud.down = true
    await t.sync.reload('plain')
    expect(t.sync.connection()).toBe('offline')
    expect(t.sync.channels()).toHaveLength(1)
    expect(t.sync.snapshot().syncedAt).not.toBeNull()
    t.cloud.down = false
    await t.sync.reload('plain')
    expect(t.sync.connection()).toBe('online')
  })

  it('退出登录：清空所有团队数据', async () => {
    const t = setup()
    await t.online()
    t.sync.stop()
    expect(t.sync.connection()).toBe('signed-out')
    expect(t.sync.channels()).toEqual([])
    expect(t.sync.members()).toEqual([])
    expect(t.sync.snapshot()).toMatchObject({ teams: [], invites: [], syncedAt: null })
    expect(t.realtime.stop).toHaveBeenCalled()
  })

  it('任务卡映射：主人、待办请求、主人离线', async () => {
    const t = setup()
    t.cloud.users['u:2'].online = false
    const a = t.cloud.addAgent('u:2', 'm-2')
    await t.online()
    const { tasks } = t.cloud.userPost('u:1', 'tc_1', '@审查员 看看', [a.id as string])
    const card = t.sync.taskOf(tasks[0].id as string)
    expect(card).toMatchObject({
      kind: 'task',
      status: 'approval',
      assigneeId: a.id,
      ownerId: 'u:2',
      authorId: 'u:1',
      pendingAction: null,
      ownerOffline: false,
    })
    t.cloud.task(tasks[0].id as string).status = 'queued'
    t.cloud.push({
      type: 'message',
      team: 'tm_1',
      channel: 'tc_1',
      seq: 999,
      message: (await import('./api')).parseMessage({
        ...t.cloud.card(tasks[0].id as string),
        seq: 999,
        updated_at: '2030-01-01T00:00:00Z',
      })!,
    })
    expect(t.sync.taskOf(tasks[0].id as string)).toMatchObject({ status: 'queued', ownerOffline: true })
  })
})

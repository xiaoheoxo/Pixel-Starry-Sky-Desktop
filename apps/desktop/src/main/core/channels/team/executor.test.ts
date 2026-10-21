import { describe, expect, it, vi } from 'vitest'
import type { AgentConfig, ChannelTask } from '../../../../shared/types/channels'
import type { TaskRun, TeamRunRef } from '../tracker'
import { newTaskRun } from '../tracker'
import { TeamApi } from './api'
import { TeamExecutor, type ExecutorHost } from './executor'
import { FakeCloud, until } from './fake-cloud'
import type { RealtimeStatus, TeamFrame } from './realtime'
import { TeamSync } from './sync'

const DEVICE = 'dev-A'

function config(id: string, name: string): AgentConfig {
  return {
    id,
    name,
    engine: 'claude',
    machineId: 'local',
    projectId: 'p1',
    copyId: null,
    settings: {},
    instructions: '只改前端代码',
    mode: 'per-task',
    sharedSessionId: null,
    createdAt: 1,
  }
}

function setup() {
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
  const members = new Map<string, AgentConfig>([['m-1', config('m-1', '前端助手')]])
  const runs = new Map<string, TaskRun>()
  const finals: (TeamRunRef['final'] | undefined)[] = []
  let status: 'idle' | 'running' | 'waiting' | 'offline' = 'idle'
  const host = {
    member: vi.fn((id: string) => members.get(id)),
    run: vi.fn((id: string) => runs.get(id)),
    runs: vi.fn(() => [...runs.values()]),
    enqueue: vi.fn((run: TaskRun) => void runs.set(run.taskId, run)),
    nextRound: vi.fn(),
    addFollowUp: vi.fn(),
    action: vi.fn(async () => {}),
    setFinal: vi.fn((id: string, final: TeamRunRef['final'] | undefined) => {
      finals.push(final)
      const run = runs.get(id)
      if (run?.team) runs.set(id, { ...run, team: { ...run.team, final } })
    }),
    agentStatus: vi.fn(() => ({ status, task: status === 'running' ? '改设置页' : null })),
    locale: () => 'zh-CN' as const,
  } satisfies ExecutorHost
  const exec = new TeamExecutor({ sync, host, deviceId: DEVICE, progressMs: 60, statusMs: 10 })
  const online = async () => {
    sync.start()
    handlers.onStatus('online')
    await until(() => sync.connection() === 'online')
  }
  const claims = () => cloud.calls.filter(c => c.path.endsWith('/claim'))
  const patches = () => cloud.calls.filter(c => c.method === 'PATCH' && c.path.includes('/tasks/'))
  return {
    cloud,
    sync,
    exec,
    host,
    members,
    runs,
    finals,
    online,
    claims,
    patches,
    setStatus: (s: typeof status) => (status = s),
    status: (s: RealtimeStatus) => handlers.onStatus(s),
  }
}

/** 云端里已经有我的 AI 成员 ta_1，周宁（u:2）发消息 @ 它，任务卡 queued（规则「团队成员可直接派活」） */
function queued(t: ReturnType<typeof setup>, text = '@前端助手 把设置页迁到新表单') {
  const agent = t.cloud.addAgent('u:1', 'm-1', { policy: 'team' })
  t.cloud.userPost('u:2', 'tc_1', '先说背景：旧表单太乱了')
  const { tasks } = t.cloud.userPost('u:2', 'tc_1', text, [agent.id as string])
  return { agent, id: tasks[0].id as string }
}

describe('TeamExecutor 认领和派活', () => {
  it('连上云端后拉待办：认领，带最近讨论排进成员的队列', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    await t.online()
    await until(() => t.host.enqueue.mock.calls.length > 0)
    expect(t.claims()).toHaveLength(1)
    expect(t.claims()[0].body).toEqual({ device: DEVICE })
    const run = t.host.enqueue.mock.calls[0][0]
    expect(run).toMatchObject({
      taskId: id,
      channelId: 'tc_1',
      memberId: 'm-1',
      phase: 'waiting',
      round: 1,
      team: { teamId: 'tm_1', channelId: 'tc_1', messageId: id, agentId: agent.id, author: 'u:2' },
    })
    // 提示词：频道、派活的人用显示名、职责、最近的讨论、这次的要求
    expect(run.prompt).toContain('#更新日志')
    expect(run.prompt).toContain('周宁')
    expect(run.prompt).toContain('只改前端代码')
    expect(run.prompt).toContain('周宁：先说背景：旧表单太乱了')
    expect(run.prompt).toContain('@前端助手 把设置页迁到新表单')
    expect(run.freshPrompt).toBe(run.prompt)
    expect(t.cloud.task(id).claimed_by).toBe(DEVICE)
  })

  it('@全体 派来的活：提示词写明频道里还有谁同时收到', async () => {
    const t = setup()
    const mine = t.cloud.addAgent('u:1', 'm-1', { policy: 'team' })
    const theirs = t.cloud.addAgent('u:2', 'm-9', { policy: 'team' })
    t.cloud.userPost('u:2', 'tc_1', '@全体 自我介绍一下', [mine.id as string, theirs.id as string])
    await t.online()
    await until(() => t.host.enqueue.mock.calls.length > 0)
    const run = t.host.enqueue.mock.calls[0][0]
    expect(run.prompt).toContain('这条消息发给了频道里全体 AI 成员，审查员 也同时收到了。')
  })

  it('要我同意的活（approval）不开工；主人同意后才认领', async () => {
    const t = setup()
    const agent = t.cloud.addAgent('u:1', 'm-1')
    const { tasks } = t.cloud.userPost('u:2', 'tc_1', '@前端助手 重构', [agent.id as string])
    const id = tasks[0].id as string
    expect(t.cloud.task(id).status).toBe('approval')
    await t.online()
    await new Promise(r => setTimeout(r, 40))
    expect(t.claims()).toHaveLength(0)
    expect(t.host.enqueue).not.toHaveBeenCalled()
    await t.sync.taskCall(id, teamId => t.sync.api.approve(teamId, id, true))
    await until(() => t.host.enqueue.mock.calls.length === 1)
    expect(t.claims()).toHaveLength(1)
  })

  it('不是我的 AI 成员的活不碰', async () => {
    const t = setup()
    const other = t.cloud.addAgent('u:2', 'm-9', { policy: 'team' })
    t.cloud.userPost('u:1', 'tc_1', '@审查员 看一下', [other.id as string])
    await t.online()
    await new Promise(r => setTimeout(r, 40))
    expect(t.claims()).toHaveLength(0)
    expect(t.host.enqueue).not.toHaveBeenCalled()
  })

  it('已被别的设备认领：不动', async () => {
    const t = setup()
    const { id } = queued(t)
    t.cloud.task(id).claimed_by = 'dev-B'
    await t.online()
    await new Promise(r => setTimeout(r, 40))
    expect(t.claims()).toHaveLength(0)
    expect(t.host.enqueue).not.toHaveBeenCalled()
  })

  it('认领时被别的设备抢先（409）：不开工、不标失败', async () => {
    const t = setup()
    queued(t)
    t.cloud.failures['POST /v1/teams/tm_1/tasks'] = 409
    await t.online()
    await until(() => t.claims().length >= 1)
    await new Promise(r => setTimeout(r, 40))
    expect(t.claims()).toHaveLength(1)
    expect(t.host.enqueue).not.toHaveBeenCalled()
    expect(t.patches()).toHaveLength(0)
  })

  it('本机成员已被删除：认领后标失败「这个 AI 成员已被删除」', async () => {
    const t = setup()
    const { id } = queued(t)
    t.members.clear()
    await t.online()
    await until(() => t.cloud.task(id).status === 'failed')
    expect(t.cloud.task(id)).toMatchObject({ status: 'failed', error: '这个 AI 成员已被删除', claimed_by: DEVICE })
    expect(t.host.enqueue).not.toHaveBeenCalled()
  })

  it('成员已不在这个频道（云端登记没了）：同样标失败', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.agents = t.cloud.agents.filter(a => a.id !== agent.id)
    await t.online()
    await until(() => t.cloud.task(id).status === 'failed')
    expect(t.cloud.task(id).error).toBe('这个 AI 成员已被删除')
  })

  it('认领过但本机没有运行记录：标失败，不重复开工', async () => {
    const t = setup()
    const { id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'queued'
    await t.online()
    await until(() => t.cloud.task(id).status === 'failed')
    expect(t.claims()).toHaveLength(0)
    expect(t.host.enqueue).not.toHaveBeenCalled()
  })

  it('实时推送来的新任务卡同样会被认领', async () => {
    const t = setup()
    const agent = t.cloud.addAgent('u:1', 'm-1', { policy: 'team' })
    await t.online()
    await until(() => t.cloud.calls.some(c => c.path.endsWith('/tasks/mine')))
    t.cloud.userPost('u:2', 'tc_1', '@前端助手 来活了', [agent.id as string])
    await until(() => t.host.enqueue.mock.calls.length === 1)
  })
})

describe('TeamExecutor 写回云端', () => {
  const runFor = (id: string, agentId: string): TaskRun =>
    newTaskRun({
      taskId: id,
      channelId: 'tc_1',
      memberId: 'm-1',
      queuedAt: 1,
      round: 1,
      prompt: 'p',
      freshPrompt: 'p',
      team: { teamId: 'tm_1', channelId: 'tc_1', messageId: id, agentId, author: 'u:2' },
    })

  it('只写和云端不一样的字段；进度更新节流，其余马上写', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'waiting'
    await t.online()
    const run = runFor(id, agent.id as string)
    t.runs.set(id, run)
    t.exec.send(run, { status: 'running' })
    await until(() => t.patches().length === 1)
    expect(t.patches()[0].body).toEqual({ status: 'running' })
    // 状态没变：不再写
    t.exec.send(run, { status: 'running' })
    // 进度：第一次马上写，一分钟内连发几次合成一次
    t.exec.send(run, { progress: { done: 1, total: 4 } })
    await until(() => t.patches().length === 2)
    t.exec.send(run, { progress: { done: 2, total: 4 } })
    t.exec.send(run, { progress: { done: 3, total: 4 } })
    await new Promise(r => setTimeout(r, 20))
    expect(t.patches()).toHaveLength(2)
    await until(() => t.patches().length === 3)
    expect(t.patches()[2].body).toEqual({ progress: { done: 3, total: 4 } })
    // 状态变化不等节流
    t.exec.send(run, { progress: { done: 4, total: 4 } })
    t.exec.send(run, { status: 'waiting' })
    await until(() => t.patches().length === 4)
    expect(t.patches()[3].body).toEqual({ progress: { done: 4, total: 4 }, status: 'waiting' })
    expect(t.cloud.task(id)).toMatchObject({ status: 'waiting', progress: { done: 4, total: 4 } })
  })

  it('做完：先以 AI 成员的身份发结果，再写任务卡；写成功后清掉收尾记录', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'waiting'
    await t.online()
    const run = runFor(id, agent.id as string)
    t.runs.set(id, run)
    t.exec.send(
      run,
      { status: 'done', summary: '迁完了', diff: { added: 20, removed: 5 }, decision: null, error: null, note: null },
      { text: '改好了，共 3 个文件。', mentions: ['u:2'] },
    )
    await until(() => t.cloud.task(id).status === 'done')
    const post = t.cloud.calls.find(
      c => c.method === 'POST' && c.path.endsWith('/messages') && (c.body as { agent_id?: string })?.agent_id,
    )!
    expect(post.body).toMatchObject({
      agent_id: agent.id,
      task_id: id,
      reply_to: id,
      text: '改好了，共 3 个文件。',
      mentions: ['u:2'],
    })
    expect(t.cloud.calls.indexOf(post)).toBeLessThan(
      t.cloud.calls.findIndex(c => c.method === 'PATCH' && c.path.includes('/tasks/')),
    )
    expect(t.cloud.task(id)).toMatchObject({ summary: '迁完了', diff: { added: 20, removed: 5 } })
    expect(t.finals[0]).toMatchObject({ result: { text: '改好了，共 3 个文件。' } })
    await until(() => t.finals.at(-1) === undefined)
    // 结果消息在频道里
    const list = t.cloud.messages.get('tc_1')!
    expect(list.at(-1)).toMatchObject({ author: agent.id, task_id: id, format: 'markdown' })
  })

  it('结果消息的 clientId 用产生它的那一轮：发出去之前已经开了下一轮也不和下一轮撞号', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'waiting'
    await t.online()
    const run = { ...runFor(id, agent.id as string), round: 1 }
    t.runs.set(id, run)
    t.exec.send(run, { status: 'done' }, { text: '第一轮', mentions: [] })
    // 追加要求：同步开了第二轮（service.ts 里 patchTeam 之后马上 nextRound）
    t.runs.set(id, { ...run, round: 2 })
    await until(() => t.cloud.task(id).status === 'done')
    const post = t.cloud.calls.find(c => c.method === 'POST' && c.path.endsWith('/messages'))!
    expect((post.body as { client_id?: string }).client_id).toBe(`res-${id}-1`)
  })

  it('没连上云端时留着，连上后补发；收尾记录重启后也能补发', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    // 重启前留下的运行信息：已经结束、收尾没写回去
    const ended: TaskRun = {
      ...runFor(id, agent.id as string),
      phase: 'ended',
      team: {
        teamId: 'tm_1',
        channelId: 'tc_1',
        messageId: id,
        agentId: agent.id as string,
        author: 'u:2',
        final: { patch: { status: 'done', summary: '好了' }, result: { text: '结果', mentions: [] } },
      },
    }
    t.runs.set(id, ended)
    await t.online()
    await until(() => t.cloud.task(id).status === 'done')
    expect(t.cloud.task(id).summary).toBe('好了')
    expect(t.cloud.messages.get('tc_1')!.some(m => m.text === '结果')).toBe(true)
    await until(() => t.finals.at(-1) === undefined)
  })

  it('实时通道没断、只是重拉总览失败被标离线：之后重拉成功（不触发 ready）也补发', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'waiting'
    await t.online()
    const run = runFor(id, agent.id as string)
    t.runs.set(id, run)
    const ready = vi.fn()
    t.sync.subscribe({ ready })
    t.cloud.failures['GET /v1/teams'] = 500
    await t.sync.reload('plain')
    expect(t.sync.connection()).toBe('offline')
    t.exec.send(run, { status: 'done', summary: '好了' }, { text: '结果', mentions: [] })
    await new Promise(r => setTimeout(r, 20))
    expect(t.patches()).toHaveLength(0)
    delete t.cloud.failures['GET /v1/teams']
    await t.sync.reload('plain')
    expect(t.sync.connection()).toBe('online')
    await until(() => t.cloud.task(id).status === 'done')
    expect(ready).not.toHaveBeenCalled()
    await until(() => t.finals.at(-1) === undefined)
    t.sync.stop()
  })

  it('网络出错会重试；云端不认（409 / 404）就放弃', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'waiting'
    await t.online()
    const run = runFor(id, agent.id as string)
    t.runs.set(id, run)
    t.cloud.failures[`PATCH /v1/teams/tm_1/tasks/${id}`] = 500
    t.exec.send(run, { status: 'running' })
    await until(() => t.patches().length === 1)
    delete t.cloud.failures[`PATCH /v1/teams/tm_1/tasks/${id}`]
    await until(() => t.cloud.task(id).status === 'running', 8000)
    // 404：放弃，不再发
    t.cloud.failures[`PATCH /v1/teams/tm_1/tasks/${id}`] = 404
    const before = t.patches().length
    t.exec.send(run, { status: 'waiting' })
    await until(() => t.patches().length === before + 1)
    await new Promise(r => setTimeout(r, 60))
    expect(t.patches()).toHaveLength(before + 1)
  }, 15_000)
})

describe('TeamExecutor 取消 / 停止 / 重试 / 追加要求', () => {
  it('别人点了「停止」：照 Phase B 执行，再清掉卡片上的请求', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'running'
    const run = {
      ...newTaskRun({
        taskId: id,
        channelId: 'tc_1',
        memberId: 'm-1',
        queuedAt: 1,
        round: 1,
        prompt: 'p',
        freshPrompt: 'p',
        team: { teamId: 'tm_1', channelId: 'tc_1', messageId: id, agentId: agent.id as string },
      }),
      phase: 'sent' as const,
    }
    t.runs.set(id, run)
    await t.online()
    await t.sync.taskCall(id, teamId => t.sync.api.action(teamId, id, 'stop'))
    await until(() => t.host.action.mock.calls.length === 1)
    expect(t.host.action).toHaveBeenCalledWith(id, 'stop')
    await until(() => t.cloud.task(id).pending_action === null)
    expect(t.patches().at(-1)?.body).toEqual({ clear_action: true })
  })

  it('取消一张没人在做的卡：直接标「已停止 · 已取消」', async () => {
    const t = setup()
    const agent = t.cloud.addAgent('u:1', 'm-1')
    const { tasks } = t.cloud.userPost('u:2', 'tc_1', '@前端助手 重构', [agent.id as string])
    const id = tasks[0].id as string
    await t.online()
    await t.sync.taskCall(id, teamId => t.sync.api.action(teamId, id, 'cancel'))
    await until(() => t.cloud.task(id).status === 'stopped')
    expect(t.cloud.task(id)).toMatchObject({ note: 'cancelled', pending_action: null })
    expect(t.host.action).not.toHaveBeenCalled()
  })

  it('重试：失败的卡有运行记录时开下一轮，再清请求', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'failed'
    const run: TaskRun = {
      ...newTaskRun({
        taskId: id,
        channelId: 'tc_1',
        memberId: 'm-1',
        queuedAt: 1,
        round: 1,
        prompt: '原提示词',
        freshPrompt: '完整提示词',
        team: { teamId: 'tm_1', channelId: 'tc_1', messageId: id, agentId: agent.id as string },
      }),
      phase: 'ended',
    }
    t.runs.set(id, run)
    await t.online()
    await t.sync.page('tc_1')
    await t.sync.taskCall(id, teamId => t.sync.api.action(teamId, id, 'retry'))
    await until(() => t.host.nextRound.mock.calls.length === 1)
    const [card, usedRun, prompt, fresh, team, memberId] = t.host.nextRound.mock.calls[0] as unknown as [
      ChannelTask,
      TaskRun,
      string,
      string,
      TeamRunRef,
      string,
    ]
    expect(card.id).toBe(id)
    expect(usedRun.taskId).toBe(id)
    expect(prompt).toBe('原提示词')
    expect(fresh).toBe('完整提示词')
    expect(team.messageId).toBe(id)
    expect(memberId).toBe('m-1')
    await until(() => t.cloud.task(id).pending_action === null)
  })

  it('这一轮做完后有人回复任务卡追加要求：新一轮用追加的文字', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'done'
    const run: TaskRun = {
      ...newTaskRun({
        taskId: id,
        channelId: 'tc_1',
        memberId: 'm-1',
        queuedAt: 1,
        round: 1,
        prompt: 'p',
        freshPrompt: 'p',
        team: { teamId: 'tm_1', channelId: 'tc_1', messageId: id, agentId: agent.id as string },
      }),
      phase: 'ended',
    }
    t.runs.set(id, run)
    await t.online()
    const { message } = t.cloud.userPost('u:2', 'tc_1', '再把按钮改成圆角', [], id)
    await until(() => t.host.nextRound.mock.calls.length === 1)
    const [, , prompt, fresh, team] = t.host.nextRound.mock.calls[0] as unknown as [
      ChannelTask,
      TaskRun,
      string,
      string,
      TeamRunRef,
    ]
    expect(prompt).toContain('再把按钮改成圆角')
    expect(prompt).toContain('周宁')
    expect(fresh).toContain('再把按钮改成圆角')
    expect(team.follow).toBe(message.id)
    expect(t.cloud.task(id).round).toBe(2)
  })

  it('还在做的时候追加要求：交给宿主攒着，同一条不重复', async () => {
    const t = setup()
    const { agent, id } = queued(t)
    t.cloud.task(id).claimed_by = DEVICE
    t.cloud.task(id).status = 'running'
    const run: TaskRun = {
      ...newTaskRun({
        taskId: id,
        channelId: 'tc_1',
        memberId: 'm-1',
        queuedAt: 1,
        round: 1,
        prompt: 'p',
        freshPrompt: 'p',
        team: { teamId: 'tm_1', channelId: 'tc_1', messageId: id, agentId: agent.id as string },
      }),
      phase: 'sent',
    }
    t.runs.set(id, run)
    await t.online()
    t.cloud.userPost('u:2', 'tc_1', '顺便加个测试', [], id)
    await until(() => t.host.addFollowUp.mock.calls.length === 1)
    expect(t.host.addFollowUp.mock.calls[0][1]).toContain('顺便加个测试')
    expect(t.host.nextRound).not.toHaveBeenCalled()
  })
})

describe('TeamExecutor 上报成员状态', () => {
  it('状态变了才上报；没变不重复', async () => {
    const t = setup()
    const agent = t.cloud.addAgent('u:1', 'm-1')
    t.cloud.addAgent('u:2', 'm-9')
    await t.online()
    const reports = () => t.cloud.calls.filter(c => c.path.endsWith('/agents/status'))
    await until(() => reports().length === 1)
    // 只报自己的
    expect(reports()[0].body).toEqual({ agents: [{ id: agent.id, status: 'idle', task: null }] })
    t.exec.statusChanged()
    await new Promise(r => setTimeout(r, 40))
    expect(reports()).toHaveLength(1)
    t.setStatus('running')
    t.exec.statusChanged()
    await until(() => reports().length === 2)
    expect(reports()[1].body).toEqual({ agents: [{ id: agent.id, status: 'running', task: '改设置页' }] })
    expect(t.cloud.agent(agent.id as string)).toMatchObject({ status: 'running', task: '改设置页' })
    // 机器断开本机报「空闲」
    t.setStatus('offline')
    t.exec.statusChanged()
    await until(() => reports().length === 3)
    expect(reports()[2].body).toEqual({ agents: [{ id: agent.id, status: 'idle', task: null }] })
  })
})

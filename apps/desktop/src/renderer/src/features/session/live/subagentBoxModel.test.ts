import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRuns, ApprovalRequest, Item, NoticeTask } from '@pixelsky/protocol'
import { approvalWaiting, boxElapsed, completionBox, dispatchBox } from './subagentBoxModel'

type Tool = Extract<Item, { kind: 'tool' }>
const call = (status: Tool['status'], name = 'Agent'): Tool => ({
  kind: 'tool',
  id: 't1',
  tool: 'task',
  name,
  title: '拆分存储层接口',
  output: '',
  status,
})
const run = (patch: Partial<AgentRun> = {}): AgentRun => ({
  id: 'a1',
  label: 'C3',
  type: 'general-purpose',
  model: 'claude-haiku-4-5',
  state: 'running',
  startedAt: 1_000,
  durationMs: 0,
  tokens: 0,
  toolCalls: 0,
  phase: null,
  prompt: '',
  result: '',
  toolUseId: 't1',
  ...patch,
})
const runs = (...agents: AgentRun[]): AgentRuns => ({ workflows: [], agents })

describe('派发小框', () => {
  it('任务名、模型短名、状态来自条目和追踪里的运行记录；点开定位到这次调用', () => {
    expect(dispatchBox(call('running'), runs(run()))).toMatchObject({
      icon: 'bot',
      label: '拆分存储层接口',
      model: 'haiku-4-5',
      fullModel: 'claude-haiku-4-5',
      typeLabel: '',
      state: 'running',
      startedAt: 1_000,
      target: { toolUseId: 't1' },
    })
  })

  it('条目结束以条目为准；还在跑看运行记录；没有运行记录（Codex）只看条目', () => {
    expect(dispatchBox(call('completed'), runs(run())).state).toBe('done')
    expect(dispatchBox(call('failed')).state).toBe('failed')
    expect(dispatchBox(call('interrupted')).state).toBe('stopped')
    expect(dispatchBox(call('running'), runs(run({ state: 'failed' }))).state).toBe('failed')
    expect(dispatchBox(call('running')).state).toBe('running')
  })

  it('Codex 派出调用完成只说明派出去了：有运行记录时看子智能体自己的状态', () => {
    const spawn = (status: Tool['status']) => call(status, 'spawn_agent')
    expect(dispatchBox(spawn('completed'), runs(run())).state).toBe('running')
    expect(dispatchBox(spawn('completed'), runs(run({ state: 'completed' }))).state).toBe('done')
    expect(dispatchBox(spawn('completed')).state).toBe('done')
    expect(dispatchBox(spawn('failed'), runs(run())).state).toBe('failed')
  })

  it('Codex 的等待 / 发消息 / 关闭调用不是派出：只看条目自己的状态', () => {
    for (const name of ['collabAgentToolCall', 'collabToolCall'])
      expect(dispatchBox(call('completed', name), runs(run({ state: 'shutdown' }))).state).toBe('done')
    expect(dispatchBox(call('completed', 'collabAgentToolCall'), runs(run({ state: 'pendingInit' }))).state).toBe(
      'done',
    )
  })

  it('等你批准只在还在跑时显示', () => {
    expect(dispatchBox(call('running'), undefined, true).state).toBe('approval')
    expect(dispatchBox(call('completed'), undefined, true).state).toBe('done')
  })

  it('Workflow 用编排图标，右边写智能体个数', () => {
    const workflows: AgentRuns = {
      agents: [],
      workflows: [
        {
          id: 'w1',
          name: 'review',
          description: '',
          status: 'running',
          startedAt: 5,
          durationMs: 0,
          tokens: 0,
          toolCalls: 0,
          phases: [],
          agents: [run({ id: 'x' }), run({ id: 'y' })],
          toolUseId: 't1',
        },
      ],
    }
    expect(dispatchBox(call('running', 'Workflow'), workflows)).toMatchObject({ icon: 'workflow', agents: 2 })
  })

  it('用时：运行中从开始时间走到现在，结束了只用报告的时长', () => {
    const running = dispatchBox(call('running'), runs(run({ startedAt: 1_000 })))
    expect(boxElapsed(running, 5_000)).toBe(4_000)
    const finished = dispatchBox(call('completed'), runs(run({ state: 'done', durationMs: 3_000 })))
    expect(boxElapsed(finished, 99_000)).toBe(3_000)
    expect(boxElapsed(dispatchBox(call('running')), 99_000)).toBe(0)
  })
})

describe('完成小框', () => {
  const task = (patch: Partial<NoticeTask> = {}): NoticeTask => ({
    toolUseId: 't1',
    kind: 'agent',
    status: 'completed',
    label: '草稿改用 IndexedDB',
    summary: '改完了',
    ...patch,
  })

  it('状态来自提示；子智能体能点开追踪，后台命令不能', () => {
    expect(completionBox(task(), runs(run({ state: 'done', durationMs: 7_000 })))).toMatchObject({
      label: '草稿改用 IndexedDB',
      state: 'done',
      durationMs: 7_000,
      model: 'haiku-4-5',
      summary: '改完了',
      target: { toolUseId: 't1' },
    })
    expect(completionBox(task({ status: 'failed' })).state).toBe('failed')
    expect(completionBox(task({ status: 'stopped' })).state).toBe('stopped')
    expect(completionBox(task({ kind: 'bash', toolUseId: undefined })).target).toBeNull()
    expect(completionBox(task({ kind: 'bash' })).icon).toBe('terminal')
  })

  it('没写任务名时退回运行记录里的名字，再没有就留空', () => {
    expect(completionBox(task({ label: '' }), runs(run())).label).toBe('C3')
    expect(completionBox(task({ label: '' })).label).toBe('')
  })
})

describe('等你批准的派发', () => {
  const request = (itemId: string | null): ApprovalRequest => ({
    requestId: 'q',
    itemId,
    kind: 'command',
    title: '运行命令',
    alwaysScopes: [],
  })
  const sub = {
    kind: 'command',
    id: 'sc1',
    command: 'ls',
    description: null,
    output: '',
    exitCode: null,
    status: 'running',
    subagent: 'C3',
    subagentCall: 't1',
  } as Item
  const main = {
    kind: 'command',
    id: 'mc1',
    command: 'ls',
    description: null,
    output: '',
    exitCode: null,
    status: 'running',
  } as Item

  it('批准请求对应子智能体的工具时，返回派出它的调用 id；主智能体的不算', () => {
    expect([...approvalWaiting([main, sub], [request('sc1')])]).toEqual(['t1'])
    expect(approvalWaiting([main, sub], [request('mc1'), request(null)]).size).toBe(0)
    expect(approvalWaiting([main, sub], []).size).toBe(0)
  })
})

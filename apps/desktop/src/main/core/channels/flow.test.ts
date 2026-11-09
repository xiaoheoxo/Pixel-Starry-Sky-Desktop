import { describe, expect, it } from 'vitest'
import type { ChannelFlow } from '../../../shared/types/channels'
import type { FlowSchedule } from '../../../shared/types/channels'
import {
  cleanLimits,
  cleanSchedule,
  cleanSteps,
  copyPlan,
  forksAt,
  draftProblem,
  limitHit,
  planSteps,
  scheduleDue,
  startable,
  withStep,
} from './flow'

const members: Record<string, { name: string; local: boolean }> = {
  a: { name: '画师', local: true },
  b: { name: '程序员', local: true },
  c: { name: '审查员', local: true },
  r: { name: '远端', local: false },
}
const member = (id: string) => members[id] ?? null

const draft = () =>
  cleanSteps([
    { id: 's1', title: '画贴图', memberId: 'a', kind: 'work' },
    { id: 's2', title: '写代码', memberId: 'b', deps: ['s1'], kind: 'work' },
    { id: 's3', title: '审查', memberId: 'c', kind: 'review', target: 's2', settings: { effort: 'low', fast: 'x' } },
    { id: 's4', title: '汇总', memberId: 'a', deps: ['s3', 'nope', 's4'], kind: 'summary' },
  ])

describe('流程草稿（docs/ui/channels-pipeline.md §4）', () => {
  it('清洗：运行时字段重置，审查步骤自动等被审的那一步，不存在的依赖和依赖自己去掉，设置只留认识的', () => {
    const steps = draft()
    expect(steps.every(s => s.status === 'pending' && s.taskId === null && s.rejects === 0)).toBe(true)
    expect(steps[2]).toMatchObject({ deps: ['s2'], target: 's2', settings: { effort: 'low' } })
    expect(steps[3].deps).toEqual(['s3'])
    expect(() => cleanSteps('x')).toThrow('步骤不正确')
    expect(() => cleanSteps([{ id: 'a' }, { id: 'a' }])).toThrow('重复')
  })

  it('校验：没写要做什么、没选成员、SSH 成员、审查没目标、绕成圈', () => {
    expect(draftProblem(draft(), member)).toBeNull()
    expect(draftProblem([], member)).toContain('还没有步骤')
    expect(draftProblem(cleanSteps([{ title: '', memberId: 'a' }]), member)).toContain('还没写')
    expect(draftProblem(cleanSteps([{ title: 'x', memberId: 'zz' }]), member)).toContain('还没选成员')
    expect(draftProblem(cleanSteps([{ title: 'x', memberId: 'r' }]), member)).toContain('SSH')
    expect(draftProblem(cleanSteps([{ title: 'x', memberId: 'c', kind: 'review' }]), member)).toContain('审哪一步')
    const loop = cleanSteps([
      { id: 'x', title: 'x', memberId: 'a', deps: ['y'] },
      { id: 'y', title: 'y', memberId: 'b', deps: ['x'] },
    ])
    expect(draftProblem(loop, member)).toContain('圈')
  })

  it('能开始的：还没开始、依赖都交付了', () => {
    let flow: ChannelFlow = { title: 't', status: 'running', steps: draft(), maxRejects: 3 }
    expect(startable(flow).map(s => s.id)).toEqual(['s1'])
    flow = withStep(flow, 's1', { status: 'delivered' })
    expect(startable(flow).map(s => s.id)).toEqual(['s2'])
    flow = withStep(flow, 's2', { status: 'running' })
    expect(startable(flow)).toEqual([])
  })

  it('成员拆好的流程：序号换成 id，成员按名字找，找不到报错', () => {
    const byName = (n: string) => Object.entries(members).find(([, m]) => m.name === n)?.[0] ?? null
    const steps = planSteps(
      [
        { title: '画贴图', member: '画师' },
        { title: '写代码', member: '程序员', deps: [1] },
        { title: '审查', member: '审查员', kind: 'review', target: 2 },
      ],
      byName,
    )
    expect(steps.map(s => [s.id, s.memberId, s.deps])).toEqual([
      ['s1', 'a', []],
      ['s2', 'b', ['s1']],
      ['s3', 'c', ['s2']],
    ])
    expect(() => planSteps([{ title: 'x', member: '谁' }], byName)).toThrow('不在频道里')
    expect(() => planSteps([], byName)).toThrow('非空')
  })
})

describe('流程第二批的纯函数（docs/ui/channels-pipeline.md §6）', () => {
  const flowOf = (steps: ReturnType<typeof cleanSteps>, patch: Partial<ChannelFlow> = {}): ChannelFlow => ({
    title: 't',
    status: 'running',
    steps,
    maxRejects: 3,
    ...patch,
  })

  it('关卡：清洗保留 gate；等你确认的一步不算交付', () => {
    const steps = cleanSteps([
      { id: 's1', title: 'a', memberId: 'a', kind: 'work', gate: true },
      { id: 's2', title: 'b', memberId: 'b', deps: ['s1'], kind: 'work', gate: 'yes' },
    ])
    expect(steps[0].gate).toBe(true)
    expect(steps[1].gate).toBeUndefined()
    const f = withStep(flowOf(steps), 's1', { status: 'gated' })
    expect(startable(f)).toEqual([])
  })

  it('护栏：清洗截到范围、空是不限；按计数起点判断', () => {
    expect(cleanLimits(undefined)).toBeUndefined()
    expect(cleanLimits({ rounds: 999, minutes: 1 })).toEqual({ rounds: 200, minutes: 5, costUsd: null })
    expect(cleanLimits({ rounds: '', minutes: null, costUsd: '' })).toEqual({
      rounds: null,
      minutes: null,
      costUsd: null,
    })
    // 花费按分取，不取整
    expect(cleanLimits({ costUsd: '2.345' })?.costUsd).toBe(2.35)
    expect(cleanLimits({ costUsd: 0.001 })?.costUsd).toBe(0.01)
    expect(cleanLimits({ costUsd: 5000 })?.costUsd).toBe(1000)
    const f = flowOf([], { limits: { rounds: 5, minutes: 10 }, since: { at: 0, rounds: 2 } })
    expect(limitHit(f, 6, 0)).toBeNull()
    expect(limitHit(f, 7, 0)).toBe('rounds')
    expect(limitHit(f, 3, 10 * 60_000)).toBe('time')
    expect(limitHit({ ...f, limits: null }, 99, 1e9)).toBeNull()
    // 花费：从继续那一刻的已知花费算起；轮次先于花费
    const g = flowOf([], { limits: { rounds: 5, minutes: null, costUsd: 1 }, since: { at: 0, rounds: 0, cost: 0.5 } })
    expect(limitHit(g, 0, 0, 1.4)).toBeNull()
    expect(limitHit(g, 0, 0, 1.5)).toBe('cost')
    expect(limitHit(g, 5, 0, 1.5)).toBe('rounds')
    // 旧数据的起点没有 cost：从 0 算
    expect(limitHit({ ...g, since: { at: 0, rounds: 0 } }, 0, 0, 1)).toBe('cost')
  })

  it('定时运行：三项护栏都要；钟点 0–23；到点跑一次，错过了当天补一次', () => {
    const steps = [{ id: 's1', title: '巡检', memberId: 'a', kind: 'work' }]
    const limits = { rounds: 5, minutes: 30, costUsd: 2 }
    expect(cleanSchedule({ title: '早报', hour: 9, steps, limits })).toMatchObject({
      id: null,
      hour: 9,
      enabled: true,
      limits,
      steps: [{ id: 's1', deps: [], kind: 'work' }],
    })
    expect(cleanSchedule({ title: '早报', hour: 9, steps, limits }).steps[0]).not.toHaveProperty('status')
    expect(() => cleanSchedule({ title: '早报', hour: 9, steps, limits: { ...limits, costUsd: null } })).toThrow(
      '都要设',
    )
    expect(() => cleanSchedule({ title: '早报', hour: 24, steps, limits })).toThrow('钟点')
    expect(() => cleanSchedule({ title: '', hour: 9, steps, limits })).toThrow('名字')
    expect(() => cleanSchedule({ title: '早报', hour: 9, steps: [], limits })).toThrow('步骤')

    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime()
    const s = { hour: 9, enabled: true, lastRunAt: at(24, 9, 1) } as FlowSchedule
    expect(scheduleDue(s, at(25, 8, 59))).toBe(false)
    expect(scheduleDue(s, at(25, 9))).toBe(true)
    // 今天到点处理过了
    expect(scheduleDue({ ...s, lastRunAt: at(25, 9) }, at(25, 23))).toBe(false)
    // 关着的不跑；电脑关了几天，开机当天补一次
    expect(scheduleDue({ ...s, enabled: false }, at(25, 10))).toBe(false)
    expect(scheduleDue({ ...s, lastRunAt: at(20, 9) }, at(25, 18))).toBe(true)
  })

  it('副本规划：串行不建；同时开始的各建一个；单依赖沿用；同一前驱分两路各建；汇合回主目录；开关关掉不建', () => {
    const steps = cleanSteps([
      { id: 's1', title: 'a', memberId: 'a', kind: 'work' },
      { id: 's2', title: 'b', memberId: 'b', kind: 'work' },
      { id: 's3', title: 'c', memberId: 'c', deps: ['s1'], kind: 'work' },
      { id: 's4', title: 'd', memberId: 'a', deps: ['s1', 's2'], kind: 'summary' },
    ])
    const f = flowOf(steps)
    // 只有 s2 开始、后面只有一步等它：主目录
    expect(copyPlan(f, 'abcdef12', 's2', ['s2'])).toEqual({ kind: 'main', merge: [] })
    // 只有 s1 开始，但后面 s3、s4 都等它（分叉点）：自己先建副本，交付后别的步骤从它的分支分出去
    expect(copyPlan(f, 'abcdef12', 's1', ['s1'])).toMatchObject({ kind: 'new', base: null })
    // s1、s2 同时开始：各建一个，基于主目录
    expect(copyPlan(f, 'abcdef12', 's1', ['s1', 's2'])).toEqual({
      kind: 'new',
      name: 'flow-abcdef-a',
      branch: 'pixelsky/flow-abcdef-a',
      base: null,
    })
    const copy = { id: 'c1', branch: 'pixelsky/flow-abcdef-a', path: '/c1' }
    const done = withStep(withStep(f, 's1', { status: 'delivered', copy }), 's2', {
      status: 'delivered',
      copy: { id: 'c2', branch: 'pixelsky/flow-abcdef-b', path: '/c2' },
    })
    // s3 只依赖 s1：沿用它的副本
    expect(copyPlan(done, 'abcdef12', 's3', ['s3'])).toEqual({ kind: 'reuse', copy })
    // s3 和另一个也从 s1 分出来的步骤同时开始：各建一个，基于 s1 的分支
    const fork = flowOf([...done.steps, { ...done.steps[2], id: 's5' }])
    expect(copyPlan(fork, 'abcdef12', 's3', ['s3', 's5'])).toMatchObject({ kind: 'new', base: copy.branch })
    // s4 依赖两个副本：主目录合并
    expect(copyPlan(done, 'abcdef12', 's4', ['s4'])).toEqual({ kind: 'main', merge: ['s1', 's2'] })
    // 开关关掉：同时开始也在主目录
    expect(copyPlan({ ...f, isolate: false }, 'abcdef12', 's1', ['s1', 's2'])).toEqual({ kind: 'main', merge: [] })
  })

  it('副本规划按项目分开：不同项目的并行步骤各在主目录做，分叉点也不建；同项目的照旧', () => {
    const steps = cleanSteps([
      { id: 's1', title: '定接口', memberId: 'a', kind: 'work' },
      { id: 's2', title: 'Core 侧', memberId: 'b', deps: ['s1'], kind: 'work' },
      { id: 's3', title: '界面', memberId: 'c', deps: ['s1'], kind: 'work' },
      { id: 's4', title: '汇总', memberId: 'a', deps: ['s2', 's3'], kind: 'summary' },
    ])
    const f = flowOf(steps)
    // b 在另一个项目：a 的项目里只有 s3 等 s1，不是分叉点
    const cross = (m: string) => (m === 'b' ? 'p2' : 'p1')
    expect(copyPlan(f, 'abcdef12', 's1', ['s1'], cross)).toEqual({ kind: 'main', merge: [] })
    const done = withStep(f, 's1', { status: 'delivered' })
    expect(copyPlan(done, 'abcdef12', 's2', ['s2', 's3'], cross)).toEqual({ kind: 'main', merge: [] })
    expect(copyPlan(done, 'abcdef12', 's3', ['s2', 's3'], cross)).toEqual({ kind: 'main', merge: [] })
    expect(forksAt(f, f.steps[0], cross)).toBe(false)
    // 都在同一个项目：s1 是分叉点
    expect(forksAt(f, f.steps[0], () => 'p1')).toBe(true)
  })
})

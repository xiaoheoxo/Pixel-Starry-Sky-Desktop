import { describe, expect, it } from 'vitest'
import type { AgentRun, Item, TodoStep } from '@pixelsky/protocol'
import {
  activeStep,
  canFoldDone,
  cardPlacement,
  currentPlan,
  NARROW_PX,
  planResult,
  progressAgents,
  turnKey,
} from './progressData'

const user = (id: string, mode?: 'guidance'): Item => ({ kind: 'user', id, text: id, createdAt: 0, mode })
const steps = (...s: TodoStep['status'][]): TodoStep[] => s.map((status, i) => ({ text: `step ${i}`, status }))
const todo = (id: string, s: TodoStep[]): Item => ({ kind: 'todo', id, steps: s, status: 'completed' })
const reply = (id: string): Item => ({ kind: 'assistant', id, text: 'ok', status: 'completed' })

describe('turnKey', () => {
  it('取最后一条非引导的用户消息', () => {
    expect(turnKey([user('u1'), reply('a'), user('u2'), user('g', 'guidance')])).toBe('u2')
    expect(turnKey([reply('a')])).toBe('')
  })
})

describe('currentPlan', () => {
  it('取最近一轮里最新的一条待办，并数出完成的步骤', () => {
    const items = [user('u1'), todo('t1', steps('pending', 'pending')), todo('t2', steps('completed', 'in_progress'))]
    expect(currentPlan(items, true)).toEqual({
      id: 't2',
      steps: items[2].kind === 'todo' ? items[2].steps : [],
      done: 1,
    })
  })

  it('引导消息不算新的一轮', () => {
    const items = [user('u1'), todo('t1', steps('completed')), user('g', 'guidance')]
    expect(currentPlan(items, false)?.id).toBe('t1')
  })

  it('上一轮的计划：空闲时不显示；运行中且没做完时继续显示', () => {
    const unfinished = [user('u1'), todo('t1', steps('completed', 'pending')), user('u2')]
    expect(currentPlan(unfinished, false)).toBeNull()
    expect(currentPlan(unfinished, true)?.id).toBe('t1')
    const finished = [user('u1'), todo('t1', steps('completed')), user('u2')]
    expect(currentPlan(finished, true)).toBeNull()
  })

  it('没做完的计划只延续到下一轮：再往后的对话不再显示（额度用完、中断后没勾完的旧计划）', () => {
    const stale = [user('u1'), todo('t1', steps('pending', 'pending')), user('u2'), reply('a'), user('u3')]
    expect(currentPlan(stale, true)).toBeNull()
  })

  it('自动发的「继续」（断线重连、额度恢复）和没送达的消息不算新的一轮', () => {
    const auto: Item[] = [
      user('u1'),
      todo('t1', steps('completed', 'pending')),
      user('u2'),
      { kind: 'user', id: 'r1', text: '继续', createdAt: 0, reconnect: 1 },
      { kind: 'user', id: 'l1', text: '继续', createdAt: 0, reconnect: 1, limit: { since: 0, at: 1 } },
      { kind: 'user', id: 'd1', text: '没送到', createdAt: 0, dismissed: true },
    ]
    expect(currentPlan(auto, true)?.id).toBe('t1')
    expect(turnKey(auto)).toBe('u2')
  })

  it('空的待办跳过，没有待办时为 null', () => {
    expect(currentPlan([user('u1'), todo('t1', steps('pending')), todo('t2', [])], false)?.id).toBe('t1')
    expect(currentPlan([user('u1'), reply('a')], true)).toBeNull()
  })
})

describe('progressAgents', () => {
  const run: AgentRun = {
    id: 'a1',
    label: 'explore',
    type: 'Explore',
    model: 'claude-haiku-5-5',
    state: 'running',
    startedAt: 1000,
    durationMs: 0,
    tokens: 0,
    toolCalls: 0,
    phase: null,
    prompt: '',
    result: '',
    toolUseId: 'tu1',
  }

  it('合并追踪里的模型、类型和开始时间', () => {
    const [a] = progressAgents([{ id: 'a1', label: '读码', status: 'running', message: 'Grep' }], {
      workflows: [],
      agents: [run],
    })
    expect(a).toEqual({
      id: 'a1',
      label: '读码',
      state: 'running',
      model: 'claude-haiku-5-5',
      type: 'Explore',
      message: 'Grep',
      startedAt: 1000,
      durationMs: 0,
      background: false,
      steps: [],
    })
  })

  it('带上摘要、结果、任务说明（追踪里的 prompt 兜底）和它调用过的工具', () => {
    const tool: Item = {
      kind: 'tool',
      id: 't1',
      tool: 'read',
      name: 'Read',
      title: 'a.ts',
      output: '',
      status: 'completed',
      subagentCall: 'tu1',
    }
    const [a] = progressAgents(
      [{ id: 'a1', label: '读码', status: 'running', message: '摘要', summary: '摘要' }],
      { workflows: [], agents: [{ ...run, prompt: '读一遍 a.ts' }] },
      [tool, { ...tool, id: 't2', subagentCall: 'other' }],
    )
    expect(a).toMatchObject({ summary: '摘要', task: '读一遍 a.ts' })
    expect(a.steps.map(s => s.id)).toEqual(['t1'])
  })

  it('没有追踪数据时用子智能体条自己的信息', () => {
    const [a] = progressAgents([{ id: 'abcdef123456', label: '', status: 'completed', message: null }], undefined)
    expect(a).toMatchObject({ label: 'abcdef12', state: 'done', model: '', type: '', startedAt: 0 })
  })
})

describe('activeStep', () => {
  it('进行中的第一个步骤', () => {
    expect(activeStep(steps('completed', 'in_progress', 'pending'))).toBe(1)
    expect(activeStep(steps('completed', 'pending'))).toBe(-1)
  })
})

describe('cardPlacement', () => {
  const place = (o: Partial<Parameters<typeof cardPlacement>[0]>) =>
    cardPlacement({ docked: false, narrow: false, collapsed: false, peek: false, ...o })

  it('够宽：展开时浮着，收起时一律收成一条（包括自动折叠）', () => {
    expect(place({})).toEqual({ strip: false, card: 'float' })
    expect(place({ collapsed: true })).toEqual({ strip: true, card: null })
    // 变宽前留下的 peek 不算
    expect(place({ collapsed: true, peek: true })).toEqual({ strip: true, card: null })
  })

  it('窄：不管折叠偏好都是一条，点开才临时盖住', () => {
    for (const collapsed of [false, true]) {
      expect(place({ narrow: true, collapsed })).toEqual({ strip: true, card: null })
      expect(place({ narrow: true, collapsed, peek: true })).toEqual({ strip: true, card: 'over' })
    }
  })

  it('停靠进概况时不看宽度和折叠，也没有那一条', () => {
    expect(place({ docked: true, narrow: true, collapsed: true, peek: true })).toEqual({ strip: false, card: 'docked' })
  })

  it('窄不窄的分界是 1032：放下 640 的阅读列和 352 的卡片', () => {
    expect(1031 < NARROW_PX).toBe(true)
    expect(1032 < NARROW_PX).toBe(false)
  })
})

describe('按轮次的进度（docs/ui/progress-card.md §11）', () => {
  const todo = (statuses: TodoStep['status'][], carried?: TodoStep[]): Item => ({
    kind: 'todo',
    id: 't',
    status: 'running',
    steps: statuses.map((status, i) => ({ text: `s${i}`, status })),
    ...(carried ? { carried } : {}),
  })

  it('上一轮没做完的不算进度，跟着计划带给卡片', () => {
    const left = [{ text: 'old', status: 'pending' as const }]
    const plan = currentPlan([todo(['completed', 'pending'], left)], true)
    expect(plan).toMatchObject({ done: 1, carried: left })
    expect(plan?.steps).toHaveLength(2)
  })

  it('做完两步起能收成一行；全做完时列全', () => {
    const fold = (statuses: TodoStep['status'][]) => canFoldDone(currentPlan([todo(statuses)], true)!)
    expect(fold(['completed', 'pending'])).toBe(false)
    expect(fold(['completed', 'completed', 'in_progress'])).toBe(true)
    expect(fold(['completed', 'completed'])).toBe(false)
  })

  it('执行那一行：取这一轮最后一份计划；没做完写停在哪一步', () => {
    expect(planResult([])).toBeNull()
    expect(planResult([todo(['completed', 'completed'])])).toEqual({ done: 2, total: 2, stoppedAt: null })
    expect(planResult([todo(['completed', 'in_progress', 'pending'])])).toEqual({ done: 1, total: 3, stoppedAt: 's1' })
    expect(planResult([todo(['completed', 'pending'])])).toEqual({ done: 1, total: 2, stoppedAt: 's1' })
    expect(planResult([todo(['pending']), todo(['completed'])])).toEqual({ done: 1, total: 1, stoppedAt: null })
  })
})

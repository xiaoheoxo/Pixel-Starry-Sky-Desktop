import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRun, EngineEvent } from '@pixelsky/protocol'
import { agnesTag } from '../src/codex/agnes-attribution'
import { CodexTranslator, codexAsyncQuestions, codexReview } from '../src/codex/translate'

describe('自动审核的审查结果', () => {
  it('状态和风险按协议转，看不懂的不显示', () => {
    expect(codexReview({ status: 'inProgress' })).toEqual({ status: 'reviewing' })
    expect(codexReview({ status: 'denied', riskLevel: 'high', rationale: 'x' })).toEqual({
      status: 'denied',
      risk: 'high',
      rationale: 'x',
    })
    expect(codexReview({ status: 'approved', riskLevel: 'bogus' })).toEqual({ status: 'approved' })
    expect(codexReview({ status: 'somethingNew' })).toBeNull()
    expect(codexReview(null)).toBeNull()
  })

  it('通知先于条目到：条目到了再带上', () => {
    const events: EngineEvent[] = []
    const t = new CodexTranslator(e => events.push(e))
    t.review('c1', { status: 'approved', risk: 'low' })
    expect(events).toHaveLength(0)
    t.item({ type: 'commandExecution', id: 'c1', command: 'ls', status: 'inProgress' }, false)
    expect(events.at(-1)).toMatchObject({ item: { id: 'cx-c1', review: { status: 'approved' } } })
    // 后面的事件不把标记弄丢
    t.item({ type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed', exitCode: 0 }, true)
    expect(events.at(-1)).toMatchObject({ type: 'item_completed', item: { review: { status: 'approved' } } })
  })
})

describe('Codex 子智能体：这一轮结束时的收尾', () => {
  const spawn = (id: string, thread: string) => ({
    type: 'subAgentActivity',
    id,
    kind: 'started',
    agentThreadId: thread,
    agentPath: `/root/${thread}`,
  })
  const subagents = (events: EngineEvent[]) =>
    events.findLast(e => e.type === 'subagents')?.subagents.map(s => [s.id, s.status])

  it('进程退出 / 中断 / 失败：还在跑的标成已中断并推给界面，已跑完的不动', () => {
    for (const outcome of ['failed', 'interrupted'] as const) {
      const events: EngineEvent[] = [],
        agents = new Map<string, AgentRun>(),
        translator = new CodexTranslator(e => events.push(e), undefined, agents)
      translator.item(spawn('s1', 'child-a'), true)
      translator.item(spawn('s2', 'child-b'), true)
      translator.item({ type: 'subAgentActivity', id: 'done-b', kind: 'completed', agentThreadId: 'child-b' }, true)
      translator.finish(outcome)
      expect(agents.get('child-a')).toMatchObject({ state: 'interrupted', toolUseId: 'cx-s1' })
      expect(agents.get('child-b')).toMatchObject({ state: 'completed' })
      expect(subagents(events)).toEqual([
        ['child-a', 'interrupted'],
        ['child-b', 'completed'],
      ])
      expect(events.findLast(e => e.type === 'runs')?.runs.agents.map(a => a.state)).toEqual([
        'interrupted',
        'completed',
      ])
    }
  })

  it('正常结束不动子智能体：它们可能在主轮结束后才跑完，之后的「跑完」事件照常更新', () => {
    const events: EngineEvent[] = [],
      agents = new Map<string, AgentRun>(),
      translator = new CodexTranslator(e => events.push(e), undefined, agents)
    translator.item(spawn('s1', 'child-a'), true)
    const before = events.length
    translator.finish('completed')
    expect(agents.get('child-a')).toMatchObject({ state: 'running' })
    expect(events.slice(before).some(e => e.type === 'runs' || e.type === 'subagents')).toBe(false)
  })

  it('已被标成已中断的子智能体后来又跑完：状态改回已完成', () => {
    const agents = new Map<string, AgentRun>(),
      translator = new CodexTranslator(() => {}, undefined, agents)
    translator.item(spawn('s1', 'child-a'), true)
    translator.finish('interrupted')
    expect(agents.get('child-a')).toMatchObject({ state: 'interrupted' })
    translator.item({ type: 'subAgentActivity', id: 'done-a', kind: 'completed', agentThreadId: 'child-a' }, true)
    expect(agents.get('child-a')).toMatchObject({ state: 'completed' })
  })

  it('没有子智能体或都已跑完时不发多余的更新', () => {
    const events: EngineEvent[] = [],
      translator = new CodexTranslator(e => events.push(e))
    translator.finish('failed')
    expect(events).toEqual([])
  })
})

describe('Codex 思考用时', () => {
  const reasoning = (events: EngineEvent[]) =>
    events.findLast(e => e.type === 'item_completed' && e.item.kind === 'reasoning')
  afterEach(() => vi.useRealTimers())

  it('思考条目想完才发、紧接着就结束：用时从上一次动静算到它结束', () => {
    vi.useFakeTimers({ now: 0 })
    const events: EngineEvent[] = [],
      translator = new CodexTranslator(e => events.push(e))
    vi.setSystemTime(5_200)
    translator.item({ type: 'reasoning', id: 'r1', summary: [] }, false)
    vi.setSystemTime(5_220)
    translator.item({ type: 'reasoning', id: 'r1', summary: [] }, true)
    expect(reasoning(events)).toMatchObject({ item: { id: 'cx-r1', status: 'completed', durationMs: 5_220 } })

    translator.item({ type: 'commandExecution', id: 'c1', command: 'ls' }, false)
    vi.setSystemTime(6_000)
    translator.item({ type: 'commandExecution', id: 'c1', command: 'ls' }, true)
    vi.setSystemTime(9_000)
    translator.item({ type: 'reasoning', id: 'r2', summary: ['想好了'] }, true)
    expect(reasoning(events)).toMatchObject({ item: { id: 'cx-r2', text: '想好了', durationMs: 3_000 } })
  })

  it('开着思考摘要时从摘要增量建出来的条目：开始时间同样取上一次动静', () => {
    vi.useFakeTimers({ now: 0 })
    const events: EngineEvent[] = [],
      translator = new CodexTranslator(e => events.push(e))
    vi.setSystemTime(2_000)
    translator.delta('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '先看' })
    expect(events[0]).toMatchObject({ type: 'item_started', item: { status: 'running' } })
    expect(events[0].type === 'item_started' && 'durationMs' in events[0].item).toBe(false)
    vi.setSystemTime(4_000)
    translator.item({ type: 'reasoning', id: 'r1', summary: ['先看'] }, true)
    expect(reasoning(events)).toMatchObject({ item: { durationMs: 4_000 } })
  })

  it('冷读的历史（子智能体记录）不算用时：一次性倒进来算出来都是 0', () => {
    const events: EngineEvent[] = [],
      translator = new CodexTranslator(e => events.push(e))
    translator.item({ type: 'reasoning', id: 'r1', summary: [] }, true, false)
    expect(reasoning(events)).toMatchObject({ item: { id: 'cx-r1', status: 'completed' } })
    expect('durationMs' in translator.items.get('cx-r1')!).toBe(false)
  })
})

describe('Codex 计划：每轮一行，记下更新次数（C16）', () => {
  it('清单变了才算一次，内容一样的重发不加', () => {
    const events: EngineEvent[] = []
    const translator = new CodexTranslator(e => events.push(e))
    const plan = (status: string) => translator.plan({ turnId: 't1', plan: [{ step: '改代码', status }] })
    const last = () => events.findLast(e => e.type === 'item_completed')
    plan('inProgress')
    expect(last()).toMatchObject({ item: { id: 'cx-plan-t1' } })
    expect(last()?.type === 'item_completed' && last()?.item).not.toHaveProperty('updates')
    plan('inProgress')
    plan('completed')
    expect(last()).toMatchObject({ item: { id: 'cx-plan-t1', updates: 2 } })
  })
})

describe('Agnes attribution', () => {
  const marker = 'c5af97be-8337-491c-a796-05afe8d9139a'
  const model = 'gpt-6.1-terra'
  const tagged = `${agnesTag(marker)}\nImplement the requested change`
  const task = (text: string) => ({ item: { type: 'userMessage', content: [{ type: 'text', text }] } })
  const spawn = (id: string, actual = model) => ({
    type: 'subAgentActivity',
    id: `spawn-${id}`,
    kind: 'started',
    agentThreadId: id,
    model: actual,
  })

  it('checks explicit tagged spawn requests on legacy Codex, not merely equal model names', () => {
    const translator = new CodexTranslator(() => {})
    translator.setAgnesAttribution({ marker, model })
    const legacy = (id: string, prompt: string, picked: string) => ({
      type: 'collabAgentToolCall',
      id,
      tool: 'spawn_agent',
      receiverThreadIds: [id],
      prompt,
      model: picked,
    })
    translator.item(legacy('yes', tagged, model), true)
    translator.item(legacy('plain', 'same model independently', model), true)
    translator.item(legacy('wrong', tagged, 'gpt-6.2-sol'), true)
    translator.item(legacy('inherited', tagged, ''), true)
    expect(translator.agents.get('yes')).toMatchObject({
      modelSource: 'agnes',
      prompt: 'Implement the requested change',
    })
    expect(translator.items.get('cx-yes')).toMatchObject({ title: 'Implement the requested change' })
    expect(translator.agents.get('plain')?.modelSource).toBe('agnes-match')
    for (const id of ['wrong', 'inherited']) expect(translator.agents.get(id)?.modelSource).toBeUndefined()
  })

  it('attributes concurrent forced dispatches independently, without same-model guesses', () => {
    const translator = new CodexTranslator(() => {})
    const second = '8f9cced2-8105-4ab5-ac86-5e10067af413'
    const otherModel = 'gpt-6.2-sol'
    translator.registerAgnesDispatch(marker, model)
    translator.registerAgnesDispatch(second, otherModel)
    translator.observeAgnesChild('second', 'item/started', task(`${agnesTag(second)}\nOther task`))
    translator.item(spawn('first'), true)
    translator.item(spawn('second', otherModel), true)
    translator.child('first', 'item/started', task(tagged))
    translator.item(spawn('unrelated'), true)
    expect(translator.agents.get('second')?.modelSource).toBe('agnes')
    expect(translator.agents.get('first')?.modelSource).toBe('agnes')
    expect(translator.agents.get('unrelated')?.modelSource).toBeUndefined()
  })

  it('marks an exact reported model match without claiming the recommendation was adopted', () => {
    const translator = new CodexTranslator(() => {})
    translator.setAgnesAttribution({ model })
    translator.item(spawn('matching'), true)
    translator.child('matching', 'item/started', task(tagged))
    expect(translator.agents.get('matching')?.modelSource).toBe('agnes-match')
    translator.setAgnesAttribution(undefined)
    translator.item(spawn('next-turn'), true)
    expect(translator.agents.get('next-turn')?.modelSource).toBeUndefined()
  })

  it('joins modern spawn and initial task on the same child regardless of arrival order', () => {
    const translator = new CodexTranslator(() => {})
    translator.setAgnesAttribution({ marker, model })
    translator.observeAgnesChild('early', 'item/completed', task(tagged))
    translator.item(spawn('early'), true)
    translator.item(spawn('late'), true)
    translator.child('late', 'item/started', task(tagged))
    translator.item(spawn('wrong', 'gpt-6.2-sol'), true)
    translator.child('wrong', 'item/completed', task(tagged))
    translator.item(spawn('followup'), true)
    translator.child('followup', 'item/completed', task('untagged first task'))
    translator.child('followup', 'item/completed', task(tagged))
    expect(translator.agents.get('early')?.modelSource).toBe('agnes')
    expect(translator.agents.get('late')?.modelSource).toBe('agnes')
    expect(translator.agents.get('wrong')?.modelSource).toBeUndefined()
    expect(translator.agents.get('followup')?.modelSource).toBe('agnes-match')
    translator.setAgnesAttribution(undefined)
    translator.item({ ...spawn('early'), kind: 'completed' }, true)
    expect(translator.agents.get('early')).toMatchObject({ modelSource: 'agnes', state: 'completed' })
  })
})

describe('Codex 异步提问（request_user_input_async）转换', () => {
  it('把 agentMessage.questions 解析为单选带自由输入或纯自由输入题目，流式增量与完成事件保留 questions', () => {
    expect(
      codexAsyncQuestions([
        { title: '用哪种数据库？', options: ['PostgreSQL (Recommended)', 'SQLite'] },
        { title: '还有什么限制？', options: null },
        { title: '   ', options: ['x'] },
      ]),
    ).toEqual([
      {
        id: 'aq-0',
        question: '用哪种数据库？',
        header: '',
        multiSelect: false,
        allowOther: true,
        options: [
          { label: 'PostgreSQL (Recommended)', description: '' },
          { label: 'SQLite', description: '' },
        ],
      },
      {
        id: 'aq-1',
        question: '还有什么限制？',
        header: '',
        multiSelect: false,
        allowOther: false,
        options: [],
      },
    ])

    // 重名题面自动加序号去重，防止前端按 question 键存草稿和答案时串题
    const dup = codexAsyncQuestions([
      { title: '确认方案', options: ['A', 'B'] },
      { title: '确认方案', options: ['X', 'Y'] },
    ])
    expect(dup.map(q => q.question)).toEqual(['确认方案', '确认方案 (2)'])

    const events: EngineEvent[] = []
    const t = new CodexTranslator(e => events.push(e))
    t.item(
      {
        type: 'agentMessage',
        id: 'call_async_1',
        text: '用哪种数据库？\n- PostgreSQL\n- SQLite',
        delivery: 'async',
        questions: [{ title: '用哪种数据库？', options: ['PostgreSQL', 'SQLite'] }],
      },
      false,
    )
    // 完成事件即使未重带 questions 也保留已解析的问题
    t.item({ type: 'agentMessage', id: 'call_async_1', text: '用哪种数据库？\n- PostgreSQL\n- SQLite' }, true)
    const completed = events.findLast(e => e.type === 'item_completed')
    expect(completed).toMatchObject({
      type: 'item_completed',
      item: {
        kind: 'assistant',
        id: 'cx-call_async_1',
        questions: [{ id: 'aq-0', question: '用哪种数据库？' }],
      },
    })
  })

  it('关闭 askQuestions 时只保留普通助手文本，不挂结构化 questions', () => {
    const events: EngineEvent[] = []
    const t = new CodexTranslator(e => events.push(e), undefined, undefined, undefined, false)
    t.item(
      {
        type: 'agentMessage',
        id: 'call_async_2',
        text: '请问用什么方案？',
        delivery: 'async',
        questions: [{ title: '请问用什么方案？', options: ['A', 'B'] }],
      },
      true,
    )
    const item = events[0]?.type === 'item_completed' ? events[0].item : null
    expect(item).toEqual({
      kind: 'assistant',
      id: 'cx-call_async_2',
      text: '请问用什么方案？',
      status: 'completed',
    })
  })
})

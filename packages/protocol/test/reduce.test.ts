import { describe, expect, it } from 'vitest'
import { emptySnapshot, reduce, type EngineEvent, type Item, type SessionRecord, type SessionSnapshot } from '../src'

const record: SessionRecord = {
  id: 's1',
  projectId: 'p1',
  cwd: 'D:\\work',
  engine: 'claude',
  engineSessionId: null,
  title: '新会话',
  model: null,
  effort: 'high',
  permissionMode: 'edits',
  ultracode: false,
  fast: false,
  thinkingSummaries: true,
  createdAt: 0,
  updatedAt: 0,
  lastOutcome: null,
}

function run(events: EngineEvent[], start: SessionSnapshot = emptySnapshot(record)): SessionSnapshot {
  return events.reduce(reduce, start)
}

describe('reduce', () => {
  it('一轮结束时收尾还在跑的条目，后台子智能体的工具留着等它自己的结果', () => {
    const tool = (id: string, background?: boolean) =>
      ({
        kind: 'tool',
        id,
        tool: 'read',
        name: 'Read',
        title: id,
        output: '',
        status: 'running',
        ...(background ? { background } : {}),
      }) as const
    const s = run([
      { type: 'turn_started', turnId: 't1' },
      { type: 'item_started', item: tool('main') },
      { type: 'item_started', item: tool('bg', true) },
      { type: 'turn_completed', turnId: 't1', outcome: 'completed', error: null },
    ])
    expect(s.items.map(i => (i.kind === 'tool' ? i.status : ''))).toEqual(['completed', 'running'])
  })

  it('流式正文按 id 追加', () => {
    const s = run([
      { type: 'turn_started', turnId: 't1' },
      { type: 'item_started', item: { kind: 'assistant', id: 'a', text: '', status: 'running' } },
      { type: 'item_delta', itemId: 'a', field: 'text', delta: '你' },
      { type: 'item_delta', itemId: 'a', field: 'text', delta: '好' },
    ])
    expect(s.turnId).toBe('t1')
    expect(s.items).toEqual([{ kind: 'assistant', id: 'a', text: '你好', status: 'running' }])
  })

  it('增量落在非末尾条目上也能找到，且不原地改旧快照', () => {
    const s0 = run([
      { type: 'item_started', item: { kind: 'assistant', id: 'a', text: '甲', status: 'running' } },
      { type: 'item_started', item: { kind: 'notice', id: 'n', level: 'warn', text: '提示' } },
    ])
    const before = s0.items
    const s1 = reduce(s0, { type: 'item_delta', itemId: 'a', field: 'text', delta: '乙' })
    expect(s1.items[0]).toMatchObject({ text: '甲乙' })
    expect(s1.items).not.toBe(before)
    expect(before[0]).toMatchObject({ text: '甲' })
    const s2 = reduce(s1, { type: 'items_truncated', fromItemId: 'n' })
    expect(s2.items.map(x => x.id)).toEqual(['a'])
  })

  it('完成事件替换同 id 条目，新 id 直接追加', () => {
    const s = run([
      { type: 'item_started', item: { kind: 'assistant', id: 'a', text: '半', status: 'running' } },
      { type: 'item_completed', item: { kind: 'assistant', id: 'a', text: '完整', status: 'completed' } },
      { type: 'item_completed', item: { kind: 'notice', id: 'n', level: 'warn', text: '提示' } },
    ])
    expect(s.items.map(x => x.id)).toEqual(['a', 'n'])
    expect(s.items[0]).toMatchObject({ text: '完整', status: 'completed' })
  })

  it('未知条目的增量被忽略，快照不变', () => {
    const s0 = emptySnapshot(record)
    expect(reduce(s0, { type: 'item_delta', itemId: 'x', field: 'text', delta: '…' })).toBe(s0)
  })

  it('审批请求按 requestId 去重，回答后移除', () => {
    const req = { requestId: 'r1', itemId: null, kind: 'command' as const, title: '运行命令', alwaysScopes: [] }
    let s = run([
      { type: 'approval_request', request: req },
      { type: 'approval_request', request: { ...req, title: '再来一次' } },
    ])
    expect(s.pending).toHaveLength(1)
    expect(s.pending[0].title).toBe('再来一次')
    s = reduce(s, { type: 'approval_resolved', requestId: 'r1' })
    expect(s.pending).toHaveLength(0)
  })

  it('一轮被中断：进行中的条目标成 interrupted，清空待审批', () => {
    const s = run([
      { type: 'turn_started', turnId: 't1' },
      {
        type: 'item_started',
        item: {
          kind: 'command',
          id: 'c',
          command: 'ls',
          description: null,
          output: '',
          exitCode: null,
          status: 'running',
        },
      },
      { type: 'item_completed', item: { kind: 'assistant', id: 'a', text: '好', status: 'completed' } },
      {
        type: 'approval_request',
        request: { requestId: 'r', itemId: 'c', kind: 'command', title: '运行命令', alwaysScopes: [] },
      },
      { type: 'turn_completed', turnId: 't1', outcome: 'interrupted', error: null },
    ])
    expect(s.turnId).toBeNull()
    expect(s.pending).toHaveLength(0)
    expect(s.items.find(x => x.id === 'c')).toMatchObject({ status: 'interrupted' })
    expect(s.items.find(x => x.id === 'a')).toMatchObject({ status: 'completed' })
  })

  it('压缩进度：直接替换；新的一轮开始和一轮结束时清掉', () => {
    const progress = {
      itemId: 'c',
      requests: 1,
      model: 'm',
      requestedModel: 'm',
      requestAt: 1,
      connectedAt: null,
      status: null,
      firstTokenAt: null,
      lastContentAt: null,
      lastByteAt: null,
      outputTokens: 0,
      outputExact: false,
      done: false,
      error: null,
    }
    const started = run([
      { type: 'turn_started', turnId: 't1' },
      { type: 'compaction_progress', progress },
    ])
    expect(started.compaction).toBe(progress)
    expect(run([{ type: 'compaction_progress', progress: null }], started).compaction).toBeNull()
    expect(run([{ type: 'turn_started', turnId: 't2' }], started).compaction).toBeNull()
    expect(
      run([{ type: 'turn_completed', turnId: 't1', outcome: 'completed', error: null }], started).compaction,
    ).toBeNull()
  })
})

describe('计划每一步的起点（docs/ui/auto-fold.md §3）', () => {
  const todo = (id: string, doing: string | null, status: 'running' | 'completed' = 'running'): Item => ({
    kind: 'todo',
    id,
    status,
    steps: ['查', '改'].map(text => ({
      text,
      status: text === doing ? ('in_progress' as const) : ('pending' as const),
    })),
  })
  const run = (id: string): Item => ({
    kind: 'command',
    id,
    command: id,
    description: null,
    output: '',
    exitCode: 0,
    status: 'completed',
  })
  const user = (id: string): Item => ({ kind: 'user', id, text: id, createdAt: 0 })
  const apply = (items: Item[]): Item[] =>
    items.reduce((s, item) => reduce(s, { type: 'item_completed', item }), emptySnapshot(record)).items

  it('合成一行的清单：进行中的那一步变了才记，状态更新不重复记', () => {
    const items = apply([
      user('u'),
      todo('p', '查'),
      run('a'),
      todo('p', '查', 'completed'),
      run('b'),
      todo('p', '改'),
      run('c'),
      todo('p', null),
    ])
    expect(items.find(i => i.kind === 'todo')).toMatchObject({
      stepMarks: [
        { step: '查', afterItemId: 'u' },
        { step: '改', afterItemId: 'b' },
        { step: null, afterItemId: 'c' },
      ],
    })
  })

  it('一轮里每次一条的清单（像素星空）：接着上一条记；新一轮从头记', () => {
    const items = apply([user('u'), todo('p1', '查'), run('a'), todo('p2', '改'), user('v'), todo('p3', '改')])
    const marks = items.filter(i => i.kind === 'todo').map(i => (i.kind === 'todo' ? i.stepMarks : null))
    expect(marks[1]).toEqual([
      { step: '查', afterItemId: 'u' },
      { step: '改', afterItemId: 'a' },
    ])
    expect(marks[2]).toEqual([{ step: '改', afterItemId: 'v' }])
  })

  it('还没开始做的清单不记', () => {
    expect(apply([user('u'), todo('p', null)])[1]).not.toHaveProperty('stepMarks')
  })
})

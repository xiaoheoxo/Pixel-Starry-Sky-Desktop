// Claude Code 新版的任务工具（TaskCreate / TaskUpdate）拼成待办清单：进度卡片和对话里的计划要靠它
// 帧序列照 2.1.310 实际跑出来的（CLAUDE_CODE_ENABLE_TODO_TOOLS=1，先 ToolSearch 再建任务）
import { describe, expect, it } from 'vitest'
import type { EngineEvent, Item } from '@pixelsky/protocol'
import { ClaudeTranslator } from '../src/claude/translate'
import { TaskBoard } from '../src/claude/tasks'

type Todo = Extract<Item, { kind: 'todo' }>

function translator(): { t: ClaudeTranslator; todos: () => Todo[] } {
  const events: EngineEvent[] = []
  const t = new ClaudeTranslator('D:/work', {
    emit: e => events.push(e),
    sessionId: () => {},
    permissionMode: () => {},
    turnEnded: () => {},
    fastState: () => {},
  })
  t.startTurn('turn-1')
  const todos = () =>
    events.flatMap(e =>
      (e.type === 'item_started' || e.type === 'item_completed') && e.item.kind === 'todo' ? [e.item] : [],
    )
  return { t, todos }
}

let msg = 0
const use = (t: ClaudeTranslator, id: string, name: string, input: Record<string, unknown>) =>
  t.handle({
    type: 'assistant',
    message: { id: `msg_${++msg}`, content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
  })
const result = (t: ClaudeTranslator, id: string, content: string, toolUseResult: unknown, isError = false) =>
  t.handle({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    tool_use_result: toolUseResult,
    parent_tool_use_id: null,
  })

describe('TaskCreate / TaskUpdate → 待办清单', () => {
  it('建三条、改状态：每次调用都带完整的清单，最后一次就是现在的清单', () => {
    const { t, todos } = translator()
    use(t, 'ts', 'ToolSearch', { query: 'select:TaskCreate,TaskUpdate', max_results: 2 })
    result(t, 'ts', 'ok', { matches: ['TaskCreate', 'TaskUpdate'] })
    ;['A: write', 'B: test', 'C: docs'].forEach((subject, i) => {
      use(t, `c${i}`, 'TaskCreate', { subject, description: 'd' })
      result(t, `c${i}`, `Task #${i + 1} created successfully: ${subject}`, { task: { id: String(i + 1), subject } })
    })
    use(t, 'u1', 'TaskUpdate', { taskId: '1', status: 'in_progress' })
    result(t, 'u1', 'Updated task #1 status', { success: true, taskId: '1' })
    use(t, 'u2', 'TaskUpdate', { taskId: '1', status: 'completed' })
    use(t, 'u3', 'TaskUpdate', { taskId: '2', status: 'in_progress' })
    const last = todos().at(-1)!
    expect(last.id).toBe('c0')
    expect(last.steps).toEqual([
      { text: 'A: write', status: 'completed' },
      { text: 'B: test', status: 'in_progress' },
      { text: 'C: docs', status: 'pending' },
    ])
    // 第一次建任务时还没拿到编号，也已经列出来
    expect(todos()[0].steps).toEqual([{ text: 'A: write', status: 'pending' }])
  })

  it('结果里没有 task.id 时从「Task #N created」取编号；建失败的丢掉', () => {
    const board = new TaskBoard()
    board.apply('a', 'TaskCreate', { subject: '写代码' })
    board.resolve('a', 'Task #7 created successfully: 写代码', false, undefined)
    board.apply('b', 'TaskCreate', { subject: '坏的' })
    board.resolve('b', 'error', true, undefined)
    expect(board.apply('u', 'TaskUpdate', { taskId: '7', status: 'completed' })).toEqual([
      { text: '写代码', status: 'completed' },
    ])
  })

  it('deleted 删掉；不认识的编号又没给名字时不凭空加一条；改名字照改', () => {
    const board = new TaskBoard()
    board.apply('a', 'TaskCreate', { subject: 'one' })
    board.resolve('a', '', false, { task: { id: '1' } })
    board.apply('b', 'TaskCreate', { subject: 'two' })
    board.resolve('b', '', false, { task: { id: '2' } })
    expect(board.apply('u', 'TaskUpdate', { taskId: '9', status: 'completed' })).toHaveLength(2)
    expect(board.apply('u', 'TaskUpdate', { taskId: '1', status: 'deleted' })).toEqual([
      { text: 'two', status: 'pending' },
    ])
    expect(board.apply('u', 'TaskUpdate', { taskId: '2', subject: 'two!' })).toEqual([
      { text: 'two!', status: 'pending' },
    ])
  })

  it('别的工具不归它管；旧的 TodoWrite 照旧', () => {
    expect(new TaskBoard().apply('x', 'Bash', { command: 'ls' })).toBeNull()
    const { t, todos } = translator()
    use(t, 'w', 'TodoWrite', { todos: [{ content: '旧清单', status: 'in_progress' }] })
    expect(todos().at(-1)?.steps).toEqual([{ text: '旧清单', status: 'in_progress' }])
  })
})

describe('任务清单在执行块里只占一行', () => {
  it('同一轮的任务调用都更新第一次调用那一行；结果晚到不会把清单写回旧的', () => {
    const { t, todos } = translator()
    use(t, 'c1', 'TaskCreate', { subject: 'one' })
    result(t, 'c1', 'Task #1 created successfully: one', { task: { id: '1' } })
    use(t, 'c2', 'TaskCreate', { subject: 'two' })
    result(t, 'c2', 'Task #2 created successfully: two', { task: { id: '2' } })
    // 两次改状态在同一条消息里发出，结果一起回来：先回来的 u1 不能把 u2 的变化盖掉
    t.handle({
      type: 'assistant',
      message: {
        id: 'msg_pair',
        content: [
          { type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
          { type: 'tool_use', id: 'u2', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } },
        ],
      },
      parent_tool_use_id: null,
    })
    result(t, 'u1', 'Updated task #1 status', { success: true })
    expect(new Set(todos().map(i => i.id))).toEqual(new Set(['c1']))
    expect(todos().at(-1)?.steps).toEqual([
      { text: 'one', status: 'completed' },
      { text: 'two', status: 'in_progress' },
    ])
  })

  it('新的一轮另开一行', () => {
    const { t, todos } = translator()
    use(t, 'a', 'TaskCreate', { subject: 'one' })
    t.startTurn('turn-2')
    use(t, 'b', 'TaskCreate', { subject: 'two' })
    expect(todos().at(-1)?.id).toBe('b')
  })
})

describe('旧的 TodoWrite 同一轮合成一行（C16）', () => {
  const w = (content: string, status: string) => ({ todos: [{ content, status }] })
  it('同一轮再调原地更新第一行，记下更新次数；结果晚到不写回旧清单', () => {
    const { t, todos } = translator()
    use(t, 'w1', 'TodoWrite', w('读代码', 'in_progress'))
    expect(todos().at(-1)).toMatchObject({ id: 'w1' })
    expect(todos().at(-1)?.updates).toBeUndefined()
    use(t, 'w2', 'TodoWrite', w('读代码', 'completed'))
    use(t, 'w3', 'TodoWrite', w('改代码', 'in_progress'))
    result(t, 'w2', 'Todos have been modified successfully', {})
    expect(new Set(todos().map(i => i.id))).toEqual(new Set(['w1']))
    expect(todos().at(-1)).toMatchObject({ updates: 3, steps: [{ text: '改代码', status: 'in_progress' }] })
  })
  it('新的一轮另开一行，次数重新算', () => {
    const { t, todos } = translator()
    use(t, 'a', 'TodoWrite', w('一', 'pending'))
    use(t, 'b', 'TodoWrite', w('一', 'completed'))
    t.startTurn('turn-2')
    use(t, 'c', 'TodoWrite', w('二', 'pending'))
    expect(todos().at(-1)).toMatchObject({ id: 'c' })
    expect(todos().at(-1)?.updates).toBeUndefined()
  })
})

describe('任务清单按轮次（docs/ui/progress-card.md §11）', () => {
  const board = () => {
    const b = new TaskBoard()
    const create = (id: string, subject: string) => {
      b.apply(`c${id}`, 'TaskCreate', { subject })
      b.resolve(`c${id}`, '', false, { task: { id } })
    }
    const set = (id: string, status: string) => b.apply(`u${id}${status}`, 'TaskUpdate', { taskId: id, status })
    return { b, create, set }
  }

  it('上一轮全做完，新一轮建任务：只剩新的', () => {
    const { b, create, set } = board()
    create('1', 'old')
    set('1', 'completed')
    b.newRound()
    create('2', 'new')
    expect(b.steps()).toEqual([{ text: 'new', status: 'pending' }])
    expect(b.carried()).toEqual([])
  })

  it('没做完就开新清单：没做完的单独放、不算进度，只留一轮', () => {
    const { b, create, set } = board()
    create('1', 'done')
    create('2', 'left')
    set('1', 'completed')
    b.newRound()
    create('3', 'new')
    create('4', 'new2')
    expect(b.steps().map(s => s.text)).toEqual(['new', 'new2'])
    expect(b.carried()).toEqual([{ text: 'left', status: 'pending' }])
    b.newRound()
    create('5', 'third')
    expect(b.steps().map(s => s.text)).toEqual(['third'])
    expect(b.carried().map(s => s.text)).toEqual(['new', 'new2'])
  })

  it('说「继续」：先改状态是接着做，整份清单不动；之后再加一步也不清', () => {
    const { b, create, set } = board()
    create('1', 'done')
    create('2', 'left')
    set('1', 'completed')
    b.newRound()
    set('2', 'in_progress')
    create('3', 'extra')
    expect(b.steps().map(s => s.text)).toEqual(['done', 'left', 'extra'])
    expect(b.carried()).toEqual([])
  })

  it('没调 newRound（断线重连自动发的「继续」、同一轮）：不清', () => {
    const { b, create, set } = board()
    create('1', 'done')
    set('1', 'completed')
    create('2', 'more')
    expect(b.steps().map(s => s.text)).toEqual(['done', 'more'])
  })

  it('新一轮先删旧任务再建新的：也算新清单，做完的不留着', () => {
    const { b, create, set } = board()
    create('1', 'done')
    create('2', 'left')
    set('1', 'completed')
    b.newRound()
    set('2', 'deleted')
    create('3', 'new')
    expect(b.steps().map(s => s.text)).toEqual(['new'])
    expect(b.carried()).toEqual([])
  })

  it('上一轮建到一半没等到结果（进程断了）：新清单不带着它', () => {
    const { b, create } = board()
    b.apply('lost', 'TaskCreate', { subject: 'never-resolved' })
    b.newRound()
    create('1', 'new')
    expect(b.steps().map(s => s.text)).toEqual(['new'])
  })

  it('上一轮没做完的又被做了：回到这一轮的清单', () => {
    const { b, create } = board()
    create('1', 'left')
    b.newRound()
    create('2', 'new')
    b.apply('u', 'TaskUpdate', { taskId: '1', status: 'in_progress' })
    expect(b.carried()).toEqual([])
    expect(b.steps()).toContainEqual({ text: 'left', status: 'in_progress' })
  })

  it('待办条目带上 carried；每轮的条目是当时那一份', () => {
    const { t, todos } = translator()
    use(t, 'c1', 'TaskCreate', { subject: 'left' })
    result(t, 'c1', 'Task #1 created', { task: { id: '1' } })
    t.newRound()
    t.startTurn('turn-2')
    use(t, 'c2', 'TaskCreate', { subject: 'new' })
    result(t, 'c2', 'Task #2 created', { task: { id: '2' } })
    const last = todos().at(-1)!
    expect(last.id).toBe('c2')
    expect(last.steps).toEqual([{ text: 'new', status: 'pending' }])
    expect(last.carried).toEqual([{ text: 'left', status: 'pending' }])
    expect(todos()[0].steps).toEqual([{ text: 'left', status: 'pending' }])
  })
})

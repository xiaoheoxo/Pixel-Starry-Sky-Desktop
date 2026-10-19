// 运行中突出「现在在干什么」（docs/ui/conversation-concise.md §7）
import { describe, expect, it } from 'vitest'
import type { Item } from '@pixelsky/protocol'
import {
  TURN_CLOCK_MS,
  clockText,
  currentStep,
  liveStatus,
  liveStep,
  stepText,
  turnElapsed,
  turnWindow,
  waitingFor,
} from './currentStep'

type Status = 'completed' | 'running' | 'failed'
const run = (id: string, status: Status = 'completed', description: string | null = null): Item => ({
  kind: 'command',
  id,
  command: 'pnpm test\n--watch=false',
  description,
  output: '',
  exitCode: status === 'running' ? null : 0,
  status,
})
const tool = (id: string, kind: 'read' | 'search' | 'task' | 'other', status: Status = 'completed'): Item => ({
  kind: 'tool',
  id,
  tool: kind,
  name: kind === 'other' ? 'Skill' : 'Read',
  title: kind === 'task' ? '审查代码' : 'src/a.ts',
  output: '',
  status,
})
const edit = (id: string, paths: string[], status: Status = 'completed', add = false): Item => ({
  kind: 'file_change',
  id,
  changes: paths.map(path => ({ path, kind: add ? 'add' : 'update', diff: '', added: 1, removed: 0 })),
  status,
})
const say = (id: string, text = id, status: 'completed' | 'running' = 'completed'): Item => ({
  kind: 'assistant',
  id,
  text,
  status,
})
const think = (id: string, status: 'completed' | 'running' = 'completed'): Item => ({
  kind: 'reasoning',
  id,
  text: '',
  status,
})
const user = (id: string, createdAt = 0, mode?: 'normal' | 'guidance', turnId?: string): Item => ({
  kind: 'user',
  id,
  text: id,
  createdAt,
  mode,
  turnId,
})
const stats = (id: string): Item => ({ kind: 'turn_stats', id }) as unknown as Item
const info = (id: string): Item => ({ kind: 'notice', id, level: 'info', text: id })

describe('正在进行的一步', () => {
  it('取最后开始的那个还在跑的；并行的数出另外几个；都结束了为 null', () => {
    expect(currentStep([run('c1'), run('c2', 'running')])).toMatchObject({ item: { id: 'c2' }, more: 0 })
    const parallel = currentStep([tool('a1', 'task', 'running'), tool('a2', 'task', 'running'), think('r', 'running')])
    expect(parallel).toMatchObject({ item: { id: 'r' }, more: 2 })
    expect(currentStep([run('c1'), say('a')])).toBeNull()
    expect(currentStep([])).toBeNull()
  })

  it('每种步骤怎么写', () => {
    expect(stepText(run('c', 'running') as never)).toBe('运行 pnpm test')
    expect(stepText(run('c', 'running', '跑单元测试') as never)).toBe('跑单元测试')
    expect(stepText(edit('f', ['src/session/Composer.tsx'], 'running') as never)).toBe('修改 Composer.tsx')
    expect(stepText(edit('f', ['src\\new.ts'], 'running', true) as never)).toBe('新建 new.ts')
    expect(stepText(edit('f', ['a.ts', 'b.ts'], 'running') as never)).toBe('修改 2 个文件')
    expect(stepText(tool('t', 'read', 'running') as never)).toBe('读取 src/a.ts')
    expect(stepText(tool('t', 'task', 'running') as never)).toBe('子智能体：审查代码')
    expect(stepText(tool('t', 'other', 'running') as never)).toBe('Skill src/a.ts')
    expect(stepText(think('r', 'running') as never)).toBe('思考中')
  })
})

describe('两步之间在等什么', () => {
  it('工具刚结束：看结果；一段话说完：准备下一步；刚发消息或刚想完：思考', () => {
    expect(waitingFor([user('u'), run('c1')])).toBe('result')
    expect(waitingFor([user('u'), run('c1', 'failed')])).toBe('result')
    expect(waitingFor([user('u'), run('c1'), say('a')])).toBe('next')
    expect(waitingFor([user('u')])).toBe('thinking')
    expect(waitingFor([user('u'), think('r')])).toBe('thinking')
    expect(waitingFor([])).toBe('thinking')
  })

  it('信息提示、空白文字不算一步，接着往前看', () => {
    expect(waitingFor([user('u'), edit('f', ['a.ts']), info('i'), say('b', '\n\n')])).toBe('result')
  })
})

describe('用时', () => {
  it('一分钟内写整秒，再长交给 formatDuration', () => {
    expect(clockText(3400, () => 'long')).toBe('3s')
    expect(clockText(59_999, () => 'long')).toBe('59s')
    expect(clockText(65_000, ms => `long:${ms}`)).toBe('long:65000')
  })
})

describe('状态行：动作 + 对象', () => {
  it('命令、改文件、读取把动作和对象分开，对象留给等宽字体', () => {
    expect(liveStep(run('c', 'running') as never)).toEqual({ verb: '正在运行', object: 'pnpm test' })
    expect(liveStep(edit('f', ['src/session/Composer.tsx'], 'running') as never)).toEqual({
      verb: '正在修改',
      object: 'Composer.tsx',
    })
    expect(liveStep(edit('f', ['src\\new.ts'], 'running', true) as never)).toEqual({
      verb: '正在新建',
      object: 'new.ts',
    })
    expect(liveStep(tool('t', 'read', 'running') as never)).toEqual({ verb: '正在读取', object: 'src/a.ts' })
    expect(liveStep(tool('t', 'search', 'running') as never)).toEqual({ verb: '正在搜索', object: 'src/a.ts' })
  })

  it('说明、多个文件、子智能体、其他工具拆不干净：整句放动作里', () => {
    expect(liveStep(run('c', 'running', '跑单元测试') as never)).toEqual({ verb: '跑单元测试', object: null })
    expect(liveStep(edit('f', ['a.ts', 'b.ts'], 'running') as never)).toEqual({ verb: '修改 2 个文件', object: null })
    expect(liveStep(tool('t', 'task', 'running') as never)).toEqual({ verb: '子智能体：审查代码', object: null })
    expect(liveStep(tool('t', 'other', 'running') as never)).toEqual({ verb: 'Skill src/a.ts', object: null })
    expect(liveStep(think('r', 'running') as never)).toEqual({ verb: '正在思考…', object: null })
  })

  it('有在跑的一步写这一步，并行的带上另外几个', () => {
    expect(liveStatus([user('u'), run('c1', 'running')])).toEqual({ verb: '正在运行', object: 'pnpm test', more: 0 })
    expect(liveStatus([user('u'), tool('a1', 'task', 'running'), tool('a2', 'task', 'running')])).toMatchObject({
      verb: '子智能体：审查代码',
      more: 1,
    })
  })

  it('正在输出回复文字写「正在写回复」，哪怕还有别的在跑；刚开口还没字时不算', () => {
    expect(liveStatus([user('u'), run('c1'), say('a', '改好了', 'running')])).toMatchObject({ verb: '正在写回复' })
    expect(liveStatus([user('u'), tool('a1', 'task', 'running'), say('a', '改好了', 'running')])).toMatchObject({
      verb: '正在写回复',
    })
    expect(liveStatus([user('u'), run('c1'), say('a', '', 'running')])).toMatchObject({ verb: '正在看结果…' })
  })

  it('没有在跑的一步：按最后一条写在等什么', () => {
    expect(liveStatus([user('u')])).toEqual({ verb: '正在思考…', object: null, more: 0 })
    expect(liveStatus([user('u'), run('c1')])).toMatchObject({ verb: '正在看结果…' })
    expect(liveStatus([user('u'), run('c1'), say('a')])).toMatchObject({ verb: '正在准备下一步…' })
  })
})

describe('这一轮与本轮用时', () => {
  it('开始时间取当前轮（turnId）的正式用户消息，引导也带 turnId 但不算', () => {
    const items = [
      user('u1', 1000, 'normal', 't1'),
      run('c1'),
      stats('s1'),
      user('u2', 5000, 'normal', 't2'),
      user('g', 9000, 'guidance', 't2'),
      run('c2'),
    ]
    const turn = turnWindow(items, 't2')
    expect(turn.startedAt).toBe(5000)
    expect(turn.items.map(i => i.id)).toEqual(['u2', 'g', 'c2'])
  })

  it('中断的轮次没有统计行，之后引擎自己开的轮次不能把中断那一轮的开始时间算进来', () => {
    // A 被 Esc 中断（没有统计行），十分钟后自动轮次 t-auto 开始：没有用户消息，对不上就不显示用时
    const items = [user('A', 1000, 'normal', 't1'), run('bg', 'running'), say('late', '后台任务完成了')]
    expect(turnWindow(items, 't-auto').startedAt).toBeNull()
    expect(turnWindow(items, null).startedAt).toBeNull()
    // 对得上的照常算
    expect(turnWindow(items, 't1').startedAt).toBe(1000)
  })

  it('用户消息没带 turnId（旧数据）或时间戳是 0 时也不猜', () => {
    expect(turnWindow([user('u1', 1000), run('c1')], 't1').startedAt).toBeNull()
    expect(turnWindow([user('u1', 0, 'normal', 't1'), run('c1')], 't1').startedAt).toBeNull()
    expect(turnWindow([], 't1').startedAt).toBeNull()
  })

  it('没对上当前轮时条目退到最后一条统计行 / 用户消息之后，更早轮次停在 running 的条目不算正在进行', () => {
    const items = [user('u1', 1000, 'normal', 't1'), run('stale', 'running'), stats('s1'), user('u2', 5000)]
    expect(liveStatus(turnWindow(items, 'other').items)).toMatchObject({ verb: '正在思考…' })
    expect(turnWindow([user('u1', 1000, 'normal', 't1'), stats('s1'), run('c2', 'running')], 'x').items).toHaveLength(1)
  })

  it('过了门槛才显示，之后跟着真实时间走；时钟比开始时间还早时不出负数', () => {
    expect(turnElapsed(null, 99_000)).toBeNull()
    expect(turnElapsed(10_000, 10_000 + TURN_CLOCK_MS - 1)).toBeNull()
    expect(turnElapsed(10_000, 10_000 + TURN_CLOCK_MS)).toBe(TURN_CLOCK_MS)
    expect(turnElapsed(10_000, 10_000 + 68_000)).toBe(68_000)
    expect(turnElapsed(10_000, 4_000)).toBeNull()
  })
})

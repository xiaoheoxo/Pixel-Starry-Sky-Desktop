import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { ChannelActivity } from '../../../../shared/types/channels'
import { activityTooltip } from '@/features/session/live/agentActivity'
import { activityView, taskActivity, taskElapsed, type ViewTask } from './taskActivity'

// 进行中的任务卡「正在做什么」（docs/ui/channels-local-ai.md §3.1 #2）

const steps: ChannelActivity['steps'] = [
  { id: 'c1', at: 1000, running: false, kind: 'command', command: 'pnpm test', description: '运行单元测试' },
  { id: 't1', at: 2000, running: false, kind: 'tool', tool: 'read', name: 'Read', title: 'src/a.ts' },
  {
    id: 'f1',
    at: 3000,
    running: true,
    kind: 'file_change',
    changes: [{ kind: 'update', path: 'src/settings/Form.tsx', added: 3, removed: 1 }],
  },
]

describe('taskActivity', () => {
  it('只有进行中才有；没有活动时没有', () => {
    expect(taskActivity({ status: 'waiting', activity: { steps, say: null } })).toBeNull()
    expect(taskActivity({ status: 'done', activity: { steps, say: null } })).toBeNull()
    expect(taskActivity({ status: 'running', activity: null })).toBeNull()
    expect(taskActivity({ status: 'running', activity: { steps: [], say: null } })).toBeNull()
  })
  it('写最近一步（和对话里工具行的说法一样），记下第一次看到的时间', () => {
    const a = taskActivity({ status: 'running', activity: { steps, say: null } })!
    expect(a.line).toMatchObject({ kind: 'step', stepId: 'f1' })
    expect(a.line.text).toContain('Form.tsx')
    expect(a.seen('f1')).toBe(3000)
  })
  it('AI 最近说的一句比最近一步新：写那一句；旧的话不盖过新的一步', () => {
    const newer = taskActivity({
      status: 'running',
      activity: { steps, say: { text: '测试过了，接着改表单。', at: 3500 } },
    })!
    expect(newer.line).toMatchObject({ kind: 'summary', text: '测试过了，接着改表单。' })
    const older = taskActivity({ status: 'running', activity: { steps, say: { text: '先看看', at: 1500 } } })!
    expect(older.line.kind).toBe('step')
    expect(
      taskActivity({ status: 'running', activity: { steps: [], say: { text: '先看看', at: 1 } } })!.line.text,
    ).toBe('先看看')
  })
  it('悬停：完整的一句，下面列最近 3 步（最新的在上，带几秒前）', () => {
    const a = taskActivity({ status: 'running', activity: { steps, say: null } })!
    const tip = activityTooltip(a.line, a.steps, a.seen, 13_000).split('\n')
    expect(tip.length).toBe(5)
    expect(tip[2]).toContain('Form.tsx')
    expect(tip[4]).toContain('pnpm test') // 悬停写完整命令（不是说明）
    expect(tip[4]).toContain('12')
  })
})

describe('activityView（docs/ui/channels-live-activity.md）', () => {
  const read = (id: string, title: string, patch = {}): ChannelActivity['steps'][number] => ({
    id,
    at: 1000,
    endedAt: 1100,
    running: false,
    kind: 'tool',
    tool: 'read',
    name: 'Read',
    title,
    ...patch,
  })
  const cmd = (id: string, patch = {}): ChannelActivity['steps'][number] => ({
    id,
    at: 2000,
    endedAt: 2100,
    running: false,
    kind: 'command',
    command: 'pnpm test\n第二行',
    description: null,
    ...patch,
  })
  const view = (patch: Partial<ViewTask>, limit?: number) =>
    activityView({ status: 'running', activity: { steps: [], say: null }, ...patch }, limit)

  it('只有进行中和失败的活有；失败时没错误也没步骤就没有', () => {
    for (const status of ['queued', 'waiting', 'done', 'stopped', 'approval'] as const)
      expect(view({ status })).toBeNull()
    expect(view({ status: 'failed', activity: null })).toBeNull()
    expect(view({ status: 'failed', activity: null, error: '坏了' })?.head).toEqual({ kind: 'error', text: '坏了' })
  })

  it('一步都没有：写正在思考，不写用时（状态条上有总用时）', () => {
    const [line] = view({ activity: null })!.lines
    expect(line).toMatchObject({ state: 'running', verb: '正在思考…' })
    expect(line.since).toBeUndefined()
  })

  it('团队频道的活没有动态数据：不显示；有错误照样显示', () => {
    expect(view({ activity: null, ownerId: 'u:2' })).toBeNull()
    expect(view({ status: 'failed', activity: null, ownerId: 'u:2', error: '坏了' })?.head?.text).toBe('坏了')
  })

  it('被打断、断线的一步：不打勾，不和前面的读文件合并', () => {
    const lines = view(
      {
        activity: {
          steps: [read('a', 'a.ts'), read('b', 'b.ts', { stopped: true }), cmd('c', { stopped: true })],
          say: null,
        },
        status: 'failed',
        error: 'x',
      },
      9,
    )!.lines
    expect(lines.map(l => [l.id, l.state])).toEqual([
      ['a', 'done'],
      ['b', 'stopped'],
      ['c', 'stopped'],
    ])
  })

  it('合并的读文件不写用时；没有路径的（ls）单独一行，不算进文件数', () => {
    const slow = view({
      activity: { steps: [read('a', 'a.ts', { at: 0, endedAt: 12_000 }), read('b', 'b.ts')], say: null },
    })!.lines
    expect(slow[0].verb).toBe('读取 2 个文件')
    expect(slow[0].spent).toBeUndefined()
    expect(
      view({ activity: { steps: [read('c', 'c.ts', { at: 0, endedAt: 12_000 })], say: null } })!.lines[0].spent,
    ).toBe(12_000)
    const ls = view({ activity: { steps: [read('a', ''), read('b', 'b.ts')], say: null } })!.lines
    expect(ls.slice(0, 2).map(l => [l.verb, l.object])).toEqual([
      ['读取', null],
      ['读取', 'b.ts'],
    ])
  })

  it('最后一行是现在：有在跑的写它，没有时写在等什么，不把做完的一步当成还在转', () => {
    const running = view({
      activity: { steps: [cmd('a'), cmd('b', { running: true, endedAt: undefined })], say: null },
    })!
    expect(running.lines.map(l => [l.verb, l.state])).toEqual([
      ['运行', 'done'],
      ['正在运行', 'running'],
    ])
    expect(running.lines[1].object).toBe('pnpm test')
    expect(running.lines[1].since).toEqual({ at: 2000, min: 3000 })
    const waiting = view({ activity: { steps: [cmd('a')], say: null, wait: { kind: 'result', at: 3000 } } })!
    expect(waiting.lines.at(-1)).toMatchObject({
      state: 'running',
      verb: '正在看结果…',
      since: { at: 3000, min: 5000 },
    })
  })

  it('总共 3 行；并行的几步都显示，放不下做完的', () => {
    const done = [cmd('a'), cmd('b'), cmd('c'), cmd('d')]
    const now = cmd('e', { running: true })
    expect(view({ activity: { steps: [...done, now], say: null } })!.lines.map(l => l.id)).toEqual(['c', 'd', 'e'])
    const parallel = ['e', 'f', 'g', 'h'].map(id => cmd(id, { running: true }))
    expect(view({ activity: { steps: [...done, ...parallel], say: null } })!.lines.map(l => l.id)).toEqual([
      'e',
      'f',
      'g',
      'h',
    ])
    expect(view({ activity: { steps: [...done, now], say: null } }, 5)!.lines).toHaveLength(5)
  })

  it('连续读文件合成一行、去重、只写文件名；隔开的、还在读的、失败的不合', () => {
    const merged = view({
      activity: {
        steps: [read('a', 'src/a.ts'), read('b', 'src/b.ts'), read('c', 'src/a.ts'), read('d', 'src/d.ts')],
        say: null,
      },
    })!.lines
    expect(merged[0]).toMatchObject({ id: 'a', verb: '读取 3 个文件', object: 'a.ts、b.ts 等', state: 'done' })
    expect(merged[0].full).toBe('src/a.ts\nsrc/b.ts\nsrc/d.ts')
    const same = view({ activity: { steps: [read('a', 'src/a.ts'), read('b', 'src/a.ts')], say: null } })!.lines
    expect(same[0]).toMatchObject({ verb: '读取', object: 'a.ts' })
    const apart = view(
      {
        activity: {
          steps: [
            read('a', 'a.ts'),
            cmd('x'),
            read('b', 'b.ts'),
            read('c', 'c.ts', { failed: true }),
            read('d', 'd.ts', { running: true }),
          ],
          say: null,
        },
      },
      9,
    )!.lines
    expect(apart.map(l => l.id)).toEqual(['a', 'x', 'b', 'c', 'd'])
  })

  it('失败标红带退出码；改文件带行数；慢的写用时；有说明时整句用说明', () => {
    const lines = view(
      {
        activity: {
          steps: [
            cmd('bad', { failed: true, exitCode: 2, at: 0, endedAt: 38_000 }),
            cmd('fast'),
            cmd('desc', { description: '运行单元测试' }),
            {
              id: 'f',
              at: 1,
              running: false,
              kind: 'file_change',
              changes: [
                { kind: 'update', path: 'src/a.ts', added: 3, removed: 1 },
                { kind: 'add', path: 'src/b.ts', added: 5, removed: 0 },
              ],
            },
            {
              id: 'f2',
              at: 1,
              running: false,
              failed: true,
              kind: 'file_change',
              changes: [{ kind: 'add', path: 'src/c.ts', added: 5, removed: 0 }],
            },
          ],
          say: null,
        },
      },
      9,
    )!.lines
    expect(lines[0]).toMatchObject({ state: 'failed', exitCode: 2, spent: 38_000 })
    expect(lines[1].spent).toBeUndefined()
    expect(lines[2]).toMatchObject({ verb: '运行单元测试', object: null, full: 'pnpm test' })
    expect(lines[3]).toMatchObject({ verb: '修改 2 个文件', object: null, added: 8, removed: 1 })
    expect(lines[4]).toMatchObject({ verb: '新建', object: 'c.ts', state: 'failed' })
    expect(lines[4].added).toBeUndefined() // 没写到文件上，不算行数
  })

  it('子智能体只占一行：跑着写它最近在做什么，做完不写', () => {
    const agent = {
      id: 'ag',
      at: 1,
      kind: 'tool',
      tool: 'task',
      name: 'Agent',
      title: '审查代码',
      inner: { kind: 'tool', tool: 'read', name: 'Read', title: 'src/a.ts' },
    } as const
    const line = (running: boolean) =>
      view({ activity: { steps: [{ ...agent, running }], say: null } })!.lines.find(l => l.id === 'ag')!
    expect(line(true)).toMatchObject({ verb: '子智能体：审查代码', object: null, inner: '读取 src/a.ts' })
    expect(line(false).inner).toBeUndefined()
  })

  it('第一行：最近一句优先，没有时写计划和进度', () => {
    const plan = { steps: [], say: null, plan: '第二步' }
    const progress = { done: 1, total: 5 }
    expect(view({ activity: { ...plan, say: { text: '在跑测试', at: 1 } }, progress })?.head).toEqual({
      kind: 'say',
      text: '在跑测试',
    })
    expect(view({ activity: plan, progress })?.head).toEqual({ kind: 'plan', text: '第二步', progress: '1/5' })
    expect(view({ activity: plan })?.head).toEqual({ kind: 'plan', text: '第二步' })
  })

  it('失败和断开：不再转圈，还没做完的那一步不算成功；断开时不写在等什么', () => {
    const steps = [cmd('a'), cmd('b', { running: true, endedAt: undefined })]
    const failed = view({ status: 'failed', error: 'x', activity: { steps, say: { text: '话', at: 1 } } })!
    expect(failed.head).toEqual({ kind: 'error', text: 'x' })
    expect(failed.lines.map(l => [l.verb, l.state])).toEqual([
      ['运行', 'done'],
      ['运行', 'stopped'],
    ])
    expect(failed.lines[1].since).toBeUndefined()
    const off = view({ disconnected: true, activity: { steps: [cmd('a')], say: null } })!
    expect(off.lines.map(l => l.id)).toEqual(['a'])
  })
})

describe('taskElapsed', () => {
  it('进行中到现在，刚开始几秒不写；结束算到结束；追加要求和重试后、其它状态不写', () => {
    const task = { status: 'running', startedAt: 1000 } as const
    expect(taskElapsed(task, 3000)).toBeNull()
    expect(taskElapsed(task, 7000)).toBe(6000)
    expect(taskElapsed({ ...task, round: 2 }, 7000)).toBeNull()
    expect(taskElapsed({ status: 'done', startedAt: 1000, endedAt: 4000 }, 9000)).toBe(3000)
    expect(taskElapsed({ status: 'failed', startedAt: 1000, endedAt: 4000 }, 9000)).toBe(3000)
    expect(taskElapsed({ status: 'stopped', startedAt: 1000, endedAt: 4000 }, 9000)).toBeNull()
    expect(taskElapsed({ status: 'running' }, 9000)).toBeNull()
  })
})

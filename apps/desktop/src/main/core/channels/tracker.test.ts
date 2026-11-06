import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, EngineEvent, Item, SessionSnapshot } from '@pixelsky/protocol'
import type { ChannelMessage } from '../../../shared/types/channels'
import { ACTIVITY_STEPS, reconcileRun, trackEvent, diffTotal, type TaskRun } from './tracker'
import {
  HISTORY_CHARS,
  HISTORY_MESSAGES,
  PINNED_CHARS,
  PINNED_ITEM_CHARS,
  clipResult,
  decisionOf,
  dispatchPrompt,
  historyLines,
  summaryOf,
  taskTitle,
  titleWithoutAll,
} from './prompt'

const run = (patch: Partial<TaskRun> = {}): TaskRun => ({
  taskId: 't1',
  channelId: 'c1',
  memberId: 'm1',
  phase: 'sent',
  queuedAt: 0,
  round: 1,
  sessionId: 's1',
  clientMessageId: 'ch-t1-1',
  prompt: 'p',
  freshPrompt: 'p',
  started: false,
  turnId: null,
  requests: [],
  diff: {},
  reply: null,
  progress: null,
  followUps: [],
  notice: null,
  ...patch,
})
const user = (id: string, turnId: string): Item => ({ kind: 'user', id, text: 'x', createdAt: 0, turnId })
const request = (id: string): ApprovalRequest => ({
  requestId: id,
  itemId: null,
  kind: 'command',
  title: '运行命令',
  alwaysScopes: [],
})

/** 依次喂事件，返回最后的运行信息和收集到的变化；第 i 个事件的时间是 1000 + i */
function feed(start: TaskRun, events: EngineEvent[]) {
  let r = start
  const patches: Array<Record<string, unknown>> = []
  let finish = null
  for (const [i, e] of events.entries()) {
    const t = trackEvent(r, e, 1000 + i)
    r = t.run
    if (t.patch) patches.push(t.patch)
    if (t.finish) finish = t.finish
  }
  return { run: r, patches, finish }
}

describe('任务状态跟踪（§5.1）', () => {
  it('user 条目出现 → 进行中；审批 → 等你确认 → 进行中；做完 → 已完成，收集回复和改动', () => {
    const r = feed(run(), [
      { type: 'item_completed', item: user('other', 'tx') },
      { type: 'item_completed', item: user('ch-t1-1', 'turn1') },
      { type: 'approval_request', request: request('r1') },
      { type: 'approval_resolved', requestId: 'r1' },
      {
        type: 'item_completed',
        item: {
          kind: 'file_change',
          id: 'f1',
          status: 'completed',
          changes: [{ path: 'a', kind: 'update', diff: '', added: 3, removed: 1 }],
        },
      },
      { type: 'item_completed', item: { kind: 'assistant', id: 'a1', text: '先看看', status: 'completed' } },
      { type: 'item_completed', item: { kind: 'assistant', id: 'a2', text: '改好了', status: 'completed' } },
      { type: 'turn_completed', turnId: 'other-turn', outcome: 'failed', error: 'x' },
      { type: 'turn_completed', turnId: 'turn1', outcome: 'completed', error: null },
    ])
    expect(r.patches.filter(p => 'status' in p)).toEqual([
      { status: 'running', request: null, progress: null, activity: null, startedAt: expect.any(Number) },
      { status: 'waiting', request: request('r1'), waitingCount: 1 },
      { status: 'running', request: null, waitingCount: 0 },
    ])
    expect(r.finish).toEqual({ status: 'done' })
    expect(r.run.reply).toBe('改好了')
    expect(diffTotal(r.run)).toEqual({ added: 3, removed: 1 })
  })

  it('被拒绝 / 失败的改文件不算进改动', () => {
    const change = (id: string, status: 'completed' | 'declined' | 'failed'): EngineEvent => ({
      type: 'item_completed',
      item: { kind: 'file_change', id, status, changes: [{ path: id, kind: 'add', diff: '', added: 1, removed: 0 }] },
    })
    const r = feed(run(), [
      { type: 'item_completed', item: user('ch-t1-1', 'turn1') },
      change('f1', 'declined'),
      change('f2', 'failed'),
      change('f3', 'completed'),
      change('f3', 'declined'),
    ])
    expect(diffTotal(r.run)).toBeNull()
  })

  it('正在做什么：命令 / 改文件 / 工具开始和完成都记，同一步原地更新、保留第一次看到的时间；AI 说的话记第一行', () => {
    const cmd = (id: string, status: 'running' | 'completed'): Item => ({
      kind: 'command',
      id,
      command: `pnpm test ${id}\n第二行`,
      description: null,
      output: '很长的输出',
      exitCode: status === 'completed' ? 0 : null,
      status,
    })
    const r = feed(run(), [
      { type: 'item_completed', item: user('ch-t1-1', 'turn1') },
      { type: 'item_started', item: cmd('c1', 'running') },
      { type: 'item_completed', item: cmd('c1', 'completed') },
      {
        type: 'item_started',
        item: { kind: 'tool', id: 't1', tool: 'read', name: 'Read', title: 'src/a.ts', output: '', status: 'running' },
      },
      { type: 'item_started', item: { kind: 'reasoning', id: 'r1', text: '', status: 'running' } },
      {
        type: 'item_started',
        item: {
          kind: 'file_change',
          id: 'f1',
          status: 'running',
          changes: [{ path: 'src/b.ts', kind: 'update', diff: '-x\n+y', added: 1, removed: 1 }],
        },
      },
      { type: 'item_started', item: cmd('c2', 'running') },
      {
        type: 'item_completed',
        item: { kind: 'assistant', id: 'a1', text: '测试过了，接着改样式。\n细节……', status: 'completed' },
      },
    ])
    const activity = r.run.activity!
    expect(activity.steps.map(s => s.id)).toEqual(['c1', 't1', 'f1', 'c2'])
    expect(activity.steps[2]).toEqual({
      id: 'f1',
      at: 1005,
      running: true,
      kind: 'file_change',
      changes: [{ kind: 'update', path: 'src/b.ts', added: 1, removed: 1 }],
    })
    expect(activity.steps[3]).toMatchObject({
      kind: 'command',
      command: 'pnpm test c2\n第二行',
      running: true,
      at: 1006,
    })
    expect(activity.say).toEqual({ text: '测试过了，接着改样式。', at: 1007 })
    // 开始 → 完成：原地更新、时间不变；输出不进任务卡
    const c1 = feed(run(), [
      { type: 'item_completed', item: user('ch-t1-1', 'turn1') },
      { type: 'item_started', item: cmd('c1', 'running') },
      { type: 'item_completed', item: cmd('c1', 'completed') },
    ]).run.activity!.steps
    expect(c1).toEqual([
      {
        id: 'c1',
        at: 1001,
        endedAt: 1002,
        running: false,
        kind: 'command',
        command: 'pnpm test c1\n第二行',
        description: null,
      },
    ])
    // 每次变化都给任务卡一个 activity 更新；下一轮开始清空
    expect(r.patches.filter(p => 'activity' in p && p.activity).length).toBe(7)
    const next = trackEvent(
      { ...r.run, clientMessageId: 'ch-t1-2' },
      { type: 'item_completed', item: user('ch-t1-2', 'turn2') },
    )
    expect(next.run.activity).toBeNull()
    expect(next.patch).toMatchObject({ activity: null })
  })

  describe('频道动态（docs/ui/channels-live-activity.md）', () => {
    const begin: EngineEvent = { type: 'item_completed', item: user('ch-t1-1', 'turn1') }
    const tool = (
      id: string,
      patch: Partial<Extract<Item, { kind: 'tool' }>> = {},
    ): Extract<Item, { kind: 'tool' }> => ({
      kind: 'tool',
      id,
      tool: 'read',
      name: 'Read',
      title: `${id}.ts`,
      output: '',
      status: 'completed',
      ...patch,
    })
    const started = (item: Item): EngineEvent => ({ type: 'item_started', item })
    const completed = (item: Item): EngineEvent => ({ type: 'item_completed', item })

    it('失败：命令非 0 退出带退出码，被拒绝也算；0 退出和被打断不算', () => {
      const cmd = (id: string, status: 'completed' | 'failed' | 'interrupted', exitCode: number | null): Item => ({
        kind: 'command',
        id,
        command: 'x',
        description: null,
        output: '',
        exitCode,
        status,
      })
      const steps = feed(run(), [
        begin,
        completed(cmd('ok', 'completed', 0)),
        completed(cmd('bad', 'failed', 2)),
        completed(cmd('silent', 'completed', 1)),
        completed(cmd('stopped', 'interrupted', null)),
        completed(tool('denied', { status: 'declined' })),
      ]).run.activity!.steps
      expect(steps.map(s => [s.id, !!s.failed])).toEqual([
        ['ok', false],
        ['bad', true],
        ['silent', true],
        ['stopped', false],
        ['denied', true],
      ])
      expect(steps[1]).toMatchObject({ exitCode: 2 })
      expect(steps[0]).not.toHaveProperty('exitCode')
    })

    it('做完的时间：只记第一次，用时不会被重复的完成事件拉长', () => {
      const steps = feed(run(), [
        begin,
        started(tool('a', { status: 'running' })),
        completed(tool('a')),
        completed(tool('a')),
      ]).run.activity!.steps
      expect(steps[0]).toMatchObject({ at: 1001, endedAt: 1002, running: false })
    })

    it('子智能体只占一行：它的工具调用记到派出它的那一步上，不单独算一步，改动统计照算', () => {
      const agent = tool('ag1', { tool: 'task', name: 'Agent', title: '审查代码', status: 'running' })
      const r = feed(run(), [
        begin,
        started(agent),
        started(tool('t1', { status: 'running', subagent: 'C1', subagentCall: 'ag1' })),
        completed({
          kind: 'file_change',
          id: 'f1',
          status: 'completed',
          subagent: 'C1',
          subagentCall: 'ag1',
          changes: [{ path: 'b.ts', kind: 'update', diff: '', added: 3, removed: 1 }],
        }),
        // 派出它的那一步不在列表里：不记，也不单独算一步
        completed(tool('t2', { subagent: 'C2', subagentCall: 'gone' })),
        completed({ ...agent, status: 'completed' }),
      ])
      const steps = r.run.activity!.steps
      expect(steps.map(s => s.id)).toEqual(['ag1'])
      // 这一步开始 → 完成时 inner 留着；最后记的是改文件
      expect(steps[0].inner).toEqual({
        kind: 'file_change',
        changes: [{ kind: 'update', path: 'b.ts', added: 3, removed: 1 }],
      })
      expect(diffTotal(r.run)).toEqual({ added: 3, removed: 1 })
    })

    it('频道工具不算一步，不管名字在哪、哪个引擎', () => {
      const steps = feed(run(), [
        begin,
        completed(tool('c1', { tool: 'mcp', name: 'mcp__pixelsky_channel__task_done', title: 'task_done' })),
        completed(tool('c2', { tool: 'mcp', name: 'pixelsky_channel / task_done', title: 'task_done' })),
        completed(tool('t1')),
      ]).run.activity!.steps
      expect(steps.map(s => s.id)).toEqual(['t1'])
    })

    it('标题里带频道服务名的普通步骤不过滤：可能是用户的路径、搜索词', () => {
      const steps = feed(run(), [
        begin,
        completed(tool('grep', { tool: 'search', name: 'Grep', title: 'pixelsky_channel' })),
        completed(tool('read', { title: 'docs/pixelsky_channel-notes.md' })),
      ]).run.activity!.steps
      expect(steps.map(s => s.id)).toEqual(['grep', 'read'])
    })

    it('被打断的一步不算做完，也不算失败', () => {
      const [step] = feed(run(), [begin, completed(tool('a', { status: 'interrupted' }))]).run.activity!.steps
      expect(step).toMatchObject({ running: false, stopped: true })
      expect(step).not.toHaveProperty('failed')
    })

    it('断线重连：步骤留着，还在跑的标成没做完，等待从重连算起；重试是重新做，清空', () => {
      const before = feed(run(), [begin, completed(tool('a')), started(tool('b', { status: 'running' }))]).run
      const reconnect = trackEvent(before, completed(user('ch-t1-1-reconnect-1', 'turn2')), 5000)
      expect(reconnect.run.activity?.steps.map(s => [s.id, s.running, !!s.stopped])).toEqual([
        ['a', false, false],
        ['b', false, true],
      ])
      expect(reconnect.run.activity?.steps[1].endedAt).toBe(5000)
      expect(reconnect.run.activity?.wait).toEqual({ kind: 'thinking', at: 5000 })
      expect(reconnect.patch).toMatchObject({ activity: reconnect.run.activity })
      const retry = trackEvent(before, completed(user('ch-t1-1-retry-1', 'turn2')), 5000)
      expect(retry.run.activity).toBeNull()
      expect(retry.patch).toMatchObject({ activity: null })
    })

    it('对账：重连前的步骤也留着', () => {
      const snapshot = {
        items: [
          user('ch-t1-1', 'turn1'),
          tool('a'),
          tool('b', { status: 'running' }),
          user('ch-t1-1-reconnect-1', 'turn2'),
          tool('c'),
        ],
        queue: [],
        pending: [],
        state: 'running',
        turnId: 'turn2',
        queuePaused: false,
        record: { lastOutcome: null },
      } as unknown as SessionSnapshot
      const steps = reconcileRun(run({ started: true }), snapshot, 5000).run.activity!.steps
      expect(steps.map(s => [s.id, !!s.stopped])).toEqual([
        ['a', false],
        ['b', true],
        ['c', false],
      ])
    })

    it('两步之间在等什么：工具做完看结果，说完话准备下一步，想的时候思考', () => {
      const wait = (...events: EngineEvent[]) => feed(run(), [begin, ...events]).run.activity?.wait
      expect(wait(started(tool('a', { status: 'running' })))).toBeUndefined()
      expect(wait(completed(tool('a')))).toEqual({ kind: 'result', at: 1001 })
      expect(wait(started({ kind: 'reasoning', id: 'r', text: '', status: 'running' }))).toEqual({
        kind: 'thinking',
        at: 1001,
      })
      expect(wait(completed({ kind: 'assistant', id: 'a', text: '好', status: 'completed' }))).toEqual({
        kind: 'next',
        at: 1001,
      })
    })

    it('计划当前这一步的文字；进度不变；没有进行中的步骤时清空', () => {
      const todo = (status: 'in_progress' | 'completed'): Item => ({
        kind: 'todo',
        id: 'td',
        status: 'running',
        steps: [
          { text: '第一步', status: 'completed' },
          { text: '第二步', status },
        ],
      })
      const r = feed(run(), [begin, started(todo('in_progress'))]).run
      expect(r.activity?.plan).toBe('第二步')
      expect(r.progress).toEqual({ done: 1, total: 2 })
      expect(feed(r, [completed(todo('completed'))]).run.activity?.plan).toBeNull()
    })

    it('只留最近 ACTIVITY_STEPS 步', () => {
      const events = Array.from({ length: ACTIVITY_STEPS + 3 }, (_, i) => completed(tool(`t${i}`)))
      const steps = feed(run(), [begin, ...events]).run.activity!.steps
      expect(steps).toHaveLength(ACTIVITY_STEPS)
      expect(steps.at(-1)?.id).toBe(`t${ACTIVITY_STEPS + 2}`)
    })

    it('对账时也按同样的规则算（子智能体、频道工具不算一步）', () => {
      const snapshot = {
        items: [
          user('ch-t1-1', 'turn1'),
          tool('ag1', { tool: 'task', name: 'Agent', title: '审查', status: 'running' }),
          tool('t1', { subagent: 'C1', subagentCall: 'ag1' }),
          tool('c1', { tool: 'mcp', name: 'mcp__pixelsky_channel__channel_read', title: 'x' }),
        ],
        queue: [],
        pending: [],
        state: 'running',
        turnId: 'turn1',
        queuePaused: false,
        record: { lastOutcome: null },
      } as unknown as SessionSnapshot
      const t = reconcileRun(run({ started: true, turnId: 'turn1' }), snapshot, 5000)
      expect(t.run.activity?.steps.map(s => s.id)).toEqual(['ag1'])
      expect(t.run.activity?.steps[0].inner).toMatchObject({ kind: 'tool', title: 't1.ts' })
    })
  })

  it('重试的 user 条目（id 带 -retry-）也算；失败取错误第一行；中断算已停止', () => {
    const started = feed(run(), [{ type: 'item_completed', item: user('ch-t1-1-retry-abc', 'turn2') }]).run
    expect(started.turnId).toBe('turn2')
    // 失败先不收尾，等紧跟着的队列事件：这条不在队列里了才算失败
    const failed = trackEvent(started, {
      type: 'turn_completed',
      turnId: 'turn2',
      outcome: 'failed',
      error: '502\n详情',
    })
    expect(failed.finish).toBeNull()
    expect(trackEvent(failed.run, { type: 'queue', items: [], paused: true }).finish).toEqual({
      status: 'failed',
      error: '502',
    })
    expect(
      trackEvent(started, { type: 'turn_completed', turnId: 'turn2', outcome: 'interrupted', error: null }).finish,
    ).toEqual({
      status: 'stopped',
    })
  })

  it('断线自动重连：这一轮报失败后这条还留在队列里，接着等续做那一轮（-reconnect- 条目），做完算完成', () => {
    const queued = { id: 'ch-t1-1', text: '', createdAt: 0, status: 'queued' } as never
    const r = feed(run(), [
      { type: 'item_completed', item: user('ch-t1-1', 'turn1') },
      { type: 'turn_completed', turnId: 'turn1', outcome: 'failed', error: 'ECONNRESET' },
      { type: 'queue', items: [queued], paused: false },
      { type: 'item_completed', item: user('ch-t1-1-reconnect-abc', 'turn2') },
      { type: 'turn_completed', turnId: 'turn2', outcome: 'completed', error: null },
    ])
    expect(r.finish).toEqual({ status: 'done' })
    // 开始时间只记第一次，续做那一轮不覆盖
    expect(r.patches.filter(p => 'startedAt' in p)).toHaveLength(1)
    // 重连后这条被标失败（次数用完）：按失败收尾
    const gaveUp = feed(run(), [
      { type: 'item_completed', item: user('ch-t1-1', 'turn1') },
      { type: 'turn_completed', turnId: 'turn1', outcome: 'failed', error: 'ECONNRESET' },
      { type: 'queue', items: [{ ...(queued as object), status: 'failed', error: '断开' } as never], paused: true },
    ])
    expect(gaveUp.finish).toEqual({ status: 'failed', error: 'ECONNRESET' })
  })

  it('还没开始：队列项失败 → 失败；从队列里消失 → 已停止（取消）', () => {
    const queued = {
      id: 'ch-t1-1',
      text: '',
      createdAt: 0,
      error: null,
      mode: 'normal' as const,
      settings: { model: null, effort: null, platform: null },
    }
    expect(
      trackEvent(run(), {
        type: 'queue',
        paused: true,
        items: [{ ...queued, status: 'failed', error: '502 无法连接' }],
      }).finish,
    ).toEqual({ status: 'failed', error: '502 无法连接' })
    expect(
      trackEvent(run(), { type: 'queue', paused: false, items: [{ ...queued, status: 'queued' }] }).finish,
    ).toBeNull()
    expect(trackEvent(run(), { type: 'queue', paused: false, items: [] }).finish).toEqual({
      status: 'stopped',
      note: 'cancelled',
    })
    // 开始之后队列项消失是正常交付
    expect(trackEvent(run({ started: true }), { type: 'queue', paused: false, items: [] }).finish).toBeNull()
  })

  it('计划进度', () => {
    const r = feed(run({ started: true, turnId: 't' }), [
      {
        type: 'item_started',
        item: {
          kind: 'todo',
          id: 'td',
          status: 'running',
          steps: [
            { text: 'a', status: 'completed' },
            { text: 'b', status: 'in_progress' },
          ],
        },
      },
    ])
    expect(r.patches).toMatchObject([{ progress: { done: 1, total: 2 } }])
  })
})

describe('重启后对账', () => {
  const snapshot = (patch: Partial<SessionSnapshot>): SessionSnapshot =>
    ({
      record: { id: 's1', lastOutcome: 'completed' },
      state: 'idle',
      items: [],
      pending: [],
      queue: [],
      turnId: null,
      ...patch,
    }) as unknown as SessionSnapshot
  const reply: Item = { kind: 'assistant', id: 'a', text: '好了', status: 'completed' }

  it('会话没了 → 失败；找不到这一轮也不在队列里 → 已停止（取消）；还在队列 → 排队中', () => {
    expect(reconcileRun(run(), null).finish).toEqual({ status: 'failed', error: '会话已删除' })
    expect(reconcileRun(run(), snapshot({})).finish).toEqual({ status: 'stopped', note: 'cancelled' })
    const queued = snapshot({
      queue: [
        {
          id: 'ch-t1-1',
          text: '',
          createdAt: 0,
          error: null,
          mode: 'normal',
          status: 'queued',
          settings: { model: null, effort: null, platform: null },
        },
      ],
    })
    expect(reconcileRun(run(), queued).patch).toEqual({ status: 'queued' })
  })

  it('空闲且有回复 → 已完成；还在跑 → 进行中 / 等你确认；后面还有别的轮次时只看这一轮', () => {
    const done = reconcileRun(run(), snapshot({ items: [user('ch-t1-1', 'k'), reply] }))
    expect(done.finish).toEqual({ status: 'done' })
    expect(done.run.reply).toBe('好了')
    const live = reconcileRun(
      run(),
      snapshot({ state: 'waiting', turnId: 'k', pending: [request('r')], items: [user('ch-t1-1', 'k')] }),
    )
    expect(live.finish).toBeNull()
    expect(live.patch).toMatchObject({ status: 'waiting' })
    const later = reconcileRun(
      run(),
      snapshot({
        state: 'running',
        turnId: 'z',
        record: { lastOutcome: 'failed' } as SessionSnapshot['record'],
        items: [user('ch-t1-1', 'k'), reply, user('mine', 'z')],
      }),
    )
    expect(later.finish).toEqual({ status: 'done' })
  })

  it('断线重连的「继续」是同一轮：重连前的改动和进度留着（实时和对账一样）', () => {
    const edit = (id: string, path: string): Item => ({
      kind: 'file_change',
      id,
      status: 'completed',
      changes: [{ path, kind: 'update', diff: '', added: 2, removed: 1 }],
    })
    const live = feed(run(), [
      { type: 'item_completed', item: user('ch-t1-1', 'turn1') },
      { type: 'item_completed', item: edit('f1', 'a') },
      { type: 'turn_completed', turnId: 'turn1', outcome: 'failed', error: 'ECONNRESET' },
      { type: 'queue', items: [{ id: 'ch-t1-1', text: '', createdAt: 0, status: 'queued' } as never], paused: false },
      { type: 'item_completed', item: user('ch-t1-1-reconnect-x', 'turn2') },
      { type: 'item_completed', item: edit('f2', 'b') },
    ])
    expect(diffTotal(live.run)).toEqual({ added: 4, removed: 2 })
    const again = reconcileRun(
      run(),
      snapshot({
        items: [
          user('ch-t1-1', 'turn1'),
          edit('f1', 'a'),
          user('ch-t1-1-reconnect-x', 'turn2'),
          edit('f2', 'b'),
          reply,
        ],
      }),
    )
    expect(again.finish).toEqual({ status: 'done' })
    expect(again.run.turnId).toBe('turn2')
    expect(diffTotal(again.run)).toEqual({ added: 4, removed: 2 })
  })

  it('失败了但还在队列里（等自动重连）→ 仍在进行（队列暂停了按失败）；没有回复文字时按这一轮的统计行判断完成', () => {
    const waiting = reconcileRun(
      run(),
      snapshot({
        items: [user('ch-t1-1', 'k')],
        record: { lastOutcome: 'failed' } as SessionSnapshot['record'],
        queue: [{ id: 'ch-t1-1', text: '', createdAt: 0, status: 'queued' } as never],
      }),
    )
    expect(waiting.finish).toBeNull()
    expect(waiting.patch).toMatchObject({ status: 'running' })
    expect(waiting.run.turnId).toBeNull()
    // 之后引擎放弃重连（队列项标失败）：按失败收尾，不一直挂在进行中
    expect(
      trackEvent(waiting.run, {
        type: 'queue',
        paused: true,
        items: [{ id: 'ch-t1-1', text: '', createdAt: 0, status: 'failed', error: '断开' } as never],
      }).finish,
    ).toMatchObject({ status: 'failed' })
    // 队列暂停了（重启后等你点继续）：按失败收尾，能重试
    const paused = reconcileRun(
      run(),
      snapshot({
        items: [user('ch-t1-1', 'k')],
        record: { lastOutcome: 'failed' } as SessionSnapshot['record'],
        queue: [{ id: 'ch-t1-1', text: '', createdAt: 0, status: 'queued' } as never],
        queuePaused: true,
      }),
    )
    expect(paused.finish).toMatchObject({ status: 'failed' })
    // 没有回复文字：这一轮有统计行（正常结束）→ 已完成；只有上一轮留下的 completed（崩溃时没写）→ 已停止
    const stats = { kind: 'turn_stats', id: 'st', turnId: 'k', outcome: 'completed', usage: {} } as unknown as Item
    expect(reconcileRun(run(), snapshot({ items: [user('ch-t1-1', 'k'), stats] })).finish).toEqual({ status: 'done' })
    expect(reconcileRun(run(), snapshot({ items: [user('ch-t1-1', 'k')] })).finish).toEqual({ status: 'stopped' })
  })

  it('应用退出时中断 → 已停止；失败 → 失败（用错误通知）', () => {
    const items: Item[] = [user('ch-t1-1', 'k'), { kind: 'notice', id: 'n', level: 'error', text: '额度不足\n详情' }]
    expect(
      reconcileRun(run(), snapshot({ items, record: { lastOutcome: 'failed' } as SessionSnapshot['record'] })).finish,
    ).toEqual({ status: 'failed', error: '额度不足' })
    expect(
      reconcileRun(run(), snapshot({ items, record: { lastOutcome: 'interrupted' } as SessionSnapshot['record'] }))
        .finish,
    ).toEqual({ status: 'stopped' })
  })
})

describe('派活提示词（§4.2）', () => {
  const members = [
    { id: 'you', name: '林夏' },
    { id: 'm1', name: '前端助手' },
    { id: 'm2', name: '前端' },
  ]
  const nameOf = (id: string) => members.find(m => m.id === id)?.name ?? '?'
  const text = (
    id: string,
    authorId: string,
    body: string,
    at: number,
    format: 'plain' | 'markdown' = 'plain',
  ): ChannelMessage => ({
    kind: 'message',
    id,
    channelId: 'c',
    at,
    authorId,
    text: body,
    format,
  })

  it('标题去掉 @，取第一行；结果摘要取第一段；「需要你决定」单独取出', () => {
    expect(taskTitle('@前端助手 ，把设置页迁移到新表单\n细节见下', members)).toBe('把设置页迁移到新表单')
    expect(taskTitle('@前端助手', members)).toBe('')
    const kinds = members.map(m => ({ ...m, kind: m.id === 'you' ? ('human' as const) : ('agent' as const) }))
    expect(taskTitle('@全体 ，一起看下登录页', kinds)).toBe('一起看下登录页')
    expect(taskTitle('@all', kinds)).toBe('')
    // 云端标题只去掉了成员名：@全体 也去掉，@真人 留着
    expect(titleWithoutAll('@全体 ，一起看下 @林夏', kinds)).toBe('一起看下 @林夏')
    expect(titleWithoutAll('看下 @林夏', kinds)).toBe('看下 @林夏')
    expect(titleWithoutAll('@全体', kinds)).toBe('@全体')
    const reply = '## 总结\n改好了设置页。\n\n需要你决定：要不要删掉旧组件？\n\n其他'
    expect(summaryOf(reply)).toBe('总结 改好了设置页。')
    // Codex 的文件引用只留文件名
    expect(summaryOf('已生成 :codex-file-citation{path="D:\\a\\报告.docx" purpose="output"}')).toBe('已生成 报告.docx')
    expect(decisionOf(reply)).toBe('要不要删掉旧组件？')
    expect(decisionOf('- **Needs your decision:** keep the flag?')).toBe('keep the flag?')
    expect(decisionOf('没有')).toBeNull()
    expect(clipResult('x'.repeat(20_001), 'zh-CN')).toMatch(/…完整内容见会话$/)
  })

  it('最近讨论：源消息之前，最多 20 条 / 8000 字，事件不带，AI 回复只带第一段，被引用的单独列出', () => {
    const list: ChannelMessage[] = []
    for (let i = 0; i < 30; i++) list.push(text(`m${i}`, 'you', `第 ${i} 条`, i))
    list.push({ kind: 'event', id: 'e', channelId: 'c', at: 30, event: 'added', actorId: 'you', targetId: 'm1' })
    list.push(text('ai', 'm1', '第一段\n\n第二段', 31, 'markdown'))
    list.push(text('src', 'you', '@前端助手 做', 32))
    list.push(text('after', 'you', '之后', 33))
    const lines = historyLines(list, { beforeId: 'src', skip: 'm29', nameOf, locale: 'zh-CN' })
    expect(lines).toHaveLength(HISTORY_MESSAGES)
    expect(lines.at(-1)).toBe('前端助手：第一段')
    expect(lines.some(l => l.includes('第 29 条'))).toBe(false)
    expect(lines[0]).toBe('林夏：第 10 条')
    // since：只要之后的
    expect(historyLines(list, { beforeId: 'src', since: 28, nameOf, locale: 'zh-CN' })).toEqual([
      '林夏：第 29 条',
      '前端助手：第一段',
    ])
    // 字数上限
    const long = [text('a', 'you', 'x'.repeat(900), 1), text('b', 'you', 'y'.repeat(900), 2)]
    const many = Array.from({ length: 12 }, (_, i) => ({ ...long[i % 2], id: `l${i}`, at: i }))
    const capped = historyLines([...many, text('s', 'you', 'go', 99)], { beforeId: 's', nameOf, locale: 'zh-CN' })
    expect(capped.join('').length).toBeLessThanOrEqual(HISTORY_CHARS)
    expect(capped.length).toBe(8)
  })

  it('提示词带频道、职责、讨论、引用、原文和收尾要求；英文界面用英文', () => {
    const zh = dispatchPrompt({
      locale: 'zh-CN',
      channel: { name: '网页版改版', topic: '10 月改版' },
      author: '林夏',
      instructions: '只提意见',
      history: ['林夏：先看看'],
      quoted: '审查员：这里有问题',
      request: '@前端助手 改一下',
    })
    expect(zh).toContain('#网页版改版')
    expect(zh).toContain('（频道主题：10 月改版）')
    expect(zh).toContain('你的职责：\n只提意见')
    expect(zh).toContain('> 审查员：这里有问题')
    expect(zh).toContain('这次的要求：\n@前端助手 改一下')
    expect(zh).toContain('需要你决定：')
    const en = dispatchPrompt({
      locale: 'en-US',
      channel: { name: 'web', topic: null },
      author: 'Lin',
      instructions: '',
      history: [],
      quoted: null,
      request: 'do it',
    })
    expect(en).not.toContain('Your role')
    // @全体：写明还有谁同时收到
    const base = {
      channel: { name: 'c', topic: null },
      author: '林夏',
      instructions: '',
      history: [],
      quoted: null,
      request: '@全体 看下',
    }
    expect(dispatchPrompt({ ...base, locale: 'zh-CN', together: ['审查员', '构建'] })).toContain(
      '交给你的人：林夏\n这条消息发给了频道里全体 AI 成员，审查员、构建 也同时收到了。',
    )
    expect(dispatchPrompt({ ...base, locale: 'en-US', together: ['Reviewer'] })).toContain('Reviewer got it too.')
    expect(dispatchPrompt({ ...base, locale: 'zh-CN', together: [] })).not.toContain('全体 AI 成员')
    expect(en).toContain('Needs your decision:')
  })

  it('频道说明和置顶资料（docs/ui/channels-local-ai.md §3.1 #9）：说明原样带上，置顶每条压成一行、超长截断', () => {
    const base = {
      locale: 'zh-CN' as const,
      channel: { name: 'c', topic: null },
      author: '林夏',
      instructions: '只改前端',
      history: [],
      quoted: null,
      request: '@前端助手 改一下',
    }
    const p = dispatchPrompt({ ...base, notes: '改完要跑 pnpm check\n不要动 API', pinned: ['林夏：设计稿\n在 Figma'] })
    expect(p).toContain('频道说明（这个频道里每项活都要照着做）：\n改完要跑 pnpm check\n不要动 API')
    expect(p).toContain('频道里置顶的资料：\n- 林夏：设计稿 在 Figma')
    // 说明在职责后面、要求前面
    expect(p.indexOf('你的职责')).toBeLessThan(p.indexOf('频道说明'))
    expect(p.indexOf('频道说明')).toBeLessThan(p.indexOf('这次的要求'))
    expect(dispatchPrompt(base)).not.toContain('频道说明')
    expect(dispatchPrompt({ ...base, notes: '  ', pinned: [] })).not.toContain('置顶')
    const long = dispatchPrompt({
      ...base,
      pinned: ['a'.repeat(PINNED_ITEM_CHARS + 50), ...Array(10).fill('b'.repeat(900))],
    })
    const section = long.slice(long.indexOf('频道里置顶的资料'), long.indexOf('这次的要求'))
    expect(section).toContain(`${'a'.repeat(PINNED_ITEM_CHARS)}…`)
    expect(section.length).toBeLessThan(PINNED_CHARS + 200)
    expect(dispatchPrompt({ ...base, locale: 'en-US', notes: 'run checks', pinned: ['Lin: spec'] })).toContain(
      'Channel guidelines (follow them for every task here):\nrun checks',
    )
  })
})

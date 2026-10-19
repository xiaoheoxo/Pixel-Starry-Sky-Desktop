import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, EngineEvent, Item, SessionSnapshot } from '@pixelsky/protocol'
import type { ChannelMessage } from '../../../shared/types/channels'
import { reconcileRun, trackEvent, diffTotal, type TaskRun } from './tracker'
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
      { status: 'running', request: null, progress: null, activity: null },
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

  it('正在做什么：命令 / 改文件 / 工具开始和完成都记，同一步原地更新、保留第一次看到的时间，只留最近 3 步；AI 说的话记第一行', () => {
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
    expect(activity.steps.map(s => s.id)).toEqual(['t1', 'f1', 'c2'])
    expect(activity.steps[1]).toEqual({
      id: 'f1',
      at: 1005,
      running: true,
      kind: 'file_change',
      changes: [{ kind: 'update', path: 'src/b.ts' }],
    })
    expect(activity.steps[2]).toMatchObject({
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
      { id: 'c1', at: 1001, running: false, kind: 'command', command: 'pnpm test c1\n第二行', description: null },
    ])
    // 每次变化都给任务卡一个 activity 更新；下一轮开始清空
    expect(r.patches.filter(p => 'activity' in p && p.activity).length).toBe(6)
    const next = trackEvent(
      { ...r.run, clientMessageId: 'ch-t1-2' },
      { type: 'item_completed', item: user('ch-t1-2', 'turn2') },
    )
    expect(next.run.activity).toBeNull()
    expect(next.patch).toMatchObject({ activity: null })
  })

  it('重试的 user 条目（id 带 -retry-）也算；失败取错误第一行；中断算已停止', () => {
    const started = feed(run(), [{ type: 'item_completed', item: user('ch-t1-1-retry-abc', 'turn2') }]).run
    expect(started.turnId).toBe('turn2')
    expect(
      trackEvent(started, { type: 'turn_completed', turnId: 'turn2', outcome: 'failed', error: '502\n详情' }).finish,
    ).toEqual({ status: 'failed', error: '502' })
    expect(
      trackEvent(started, { type: 'turn_completed', turnId: 'turn2', outcome: 'interrupted', error: null }).finish,
    ).toEqual({
      status: 'stopped',
    })
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
    expect(r.patches).toEqual([{ progress: { done: 1, total: 2 } }])
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

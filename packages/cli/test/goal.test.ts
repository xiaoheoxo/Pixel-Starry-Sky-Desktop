import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { goalExtension } from '../src/extensions/goal.ts'
import { LOOP_GUARD_RESET_EVENT, LOOP_GUARD_STOP_EVENT } from '../src/extensions/loopGuard.ts'
import {
  PIXEL_GOAL_COMMAND,
  PIXEL_GOAL_CONTINUE,
  PIXEL_GOAL_ENTRY,
  type PixelGoalAction,
  type PixelGoalReport,
} from '../../protocol/src/pixel-goal.ts'

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown
type Tool = {
  name: string
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[] }>
}
type Entry = { type: string; customType: string; data: unknown }

function setup(saved: Entry[] = []) {
  const handlers = new Map<string, Handler>()
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>()
  const tools = new Map<string, Tool>()
  const bus = new Map<string, () => void>()
  const resets = vi.fn()
  bus.set(LOOP_GUARD_RESET_EVENT, resets)
  const entries = structuredClone(saved)
  const reports: PixelGoalReport[] = []
  const messages: unknown[] = []
  const abort = vi.fn()
  let idle = true
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort,
    sessionManager: { getBranch: () => entries },
    ui: { setStatus: (_key: string, value: string) => reports.push(JSON.parse(value)), notify: vi.fn() },
  } as unknown as ExtensionContext
  goalExtension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerCommand: (name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      commands.set(name, value.handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    sendMessage: (message: unknown) => messages.push(message),
    events: {
      on: (name: string, fn: () => void) => {
        bus.set(name, fn)
        return () => bus.delete(name)
      },
      emit: (name: string) => bus.get(name)?.(),
    },
  } as never)
  const emit = async (name: string, event: Record<string, unknown> = {}) =>
    handlers.get(name)?.({ type: name, ...event }, ctx)
  const start = async (user = false) => {
    idle = false
    await emit(
      'before_agent_start',
      user
        ? { messageType: 'user', prompt: 'Continue' }
        : { messageType: 'custom', message: { customType: PIXEL_GOAL_CONTINUE } },
    )
  }
  const settle = async (aborted = false) => {
    idle = true
    await emit('agent_settled', { aborted })
  }
  const action = async (value: PixelGoalAction) => {
    await commands.get(PIXEL_GOAL_COMMAND)!(JSON.stringify({ ...value, req: 'test' }), ctx)
    return reports.at(-1)!
  }
  const call = async (name: string, params: Record<string, unknown> = {}) =>
    JSON.parse((await tools.get(name)!.execute('tool', params)).content[0].text)
  return {
    emit,
    start,
    settle,
    action,
    call,
    entries,
    reports,
    messages,
    abort,
    ctx,
    bus,
    resets,
    init: () => emit('session_start'),
    goal: () => reports.at(-1)?.goal,
    usage: async (usage: Record<string, number>) => {
      await emit('context', { messages: [] })
      await emit('message_start', { message: { role: 'assistant' } })
      await emit('message_end', { message: { role: 'assistant', stopReason: 'stop', usage } })
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Pixel goal lifecycle', () => {
  it('ordinary tasks do not create goals; an active goal continues after settlement and completion stops it', async () => {
    const s = setup()
    await s.init()
    await s.start(true)
    await s.settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.messages).toHaveLength(0)
    await s.action({ kind: 'set', objective: 'Finish the implementation' })
    await vi.advanceTimersByTimeAsync(100)
    expect(s.messages).toHaveLength(1)
    await s.start()
    await vi.advanceTimersByTimeAsync(1200)
    await s.usage({ input: 10, output: 4, cacheRead: 6, cacheWrite: 2 })
    await s.settle()
    expect(s.goal()).toMatchObject({ tokensUsed: 22, timeUsedSeconds: 1.2, status: 'active' })
    await vi.advanceTimersByTimeAsync(100)
    expect(s.messages).toHaveLength(2)
    await s.start()
    const { goal_id } = await s.call('get_goal')
    await s.call('update_goal', { goal_id, status: 'complete' })
    await s.settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.messages).toHaveLength(2)
    expect(s.goal()?.status).toBe('complete')
    expect(s.entries.at(-1)?.customType).toBe(PIXEL_GOAL_ENTRY)
  })

  it('pause and clear cancel pending continuations; replacement rejects results from an older goal', async () => {
    const s = setup()
    await s.init()
    await s.action({ kind: 'set', objective: 'First goal' })
    const old = await s.call('get_goal')
    await s.action({ kind: 'pause' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.messages).toHaveLength(0)
    await s.start(true)
    await s.settle()
    expect(s.goal()?.status).toBe('paused')
    await s.action({ kind: 'set', objective: 'Replacement goal' })
    await expect(s.call('update_goal', { goal_id: old.goal_id, status: 'complete' })).rejects.toThrow('goal changed')
    const context = (await s.emit('context', { messages: [] })) as { messages: { content: string }[] }
    expect(context.messages[0].content).toContain('Replacement goal')
    expect(context.messages[0].content).not.toContain('First goal')
    await s.action({ kind: 'clear' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.messages).toHaveLength(0)
    expect(s.goal()).toBeNull()
    expect(await s.emit('context', { messages: [] })).toEqual({ messages: [] })
  })

  it('a held goal survives restart and resumes on a user message; explicit pause survives messages and restart', async () => {
    const first = setup()
    await first.init()
    await first.action({ kind: 'set', objective: 'Persistent work' })
    await first.start()
    await first.usage({ input: 12, output: 3 })
    await first.action({ kind: 'hold' })
    await first.settle(true)
    const next = setup(first.entries)
    await next.init()
    expect(next.goal()).toMatchObject({ status: 'paused', tokensUsed: 15 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(next.messages).toHaveLength(0)
    await next.start(true)
    expect(next.goal()?.status).toBe('active')
    await next.action({ kind: 'pause' })
    await next.settle()
    const paused = setup(next.entries)
    await paused.init()
    await paused.start(true)
    await paused.settle()
    expect(paused.goal()?.status).toBe('paused')
    await vi.advanceTimersByTimeAsync(1000)
    expect(paused.messages).toHaveLength(0)
  })

  it('counts main requests, compaction and subagent usage once, and stops at an explicit budget', async () => {
    const s = setup()
    await s.init()
    await s.action({ kind: 'set', objective: 'Budgeted work', tokenBudget: 40 })
    await s.start()
    await s.usage({ input: 10, output: 2, cacheRead: 3, cacheWrite: 1 })
    await s.emit('tool_execution_start', { toolName: 'task', toolCallId: 'child' })
    await s.emit('tool_execution_update', { toolCallId: 'child', partialResult: { details: { tokens: 10 } } })
    await s.emit('tool_execution_end', { toolCallId: 'child', result: { details: { tokens: 10 } } })
    await s.emit('session_before_compact')
    await s.emit('session_compact', { compactionEntry: { usage: { input: 8, output: 2 } } })
    expect(s.goal()?.tokensUsed).toBe(36)
    await s.usage({ input: 4, output: 1 })
    expect(s.abort).toHaveBeenCalledOnce()
    await s.settle(true)
    expect(s.goal()).toMatchObject({ tokensUsed: 41, tokenBudget: 40, status: 'budgetLimited' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.messages).toHaveLength(0)
    expect((await s.action({ kind: 'resume' })).error).toContain('预算已用完')
    await s.action({ kind: 'set', objective: 'Budgeted work', tokenBudget: 80 })
    expect(s.goal()).toMatchObject({ tokensUsed: 0, tokenBudget: 80, status: 'active' })
  })

  it('requires the same blocker in three runs, not three tool calls in one run; resume resets the audit', async () => {
    const s = setup()
    await s.init()
    await s.action({ kind: 'set', objective: 'Needs external input' })
    const { goal_id } = await s.call('get_goal')
    const block = () => s.call('update_goal', { goal_id, status: 'blocked', reason: 'Missing project credentials' })
    for (let run = 1; run <= 3; run++) {
      await s.start()
      await block()
      await block()
      expect((await s.call('get_goal')).blocker.count).toBe(run)
      expect(s.goal()?.status).toBe(run === 3 ? 'blocked' : 'active')
      await s.settle()
    }
    await s.action({ kind: 'resume' })
    expect(s.resets).toHaveBeenCalledTimes(2)
    await s.start()
    await block()
    expect((await s.call('get_goal')).blocker.count).toBe(1)
    expect(s.goal()?.status).toBe('active')
  })

  it('provider failure, user abort and the loop guard never trigger another goal run', async () => {
    for (const reason of ['error', 'abort', 'guard']) {
      const s = setup()
      await s.init()
      await s.action({ kind: 'set', objective: reason })
      await s.start()
      if (reason === 'error')
        await s.emit('message_end', {
          message: { role: 'assistant', stopReason: 'error', errorMessage: '401 Unauthorized' },
        })
      if (reason === 'guard') s.bus.get(LOOP_GUARD_STOP_EVENT)!()
      await s.settle(reason === 'abort')
      await vi.advanceTimersByTimeAsync(1000)
      expect(s.goal()?.status).toBe(reason === 'abort' ? 'paused' : 'blocked')
      expect(s.messages).toHaveLength(0)
    }
  })
})

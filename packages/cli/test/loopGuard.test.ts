import { describe, expect, it } from 'vitest'
import {
  FAILED_STEPS_STOP,
  LoopGuard,
  REPEAT_STOP,
  REPEAT_WARN,
  callKey,
  loopGuardExtension,
  stableJson,
  stopNotice,
} from '../src/extensions/loopGuard.ts'

const text = (t: string) => [{ type: 'text', text: t }]

describe('LoopGuard', () => {
  it('同样的调用、同样的结果连着数；参数键的顺序不算不同', () => {
    const g = new LoopGuard()
    expect(g.afterResult('read', { path: 'a', limit: 5 }, text('x'), false)).toBe(1)
    expect(g.afterResult('read', { limit: 5, path: 'a' }, text('x'), false)).toBe(2)
    expect(stableJson({ b: [1, { d: 1, c: 2 }], a: undefined })).toBe('{"b":[1,{"c":2,"d":1}]}')
    expect(callKey('read', { a: 1, b: 2 })).toBe(callKey('read', { b: 2, a: 1 }))
    // 结果变了、参数变了、换了工具，都从 1 重新数
    expect(g.afterResult('read', { path: 'a', limit: 5 }, text('y'), false)).toBe(1)
    expect(g.afterResult('read', { path: 'b', limit: 5 }, text('y'), false)).toBe(1)
    expect(g.afterResult('grep', { path: 'b', limit: 5 }, text('y'), false)).toBe(1)
    // 同样的文字，一次失败一次成功也算不同
    expect(g.afterResult('grep', { path: 'b', limit: 5 }, text('y'), true)).toBe(1)
  })

  it(`连着 ${REPEAT_STOP - 1} 次一模一样，第 ${REPEAT_STOP} 次拦下；之后的调用都拦`, () => {
    const g = new LoopGuard()
    for (let i = 1; i < REPEAT_STOP; i++) {
      expect(g.beforeCall('bash', { command: 'npm test' })).toBeNull()
      g.afterResult('bash', { command: 'npm test' }, text('FAIL'), true)
    }
    // 换个调用不拦
    expect(new LoopGuard().beforeCall('bash', { command: 'npm test' })).toBeNull()
    expect(g.beforeCall('bash', { command: 'npm test' })).toEqual({
      kind: 'repeat',
      tool: 'bash',
      count: REPEAT_STOP - 1,
    })
    expect(g.beforeCall('read', { path: 'other' })).toMatchObject({ kind: 'repeat' })
    g.reset()
    expect(g.beforeCall('bash', { command: 'npm test' })).toBeNull()
  })

  it('结果在变（比如轮询状态）不算打转', () => {
    const g = new LoopGuard()
    for (let i = 0; i < REPEAT_STOP * 2; i++) {
      expect(g.beforeCall('bash', { command: 'gh run view' })).toBeNull()
      g.afterResult('bash', { command: 'gh run view' }, text(`step ${i}`), false)
    }
  })

  it(`连着 ${FAILED_STEPS_STOP} 步全部失败就停；中间成功一次清零；没有工具调用的一步不算`, () => {
    const g = new LoopGuard()
    for (let i = 1; i < FAILED_STEPS_STOP; i++) g.afterStep([{ isError: true }, { isError: true }])
    g.afterStep([{ isError: true }, { isError: false }])
    g.afterStep([])
    for (let i = 1; i < FAILED_STEPS_STOP; i++) g.afterStep([{ isError: true }])
    expect(g.stopped).toBeNull()
    g.afterStep([{ isError: true }])
    expect(g.stopped).toEqual({ kind: 'failed', steps: FAILED_STEPS_STOP })
    expect(g.beforeCall('read', {})).toEqual({ kind: 'failed', steps: FAILED_STEPS_STOP })
  })
})

describe('loopGuardExtension', () => {
  function setup() {
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {}
    const notices: Array<[string, string]> = []
    loopGuardExtension({
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers[name] = handler
      },
    } as never)
    const ctx = { ui: { notify: (message: string, type: string) => notices.push([message, type]) } }
    const call = (toolName: string, input: unknown, parentToolCallId?: string) =>
      handlers.tool_call({ type: 'tool_call', toolCallId: 'c', toolName, input, parentToolCallId }, ctx) as Promise<
        { block: boolean; reason: string; terminate: boolean } | undefined
      >
    const result = (toolName: string, input: unknown, out: string, isError = false, parentToolCallId?: string) =>
      handlers.tool_result(
        {
          type: 'tool_result',
          toolCallId: 'c',
          toolName,
          input,
          content: text(out),
          structuredContent: { kept: true },
          isError,
          parentToolCallId,
        },
        ctx,
      ) as Promise<{ content: Array<{ text: string }>; structuredContent: unknown } | undefined>
    const step = (isError: boolean[]) =>
      handlers.turn_end({ type: 'turn_end', toolResults: isError.map(e => ({ isError: e })) }, ctx)
    return { handlers, notices, call, result, step }
  }

  it(`第 ${REPEAT_WARN} 次起提醒模型，第 ${REPEAT_STOP} 次拦下并停止、只提示用户一次`, async () => {
    const { notices, call, result } = setup()
    const input = { path: 'src/a.ts', oldText: 'x', newText: 'y' }
    for (let i = 1; i < REPEAT_STOP; i++) {
      expect(await call('edit', input)).toBeUndefined()
      const r = await result('edit', input, 'Could not find oldText', true)
      if (i < REPEAT_WARN) expect(r).toBeUndefined()
      else {
        expect(r!.content.at(-1)!.text).toContain(`identical "edit" call #${i}`)
        expect(r!.content[0].text).toBe('Could not find oldText')
        expect(r!.structuredContent).toEqual({ kept: true })
      }
    }
    const blocked = await call('edit', input)
    expect(blocked).toMatchObject({ block: true, terminate: true })
    expect(blocked!.reason).toContain('[loop guard] Blocked')
    expect(await call('read', { path: 'x' })).toMatchObject({ block: true, terminate: true })
    expect(notices).toEqual([[stopNotice({ kind: 'repeat', tool: 'edit', count: REPEAT_STOP - 1 }), 'warning']])
  })

  it('用户发了新消息（或新一轮开始）重新计数；codemode 脚本里的嵌套调用不算', async () => {
    const { handlers, call, result } = setup()
    for (let i = 1; i < REPEAT_STOP; i++) {
      await call('read', { path: 'a' })
      await result('read', { path: 'a' }, 'same')
    }
    await handlers.message_start({ type: 'message_start', message: { role: 'user' } }, {})
    expect(await call('read', { path: 'a' })).toBeUndefined()
    await handlers.agent_start({ type: 'agent_start' }, {})
    for (let i = 0; i < REPEAT_STOP * 2; i++) {
      expect(await call('read', { path: 'a' }, 'parent')).toBeUndefined()
      expect(await result('read', { path: 'a' }, 'same', false, 'parent')).toBeUndefined()
    }
  })

  it(`连着 ${FAILED_STEPS_STOP} 步全部失败：下一个调用拦下`, async () => {
    const { notices, call, step } = setup()
    for (let i = 0; i < FAILED_STEPS_STOP; i++) await step([true, true])
    expect(await call('bash', { command: 'ls' })).toMatchObject({ block: true, terminate: true })
    expect(notices[0][0]).toBe(stopNotice({ kind: 'failed', steps: FAILED_STEPS_STOP }))
  })
})

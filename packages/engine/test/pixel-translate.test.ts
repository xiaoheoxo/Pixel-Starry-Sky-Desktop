import { describe, expect, it } from 'vitest'
import type { EngineEvent } from '@pixelsky/protocol'
import {
  PixelTranslator,
  approvalFor,
  diffFromPatch,
  isDeclined,
  toolItem,
  toolNameFromTitle,
} from '../src/pixel/translate'

const setup = () => {
  const events: EngineEvent[] = []
  const t = new PixelTranslator(e => events.push(e), { cwd: '/proj' })
  return { t, events }
}

describe('Pixel 事件翻译', () => {
  it('diffFromPatch 去掉文件头和 "No newline" 行并计数', () => {
    expect(diffFromPatch('Index: a\n--- a\n+++ a\n@@ -1 +1,2 @@\n-x\n+y\n+z\n\\ No newline at end of file\n')).toEqual({
      diff: '@@ -1 +1,2 @@\n-x\n+y\n+z',
      added: 2,
      removed: 1,
    })
    expect(diffFromPatch('nothing')).toBeNull()
  })
  it('拒绝类的工具结果识别为 declined', () => {
    expect(isDeclined('The user denied the "bash" tool call.')).toBe(true)
    expect(isDeclined('Tool "write" is blocked: the session is in plan mode')).toBe(true)
    expect(isDeclined('ENOENT')).toBe(false)
  })
  it('文字增量：start/delta/end 以 end 里的完整内容为准', () => {
    const { t, events } = setup()
    t.event({ type: 'message_start', message: { role: 'assistant' } })
    t.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ab' } })
    t.event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'c' } })
    t.event({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'abcd' } })
    expect(events.map(e => e.type)).toEqual(['item_started', 'item_delta', 'item_delta', 'item_completed'])
    expect(events[3]).toMatchObject({ item: { kind: 'assistant', text: 'abcd', status: 'completed' } })
  })
  it('message_end 的用量累加到本轮和会话，带费用', () => {
    const { t, events } = setup()
    t.beginTurn()
    t.event({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'm',
        content: [{ type: 'text', text: 'hi' }],
        stopReason: 'stop',
        usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, totalTokens: 115, cost: { total: 0.25 } },
      },
    })
    expect(t.turnUsage(7)).toEqual({
      durationMs: 7,
      models: { m: { input: 100, cacheRead: 5, cacheWrite: 0, output: 10, costUsd: 0.25, requests: 1 } },
    })
    expect(events.find(e => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 100, costUsd: 0.25, contextTokens: 115 },
    })
    expect(events.find(e => e.type === 'item_completed')).toMatchObject({ item: { kind: 'assistant', text: 'hi' } })
  })
  it('一轮结束后才报的用量（后台子智能体）记进下一轮，不改已经结束的那一轮（docs/ui/usage.md §14）', () => {
    const { t } = setup()
    t.beginTurn()
    t.addUsage('m', { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.1)
    t.finish('completed')
    const ended = t.turnUsage(1).models
    t.addUsage('sub', { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 }, 0.5, 2)
    expect(ended).toEqual({ m: expect.objectContaining({ input: 10 }) })
    t.beginTurn()
    t.addUsage('m', { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 }, 0.2)
    expect(t.turnUsage(1).models).toEqual({
      sub: { input: 50, cacheRead: 0, cacheWrite: 0, output: 5, costUsd: 0.5, requests: 2 },
      m: { input: 20, cacheRead: 0, cacheWrite: 0, output: 2, costUsd: 0.2, requests: 1 },
    })
  })
  it('最后一条助手消息出错时 takeError 给出原因，下一条消息开始后清掉', () => {
    const { t } = setup()
    t.event({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'bad' },
    })
    expect(t.takeError()).toBe('bad')
    expect(t.takeError()).toBeNull()
  })
  it('工具归类：命令 / 改文件 / 待办 / 其余', () => {
    expect(toolItem('i', 'powershell', { command: 'dir' }, '/p')).toMatchObject({ kind: 'command', command: 'dir' })
    expect(toolItem('i', 'grep', { pattern: 'x', path: '/proj/src' }, '/proj')).toMatchObject({
      kind: 'tool',
      tool: 'search',
      title: 'x · src',
    })
    expect(toolItem('i', 'mcp__s__t', {}, '/p')).toMatchObject({ tool: 'mcp' })
    expect(toolItem('i', 'whatever', { url: 'http://x' }, '/p')).toMatchObject({ tool: 'other', title: 'http://x' })
    expect(toolItem('i', 'todo_write', { todos: [{ content: 'a', status: 'pending' }] }, '/p')).toMatchObject({
      kind: 'todo',
      steps: [{ text: 'a', status: 'pending' }],
    })
    const edit = toolItem('i', 'edit', { path: '/proj/a.ts', oldText: 'a', newText: 'b' }, '/proj')
    expect(edit).toMatchObject({
      kind: 'file_change',
      changes: [{ path: 'a.ts', kind: 'update', added: 1, removed: 1 }],
    })
  })
  it('工具输出更新：能接上发增量，被重写时整条替换', () => {
    const { t, events } = setup()
    t.event({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: { command: 'x' } })
    const upd = (text: string) =>
      t.event({ type: 'tool_execution_update', toolCallId: 'c', partialResult: { content: [{ type: 'text', text }] } })
    upd('ab')
    upd('abc')
    upd('z')
    expect(events.map(e => e.type)).toEqual(['item_started', 'item_delta', 'item_delta', 'item_started'])
    expect(events[2]).toMatchObject({ delta: 'c' })
  })
  it('read 读到图片：工具条目带上图片，能在对话里点开看；不认识的类型和出错的结果不带', () => {
    const { t, events } = setup()
    const content = [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'image', data: 'AAAA', mimeType: 'image/bmp' },
    ]
    t.event({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'read', args: { path: '/proj/a.png' } })
    t.event({ type: 'tool_execution_end', toolCallId: 'c', toolName: 'read', result: { content }, isError: false })
    const done = events.filter(e => e.type === 'item_completed').pop()
    expect(done).toMatchObject({
      item: {
        kind: 'tool',
        output: 'Read image file [image/png]\n[图片]\n[图片]',
        images: [{ mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', bytes: 9 }],
      },
    })
    const item = (done as Extract<EngineEvent, { type: 'item_completed' }>).item
    expect(item.kind === 'tool' && item.images?.map(i => i.id)).toEqual([`${item.id}-img0`])

    t.event({ type: 'tool_execution_start', toolCallId: 'd', toolName: 'read', args: { path: '/proj/b.png' } })
    t.event({ type: 'tool_execution_end', toolCallId: 'd', toolName: 'read', result: { content }, isError: true })
    expect(events.filter(e => e.type === 'item_completed').pop()).not.toHaveProperty('item.images')
  })
  it('压缩：start/end 生成条目并给出压缩前后大小', () => {
    const { t, events } = setup()
    t.event({ type: 'compaction_start', reason: 'manual' })
    t.event({
      type: 'compaction_end',
      reason: 'manual',
      result: { tokensBefore: 10, estimatedTokensAfter: 2 },
      aborted: false,
    })
    expect(events.filter(e => e.type === 'item_completed').pop()).toMatchObject({
      item: { kind: 'compaction', trigger: 'manual', status: 'completed', preTokens: 10, postTokens: 2 },
    })
  })
  it('审批卡片：按工具条目、没有条目时按标题', () => {
    const cmd = toolItem('i', 'bash', { command: 'ls' }, '/p')
    expect(approvalFor('r', 't', 'm', cmd)).toMatchObject({
      kind: 'command',
      command: 'ls',
      itemId: 'i',
      alwaysScopes: [],
    })
    expect(approvalFor('r', '允许工具 write？ / Allow tool write?', 'a.txt', null)).toMatchObject({
      kind: 'tool',
      toolName: 'write',
      itemId: null,
    })
    expect(toolNameFromTitle('允许工具 bash？ / Allow tool bash?')).toBe('bash')
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EngineEvent } from '@pixelsky/protocol'
import { PixelAdapter } from '../src'
import { runsFromSession, subagentItemId } from '../src/pixel/agents'
import { PixelTranslator } from '../src/pixel/translate'
import { transcriptItems } from '../src/pixel/transcript'

const root = mkdtempSync(join(tmpdir(), 'pixel-agents-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const progress = (extra: Record<string, unknown> = {}) => ({
  agentId: 'child-1',
  label: '找调用点',
  prompt: '找出所有调用 foo 的地方',
  state: 'running',
  model: 'pixelsky/m1',
  startedAt: 1000,
  durationMs: 50,
  tokens: 120,
  toolCalls: 2,
  lastTool: 'grep',
  sessionFile: join(root, 'child.jsonl'),
  result: '',
  ...extra,
})
const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

describe('像素星空子智能体 → 智能体追踪', () => {
  it('task 工具：条目显示成 Agent（能打开追踪），进度和结果变成 runs / subagents', () => {
    const events: EngineEvent[] = []
    const t = new PixelTranslator(e => events.push(e), { cwd: '/proj' })
    t.beginTurn()
    t.event({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'task',
      args: { description: '找调用点', prompt: 'x' },
    })
    const started = events.find(e => e.type === 'item_started')
    expect(started).toMatchObject({
      item: { id: subagentItemId('c1'), kind: 'tool', tool: 'task', name: 'Agent', title: '找调用点' },
    })
    t.event({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'task',
      partialResult: { details: progress() },
    })
    expect(events.filter(e => e.type === 'runs').pop()).toMatchObject({
      runs: {
        workflows: [],
        agents: [{ id: 'child-1', label: '找调用点', state: 'running', toolCalls: 2, toolUseId: 'px-task-c1' }],
      },
    })
    expect(events.filter(e => e.type === 'subagents').pop()).toMatchObject({
      subagents: [{ id: 'child-1', status: 'running', lastTool: 'grep', toolUseId: 'px-task-c1' }],
    })
    t.event({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'task',
      result: {
        content: [{ type: 'text', text: '在 a.ts、b.ts' }],
        details: progress({ state: 'completed', result: '在 a.ts、b.ts' }),
      },
      isError: false,
    })
    expect(events.filter(e => e.type === 'runs').pop()).toMatchObject({
      runs: { agents: [{ state: 'completed', result: '在 a.ts、b.ts' }] },
    })
    // 跑完的不在子智能体条上
    expect(events.filter(e => e.type === 'subagents').pop()).toMatchObject({ subagents: [] })
    expect(events.filter(e => e.type === 'item_completed').pop()).toMatchObject({
      item: { id: 'px-task-c1', output: '在 a.ts、b.ts', status: 'completed' },
    })
  })

  it('子智能体失败：工具出错时状态变失败；以前的子智能体（seedRuns）一直带着', () => {
    const events: EngineEvent[] = []
    const t = new PixelTranslator(e => events.push(e), { cwd: '/proj' })
    t.seedRuns(runsFromSessionRows([{ toolCallId: 'old', ...progress({ agentId: 'old-agent', state: 'completed' }) }]))
    t.beginTurn()
    t.event({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'task', args: { description: 'd' } })
    t.event({
      type: 'tool_execution_update',
      toolCallId: 'c2',
      toolName: 'task',
      partialResult: { details: progress({ agentId: 'new' }) },
    })
    t.event({
      type: 'tool_execution_end',
      toolCallId: 'c2',
      toolName: 'task',
      result: { content: [{ type: 'text', text: 'Subagent failed: 401 REVIEW_AUTH_FAILURE' }] },
      isError: true,
    })
    const runs = events.filter(e => e.type === 'runs').pop() as Extract<EngineEvent, { type: 'runs' }>
    expect(runs.runs.agents.map(a => [a.id, a.state])).toEqual([
      ['old-agent', 'completed'],
      ['new', 'failed'],
    ])
    // 原因进追踪（details 是空的，不能留着之前的进度文字）
    expect(runs.runs.agents[1].result).toBe('Subagent failed: 401 REVIEW_AUTH_FAILURE')
    const ended = events.filter(e => e.type === 'item_completed').pop() as Extract<
      EngineEvent,
      { type: 'item_completed' }
    >
    expect(ended.item).toMatchObject({ id: subagentItemId('c2'), status: 'failed' })
  })

  it('重新打开：从主会话文件读子智能体（同一个调用取最后一条），读子智能体的对话', () => {
    const child = join(root, 'child.jsonl')
    writeFileSync(
      child,
      jsonl([
        { type: 'session', id: 's' },
        {
          type: 'message',
          id: 'm1',
          timestamp: '2026-10-17T00:00:00Z',
          message: { role: 'user', content: [{ type: 'text', text: '找 foo' }] },
        },
        {
          type: 'message',
          id: 'm2',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '想想' },
              { type: 'toolCall', id: 'k1', name: 'grep', arguments: { pattern: 'foo' } },
            ],
          },
        },
        {
          type: 'message',
          id: 'm3',
          message: {
            role: 'toolResult',
            toolCallId: 'k1',
            content: [{ type: 'text', text: 'a.ts:1: foo' }],
            isError: false,
          },
        },
        { type: 'message', id: 'm4', message: { role: 'assistant', content: [{ type: 'text', text: '在 a.ts' }] } },
        {
          type: 'message',
          id: 'm5',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'k2', name: 'bash', arguments: { command: 'ls' } }],
          },
        },
      ]) + '{"type":"message","id":"half',
    )
    const parent = join(root, 'parent.jsonl')
    writeFileSync(
      parent,
      jsonl([
        { type: 'session', id: 'p' },
        { type: 'custom', customType: 'pixelsky-subagent', data: { toolCallId: 'c1', ...progress() } },
        {
          type: 'custom',
          customType: 'pixelsky-subagent',
          data: { toolCallId: 'c1', ...progress({ state: 'completed', result: '在 a.ts' }) },
        },
        { type: 'custom', customType: 'other', data: { toolCallId: 'c9' } },
      ]),
    )
    const adapter = new PixelAdapter({})
    const record = { engineSessionId: parent, cwd: '/proj' } as never
    expect(adapter.loadRuns(record)).toEqual({
      workflows: [],
      agents: [
        expect.objectContaining({ id: 'child-1', state: 'completed', result: '在 a.ts', toolUseId: 'px-task-c1' }),
      ],
    })
    const items = adapter.subagentTranscript(record, 'child-1')
    expect(items.map(i => i.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant', 'command'])
    expect(items[2]).toMatchObject({ kind: 'tool', tool: 'search', status: 'completed', output: 'a.ts:1: foo' })
    // 没等到结果的命令：算中断
    expect(items[4]).toMatchObject({ kind: 'command', command: 'ls', status: 'interrupted' })
    expect(() => adapter.subagentTranscript(record, 'nope')).toThrow(/not found/)
    expect(adapter.loadRuns({ engineSessionId: join(root, 'missing.jsonl') } as never)).toEqual({
      workflows: [],
      agents: [],
    })
    expect(transcriptItems(join(root, 'missing.jsonl'), '/proj')).toEqual([])
  })
})

function runsFromSessionRows(rows: Array<Record<string, unknown>>) {
  const file = join(root, `seed-${Math.random().toString(16).slice(2)}.jsonl`)
  writeFileSync(file, jsonl(rows.map(data => ({ type: 'custom', customType: 'pixelsky-subagent', data }))))
  return runsFromSession(file).map(({ sessionFile: _, ...run }) => run)
}

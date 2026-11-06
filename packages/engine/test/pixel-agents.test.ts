import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EngineEvent } from '@pixelsky/protocol'
import { PixelAdapter } from '../src'
import { entries, runsFromSession, subagentItemId, subagentRun, subagentTotals } from '../src/pixel/agents'
import { LINE_MAX } from '../src/jsonl'
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

  it('子智能体被停止：工具不算出错，条目也记成中断（卡片不写「已完成」）', () => {
    const events: EngineEvent[] = []
    const t = new PixelTranslator(e => events.push(e), { cwd: '/proj' })
    t.beginTurn()
    t.event({ type: 'tool_execution_start', toolCallId: 'c3', toolName: 'task', args: { description: 'd' } })
    t.event({
      type: 'tool_execution_end',
      toolCallId: 'c3',
      toolName: 'task',
      result: { content: [{ type: 'text', text: 'Subagent was stopped.' }], details: progress({ state: 'stopped' }) },
      isError: false,
    })
    expect(events.filter(e => e.type === 'item_completed').pop()).toMatchObject({
      item: { id: subagentItemId('c3'), status: 'interrupted' },
    })
  })

  it('主模型调度的标记带到运行记录；老记录和认不出的值没有', () => {
    const runOf = (extra: Record<string, unknown>) => subagentRun({ agentId: 'a', model: 'm', ...extra }, 't')
    expect(runOf({ modelSource: 'chosen', outsideGroup: true })).toMatchObject({
      modelSource: 'chosen',
      outsideGroup: true,
    })
    const old = runOf({ modelSource: 'nope', outsideGroup: 'yes' })
    expect(old).not.toHaveProperty('modelSource')
    expect(old).not.toHaveProperty('outsideGroup')
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

  it('子智能体读到的图片：追踪窗口的工具条目带上图片', () => {
    const file = join(root, 'child-image.jsonl')
    writeFileSync(
      file,
      jsonl([
        {
          type: 'message',
          id: 'm1',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'k1', name: 'read', arguments: { path: '/proj/a.png' } }],
          },
        },
        {
          type: 'message',
          id: 'm2',
          message: {
            role: 'toolResult',
            toolCallId: 'k1',
            content: [
              { type: 'text', text: 'Read image file [image/png]' },
              { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
            ],
          },
        },
      ]),
    )
    const [item] = transcriptItems(file, '/proj')
    expect(item).toMatchObject({
      kind: 'tool',
      status: 'completed',
      images: [{ id: `${item.id}-img0`, mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
    })
  })
})

function runsFromSessionRows(rows: Array<Record<string, unknown>>) {
  const file = join(root, `seed-${Math.random().toString(16).slice(2)}.jsonl`)
  writeFileSync(file, jsonl(rows.map(data => ({ type: 'custom', customType: 'pixelsky-subagent', data }))))
  return runsFromSession(file).map(({ sessionFile: _, ...run }) => run)
}

describe('子智能体的用量算进这一轮（docs/own-cli.md §15）', () => {
  const usage = (input: number, output: number, cost: number, requests: number) => ({
    'm-child': { input, output, cacheRead: 0, cacheWrite: 0, cost, requests },
  })
  const update = (t: PixelTranslator, details: Record<string, unknown>, final = false) =>
    t.event(
      final
        ? { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'task', result: { details }, isError: false }
        : { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'task', partialResult: { details } },
    )

  it('进度报累计，只加多出来的；同样的进度重复报不重复算；会话累计也加上', () => {
    const events: EngineEvent[] = []
    const t = new PixelTranslator(e => events.push(e), { cwd: '/proj' })
    t.beginTurn()
    update(t, progress({ usage: usage(100, 10, 0.01, 1) }))
    update(t, progress({ usage: usage(100, 10, 0.01, 1) }))
    update(t, progress({ usage: usage(250, 30, 0.03, 2), state: 'completed' }), true)
    expect(t.turnUsage(5).models['m-child']).toMatchObject({ input: 250, output: 30, requests: 2 })
    expect(t.turnUsage(5).models['m-child'].costUsd).toBeCloseTo(0.03)
    expect(events.filter(e => e.type === 'usage').pop()).toMatchObject({
      usage: { inputTokens: 250, outputTokens: 30 },
    })
  })

  it('不知道价格的模型（自选站点）报费用 0：记成不知道，不当成免费', () => {
    const t = new PixelTranslator(() => {}, { cwd: '/proj' })
    t.beginTurn()
    update(t, progress({ usage: usage(100, 10, 0, 1) }))
    expect(t.turnUsage(5).models['m-child']).toMatchObject({ input: 100, costUsd: null })
  })

  it('老版本命令行不报 usage：不动用量', () => {
    const t = new PixelTranslator(() => {}, { cwd: '/proj' })
    t.beginTurn()
    update(t, progress())
    expect(t.turnUsage(5).models).toEqual({})
  })

  it('重新打开：会话文件里每个调用取最后一条记录的用量合计', () => {
    const rows = [
      { type: 'custom', customType: 'pixelsky-subagent', data: { toolCallId: 'a', usage: usage(10, 1, 0.1, 1) } },
      { type: 'custom', customType: 'pixelsky-subagent', data: { toolCallId: 'a', usage: usage(30, 3, 0.3, 2) } },
      { type: 'custom', customType: 'pixelsky-subagent', data: { toolCallId: 'b', usage: usage(5, 5, 0.05, 1) } },
      { type: 'custom', customType: 'pixelsky-subagent', data: { toolCallId: 'c' } },
    ]
    const sum = subagentTotals(rows)
    expect(sum).toMatchObject({ input: 35, output: 8, cacheRead: 0, cacheWrite: 0 })
    expect(sum.cost).toBeCloseTo(0.35)
  })
})

describe('读 Pi 的会话文件（长会话的文件可能超过 512 MB）', () => {
  it('按块读、按行切：跨块的行、跨块的中文、超长行、没写完的最后一行', () => {
    const file = join(root, 'big.jsonl')
    const pad = 'x'.repeat(1024 * 1024 - 20)
    const rows = [
      JSON.stringify({ type: 'session', id: 's' }),
      // 刚好跨过 1 MB 的块边界，中文落在边界上
      JSON.stringify({ type: 'message', id: 'm1', text: pad + '中文跨块' }),
      JSON.stringify({ type: 'custom', customType: 'pixelsky-subagent', data: { toolCallId: 'c1', text: '子' } }),
      '',
      '{"type":"message","id":"half"',
    ]
    writeFileSync(file, rows.join('\n'))
    const all = entries(file)
    expect(all.map(e => e.id ?? e.customType)).toEqual(['s', 'm1', 'pixelsky-subagent'])
    expect(String(all[1].text).endsWith('中文跨块')).toBe(true)
    expect(entries(file, 'pixelsky-subagent')).toEqual([JSON.parse(rows[2])])
    expect(entries(join(root, 'missing.jsonl'))).toEqual([])
  })

  it('超过 LINE_MAX 的一行整行跳过，后面的行照常读', () => {
    const file = join(root, 'huge-line.jsonl')
    writeFileSync(file, `{"type":"message","text":"${'y'.repeat(LINE_MAX + 10)}"}\n{"type":"custom","id":"after"}`)
    expect(entries(file).map(e => e.id)).toEqual(['after'])
  })
})
